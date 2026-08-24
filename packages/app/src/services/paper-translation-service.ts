/**
 * 论文翻译服务（块级平行译本）。
 *
 * 产物：{appDataDir}/books/{paperId}/translation-zh.json
 *   {version:1, lang:"zh", updatedAt, blocks: {"<blockIndex>": {hash, text}, "fn:<脚注id>": {hash, text}}}
 * hash = 块源文本 sha256 前 16 hex；翻译只增不改——hash 匹配的块跳过重翻（幂等/断点续翻）。
 * 脚注定义（[^id]: …）不占块序号，以 fn:<id> 独立键入译本（同一幂等 hash 语义）。
 * 分批调用辅助模型（参照 ai-context-service.ts 的 utility model 调用），每批落盘一次，崩溃/取消可续。
 * 元数据（title/abstract）顺带翻译，读改写 metadata.json 的 title_zh/abstract_zh（不动其他字段）。
 */

import {
  type createModelInstance,
  createUtilityModelInstance,
  getUtilityModel,
  utilityTaskProviderOptions,
} from "@/ai/providers/factory";
import { cutPaperBlocks, extractPaperFootnotes } from "@/pages/paper-reader/paper-blocks";
import type { PaperAlignPair } from "@/pages/paper-reader/paper-cross-anchor";
import { parsePaperMarkdown } from "@/pages/paper-reader/paper-metadata";
import { invoke } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";
import { exists, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { generateText } from "ai";

export const PAPER_TRANSLATION_LANG = "zh";
const TRANSLATION_FILE = `translation-${PAPER_TRANSLATION_LANG}.json`;

export interface PaperTranslationBlock {
  /** 块源文本 sha256 前 16 hex */
  hash: string;
  text: string;
  /** T2 句级对齐表（译文 text 内偏移 ↔ 块源文本 textContent 内偏移，格式见 paper-cross-anchor.ts） */
  align?: PaperAlignPair[];
  /** 计算 align 时译文 text 的 sha256 前 16 hex（幂等键：译文未变则对齐不重算） */
  alignHash?: string;
  /** T3 词级对齐表（坐标系同 align，粒度细到词/字；在句对内部逐对计算） */
  alignW?: PaperAlignPair[];
  /** 计算 alignW 时译文 text 的 sha256 前 16 hex（幂等键与句对齐一致） */
  alignWHash?: string;
}

/** 对齐状态：done=全部有译文的块均已对齐；partial=部分失败/中断；skipped=无嵌入能力跳过 */
export type PaperAlignStatus = "done" | "skipped" | "partial";

export interface PaperTranslationFile {
  version: 1;
  lang: string;
  updatedAt: string;
  /** 版本锚：翻译时 paper.md 内容的 sha256 前 16 hex（与 Rust 侧 sourceHash 同口径）。
   * 重解析后 paper.md 变更 → 锚不一致 → 渲染侧按未翻译处理（不显示旧译文） */
  sourceHash?: string;
  /** T2 句对齐状态（缺省 = 尚未计算对齐） */
  alignStatus?: PaperAlignStatus;
  /** T3 词对齐状态（缺省 = 尚未计算词对齐） */
  alignWStatus?: PaperAlignStatus;
  /** 动态术语表（翻译首轮抽取并注入后续批次；随译本同生命周期，force 重翻时重新抽取） */
  glossary?: PaperGlossaryItem[];
  blocks: Record<string, PaperTranslationBlock>;
}

export interface PaperTranslatedMeta {
  title_zh?: string;
  abstract_zh?: string;
}

/** 动态术语表条目：src 为原文逐字术语，tgt 为规范中文译法（后续批次强制一致） */
export interface PaperGlossaryItem {
  src: string;
  tgt: string;
}

export interface TranslateProgress {
  /** 已就绪（含跳过的）可翻译块数 */
  done: number;
  /** 可翻译块总数 */
  total: number;
}

export interface TranslateResult {
  /** 本批可翻译块总数 */
  total: number;
  /** hash 匹配跳过的块数（幂等/续翻） */
  skipped: number;
  /** 本次新翻译的块数 */
  translated: number;
  /** 重试后仍失败被跳过的批次数（这些块未落盘，续翻可补齐） */
  failedBatches: number;
  /** 是否被中途取消（已翻译部分已落盘） */
  cancelled: boolean;
}

const BATCH_MAX_BLOCKS = 12;
const BATCH_MAX_CHARS = 6000;

/** 块源文本 sha256 前 16 hex（幂等键） */
export async function hashBlockText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

async function paperDirOf(paperId: string): Promise<string> {
  const base = await appDataDir();
  return join(base, "books", paperId);
}

/** 读取平行译本；不存在/损坏返回 null */
export async function loadPaperTranslation(paperId: string): Promise<PaperTranslationFile | null> {
  try {
    const dir = await paperDirOf(paperId);
    const path = await join(dir, TRANSLATION_FILE);
    if (!(await exists(path))) return null;
    const parsed = JSON.parse(await readTextFile(path)) as PaperTranslationFile;
    if (parsed?.version !== 1 || typeof parsed.blocks !== "object" || !parsed.blocks) return null;
    return parsed;
  } catch (error) {
    console.warn("读取论文译本失败:", error);
    return null;
  }
}

/** 写回平行译本（翻译逐批落盘 / T2 对齐结果写回共用） */
export async function savePaperTranslation(paperId: string, file: PaperTranslationFile): Promise<void> {
  const dir = await paperDirOf(paperId);
  await writeTextFile(await join(dir, TRANSLATION_FILE), JSON.stringify(file, null, 2));
}

/** 读取 metadata.json 的 title_zh/abstract_zh（无则 null） */
export async function loadPaperTranslatedMeta(paperId: string): Promise<PaperTranslatedMeta | null> {
  try {
    const dir = await paperDirOf(paperId);
    const path = await join(dir, "metadata.json");
    if (!(await exists(path))) return null;
    const parsed = JSON.parse(await readTextFile(path)) as Record<string, unknown>;
    const meta: PaperTranslatedMeta = {};
    if (typeof parsed.title_zh === "string" && parsed.title_zh) meta.title_zh = parsed.title_zh;
    if (typeof parsed.abstract_zh === "string" && parsed.abstract_zh) meta.abstract_zh = parsed.abstract_zh;
    return meta.title_zh || meta.abstract_zh ? meta : null;
  } catch (error) {
    console.warn("读取论文元数据译文失败:", error);
    return null;
  }
}

function buildBatchPrompt(
  batch: { index: number; text: string }[],
  strict = false,
  glossary?: PaperGlossaryItem[] | null,
): string {
  const strictNote = strict
    ? "\n\n注意：上一次输出的 JSON 无法解析。本次必须只输出一个严格合法的 JSON 数组（双引号、无尾随逗号、字符串内控制字符已转义），不要任何额外文字。"
    : "";
  const glossaryNote = glossary?.length
    ? `\n\n术语表（以下术语必须严格采用给定译法，全篇保持一致）：\n${glossary.map((g) => `${g.src} → ${g.tgt}`).join("\n")}`
    : "";
  return `你是专业的学术论文翻译引擎。把给定英文论文片段逐条翻译为简体中文。

要求：
1. 学术术语、人名、化学式、符号在全篇保持一致译法；人名不译。
2. $...$ 与 $$...$$ 包裹的数学公式、代码片段、URL、DOI、参考文献条目、[^...] 脚注引用标记原样保留，不得翻译或改动。
3. 保留原文的 Markdown 行内格式（**粗体**、*斜体*、\`代码\`、链接文字可译但保留 [文字](URL) 结构）。
4. ![...](...) 图片引用必须原样保留（路径与定界符不得改动），不得翻译、删除或改写为普通文字。
5. 输入是 JSON 数组 [{"index":N,"text":"..."}]，只输出 JSON 数组 [{"index":N,"text":"译文"}]：index 与输入一一对应、不得遗漏或新增，不要输出任何其他文字或解释。${glossaryNote}${strictNote}

待翻译内容：
${JSON.stringify(batch)}`;
}

/** 脚注批次提示词：与正文批次同规则，键契约改为 fn 字符串（脚注定义不入块序号） */
function buildFootnoteBatchPrompt(
  batch: { fn: string; text: string }[],
  strict = false,
  glossary?: PaperGlossaryItem[] | null,
): string {
  const strictNote = strict
    ? "\n\n注意：上一次输出的 JSON 无法解析。本次必须只输出一个严格合法的 JSON 数组（双引号、无尾随逗号、字符串内控制字符已转义），不要任何额外文字。"
    : "";
  const glossaryNote = glossary?.length
    ? `\n\n术语表（以下术语必须严格采用给定译法，全篇保持一致）：\n${glossary.map((g) => `${g.src} → ${g.tgt}`).join("\n")}`
    : "";
  return `你是专业的学术论文翻译引擎。把给定论文的脚注（页下注）逐条翻译为简体中文。

要求：
1. 学术术语、人名、化学式、符号与正文保持一致译法；人名不译。
2. $...$ 与 $$...$$ 包裹的数学公式、代码片段、URL、DOI 原样保留，不得翻译或改动。
3. 保留原文的 Markdown 行内格式（**粗体**、*斜体*、\`代码\`、链接文字可译但保留 [文字](URL) 结构）。
4. 输入是 JSON 数组 [{"fn":"脚注ID","text":"..."}]，只输出 JSON 数组 [{"fn":"脚注ID","text":"译文"}]：fn 与输入一一对应、不得遗漏或新增，不要输出任何其他文字或解释。${glossaryNote}${strictNote}

待翻译内容：
${JSON.stringify(batch)}`;
}

/** 脚注批次切分（与 makeBatches 同限额；fn 键契约） */
function makeFootnoteBatches(pending: { fn: string; text: string }[]): { fn: string; text: string }[][] {
  const batches: { fn: string; text: string }[][] = [];
  let current: { fn: string; text: string }[] = [];
  let chars = 0;
  for (const item of pending) {
    if (current.length > 0 && (current.length >= BATCH_MAX_BLOCKS || chars + item.text.length > BATCH_MAX_CHARS)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += item.text.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** 术语表抽取的源文本采样上限（标题+摘要+正文前若干块） */
const GLOSSARY_SAMPLE_CHARS = 12000;
const GLOSSARY_MAX_ITEMS = 80;

/**
 * 动态术语表抽取（翻译首轮一次）：从标题/摘要/正文前部采样提取领域术语及规范译法。
 * 失败（模型不可用/输出无法解析）抛出——调用方捕获并按无术语表继续（不阻断翻译）。
 */
async function extractGlossary(
  markdown: string,
  model: ReturnType<typeof createModelInstance>,
  signal?: AbortSignal,
  providerOptions?: Record<string, Record<string, any>>,
): Promise<PaperGlossaryItem[] | null> {
  const { metadata } = parsePaperMarkdown(markdown.replace(/\r\n?/g, "\n"));
  const parts: string[] = [];
  if (metadata.title) parts.push(`标题：${metadata.title}`);
  if (metadata.abstract) parts.push(`摘要：${metadata.abstract}`);
  let chars = 0;
  for (const block of cutPaperBlocks(markdown)) {
    if (!block.translatable) continue;
    if (chars + block.sourceText.length > GLOSSARY_SAMPLE_CHARS) break;
    parts.push(block.sourceText);
    chars += block.sourceText.length;
  }

  const prompt = `你是学术翻译术语专家。从以下论文内容中提取 30~60 个关键术语，并给出规范的简体中文译法。
要求：
1. 只提取领域专有名词、技术术语、材料/方法/体系名称；通用词汇不提取。
2. src 必须是原文中逐字出现的英文术语（含大小写），tgt 为规范中文译法——后续全篇将强制统一使用。
3. 人名、化学式、数学符号、纯缩写不收录。
4. 只输出 JSON 数组 [{"src":"...","tgt":"..."}]，不要输出任何其他文字。

论文内容：
${parts.join("\n\n")}`;

  const { text } = await generateText({ model, prompt, temperature: 0.2, abortSignal: signal, providerOptions });
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "");
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end <= start) throw new Error("术语表响应中未找到 JSON 数组");
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as unknown;
  if (!Array.isArray(parsed)) throw new Error("术语表响应不是 JSON 数组");

  const seen = new Set<string>();
  const items: PaperGlossaryItem[] = [];
  for (const entry of parsed) {
    const record = entry as { src?: unknown; tgt?: unknown };
    const src = typeof record?.src === "string" ? record.src.trim() : "";
    const tgt = typeof record?.tgt === "string" ? record.tgt.trim() : "";
    if (!src || !tgt || seen.has(src.toLowerCase())) continue;
    seen.add(src.toLowerCase());
    items.push({ src, tgt });
    if (items.length >= GLOSSARY_MAX_ITEMS) break;
  }
  return items.length > 0 ? items : null;
}

/** 解析模型输出为 JSON 数组：容忍 ```json 围栏与前后杂讯；LaTeX 反斜杠保守修复；结构非法抛错 */
function parseJsonArrayResponse(raw: string): unknown[] {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "");
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end <= start) throw new Error("模型响应中未找到 JSON 数组");
  const slice = cleaned.slice(start, end + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch {
    // LaTeX 密集批次的高发失败：模型漏双写反斜杠（\vartheta 的 \v 等为非法 JSON 转义）→ 保守修复。
    // 交替顺序保证合法转义（\\ \" \n \uXXXX…）作为整体先被消费、原样保留——只双写落单的反斜杠，
    // 对已合法输出幂等（不能像 /\\(?![…])/ 那样只看单个反斜杠，否则 \\ 的第二个反斜杠会被误判）
    const repaired = slice.replace(/\\(?:[\\/"bfnrtu]|u[0-9a-fA-F]{4})|\\/g, (m) => (m.length > 1 ? m : "\\\\"));
    parsed = JSON.parse(repaired); // 仍失败则抛给上层（严格措辞重试/跳过该批）
  }
  if (!Array.isArray(parsed)) throw new Error("模型响应不是 JSON 数组");
  return parsed;
}

/** 正文块批次响应 → [{index, text}] */
function parseBatchResponse(raw: string): { index: number; text: string }[] {
  return parseJsonArrayResponse(raw).map((item) => {
    const record = item as { index?: unknown; text?: unknown };
    if (typeof record?.index !== "number" || typeof record?.text !== "string" || !record.text.trim()) {
      throw new Error("模型响应条目缺少 index/text");
    }
    return { index: record.index, text: record.text };
  });
}

/** 脚注批次响应 → [{fn, text}]（fn 为字符串键，对应 fn:<id> 独立键） */
function parseFootnoteBatchResponse(raw: string): { fn: string; text: string }[] {
  return parseJsonArrayResponse(raw).map((item) => {
    const record = item as { fn?: unknown; text?: unknown };
    if (typeof record?.fn !== "string" || !record.fn || typeof record?.text !== "string" || !record.text.trim()) {
      throw new Error("模型响应条目缺少 fn/text");
    }
    return { fn: record.fn, text: record.text };
  });
}

/** 把待翻译块切成批次（每批 ≤12 块且 ≤6k 字符） */
function makeBatches(pending: { index: number; text: string }[]): { index: number; text: string }[][] {
  const batches: { index: number; text: string }[][] = [];
  let current: { index: number; text: string }[] = [];
  let chars = 0;
  for (const block of pending) {
    if (current.length > 0 && (current.length >= BATCH_MAX_BLOCKS || chars + block.text.length > BATCH_MAX_CHARS)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(block);
    chars += block.text.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** 元数据翻译：title/abstract 一次附加调用，写 metadata.json 的 title_zh/abstract_zh
 * （写入走 patch_paper_metadata_json 全局锁串行化，与向量锚/Zotero 回链并发互不覆盖） */
async function translateMetadata(
  paperId: string,
  source: { title?: string; abstract?: string },
  model: ReturnType<typeof createModelInstance>,
  force: boolean,
  signal?: AbortSignal,
  glossary?: PaperGlossaryItem[] | null,
  providerOptions?: Record<string, Record<string, any>>,
): Promise<void> {
  const metaPath = await join(await paperDirOf(paperId), "metadata.json");
  if (!(await exists(metaPath))) return;
  let metadata: Record<string, unknown>;
  try {
    metadata = JSON.parse(await readTextFile(metaPath)) as Record<string, unknown>;
  } catch {
    return;
  }
  // 幂等：两个字段都有译文且非强制重翻时跳过
  if (!force && typeof metadata.title_zh === "string" && typeof metadata.abstract_zh === "string") return;
  const needTitle = typeof source.title === "string" && !!source.title;
  const needAbstract = typeof source.abstract === "string" && !!source.abstract;
  if (!needTitle && !needAbstract) return;

  const glossaryNote = glossary?.length
    ? `\n术语表（必须严格采用）：${glossary.map((g) => `${g.src} → ${g.tgt}`).join("；")}`
    : "";
  const prompt = `你是专业的学术论文翻译引擎。把给定论文的标题和摘要翻译为简体中文（术语与正文译法一致，人名不译，$...$ 数学与化学式原样保留）。${glossaryNote}
只输出 JSON 对象 {"title_zh":"...","abstract_zh":"..."}，缺省字段输出空字符串，不要输出任何其他文字。
输入：${JSON.stringify({ title: source.title ?? "", abstract: source.abstract ?? "" })}`;
  const { text } = await generateText({ model, prompt, temperature: 0.2, abortSignal: signal, providerOptions });
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("元数据翻译响应解析失败");
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as { title_zh?: unknown; abstract_zh?: unknown };
  // 只落非空字段；写入走 Rust 侧全局锁（读改写串行化，其他字段不受并发写者覆盖）
  const patch: Record<string, string> = {};
  if (needTitle && typeof parsed.title_zh === "string" && parsed.title_zh.trim()) {
    patch.title_zh = parsed.title_zh.trim();
  }
  if (needAbstract && typeof parsed.abstract_zh === "string" && parsed.abstract_zh.trim()) {
    patch.abstract_zh = parsed.abstract_zh.trim();
  }
  if (Object.keys(patch).length > 0) {
    await invoke("patch_paper_metadata_json", { paperId, patch });
  }
}

/** 翻译运行状态戳记：写 metadata.json 的 translationRunState（"complete"|"partial"），
 *  供列表徽标区分完整/不完整译本（中断、批次失败 → partial）。
 *  重解析换新 metadata.json 后戳记消失，但此时译本必然 stale——徽标走陈旧口径，不依赖戳记 */
async function stampTranslationRunState(paperId: string, state: "complete" | "partial"): Promise<void> {
  try {
    await invoke("patch_paper_metadata_json", { paperId, patch: { translationRunState: state } });
  } catch (error) {
    console.warn("写入翻译状态戳记失败:", error);
  }
}

/**
 * 翻译论文正文块 + 元数据。
 * force=false 时 hash 匹配的块跳过重翻（幂等/断点续翻）；force=true 全部重翻。
 * 每批落盘一次；signal 取消时抛出前，已翻译部分均已持久化。
 * 单批容错：生成/解析失败先以"严格 JSON"措辞重试 1 次，仍失败则跳过该批并计数（failedBatches），
 * 继续后续批次，不再整体中止；被跳过的块不落盘，续翻（force=false）时自动补翻。
 */
export async function translatePaper(options: {
  paperId: string;
  markdown: string;
  force?: boolean;
  onProgress?: (progress: TranslateProgress) => void;
  signal?: AbortSignal;
}): Promise<TranslateResult> {
  const { paperId, markdown, force = false, onProgress, signal } = options;

  const utilityModel = getUtilityModel();
  if (!utilityModel) {
    throw new Error("未配置 AI 模型：请先在设置中配置辅助模型（或聊天模型）后再翻译");
  }
  const model = createUtilityModelInstance(utilityModel.providerId, utilityModel.modelId);
  // 简单任务压思考强度（混合推理模型先想几十秒再输出，是翻译慢的主因之一）
  const taskOptions = utilityTaskProviderOptions(utilityModel.providerId, utilityModel.modelId);

  const dir = await paperDirOf(paperId);
  const blocks = cutPaperBlocks(markdown);
  const translatable = blocks.filter((block) => block.translatable);
  // 版本锚：所译内容的整篇 hash（调用方传入的均为 paper.md 原文，口径同 Rust 侧 paper.md 文件 sha256）
  const sourceHash = await hashBlockText(markdown);

  const existing = force ? null : await loadPaperTranslation(paperId);
  const working: Record<string, PaperTranslationBlock> = { ...(existing?.blocks ?? {}) };

  const hashes = new Map<number, string>();
  for (const block of translatable) {
    hashes.set(block.index, await hashBlockText(block.sourceText));
  }
  const pending = translatable
    .filter((block) => working[String(block.index)]?.hash !== hashes.get(block.index))
    .map((block) => ({ index: block.index, text: block.sourceText }));

  // 脚注（[^id]: 定义）：不占块序号，以 fn:<id> 独立键入译本（与正文块同一幂等 hash 语义）
  const footnotes = extractPaperFootnotes(markdown);
  const fnHashes = new Map<string, string>();
  for (const fn of footnotes) {
    fnHashes.set(fn.id, await hashBlockText(fn.text));
  }
  const pendingFootnotes = footnotes
    .filter((fn) => working[`fn:${fn.id}`]?.hash !== fnHashes.get(fn.id))
    .map((fn) => ({ fn: fn.id, text: fn.text }));

  const total = translatable.length + footnotes.length;
  let done = total - pending.length - pendingFootnotes.length;
  const skipped = done;
  let failedBatches = 0;
  onProgress?.({ done, total });

  // 动态术语表：有待翻块且（无既有术语表或强制重翻）时，首轮先抽取并注入后续所有批次；
  // 抽取失败不阻断翻译（按无术语表继续）；force=false 续翻复用译本中已有术语表
  let glossary = existing?.glossary ?? null;
  if (pending.length > 0 && (!glossary || force)) {
    try {
      const extracted = await extractGlossary(markdown, model, signal, taskOptions);
      if (extracted) glossary = extracted;
    } catch (error) {
      if (signal?.aborted) throw error; // 取消优先
      console.warn("术语表抽取失败，按无术语表继续翻译:", error);
    }
  }

  const save = async () => {
    const file: PaperTranslationFile = {
      version: 1,
      lang: PAPER_TRANSLATION_LANG,
      updatedAt: new Date().toISOString(),
      sourceHash,
      ...(glossary ? { glossary } : {}),
      blocks: working,
    };
    await writeTextFile(await join(dir, TRANSLATION_FILE), JSON.stringify(file, null, 2));
  };

  /** 单批生成+解析；strict=true 时附加"严格 JSON"措辞（重试用） */
  const generateBatch = async (batch: { index: number; text: string }[], strict: boolean) => {
    const { text } = await generateText({
      model,
      prompt: buildBatchPrompt(batch, strict, glossary),
      temperature: 0.2,
      abortSignal: signal,
      providerOptions: taskOptions,
    });
    return parseBatchResponse(text);
  };

  const result = (cancelled: boolean): TranslateResult => ({
    total,
    skipped,
    translated: done - skipped,
    failedBatches,
    cancelled,
  });

  // 3 路并发处理批次（各批写入按块索引互不相交；save 全量快照幂等），墙钟时间约为串行的 1/3
  const TRANSLATE_CONCURRENCY = 3;
  const batches = makeBatches(pending);
  let nextBatch = 0;
  const runWorker = async () => {
    for (;;) {
      if (signal?.aborted) return;
      const batch = batches[nextBatch];
      nextBatch += 1;
      if (!batch) return;
      let translated: { index: number; text: string }[] | null = null;
      try {
        translated = await generateBatch(batch, false);
      } catch (error) {
        if (signal?.aborted) throw error; // 取消优先：保持整体中止语义（调用方按取消处理）
        console.warn("论文翻译批次失败，以严格 JSON 措辞重试一次:", error);
        try {
          translated = await generateBatch(batch, true);
        } catch (retryError) {
          if (signal?.aborted) throw retryError;
          // 重试仍失败：跳过该批并计数，继续后续批次（不整体中止；这些块不落盘，续翻可补）
          console.warn(`论文翻译批次重试仍失败，跳过该批 ${batch.length} 块:`, retryError);
          failedBatches += 1;
        }
      }
      if (translated) {
        const batchIndexes = new Set(batch.map((block) => block.index));
        for (const item of translated) {
          if (!batchIndexes.has(item.index)) continue; // 模型多给的条目直接丢弃
          const hash = hashes.get(item.index);
          if (!hash) continue;
          working[String(item.index)] = { hash, text: item.text.trim() };
          done += 1;
        }
        await save(); // 每批落盘一次，崩溃/取消可续
        onProgress?.({ done, total });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(TRANSLATE_CONCURRENCY, batches.length) }, () => runWorker()));
  if (signal?.aborted) {
    await save();
    await stampTranslationRunState(paperId, "partial");
    return result(true);
  }

  // 脚注批次（fn 键独立契约；量少通常一批，串行即可，与正文同一取消/容错语义）
  for (const batch of makeFootnoteBatches(pendingFootnotes)) {
    if (signal?.aborted) break;
    let translated: { fn: string; text: string }[] | null = null;
    try {
      const { text } = await generateText({
        model,
        prompt: buildFootnoteBatchPrompt(batch, false, glossary),
        temperature: 0.2,
        abortSignal: signal,
        providerOptions: taskOptions,
      });
      translated = parseFootnoteBatchResponse(text);
    } catch (error) {
      if (signal?.aborted) throw error; // 取消优先
      console.warn("论文脚注翻译批次失败，以严格 JSON 措辞重试一次:", error);
      try {
        const { text } = await generateText({
          model,
          prompt: buildFootnoteBatchPrompt(batch, true, glossary),
          temperature: 0.2,
          abortSignal: signal,
          providerOptions: taskOptions,
        });
        translated = parseFootnoteBatchResponse(text);
      } catch (retryError) {
        if (signal?.aborted) throw retryError;
        console.warn(`论文脚注翻译批次重试仍失败，跳过该批 ${batch.length} 条:`, retryError);
        failedBatches += 1;
      }
    }
    if (translated) {
      const batchKeys = new Set(batch.map((item) => item.fn));
      for (const item of translated) {
        if (!batchKeys.has(item.fn)) continue; // 模型多给的条目直接丢弃
        const hash = fnHashes.get(item.fn);
        if (!hash) continue;
        working[`fn:${item.fn}`] = { hash, text: item.text.trim() };
        done += 1;
      }
      await save(); // 每批落盘一次，崩溃/取消可续
      onProgress?.({ done, total });
    }
  }
  if (signal?.aborted) {
    await save();
    await stampTranslationRunState(paperId, "partial");
    return result(true);
  }

  // 元数据（title/abstract）顺带翻译；失败不影响正文译本
  const { metadata } = parsePaperMarkdown(markdown.replace(/\r\n?/g, "\n"));
  try {
    await translateMetadata(
      paperId,
      { title: metadata.title, abstract: metadata.abstract },
      model,
      force,
      signal,
      glossary,
      taskOptions,
    );
  } catch (error) {
    if (signal?.aborted) {
      await stampTranslationRunState(paperId, "partial");
      return result(true);
    }
    console.warn("论文元数据翻译失败（正文译本不受影响）:", error);
  }

  await stampTranslationRunState(paperId, failedBatches > 0 ? "partial" : "complete");
  return result(false);
}
