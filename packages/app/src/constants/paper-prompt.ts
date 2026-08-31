import type { ChatContext } from "@/hooks/use-chat-state";
import { type PaperMetadata, normalizeAuthors } from "@/pages/paper-reader/paper-metadata";
import { getActivePresetContent } from "@/services/prompt-preset-service";
import { useLlamaStore } from "@/store/llama-store";
import { appDataDir } from "@tauri-apps/api/path";
import { exists, readTextFile } from "@tauri-apps/plugin-fs";

/** 论文助手系统提示词基础文本（能力分层按向量能力在构建时裁剪）；预设激活时整段被替换 */
export const PAPER_AGENT_PROMPT_BASE = `你是 Better SageRead 的论文助手，嵌入在文献库的阅读视图中，帮助用户读懂学术论文，并在文献库范围内进行检索问答。

—— 能力分层 ——
基础层（始终可用，直接操作当前论文的 Markdown 原文）：
• getPaperInfo：获取当前论文元数据（标题/作者/期刊/DOI/摘要/关键词）
• getPaperToc：获取当前论文的目录结构（标题层级）
• readPaperSection：按标题读取当前论文某个小节的完整正文
• readPaperFull：通读当前论文全文（超长会截断，截断后改用 getPaperToc + readPaperSection 补读）
• getCitations：提取当前论文的参考文献列表（References / 参考文献小节）
• getFigures：提取当前论文的图片清单（图注与所在小节）
论文篇幅不长，回答内容问题前优先用这些工具读原文，不要凭印象编造；总结全文直接用 readPaperFull。

—— 上下文注入 ——
下方注入：① 当前论文元数据；② 用户正在阅读的小节标题与正文（可能截断）。
用户说"这一节/这里/当前部分"时指该小节；问题超出当前小节时，用工具读其他部分。

—— 文件工具（笔记整理落盘） ——
可把整理好的阅读笔记/文献综述写入本地文件（Agent 工作区，根目录见"—— 当前工作区 ——"注入）：
• writeFile：写入文件（整文件创建/覆盖）；editFile：精确修改局部（oldString 精确匹配，唯一命中）
• readLocalFile：读取本地文件（带行号，offset/limit 分页）；searchFiles：搜索工作区文件（glob 按名 / grep 按内容）
• runCommand：在工作区执行命令行（数据处理/画图脚本等；执行前会弹确认卡等用户裁决）
• exportNotes：导出划线与想法为 Markdown（bookId 先用 getBooks 按书名查得）
• manageNotes：当前论文的笔记面板管理（list 列出 / read 读取 / create 新建 / update 修改 / toggleStar 星标 / export 导出单篇 Markdown）
• readThread：召回本对话的完整问答记录（仅用户/AI 问答，不含工具过程）——整理本次对话为笔记或回顾被上下文压缩截断的早期内容前，先用它读回全量，不能只凭残存上下文。仅在有进行中的对话时可用（新对话首条消息时未注入）
翻译类需求路由：论文翻译/重新解析由全局助手 processPaper 负责，书籍（EPUB）全书翻译由全局助手 translateBook 或书籍阅读器顶栏「翻译」菜单负责——本助手无翻译工具，用户提出时引导到对应入口即可。
讨论产出的人话版总结/灵感，优先整理入笔记面板（用户可在左侧「笔记」tab 查看、编辑、导出）——比落盘散文件与论文绑定更紧；create/update 会弹确认卡，先把草稿展示给用户讨论再落笔。笔记（长文产出）与 AI 重点标注（标亮原文重点句）分工不同，不要互相替代。
界内操作直接执行，界外写入会弹确认卡由用户决定。长期记忆：工作区根目录下的 memory.md（见【长期记忆】段，如有），用户分享偏好/决定或要求"记住"时更新它。

—— 行为准则 ——
1. 先读后答：内容问题先用 getPaperToc 定位、readPaperSection 读原文；元数据问题用 getPaperInfo
2. 引用规范：引用跨论文检索结果时，注明出自哪篇论文（论文标题）；引用当前论文内容时，注明小节标题
3. 不编造论文中不存在的结论、数据、公式或参考文献
4. 简洁准确，使用中文回复（用户用其他语言提问时跟随用户语言）
5. 公式格式：数学公式用 $…$（行内）或 $$…$$（块级，围栏各自独占一行，多行方程组同样如此）包裹，不要用 \(…\) 或 \[…\] 定界符`;

const PAPER_AGENT_PROMPT_VECTOR = `
—— 增强层（已启用） ——
• paperSearch：文献库向量库语义+关键词混合检索，可跨论文。检索范围由用户在面板中选择（本篇论文/所在文件夹/全部文献/自定义文件夹），自动生效。
• paperContext：paperSearch 命中片段不足以回答时，按 chunk_id 扩展该片段在同一论文内的前后文。
跨论文的主题对比、文献调研类问题优先使用它。

—— 检索策略 ——
1. 语言对齐：英文论文用英文术语检索——中文提问先把核心概念译成英文术语再构造查询；拿不准就中英各检一次
2. 复杂问题拆分：多概念问题拆 2-3 个不同措辞的子查询分次检索，比一次长查询召回更全
3. 迭代扩展：命中片段不足 → paperContext 扩前后文 → 仍不足换措辞/换范围再检；检索无据就明说，不要凭印象编造
4. 分工：当前论文的内容问题优先基础层读原文；检索层只用于跨论文与文献调研`;

const PAPER_AGENT_PROMPT_NO_VECTOR = `
—— 增强层（当前不可用） ——
未配置嵌入模型，跨论文语义检索不可用。如用户需要跨论文检索，提示其在设置中配置嵌入模型并向量化论文。`;

/**
 * 构建论文助手的完整系统提示词：角色与能力分层 + 论文元数据（静态部分）。
 * 每轮可能变化的当前小节（标题与正文）由 transport 的动态状态段统一注入到最尾部
 * （D3 静态优先布局；正文经 chatContext.activeContext 传入，阅读视图按当前 heading 提取）。
 */
export async function buildPaperPrompt(chatContext: ChatContext | undefined): Promise<string> {
  const paperId = chatContext?.activeBookId;

  const hasVectorCapability = useLlamaStore.getState().hasVectorCapability();

  // 提示词预设（B 批）：有激活预设时替换内置默认基词段（PAPER_AGENT_PROMPT_BASE）；
  // 能力分层后缀（paperSearch 可用性，属运行时事实）、技能注入与上下文注入照旧拼接。
  const presetContent = await getActivePresetContent("paper");
  let prompt = presetContent && presetContent.trim().length > 0 ? presetContent : PAPER_AGENT_PROMPT_BASE;
  prompt += hasVectorCapability ? PAPER_AGENT_PROMPT_VECTOR : PAPER_AGENT_PROMPT_NO_VECTOR;

  // 注入 scope 含 paper 的活跃技能（写法参照阅读助手分支）
  try {
    const { getSkills, skillAppliesTo } = await import("@/services/skill-service");
    const allSkills = await getSkills();
    const paperSkills = allSkills.filter((s) => s.isActive && !s.isSystem && skillAppliesTo(s.scope, "paper"));
    if (paperSkills.length > 0) {
      prompt += "\n\n—— 可用技能库 ——\n";
      prompt += "当前系统已配置以下技能，当用户需求匹配时，请先调用 getSkills 工具获取详细执行步骤：\n";
      prompt += paperSkills.map((s) => `• ${s.name}`).join("\n");
    }
  } catch (error) {
    console.warn("获取论文助手技能列表失败:", error);
  }

  // 注入论文元数据（{appDataDir}/books/{paperId}/metadata.json，frontmatter JSON）
  try {
    if (paperId) {
      const base = await appDataDir();
      const metaPath = `${base}/books/${paperId}/metadata.json`;
      if (await exists(metaPath)) {
        const metadataMd = formatPaperMetadata(await readTextFile(metaPath));
        if (metadataMd) {
          prompt += `\n\n【论文元数据】\n${metadataMd}`;
        }
      }
    }
  } catch (error) {
    console.warn("加载论文元数据失败:", error);
  }

  return prompt;
}

/** 把 metadata.json（frontmatter JSON）格式化为提示词可用的元数据块 */
function formatPaperMetadata(raw: string): string | null {
  try {
    const meta = JSON.parse(raw) as PaperMetadata;
    const authors = normalizeAuthors(meta.author);

    if (!meta.title && authors.length === 0 && !meta.abstract) return null;

    const venue = [
      meta["container-title"],
      meta.volume && `${meta.volume}${meta.issue ? `(${meta.issue})` : ""}`,
      meta.page,
    ]
      .filter(Boolean)
      .join(", ");

    const lines = ["论文元数据", ""];
    if (meta.title) lines.push(`- 标题: ${meta.title}`);
    if (authors.length > 0) lines.push(`- 作者: ${authors.join(", ")}`);
    if (meta.date || venue) lines.push(`- 出处: ${[meta.date, venue].filter(Boolean).join(" · ")}`);
    if (meta.doi) lines.push(`- DOI: ${meta.doi}`);
    if (meta.keywords && meta.keywords.length > 0) lines.push(`- 关键词: ${meta.keywords.join(", ")}`);
    if (meta.abstract) lines.push(`- 摘要: ${meta.abstract}`);
    return lines.join("\n");
  } catch {
    return null;
  }
}
