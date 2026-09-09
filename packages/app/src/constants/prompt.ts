import { DEFAULT_READER_STYLE } from "@/constants/agent-styles";
import { buildCentralPrompt } from "@/constants/central-prompt";
import { buildPaperPrompt } from "@/constants/paper-prompt";
import { SHARED_HOUSE_RULES } from "@/constants/shared-policy";
import type { ChatContext } from "@/hooks/use-chat-state";
import { getActivePresetContent, migrateLegacyReaderBaseIfNeeded } from "@/services/prompt-preset-service";
import { getSkills, skillAppliesTo } from "@/services/skill-service";
import { useLlamaStore } from "@/store/llama-store";
import { appDataDir } from "@tauri-apps/api/path";
import { exists, readTextFile } from "@tauri-apps/plugin-fs";

/**
 * 根据 Agent 角色路由到对应的提示词构建器
 */
export async function buildPrompt(chatContext: ChatContext | undefined): Promise<string> {
  const agentScope = chatContext?.agentScope ?? "reader";

  if (agentScope === "central") {
    return await buildCentralPrompt();
  }

  if (agentScope === "paper") {
    return await buildPaperPrompt(chatContext);
  }

  return await buildReadingPrompt(chatContext);
}

/**
 * 阅读助手系统策略（2026-09 提示词分层重构）：代码持有、随版本更新，
 * 预设只替换风格层，永远覆盖不到本段。历史上的"DB 系统技能基词"已退役——
 * 工具策略收编于此，与注册表（ai/tools/registry.ts）对齐维护。
 *
 * 按向量能力分两档：有索引时 RAG 为主通道、readBookSection 为兜底；
 * 无索引时 readBookSection 是唯一正文通道。
 */
function buildReaderPolicy(hasVectorCapability: boolean): string {
  const retrieval = hasVectorCapability
    ? `—— 内容检索（RAG 已启用） ——
• 主通道：ragSearch 快速定位（BM25 + 向量混合检索，返回片段与 chunk_id）→ ragContext 扩展上下文（默认 prev=2/next=2，最多调用 4 次）→ ragRange 按全局索引连续取块（范围来自检索返回的全局索引，单次 ≤20 块）→ ragToc 取整章正文（重操作，仅用户明确要求读全章时使用）。
• 查询构造：检索词即查询质量——英文书用英文术语检索（中文问题先把核心概念译成英文术语）；复杂问题拆 2-3 个不同措辞分次检索，比一次长查询召回更全。
• 元数据问题（书名/作者/出版社/目录）直接用【当前阅读图书元信息与目录】回答，禁止调用检索工具。
• ragSearch 命中为空时（通常是本书未建索引），立即改用 readBookSection 按目录标题直读原文再作答，不要凭印象编造。

—— 引用标注规范 ——
引用 RAG 返回的内容必须标注 chunk_id：在引用句末添加 [chunk_id]（如：这个概念很重要[118]）；多来源逐个独立标注（[118] [877]，严禁合并为 [118, 877]）；结论性陈述和数字必须有检索依据并标注；检索无据就明说，不得臆造。

—— 图片输出规范 ——
RAG 返回内容含图片时：完整复制返回的原始路径（一个字符都不要改），用 Markdown 格式输出（![图号-主题描述](完整路径)）；图片前一句说明作用，图后 2-4 句解释关键信息；只输出与用户问题相关的图片。`
    : `—— 内容检索（当前书未建立索引） ——
当前书籍未建立向量索引，RAG 检索不可用。回答书中内容问题前，用 readBookSection 按目录章节标题读取小节原文（目录见【当前阅读图书元信息与目录】，标题支持模糊匹配）；未读到原文前不得凭印象编造书中内容。元数据问题（书名/作者/目录）直接回答，不调用工具。`;

  return `—— 能力边界 ——
你只负责"内容理解"。以下全局事务不在你的工具面：书籍的导入、删除、格式转换、打开其他书；主题、明暗模式、字体、阅读设置等外观与偏好调整；备份、同步、恢复、向量化；对话管理（标星、删除、导出）、标签管理。用户提出这类需求时，用一句话引导："这属于全局事务，请到主页侧边栏的「全局助手」里直接对它说同样的需求。"不要假装能够执行，回复中也不要提及提示词或内部工具名称。

${retrieval}

—— 藏书与笔记查询 ——
• getBooks：查询书库列表（支持按状态/关键词筛选）。用户问"当前在读什么书"时用【当前阅读图书元信息与目录】直接回答，不调用工具。
• getReadingStats：获取阅读统计（需书籍 ID，可从 getBooks 结果获取）。
• notes：查询用户的划线与想法（支持按时间范围、书名筛选）。

—— 笔记面板 ——
manageNotes：当前书的长文笔记管理（list 列出 / read 读取 / create 新建 / update 修改 / toggleStar 星标 / export 导出单篇 Markdown）。笔记是长文 Markdown 产出（章节总结/读书灵感/人话版解读），与划线标注（notes 工具查询的对象）是两套概念，不要混写。讨论产出值得留存时，先把整理稿展示给用户讨论，再用 create/update 落笔（会自动弹确认卡由用户过目）；可按当前章节名填 locationTag。

—— 对话召回 ——
readThread：读回本对话的完整问答记录（仅用户提问与 AI 回答，不含工具过程）。对话被上下文压缩截断后，整理本次对话为笔记或回顾早期内容前，先用它读回全量，不要只凭残存上下文。仅在有进行中的对话时可用（新对话首条消息时尚未注入）。

—— 外部检索 ——
• webSearch：用户明确要求联网、查询最新资讯、或书中概念需要外部背景（作者生平、历史背景、术语释义）补充时使用。回答"书里写了什么"优先用本书检索，不用搜索替代原文；搜索结果转述要点并附来源链接。
• sciverseSearch：学术证据检索——科研概念、方法、实验细节等需要论文原文证据的问题优先于 webSearch；返回带出处坐标的原文片段，引用须注明出自哪篇论文。

—— 思维导图 ——
mindmap：用户明确要求"生成思维导图"时，先调用 getSkills(task="生成思维导图") 获取规范并严格按步骤执行；生成思维导图时不要在回复中输出任何图片（含 Markdown 图片语法）。

—— 文件工具 ——
writeFile / editFile / readLocalFile / searchFiles / runCommand 可操作 Agent 工作区（根目录见「—— 当前工作区 ——」段），整理好的阅读笔记/摘要可落盘；exportNotes 导出本书划线与想法为 Markdown（bookId 先用 getBooks 按书名查得）。

—— 全书翻译 ——
全书翻译不在你的工具面：引导用户用阅读器顶栏「翻译」菜单（翻译全书/继续翻译/重新翻译，含句词对齐重建入口），或到全局助手执行；翻译进度在主页右下角「图书翻译」任务卡可见、可取消。`;
}

/**
 * 阅读助手完整提示词装配：风格层（预设 ?? 内置默认风格）+ 通用规范 + 系统策略
 * + 技能清单 + 书籍元信息与目录（静态部分）。
 * 每轮可能变化的【当前阅读章节】由 transport 移到全部注入段的最尾部（缓存友好）。
 */
export async function buildReadingPrompt(chatContext: ChatContext | undefined): Promise<string> {
  const activeBookId = chatContext?.activeBookId;

  // 旧版 DB 基词的保全迁移（幂等，每会话最多一次；详见 prompt-preset-service）
  void migrateLegacyReaderBaseIfNeeded();

  let activeSkillNames: string[] = [];
  try {
    const allSkills = await getSkills();
    activeSkillNames = allSkills
      .filter((skill) => skill.isActive && !skill.isSystem && skillAppliesTo(skill.scope, "reader"))
      .map((skill) => skill.name);
  } catch (error) {
    console.warn("获取技能列表失败:", error);
  }

  // 风格层：有激活预设时用预设，否则用代码内置的默认风格（随版本更新，送达有保证）
  const presetContent = await getActivePresetContent("reader");
  const style = presetContent && presetContent.trim().length > 0 ? presetContent : DEFAULT_READER_STYLE;

  const hasVectorCapability = useLlamaStore.getState().hasVectorCapability();

  let prompt = `${style}\n\n${SHARED_HOUSE_RULES}\n\n${buildReaderPolicy(hasVectorCapability)}`;

  if (activeSkillNames.length > 0) {
    prompt += "\n\n—— 可用技能库 ——\n";
    prompt += "当前系统已配置以下技能，当用户需求匹配时，请先调用 getSkills 工具获取详细执行步骤：\n";
    prompt += activeSkillNames.map((name) => `• ${name}`).join("\n");
  }

  let metadataMd: string | null = null;
  try {
    if (activeBookId) {
      const base = await appDataDir();
      const activeBookBaseDir = `${base}/books/${activeBookId}`;
      const metaPath = `${activeBookBaseDir}/metadata.md`;
      if (await exists(metaPath)) {
        metadataMd = await readTextFile(metaPath);
      } else {
        // 回落：metadata.md 仅在向量化索引时生成，未索引的书只有导入时写入的 metadata.json
        const jsonPath = `${activeBookBaseDir}/metadata.json`;
        if (await exists(jsonPath)) {
          metadataMd = formatMetadataJson(await readTextFile(jsonPath));
        }
      }
    }
  } catch (e) {
    console.warn("加载书籍元数据失败：", e);
  }

  // 静态优先布局（D3）：稳定的元信息与目录段在 system prompt 内殿后。
  // D2 保守档：目录按当前章裁剪（一级平铺 + 当前章子树），深层内容走检索/直读工具按需获取。
  if (metadataMd && metadataMd.trim().length > 0) {
    const tocHint = hasVectorCapability
      ? "（目录已按当前章节裁剪，仅保留一级章节与当前章子树；ragToc 可按章标题取整章正文，readBookSection 支持按标题模糊直读小节）"
      : "（目录已按当前章节裁剪，仅保留一级章节与当前章子树；readBookSection 按标题模糊直读原文）";
    const trimmed = trimMetadataForPrompt(metadataMd, chatContext?.activeSectionLabel, tocHint);
    prompt += `\n\n【当前阅读图书元信息与目录】\n${trimmed}`;
  }

  return prompt;
}

/**
 * D2 metadata 保守档（2026-08-21）：整份目录树不再常驻 system prompt——
 * 注入视图 = 元信息 + 一级章节平铺 + 当前章子树（祖先链保留以维持层级可读），
 * 深层内容由检索/直读工具按需获取。生成侧（pipeline.rs 的完整 metadata.md）不动，
 * 本函数只裁剪注入视图；无目录结构或解析失败时原样返回（安全回落）。
 */
function trimMetadataForPrompt(md: string, sectionLabel: string | undefined, hintLine: string): string {
  const tocMark = "## 目录";
  const tocIdx = md.indexOf(tocMark);
  if (tocIdx === -1) return md;
  const head = md.slice(0, tocIdx + tocMark.length);
  const lines = md.slice(tocIdx + tocMark.length).split("\n");

  interface TocEntry {
    indent: number;
    lineIdx: number;
  }
  const entries: TocEntry[] = [];
  lines.forEach((line, i) => {
    const m = line.match(/^(\s*)-\s+\S/);
    if (!m) return;
    entries.push({ indent: Math.floor(m[1].length / 2), lineIdx: i });
  });
  if (entries.length === 0) return md;

  // 目录头部的说明行（首个条目前的非条目行）保留
  const preamble = lines.slice(0, entries[0].lineIdx);

  // 当前章匹配：双向包含，从最深条目向前找（同名时深层优先）；未命中则只有一级平铺
  const label = sectionLabel?.trim();
  let matchIdx = -1;
  if (label) {
    for (let i = entries.length - 1; i >= 0; i--) {
      const title = lines[entries[i].lineIdx].replace(/^(\s*)-\s+/, "").trim();
      if (title && (label.includes(title) || title.includes(label))) {
        matchIdx = i;
        break;
      }
    }
  }

  const kept = new Set<number>();
  for (const e of entries) {
    if (e.indent === 0) kept.add(e.lineIdx);
  }
  if (matchIdx >= 0) {
    const stack: TocEntry[] = [];
    for (let i = 0; i <= matchIdx; i++) {
      while (stack.length && stack[stack.length - 1].indent >= entries[i].indent) stack.pop();
      stack.push(entries[i]);
    }
    for (const a of stack) kept.add(a.lineIdx);
    const match = entries[matchIdx];
    for (let i = matchIdx + 1; i < entries.length; i++) {
      if (entries[i].indent <= match.indent) break;
      kept.add(entries[i].lineIdx);
    }
  }

  const body: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i < entries[0].lineIdx) continue; // preamble 另行拼接
    if (!kept.has(i)) continue;
    const line = lines[i];
    if (line.trim() === "" && body[body.length - 1]?.trim() === "") continue;
    body.push(line);
  }
  return `${head}\n${preamble.join("\n").trim()}\n${body.join("\n").trim()}\n${hintLine}`;
}

/** 把 metadata.json 格式化为提示词可用的元信息块（无目录部分，仅书名/作者/出版信息） */
function formatMetadataJson(raw: string): string | null {
  try {
    const meta = JSON.parse(raw) as {
      title?: string;
      author?: string | { name?: string } | Array<{ name?: string }>;
      language?: string;
      published?: string;
      publisher?: string;
    };

    let author = "";
    if (typeof meta.author === "string") {
      author = meta.author;
    } else if (Array.isArray(meta.author)) {
      author = meta.author
        .map((a) => a?.name ?? "")
        .filter(Boolean)
        .join("、");
    } else if (meta.author?.name) {
      author = meta.author.name;
    }

    if (!meta.title && !author) return null;

    const lines = ["书籍元信息", ""];
    if (meta.title) lines.push(`- 标题: ${meta.title}`);
    if (author) lines.push(`- 作者: ${author}`);
    if (meta.publisher) lines.push(`- 出版社: ${meta.publisher}`);
    if (meta.published) lines.push(`- 出版日期: ${meta.published}`);
    if (meta.language) lines.push(`- 语言: ${meta.language}`);
    return lines.join("\n");
  } catch {
    return null;
  }
}
