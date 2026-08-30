/**
 * 书籍翻译服务（全书平行译本，docs/book-translation-plan.md）。
 *
 * 产物：{appDataDir}/books/{bookId}/translation/{spineIndex}.json（按章分文件 sidecar，
 * 原 EPUB 永远只读）。结构平移论文侧 translation-zh.json：
 *   {version:1, lang:"zh", updatedAt, sourceHash(章锚), alignStatus, glossary, blocks}
 *   blocks 键 = 章内段序号（section-blocks.ts 的枚举契约），块 = {hash, text, align?, alignW?}。
 *
 * 与论文侧的关键差异：
 * - 按章分文件——书籍 10~20 倍体量，控 save 全量快照的写放大，断点粒度天然按章；
 * - 术语表跨章采样抽取一次，写入每章文件（续翻从任一章读回，不重抽）；
 * - 定位不依赖 markdown 块序号契约，枚举走 section-blocks.ts（transformer 与本服务共用）；
 * - 守卫：仅 EPUB、fixed-layout（rendition.layout=pre-paginated）排除、中文书拒翻（防中文翻中文）。
 *
 * 断点续翻语义与论文侧对齐（验收基线）：每批落盘一次；signal 取消时抛出前已翻部分均已
 * 持久化；hash 匹配的段跳过重翻；单批失败以严格 JSON 措辞重试 1 次，仍失败跳过计数不整体中止。
 */

import {
  type createModelInstance,
  createUtilityModelInstance,
  getUtilityModel,
  utilityTaskProviderOptions,
} from "@/ai/providers/factory";
import { DocumentLoader } from "@/lib/document";
import type { BookDoc } from "@/lib/document";
import type { PaperAlignPair } from "@/pages/paper-reader/paper-cross-anchor";
import { recordAuxUsage } from "@/services/ai-usage-service";
import { getBookById } from "@/services/book-service";
import { type PaperGlossaryItem, hashBlockText } from "@/services/paper-translation-service";
import type { SimpleBook } from "@/types/simple-book";
import { convertFileSrc } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";
import { exists, mkdir, readDir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { generateText } from "ai";
import { enumerateSectionBlocks, wrapSectionDocument } from "./section-blocks";

export const BOOK_TRANSLATION_LANG = "zh";
const TRANSLATION_DIR = "translation";

export interface BookTranslationBlock {
  /** 段源文本 sha256 前 16 hex（幂等键：对原文计，注入侧不校验） */
  hash: string;
  text: string;
  /** T2 句级对齐表（坐标系同论文侧 PaperAlignPair，段文本内字符偏移） */
  align?: PaperAlignPair[];
  /** 计算 align 时译文 text 的 sha256 前 16 hex（幂等键） */
  alignHash?: string;
  /** T3 词级对齐表（一期不自动计算，结构先留） */
  alignW?: PaperAlignPair[];
  /** 计算 alignW 时译文 text 的幂等键 */
  alignWHash?: string;
}

export type BookAlignStatus = "done" | "skipped" | "partial";

export interface BookTranslationSectionFile {
  version: 1;
  lang: string;
  updatedAt: string;
  /** 章锚：翻译时该章全部段源文本拼接的 sha256 前 16 hex；重导入换书后按未翻译处理 */
  sourceHash?: string;
  alignStatus?: BookAlignStatus;
  alignWStatus?: BookAlignStatus;
  /** 全书术语表的章内副本（抽取一次写入每章，续翻从任一章读回） */
  glossary?: PaperGlossaryItem[];
  blocks: Record<string, BookTranslationBlock>;
}

export interface BookTranslateProgress {
  done: number;
  total: number;
}

export interface BookTranslateResult {
  total: number;
  skipped: number;
  translated: number;
  failedBatches: number;
  cancelled: boolean;
}

const BATCH_MAX_BLOCKS = 12;
const BATCH_MAX_CHARS = 6000;
const TRANSLATE_CONCURRENCY = 3;
const GLOSSARY_SAMPLE_CHARS = 12000;
const GLOSSARY_MAX_ITEMS = 80;

// ─── 存储层（按章分文件 sidecar） ───

async function translationDirOf(bookId: string): Promise<string> {
  const base = await appDataDir();
  return join(base, "books", bookId, TRANSLATION_DIR);
}

/** 读取章译本；不存在/损坏返回 null */
export async function loadBookTranslationSection(
  bookId: string,
  spineIndex: number,
): Promise<BookTranslationSectionFile | null> {
  try {
    const path = await join(await translationDirOf(bookId), `${spineIndex}.json`);
    if (!(await exists(path))) return null;
    const parsed = JSON.parse(await readTextFile(path)) as BookTranslationSectionFile;
    if (parsed?.version !== 1 || typeof parsed.blocks !== "object" || !parsed.blocks) return null;
    return parsed;
  } catch (error) {
    console.warn(`读取书籍章译本失败 (section ${spineIndex}):`, error);
    return null;
  }
}

export async function saveBookTranslationSection(
  bookId: string,
  spineIndex: number,
  file: BookTranslationSectionFile,
): Promise<void> {
  const dir = await translationDirOf(bookId);
  if (!(await exists(dir))) await mkdir(dir, { recursive: true });
  await writeTextFile(await join(dir, `${spineIndex}.json`), JSON.stringify(file, null, 2));
}

/** 已有译本的章序号列表（UI 状态汇总 / 对齐遍历用；文件名即 spineIndex） */
export async function listBookTranslationSectionIndexes(bookId: string): Promise<number[]> {
  try {
    const dir = await translationDirOf(bookId);
    if (!(await exists(dir))) return [];
    const entries = await readDir(dir);
    const indexes: number[] = [];
    for (const entry of entries) {
      const match = /^(\d+)\.json$/.exec(entry.name);
      if (match) indexes.push(Number(match[1]));
    }
    return indexes.sort((a, b) => a - b);
  } catch (error) {
    console.warn("列举书籍译本目录失败:", error);
    return [];
  }
}

/** 读取全书既有术语表（从任一存在的章文件读回，抽取幂等） */
async function loadExistingGlossary(bookId: string): Promise<PaperGlossaryItem[] | null> {
  const indexes = await listBookTranslationSectionIndexes(bookId);
  for (const index of indexes) {
    const file = await loadBookTranslationSection(bookId, index);
    if (file?.glossary?.length) return file.glossary;
  }
  return null;
}

// ─── 打开书籍与守卫 ───

/** 打开书的 DOM（翻译/对齐共用）：fetch 原文件 → DocumentLoader（不挂 transform，读到的是纯原文） */
export async function openBookDocument(bookId: string): Promise<{ book: SimpleBook; bookDoc: BookDoc }> {
  const book = await getBookById(bookId);
  if (!book) throw new Error("书籍不存在");
  if (book.format !== "EPUB") throw new Error("仅 EPUB 书籍支持对照翻译");
  const base = await appDataDir();
  const absolutePath = book.filePath.startsWith("/") ? book.filePath : `${base}/${book.filePath}`;
  const response = await fetch(convertFileSrc(absolutePath));
  if (!response.ok) throw new Error(`读取书籍文件失败: ${response.status}`);
  const arrayBuffer = await response.arrayBuffer();
  const filename = book.filePath.split("/").pop() || "book.epub";
  const file = new File([arrayBuffer], filename, { type: "application/epub+zip" });
  const { book: bookDoc } = await new DocumentLoader(file).open();
  if (!bookDoc) throw new Error("书籍解析失败");
  return { book, bookDoc };
}

/**
 * 遍历书各章枚举段文本（spineIndex → 段文本序列）。
 * translateBook 与 alignBookTranslation 共用的定位契约入口——段序号只在此产生。
 */
export async function collectBookSections(bookDoc: BookDoc): Promise<{ spineIndex: number; sourceTexts: string[] }[]> {
  const out: { spineIndex: number; sourceTexts: string[] }[] = [];
  for (const [index, section] of (bookDoc.sections ?? []).entries()) {
    if (section.linear === "no") continue; // 与渲染端一致：非线性章不处理
    let doc: Document | undefined;
    try {
      doc = await section.createDocument?.();
    } catch (error) {
      console.warn(`书籍章节解析失败，跳过 (section ${index}):`, error);
      continue;
    }
    if (!doc) continue;
    const sourceTexts = enumerateSectionBlocks(wrapSectionDocument(doc)).map((block) => block.sourceText);
    if (sourceTexts.length > 0) out.push({ spineIndex: index, sourceTexts });
  }
  return out;
}

/** CJK 字符占比（语言检测：规则优先，不耗模型调用） */
export function chineseRatio(texts: string[]): number {
  let total = 0;
  let cjk = 0;
  for (const text of texts) {
    total += text.length;
    for (const ch of text) {
      const code = ch.codePointAt(0) ?? 0;
      if (
        (code >= 0x4e00 && code <= 0x9fff) ||
        (code >= 0x3400 && code <= 0x4dbf) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0x3040 && code <= 0x30ff) ||
        (code >= 0xac00 && code <= 0xd7af)
      ) {
        cjk += 1;
      }
    }
  }
  return total > 0 ? cjk / total : 0;
}

/**
 * 翻译前置守卫：format / fixed-layout / 中文书。
 * 抛出的 Error 文案直接面向用户（executor 透传 toast）。
 */
export function assertBookTranslatable(book: SimpleBook, bookDoc: BookDoc, sampleTexts: string[]): void {
  if (bookDoc.rendition?.layout === "pre-paginated") {
    throw new Error("固定版式（fixed-layout）书籍不支持对照翻译：插入译文会破坏原始排版");
  }
  const lang = (book.language || "").toLowerCase();
  const docLang = Array.isArray(bookDoc.metadata?.language)
    ? String(bookDoc.metadata.language[0] ?? "")
    : String(bookDoc.metadata?.language ?? "");
  const knownChinese =
    lang.includes("zh") ||
    lang.includes("chi") ||
    lang.includes("中文") ||
    docLang.toLowerCase().includes("zh") ||
    docLang.toLowerCase().includes("chi");
  if (knownChinese || chineseRatio(sampleTexts) > 0.3) {
    throw new Error("检测到中文书籍，无需对照翻译");
  }
}

// ─── 提示词与解析（书侧版：输入是纯文本段落，无 markdown 格式条款） ───

function buildBatchPrompt(
  batch: { index: number; text: string }[],
  strict = false,
  glossary?: PaperGlossaryItem[] | null,
): string {
  const strictNote = strict
    ? "\n\n注意：上一次输出无法解析，或条目与输入不一一对应（合并/遗漏了条目）。本次必须只输出一个严格合法的 JSON 数组（双引号、无尾随逗号、字符串内控制字符已转义），且 index 与输入逐条对应——每一条输入恰好对应一条输出，不得合并相邻条目、不得重新分段。"
    : "";
  const glossaryNote = glossary?.length
    ? `\n\n术语表（以下术语必须严格采用给定译法，全书保持一致）：\n${glossary.map((g) => `${g.src} → ${g.tgt}`).join("\n")}`
    : "";
  return `你是专业的书籍翻译引擎。把给定书籍片段逐条翻译为简体中文。

要求：
1. 术语、人名在全篇保持一致译法；人名不译。
2. 数字、数学表达式、代码片段、URL 原样保留，不得翻译或改动。
3. 译文使用流畅自然的书面简体中文，不添加注释、译名标注或原文。
4. 输入是 JSON 数组 [{"index":N,"text":"..."}]，只输出 JSON 数组 [{"index":N,"text":"译文"}]：index 与输入一一对应、不得遗漏或新增，不要输出任何其他文字或解释。
5. 即使相邻条目在语义上是同一段落的延续（原书跨页断开），也必须逐条独立翻译、按原 index 逐条输出——不得合并条目、不得重新分段、不得调整条目数。${glossaryNote}${strictNote}

待翻译内容：
${JSON.stringify(batch)}`;
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
    // LaTeX 密集批次的高发失败：模型漏双写反斜杠 → 保守双写落单反斜杠（对已合法输出幂等）
    const repaired = slice.replace(/\\(?:[\\/"bfnrtu]|u[0-9a-fA-F]{4})|\\/g, (m) => (m.length > 1 ? m : "\\\\"));
    parsed = JSON.parse(repaired);
  }
  if (!Array.isArray(parsed)) throw new Error("模型响应不是 JSON 数组");
  return parsed;
}

function parseBatchResponse(raw: string): { index: number; text: string }[] {
  return parseJsonArrayResponse(raw).map((item) => {
    const record = item as { index?: unknown; text?: unknown };
    if (typeof record?.index !== "number" || typeof record?.text !== "string" || !record.text.trim()) {
      throw new Error("模型响应条目缺少 index/text");
    }
    return { index: record.index, text: record.text };
  });
}

/**
 * 批响应完整性校验：回显 index 集合必须与输入完全一致。
 * 跨页切断的碎片书（相邻短行本是同一句）模型会"好心"合并翻译——返回条目数少于输入、
 * index 错位回显，逐 index 落库会把 A 段译文写到 B 段头上（实锤案例：Society Must Be
 * Defended 章首目录五行被拼合）。此处整批作废抛错，走严格措辞重试；仍失败跳批不落盘（续翻可补）。
 */
function validateBatchResponse(
  batch: { index: number; text: string }[],
  translated: { index: number; text: string }[],
): { index: number; text: string }[] {
  const expected = new Set(batch.map((block) => block.index));
  const got = new Set(translated.map((item) => item.index));
  const missing = [...expected].filter((index) => !got.has(index));
  const extra = [...got].filter((index) => !expected.has(index));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `模型响应条目与输入不一一对应（缺 ${missing.join(",") || "无"} / 多 ${extra.join(",") || "无"}）——疑似合并了条目`,
    );
  }
  return translated;
}

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

/** 术语表抽取（书侧版）：标题 + 正文跨章顺序采样；失败由调用方按无术语表继续（不阻断） */
async function extractBookGlossary(
  bookTitle: string,
  sampleParts: string[],
  model: ReturnType<typeof createModelInstance>,
  signal?: AbortSignal,
  providerOptions?: Record<string, Record<string, any>>,
  aux?: { providerId: string; modelId: string },
): Promise<PaperGlossaryItem[] | null> {
  const prompt = `你是书籍翻译术语专家。从以下书籍内容中提取 30~60 个关键术语，并给出规范的简体中文译法。
要求：
1. 只提取领域专有名词、技术术语、作品/组织/体系名称；通用词汇不提取。
2. src 必须是原文中逐字出现的术语（含大小写），tgt 为规范中文译法——全书将强制统一使用。
3. 人名、化学式、数学符号、纯缩写不收录。
4. 只输出 JSON 数组 [{"src":"...","tgt":"..."}]，不要输出任何其他文字。

书名：${bookTitle}
书籍内容：
${sampleParts.join("\n\n")}`;

  const { text, usage } = await generateText({ model, prompt, temperature: 0.2, abortSignal: signal, providerOptions });
  if (aux) recordAuxUsage(aux.providerId, aux.modelId, usage, "translate");
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

// ─── 主流程 ───

interface ChapterWork {
  spineIndex: number;
  sourceHash: string;
  hashes: Map<number, string>;
  working: Record<string, BookTranslationBlock>;
  /** 待翻段（章内分批，批内块 index 连续属于同一章） */
  batches: { index: number; text: string }[][];
  /** 每批落盘时构造的章文件骨架（blocks 引用 working，落盘即最新） */
  save: () => Promise<void>;
}

/**
 * 翻译全书。force=false 时 hash 匹配的段跳过（幂等/断点续翻）；force=true 全部重翻。
 * 每批落盘该章文件一次；signal 取消时抛出前已翻部分均已持久化。
 */
export async function translateBook(options: {
  bookId: string;
  force?: boolean;
  onProgress?: (progress: BookTranslateProgress) => void;
  signal?: AbortSignal;
}): Promise<BookTranslateResult> {
  const { bookId, force = false, onProgress, signal } = options;

  const utilityModel = getUtilityModel();
  if (!utilityModel) {
    throw new Error("未配置 AI 模型：请先在设置中配置辅助模型（或聊天模型）后再翻译");
  }
  const model = createUtilityModelInstance(utilityModel.providerId, utilityModel.modelId);
  const taskOptions = utilityTaskProviderOptions(utilityModel.providerId, utilityModel.modelId);
  const aux = { providerId: utilityModel.providerId, modelId: utilityModel.modelId };

  const { book, bookDoc } = await openBookDocument(bookId);
  const sectionTexts = await collectBookSections(bookDoc);

  // 守卫采样：前 3 章累计至 2000 字（防单章中文版权页误杀英文书；超短书用全量）
  const guardSample: string[] = [];
  let guardChars = 0;
  for (const sec of sectionTexts) {
    if (guardChars >= 2000 || guardSample.length >= 60) break;
    for (const text of sec.sourceTexts) {
      guardSample.push(text);
      guardChars += text.length;
      if (guardChars >= 2000) break;
    }
  }
  assertBookTranslatable(book, bookDoc, guardSample);

  // 术语表采样：全书顺序累计（跨章保证术语覆盖中后段章节）
  const glossarySample: string[] = [];
  let glossaryChars = 0;
  for (const sec of sectionTexts) {
    for (const text of sec.sourceTexts) {
      if (glossaryChars >= GLOSSARY_SAMPLE_CHARS) break;
      glossarySample.push(text);
      glossaryChars += text.length;
    }
    if (glossaryChars >= GLOSSARY_SAMPLE_CHARS) break;
  }

  // 逐章组织待翻：hash 幂等对比既有章文件
  const chapters: ChapterWork[] = [];
  for (const { spineIndex, sourceTexts } of sectionTexts) {
    const hashes = new Map<number, string>();
    for (const [i, text] of sourceTexts.entries()) hashes.set(i, await hashBlockText(text));
    const existing = force ? null : await loadBookTranslationSection(bookId, spineIndex);
    const working: Record<string, BookTranslationBlock> = { ...(existing?.blocks ?? {}) };
    const pending = sourceTexts
      .map((text, i) => ({ index: i, text }))
      .filter((block) => working[String(block.index)]?.hash !== hashes.get(block.index));
    chapters.push({
      spineIndex,
      sourceHash: await hashBlockText(sourceTexts.join("\n")),
      hashes,
      working,
      batches: makeBatches(pending),
      save: async () => {
        /* 占位，glossary 确定后统一补齐 */
      },
    });
  }

  const total = chapters.reduce((sum, ch) => sum + ch.hashes.size, 0);
  const initialReady = chapters.reduce(
    (sum, ch) => sum + (ch.hashes.size - ch.batches.reduce((s, b) => s + b.length, 0)),
    0,
  );
  let done = initialReady;
  const skipped = initialReady;
  let failedBatches = 0;
  onProgress?.({ done, total });

  // 术语表：全书一次（标题+跨章采样）；续翻复用既有表；抽取失败按无术语表继续
  let glossary = force ? null : await loadExistingGlossary(bookId);
  const hasPending = chapters.some((ch) => ch.batches.length > 0);
  if (hasPending && !glossary) {
    try {
      const extracted = await extractBookGlossary(book.title, glossarySample, model, signal, taskOptions, aux);
      if (extracted) glossary = extracted;
    } catch (error) {
      if (signal?.aborted) throw error; // 取消优先
      console.warn("书籍术语表抽取失败，按无术语表继续翻译:", error);
    }
  }

  // 落盘闭包（glossary 确定后补齐每章 save）
  for (const ch of chapters) {
    ch.save = async () => {
      const file: BookTranslationSectionFile = {
        version: 1,
        lang: BOOK_TRANSLATION_LANG,
        updatedAt: new Date().toISOString(),
        sourceHash: ch.sourceHash,
        ...(glossary ? { glossary } : {}),
        blocks: ch.working,
      };
      await saveBookTranslationSection(bookId, ch.spineIndex, file);
    };
  }

  const result = (cancelled: boolean): BookTranslateResult => ({
    total,
    skipped,
    translated: done - skipped,
    failedBatches,
    cancelled,
  });

  // 全书批次摊平，3 路并发 worker（各批写入按段序号互不相交；章文件每批全量快照幂等）
  const jobs = chapters.flatMap((ch) => ch.batches.map((batch) => ({ ch, batch })));
  let nextJob = 0;
  const runWorker = async () => {
    for (;;) {
      if (signal?.aborted) return;
      const job = jobs[nextJob];
      nextJob += 1;
      if (!job) return;
      let translated: { index: number; text: string }[] | null = null;
      try {
        const { text } = await generateText({
          model,
          prompt: buildBatchPrompt(job.batch, false, glossary),
          temperature: 0.2,
          abortSignal: signal,
          providerOptions: taskOptions,
        });
        translated = validateBatchResponse(job.batch, parseBatchResponse(text));
      } catch (error) {
        if (signal?.aborted) throw error; // 取消优先：保持整体中止语义（调用方按取消处理）
        console.warn("书籍翻译批次失败，以严格 JSON 措辞重试一次:", error);
        try {
          const { text } = await generateText({
            model,
            prompt: buildBatchPrompt(job.batch, true, glossary),
            temperature: 0.2,
            abortSignal: signal,
            providerOptions: taskOptions,
          });
          translated = validateBatchResponse(job.batch, parseBatchResponse(text));
        } catch (retryError) {
          if (signal?.aborted) throw retryError;
          console.warn(`书籍翻译批次重试仍失败，跳过该批 ${job.batch.length} 段:`, retryError);
          failedBatches += 1;
        }
      }
      if (translated) {
        const batchIndexes = new Set(job.batch.map((block) => block.index));
        for (const item of translated) {
          if (!batchIndexes.has(item.index)) continue; // 模型多给的条目直接丢弃
          const hash = job.ch.hashes.get(item.index);
          if (!hash) continue;
          job.ch.working[String(item.index)] = { hash, text: item.text.trim() };
          done += 1;
        }
        await job.ch.save(); // 每批落盘一次，崩溃/取消可续
        onProgress?.({ done, total });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(TRANSLATE_CONCURRENCY, jobs.length) }, () => runWorker()));
  return result(Boolean(signal?.aborted));
}
