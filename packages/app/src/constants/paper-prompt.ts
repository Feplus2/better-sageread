import { getDocumentToolMode } from "@/ai/tools/document/mode";
import { DEFAULT_PAPER_STYLE } from "@/constants/agent-styles";
import { RETRIEVAL_SCOPE_LABELS, type RetrievalScope } from "@/constants/retrieval-scope";
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
• getFigures：图片清单（图注与所在小节，返回绝对 image_path）；要真正看图用 readImage(path=image_path)。看图昂贵：先读图注/正文，确需视觉细节时最后再看图，看完立即作答。
（旧版模式不提供 readDocument / getDocumentInfo / searchLibrary / getCitationGraph；跨文献检索用下方检索层工具。）

—— 阅读位置（每轮刷新，以本轮为准） ——
system 提示词尾部的【当前阅读位置】是用户此刻的精确位置（小节标题 + paper.md 字符坐标 + 估算分块区间 + 全文进度），每轮发送前实时更新；对话历史里早前出现的位置一律视为过时，位置类问题以该段为准。
• 位置类问题（我读到哪/这段属于哪/进度多少）直接看该段回答，不必调工具；要完整结构化字段时用 getReadingPosition。
• 用户说"这一节/这里/当前部分"且需要原文时，用 readAtReadingPosition 按当前位置读取（默认向后 6000 字符，before/after 可扩窗，next_offset 续读）；不要凭记忆复述正文。
• 注入段不含正文是刻意设计：目录/小节结构异常时整篇灌入会浪费上下文，按需读取更省更准。
• 问题超出当前位置时，用 getPaperToc / readPaperSection / readPaperFull 读其它部分。

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

const PAPER_POLICY_BASE_NEW = `—— 先读后答 ——
回答当前论文的内容问题前，先用文档原语读原文；不编造论文中不存在的结论、数据、公式或参考文献。
• getDocumentInfo：元数据（标题/作者/期刊/DOI/摘要）+ 目录 + 图表与引用计数；元数据问题直接用它。
• readDocument：按 doc 读原文窗口（doc=paper:<id> / book:<id>；heading/offset/position + 窗口续读），但只能读用户圈定范围内的文档。总结全文先 getDocumentInfo 看目录，再按小节分窗读，不要一次读全文。
• getCitations：本篇参考文献列表（References 小节）。
• getCitationGraph：库内引用关系——它引用了库内哪些论文 / 库内哪些论文引用了它（按 DOI/标题匹配 References，无需向量索引）；该工具会扫描论文库其它论文，只有范围在「论文库」及以上时才可用。
• getFigures：本篇图片清单（图注 + 绝对 image_path）；真正看图用 readImage(path=image_path)。看图昂贵：先读图注/正文，确需视觉细节时最后再看图，看完立即作答。
• 检索当前/跨论文用 searchLibrary（scope 只能在用户圈内收窄，见【检索范围】段）；命中后用 readDocument 精读。

—— 阅读位置（每轮刷新，以本轮为准） ——
system 提示词尾部的【当前阅读位置】是用户此刻的精确位置（小节标题 + paper.md 字符坐标 + 估算分块区间 + 全文进度），每轮发送前实时更新；对话历史里早前出现的位置一律视为过时，位置类问题以该段为准。
• 位置类问题（我读到哪/这段属于哪/进度多少）直接看该段回答，不必调工具。
• 用户说"这一节/这里/当前部分"且需要原文时，用 readDocument(position=true)（默认向后 6000 字符，before/after 可扩窗，next_offset 续读）；不要凭记忆复述正文。
• 问题超出当前位置时，getDocumentInfo 看目录后用 readDocument(heading=...) 读其它部分。

—— 引用规范 ——
引用当前论文内容时注明小节标题；引用跨论文检索结果时注明出自哪篇论文（论文标题）。

—— 外部检索 ——
• sciverseSearch：学术证据检索——学术概念、方法、实验细节等需要论文原文证据的问题优先于 webSearch；返回带出处坐标的原文片段，引用须注明出自哪篇论文。
• webSearch：通用网页搜索（作者近况、会议信息、代码仓库、术语通俗解释等非论文证据类需求）。
• notes：查询用户在论文上的划线与想法。

—— 笔记面板 ——
manageNotes：当前论文的长文笔记管理（list 列出 / read 读取 / create 新建 / update 修改 / toggleStar 星标 / export 导出单篇 Markdown）。讨论产出的人话版总结/灵感优先整理入笔记面板（用户可在左侧「笔记」tab 查看、编辑、导出）——比落盘散文件与论文绑定更紧；create/update 会弹确认卡，先把草稿展示给用户讨论再落笔。笔记（长文产出）与 AI 重点标注（标亮原文重点句）分工不同，不要互相替代。exportNotes 导出划线与想法为 Markdown。

—— 对话召回 ——
readThread：读回本对话的完整问答记录（仅用户/AI 问答，不含工具过程）。整理本次对话为笔记或回顾被上下文压缩截断的早期内容前，先用它读回全量，不要只凭残存上下文。仅在有进行中的对话时可用（新对话首条消息时尚未注入）。

—— 文件工具 ——
readLocalFile / writeFile / editFile / searchFiles / runCommand 在本模式不可用；文献综述与笔记产出用 manageNotes 落盘，工作区文件操作请到全局助手。

—— 思维导图 ——
mindmap：用户明确要求"生成思维导图"时，先调用 getSkills(task="生成思维导图") 获取规范并严格按步骤执行；生成思维导图时不要在回复中输出任何图片（含 Markdown 图片语法）。

—— 翻译路由 ——
论文翻译/句词对齐/重新解析由全局助手 processPaper 负责，书籍（EPUB）全书翻译由全局助手 translateBook 或书籍阅读器顶栏「翻译」菜单负责——你没有翻译工具，用户提出时引导到对应入口即可。`;

const PAPER_POLICY_VECTOR_NEW = `—— 文献库检索（新原语） ——
• searchLibrary：语义 + 关键词混合检索；scope=current（当前论文）/ library（论文库全部论文）/ all（论文库+图书馆），也可用 doc=paper:<id> 在圈内指定单篇。scope/doc 只能收窄用户圈定范围，不能放大。
• 命中后先看 doc/章节，再用 readDocument(doc=paper:<id>, heading=... 或 offset=...) 精读，不要一次读全文。
• 检索策略：英文论文用英文术语；多概念问题拆 2-3 个不同措辞的子查询；命中不足换措辞/在圈内换范围再检；检索无据就明说，不要凭印象编造。
• 分工：当前论文内容问题优先 getDocumentInfo + readDocument 读原文；searchLibrary 只用于检索已建索引论文的片段。`;

const PAPER_POLICY_NO_VECTOR_NEW = `—— 文献库检索（当前不可用） ——
未配置嵌入模型，searchLibrary 不可用；当前论文用 getDocumentInfo + readDocument 读原文。用户需要跨论文检索时，提示其在设置中配置嵌入模型并向量化论文。`;

const PAPER_POLICY_VECTOR = `—— 文献库检索（已启用） ——
• paperSearch：文献库语义+关键词混合检索，可跨论文。检索范围由用户在面板中选择（本篇/论文库/论文库+图书馆）；旧版工具只支持论文（本篇或全部论文），无法包含书籍，属部分生效。
• paperContext：paperSearch 命中片段不足以回答时，按 chunk_id 扩展该片段在同一论文内的前后文。
• 检索策略：英文论文用英文术语检索（中文提问先把核心概念译成英文，拿不准就中英各检一次）；多概念问题拆 2-3 个不同措辞的子查询分次检索；命中不足 → paperContext 扩前后文 → 仍不足换措辞/换范围再检；检索无据就明说，不要凭印象编造。
• 分工：当前论文的内容问题优先基础层读原文；检索层只用于跨论文的主题对比与文献调研。`;

const PAPER_POLICY_NO_VECTOR = `—— 文献库检索（当前不可用） ——
未配置嵌入模型，跨论文语义检索不可用。如用户需要跨论文检索，提示其在设置中配置嵌入模型并向量化论文。`;

/**
 * 用户划定的检索范围（论文助手）：写在政策层，模型检索/直读前先看圈。
 * 旧工具集只能表达论文范围（本篇/全部论文），必须明确说"书籍部分不生效"。
 */
function buildPaperScopePolicy(
  scope: RetrievalScope,
  docMode: "new" | "legacy" | "both",
  currentPaperId?: string,
): string {
  const label = RETRIEVAL_SCOPE_LABELS.paper[scope];
  const currentRef = currentPaperId ? `paper:${currentPaperId}` : "（未绑定当前论文）";
  if (docMode === "legacy") {
    return `—— 检索范围（旧版工具模式） ——
旧版工具模式不显示范围下拉（此前保存的选择只部分生效）：paperSearch 只能是「本篇」（paperIds=[当前论文]）或「全部论文」（不含书籍）；readDocument / getCitationGraph 等新原语不可用，${currentRef} 之外的直读也做不到。需要真正的「论文库+图书馆」范围时，请让用户切到新原语模式（设置 → Agent）或到全局助手处理；不要声称检索过书籍。`;
  }
  const allowed =
    scope === "current"
      ? `只能检索/读取当前这篇论文（${currentRef}）；其它论文与书籍都在圈外。searchLibrary（若已配置嵌入模型）只在本篇内检索；readDocument/getDocumentInfo 传圈外 doc 会被拒绝；getFigures/getCitations 也只读本篇。getCitationGraph 需要扫描论文库其它论文，在当前范围会要求用户切换范围。`
      : scope === "library"
        ? "可检索/读取论文库全部论文（不含书籍）。searchLibrary（若已配置嵌入模型）搜全部论文；readDocument/getDocumentInfo/getCitationGraph 可跨论文；book:<id> 在圈外，越界会被拒绝。"
        : "可检索/读取论文库全部论文 + 图书馆全部书籍（跨库结果 RRF 融合）。searchLibrary（若已配置嵌入模型）跨库检索；readDocument/getDocumentInfo/getCitationGraph 可读论文，readDocument/getDocumentInfo 也可读书；圈外/库外文件仍在界外。";
  return `—— 检索范围（用户划定，本轮以此为准） ——
用户当前选择：${label}（retrievalScope=${scope}）。
• ${allowed}
• 工具参数只能在圈内收窄，不能扩大：searchLibrary 的 scope/doc 与 readDocument/getDocumentInfo/getCitationGraph 的 doc 越界会被明确拒绝，不要换关键词、换工具或绕路径重试。
• 用户的问题若需要更广范围（其它论文/书籍），不要自行越界；直接说明需要切换范围，并请用户使用侧栏顶部的范围下拉（本篇 / 论文库 / 论文库+图书馆）。
• 全局助手不受此限制；本助手只按用户圈定的范围工作。`;
}

/**
 * 构建论文助手的完整系统提示词：风格层（预设 ?? 内置默认风格）+ 通用规范
 * + 系统策略（检索层按向量能力分两档）+ 技能清单 + 论文元数据（静态部分）。
 * 每轮可能变化的【当前阅读位置】由 transport 的动态状态段统一注入到最尾部
 * （D3 静态优先布局；位置来自活注册表 services/reading-position，论文正文不再注入）。
 */
export async function buildPaperPrompt(chatContext: ChatContext | undefined): Promise<string> {
  const paperId = chatContext?.activeBookId;

  const hasVectorCapability = useLlamaStore.getState().hasVectorCapability();

  // 风格层：有激活预设时用预设，否则用代码内置的默认风格（随版本更新，送达有保证）；
  // 系统策略段（含检索能力的运行时事实）不受预设影响，照常拼接。
  const presetContent = await getActivePresetContent("paper");
  const style = presetContent && presetContent.trim().length > 0 ? presetContent : DEFAULT_PAPER_STYLE;

  const docMode = getDocumentToolMode();
  const basePolicy = docMode === "new" ? PAPER_POLICY_BASE_NEW : PAPER_POLICY_BASE;
  const retrievalPolicy =
    docMode === "new"
      ? hasVectorCapability
        ? PAPER_POLICY_VECTOR_NEW
        : PAPER_POLICY_NO_VECTOR_NEW
      : hasVectorCapability
        ? PAPER_POLICY_VECTOR
        : PAPER_POLICY_NO_VECTOR;
  const scopePolicy = buildPaperScopePolicy(chatContext?.retrievalScope ?? "current", docMode, paperId);
  let prompt = `${style}\n\n${SHARED_HOUSE_RULES}\n\n${basePolicy}\n\n${retrievalPolicy}\n\n${scopePolicy}`;

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
