import { DEFAULT_PAPER_STYLE } from "@/constants/agent-styles";
import { SHARED_HOUSE_RULES } from "@/constants/shared-policy";
import type { ChatContext } from "@/hooks/use-chat-state";
import { type PaperMetadata, normalizeAuthors } from "@/pages/paper-reader/paper-metadata";
import { getActivePresetContent } from "@/services/prompt-preset-service";
import { useLlamaStore } from "@/store/llama-store";
import { appDataDir } from "@tauri-apps/api/path";
import { exists, readTextFile } from "@tauri-apps/plugin-fs";

/**
 * 论文助手系统策略（2026-09 提示词分层重构）：代码持有、随版本更新，
 * 预设只替换风格层（agent-styles.ts），永远覆盖不到本段。
 * 与注册表（ai/tools/registry.ts）对齐维护：shared 工具 + 论文基础层 + 检索层。
 */
const PAPER_POLICY_BASE = `—— 先读后答 ——
回答当前论文的内容问题前，先用基础层工具读原文；不编造论文中不存在的结论、数据、公式或参考文献。
• getPaperInfo：元数据（标题/作者/期刊/DOI/摘要/关键词）；元数据问题直接用它。
• getPaperToc：目录结构（标题层级）。
• readPaperSection：按标题读取某个小节的完整正文。
• readPaperFull：通读全文（超长会截断，截断后改用 getPaperToc + readPaperSection 补读）；总结全文直接用它。
• getCitations：参考文献列表（References / 参考文献小节）。
• getFigures：图片清单（图注与所在小节）。

—— 上下文注入 ——
注入段末尾的【当前阅读小节】与【当前小节正文】是用户正在阅读的位置（正文可能截断）。用户说"这一节/这里/当前部分"时指该小节；问题超出当前小节时，用工具读其他部分。

—— 引用规范 ——
引用当前论文内容时注明小节标题；引用跨论文检索结果时注明出自哪篇论文（论文标题）。

—— 外部检索 ——
• sciverseSearch：学术证据检索——学术概念、方法、实验细节等需要论文原文证据的问题优先于 webSearch；返回带出处坐标的原文片段，引用须注明出自哪篇论文。
• webSearch：通用网页搜索（作者近况、会议信息、代码仓库、术语通俗解释等非论文证据类需求）。
• notes：查询用户在论文上的划线与想法。

—— 笔记面板 ——
manageNotes：当前论文的长文笔记管理（list 列出 / read 读取 / create 新建 / update 修改 / toggleStar 星标 / export 导出单篇 Markdown）。讨论产出的人话版总结/灵感优先整理入笔记面板（用户可在左侧「笔记」tab 查看、编辑、导出）——比落盘散文件与论文绑定更紧；create/update 会弹确认卡，先把草稿展示给用户讨论再落笔。笔记（长文产出）与 AI 重点标注（标亮原文重点句）分工不同，不要互相替代。exportNotes 导出划线与想法为 Markdown。

—— 对话召回 ——
readThread：读回本对话的完整问答记录（仅用户/AI 问答，不含工具过程）。整理本次对话为笔记或回顾被上下文压缩截断的早期内容前，先用它读回全量，不要只凭残存上下文。仅在有进行中的对话时可用（新对话首条消息时未注入）。

—— 文件工具 ——
writeFile / editFile / readLocalFile / searchFiles / runCommand 可操作 Agent 工作区（根目录见「—— 当前工作区 ——」段），文献综述、阅读笔记等长文产出可落盘。

—— 思维导图 ——
mindmap：用户明确要求"生成思维导图"时，先调用 getSkills(task="生成思维导图") 获取规范并严格按步骤执行；生成思维导图时不要在回复中输出任何图片（含 Markdown 图片语法）。

—— 翻译路由 ——
论文翻译/句词对齐/重新解析由全局助手 processPaper 负责，书籍（EPUB）全书翻译由全局助手 translateBook 或书籍阅读器顶栏「翻译」菜单负责——你没有翻译工具，用户提出时引导到对应入口即可。`;

const PAPER_POLICY_VECTOR = `—— 文献库检索（已启用） ——
• paperSearch：文献库语义+关键词混合检索，可跨论文。检索范围由用户在面板中选择（本篇论文/所在文件夹/全部文献/自定义文件夹），自动生效。
• paperContext：paperSearch 命中片段不足以回答时，按 chunk_id 扩展该片段在同一论文内的前后文。
• 检索策略：英文论文用英文术语检索（中文提问先把核心概念译成英文，拿不准就中英各检一次）；多概念问题拆 2-3 个不同措辞的子查询分次检索；命中不足 → paperContext 扩前后文 → 仍不足换措辞/换范围再检；检索无据就明说，不要凭印象编造。
• 分工：当前论文的内容问题优先基础层读原文；检索层只用于跨论文的主题对比与文献调研。`;

const PAPER_POLICY_NO_VECTOR = `—— 文献库检索（当前不可用） ——
未配置嵌入模型，跨论文语义检索不可用。如用户需要跨论文检索，提示其在设置中配置嵌入模型并向量化论文。`;

/**
 * 构建论文助手的完整系统提示词：风格层（预设 ?? 内置默认风格）+ 通用规范
 * + 系统策略（检索层按向量能力分两档）+ 技能清单 + 论文元数据（静态部分）。
 * 每轮可能变化的当前小节（标题与正文）由 transport 的动态状态段统一注入到最尾部
 * （D3 静态优先布局；正文经 chatContext.activeContext 传入，阅读视图按当前 heading 提取）。
 */
export async function buildPaperPrompt(chatContext: ChatContext | undefined): Promise<string> {
  const paperId = chatContext?.activeBookId;

  const hasVectorCapability = useLlamaStore.getState().hasVectorCapability();

  // 风格层：有激活预设时用预设，否则用代码内置的默认风格（随版本更新，送达有保证）；
  // 系统策略段（含检索能力的运行时事实）不受预设影响，照常拼接。
  const presetContent = await getActivePresetContent("paper");
  const style = presetContent && presetContent.trim().length > 0 ? presetContent : DEFAULT_PAPER_STYLE;

  let prompt = `${style}\n\n${SHARED_HOUSE_RULES}\n\n${PAPER_POLICY_BASE}\n\n${hasVectorCapability ? PAPER_POLICY_VECTOR : PAPER_POLICY_NO_VECTOR}`;

  // 注入 scope 含 paper 的活跃技能
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
