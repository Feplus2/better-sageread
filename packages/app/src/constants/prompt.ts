import { buildCentralPrompt } from "@/constants/central-prompt";
import { buildPaperPrompt } from "@/constants/paper-prompt";
import type { ChatContext } from "@/hooks/use-chat-state";
import { getActivePresetContent } from "@/services/prompt-preset-service";
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

export async function buildReadingPrompt(chatContext: ChatContext | undefined): Promise<string> {
  const activeBookId = chatContext?.activeBookId;
  let systemPromptBase = "";
  let activeSkillNames: string[] = [];
  try {
    const allSkills = await getSkills();
    const systemPromptSkill = allSkills.find((skill) => skill.isSystem && skill.isActive);
    systemPromptBase = systemPromptSkill?.content || "";
    activeSkillNames = allSkills
      .filter((skill) => skill.isActive && !skill.isSystem && skillAppliesTo(skill.scope, "reader"))
      .map((skill) => skill.name);
  } catch (error) {
    console.warn("获取技能列表失败:", error);
  }

  // 提示词预设（B 批）：有激活预设时替换内置默认基词（即 DB 系统技能的内容，不改库），
  // 其余组装照旧——下方 RAG 裁剪只匹配内置基词的固定小节标记，对自定义预设自然不生效（no-op）。
  const presetContent = await getActivePresetContent("reader");
  if (presetContent && presetContent.trim().length > 0) {
    systemPromptBase = presetContent;
  }

  const hasVectorCapability = useLlamaStore.getState().hasVectorCapability();

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

  let base = systemPromptBase;

  if (hasVectorCapability === false) {
    base = base.replace(/—— RAG 工具使用策略 ——[\s\S]*?—— 引用标注规范 ——/m, "");
    base = base.replace(/—— 引用标注规范 ——[\s\S]*?—— 图片输出规范 ——/m, "");
    base = base.replace(/—— 图片输出规范 ——[\s\S]*?—— 书籍与笔记管理工具 ——/m, "—— 书籍与笔记管理工具 ——");
    // P3 兜底：无向量能力时注入原文直读通道说明（readBookSection 对 reader 常驻注册）
    base +=
      "\n\n—— 章节原文直读（当前书未建立索引） ——\n当前书籍未建立向量索引，RAG 检索不可用。回答书中内容问题前，用 readBookSection 按目录章节标题读取小节原文（目录见【当前阅读图书元信息与目录】，标题支持模糊匹配）；未读到原文前不得凭印象编造书中内容。元数据问题（书名/作者/目录）直接回答，不调用工具。";
  } else {
    // 有向量能力 ≠ 本书已建索引：补充直读兜底的使用时机（工具常驻注册）
    base +=
      "\n\n—— 补充工具：章节原文直读 ——\nreadBookSection：按目录章节标题直读小节原文。RAG 检索命中为空时（通常是本书未建索引），立即改用它读取原文再作答，不要凭印象编造。";
  }

  // 笔记面板（manageNotes 对 reader 常驻注册；静态追加说明，不动 DB 基词/预设）
  base +=
    "\n\n—— 笔记面板 ——\nmanageNotes：当前书的笔记面板管理（list 列出 / read 读取 / create 新建 / update 修改 / toggleStar 星标 / export 导出单篇 Markdown）。笔记是长文 Markdown 产出（章节总结/读书灵感/人话版解读），与划线标注（notes 工具查询的是后者）是两套概念，不要混写。讨论产出值得留存时，先把整理稿展示给用户讨论，再用 create/update 落笔（会自动弹确认卡由用户过目）；可按当前章节名填 locationTag。";

  // 对话召回（readThread 条件注册：仅当前有进行中的对话线程时注入，新对话首条消息时不可用；
  // 静态追加说明，不动 DB 基词/预设）
  base +=
    "\n\n—— 对话召回 ——\nreadThread：读回本对话的完整问答记录（仅用户提问与 AI 回答，不含工具过程）。对话被上下文压缩截断后，整理本次对话为笔记或回顾早期内容前，先用它读回全量，不要只凭残存上下文。仅在有进行中的对话时可用（新对话首条消息时尚未注入）。";

  // 公式格式（静态追加）：渲染管线吃 $…$ / $$…$$，模型用 \(…\) 会源码外泄（实测 deepseek 解释公式时如此）
  base +=
    "\n\n—— 公式格式 ——\n输出数学公式时，行内用 $…$ 包裹，块级用 $$…$$ 包裹（围栏各自独占一行，多行方程组如 \\begin{cases} 也一样）；不要用 \\(…\\) 或 \\[…\\] 定界符。";

  let prompt = base;

  if (activeSkillNames && activeSkillNames.length > 0) {
    prompt += "\n\n—— 可用技能库 ——\n";
    prompt += "当前系统已配置以下技能，当用户需求匹配时，请先调用 getSkills 工具获取详细执行步骤：\n";
    prompt += activeSkillNames.map((name) => `• ${name}`).join("\n");
  }

  // 静态优先布局（D3）：稳定的元信息与目录段在 system prompt 内殿后；
  // 每轮可能变化的【当前阅读章节】由 transport 移到全部注入段的最尾部（缓存友好）。
  // D2 保守档：目录按当前章裁剪（一级平铺 + 当前章子树），深层走 ragToc/readBookSection。
  if (metadataMd && metadataMd.trim().length > 0) {
    const tocHint = hasVectorCapability
      ? "（目录已按当前章节裁剪，仅保留一级章节与当前章子树；完整目录用 ragToc 获取，readBookSection 支持标题模糊匹配）"
      : "（目录已按当前章节裁剪，仅保留一级章节与当前章子树；readBookSection 按标题模糊直读原文）";
    const trimmed = trimMetadataForPrompt(metadataMd, chatContext?.activeSectionLabel, tocHint);
    prompt += `\n\n【当前阅读图书元信息与目录】\n${trimmed}`;
  }

  return prompt;
}

/**
 * D2 metadata 保守档（2026-08-21）：整份目录树不再常驻 system prompt——
 * 注入视图 = 元信息 + 一级章节平铺 + 当前章子树（祖先链保留以维持层级可读），
 * 深层目录由 ragToc/readBookSection 按需获取。生成侧（pipeline.rs 的完整 metadata.md）不动，
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
