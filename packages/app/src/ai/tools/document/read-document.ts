import { readPaperMarkdown } from "@/ai/tools/paper/shared";
import { findSectionHeading, parsePaperSections } from "@/pages/paper-reader/markdown-sections";
import {
  readBookDocumentCanonical,
  readBookSectionCanonical,
  resolveBookWindowImages,
} from "@/services/book-content/book-reading-adapter";
import {
  readPositionWindow,
  resolveLiveReadingPosition,
  shortMdPath,
} from "@/services/reading-position/position-service";
import { invoke } from "@tauri-apps/api/core";
import { appDataDir } from "@tauri-apps/api/path";
import { exists, readDir } from "@tauri-apps/plugin-fs";
import { tool } from "ai";
import { z } from "zod";
import { readCanonicalWindow } from "./canonical-window";
import { type DocImageContext, type DocImageFs, rewriteDocumentImagePaths } from "./image-paths";
import {
  type AgentDocScope,
  type DocRef,
  assertDocInRetrievalScope,
  bookIndexed,
  docRefString,
  paperIndexed,
  readDocMetadata,
  resolveDocRef,
} from "./shared";

const DEFAULT_WINDOW = 6000;
const MAX_WINDOW = 12000;
const MAX_BEFORE = 8000;

interface BookSectionResult {
  matchedTitle: string;
  text: string;
  truncated: boolean;
  totalChars: number;
  pages: number;
}

interface ReadArgs {
  reasoning: string;
  doc?: string;
  heading?: string;
  spine?: number;
  offset?: number;
  position?: boolean;
  before?: number;
  after?: number;
}

function clampWindow(value: number | undefined): number {
  return Math.min(Math.max(value ?? DEFAULT_WINDOW, 500), MAX_WINDOW);
}

function clampBefore(value: number | undefined): number {
  return Math.min(Math.max(value ?? 0, 0), MAX_BEFORE);
}

async function readPaperWindowRaw(doc: DocRef, args: ReadArgs) {
  const markdown = await readPaperMarkdown(doc.id);
  const parsed = parsePaperSections(markdown);
  const body = parsed.body;
  const after = clampWindow(args.after);
  const before = clampBefore(args.before);

  if (args.heading) {
    const heading = findSectionHeading(parsed, args.heading);
    if (!heading) {
      const available = parsed.headings
        .map((item) => item.text)
        .slice(0, 20)
        .join("；");
      throw new Error(`未找到标题「${args.heading}」。可用标题：${available || "（本文档没有章节标题）"}`);
    }
    const next = parsed.headings
      .slice(parsed.headings.indexOf(heading) + 1)
      .find((item) => item.level <= heading.level);
    const sectionEnd = next ? next.start : body.length;
    const window = readCanonicalWindow(body, {
      offset: args.offset ?? heading.contentStart,
      before: args.offset == null ? 0 : before,
      after,
      minStart: heading.contentStart,
      maxEnd: sectionEnd,
    });
    return {
      anchor: { kind: "heading", heading: heading.text },
      range: { start: window.start, end: window.end },
      text: window.text,
      totalChars: body.length,
      nextOffset: window.nextOffset,
      truncated: window.truncated,
      note: next ? `本窗口止于下一个同级/更高级标题「${next.text}」` : "",
    };
  }

  if (args.position) {
    const snapshot = await resolveLiveReadingPosition("paper", doc.id);
    if (!snapshot) throw new Error("当前没有可用的论文阅读位置（该论文可能未打开或尚未定位）");
    const positionedSnapshot = args.offset == null ? snapshot : { ...snapshot, charOffset: args.offset };
    const window = await readPositionWindow(positionedSnapshot, { before, after });
    return {
      anchor: { kind: "position", label: snapshot.label, md_file: shortMdPath(snapshot.mdRelPath) },
      range: { start: window.start, end: window.end },
      text: window.text,
      totalChars: window.totalLength,
      nextOffset: window.nextOffset,
      truncated: window.nextOffset != null,
      note: `位置窗口：字符 ${window.start}–${window.end}`,
    };
  }

  if (args.offset != null) {
    const window = readCanonicalWindow(body, { offset: args.offset, before, after });
    return {
      anchor: { kind: "offset", offset: args.offset },
      range: { start: window.start, end: window.end },
      text: window.text,
      totalChars: body.length,
      nextOffset: window.nextOffset,
      truncated: window.truncated,
      note: "",
    };
  }

  const window = readCanonicalWindow(body, { offset: 0, after });
  return {
    anchor: { kind: "start" },
    range: { start: window.start, end: window.end },
    text: window.text,
    totalChars: body.length,
    nextOffset: window.nextOffset,
    truncated: window.truncated,
    note: "未指定锚点，从正文开头读取；可用 heading 定位小节",
  };
}

async function readBookHeadingFromRust(doc: DocRef, heading: string, offset: number, before: number, after: number) {
  const within = Math.max(offset, 0);
  const result = await invoke<BookSectionResult>("plugin:epub|read_book_section", {
    bookId: doc.id,
    chapterTitle: heading,
    maxChars: after + within,
  });
  const start = Math.max(0, within - before);
  const end = Math.min(result.text.length, within + after);
  const text = result.text.slice(start, end);
  const nextOffset = end < result.totalChars ? end : null;
  return {
    anchor: { kind: "heading", heading: result.matchedTitle },
    range: { start, end },
    text,
    totalChars: result.totalChars,
    nextOffset,
    truncated: nextOffset != null,
    note: result.truncated ? `章节较长，已截断；用 offset=${nextOffset ?? 0} 续读` : "",
  };
}

async function readBookWindowRaw(doc: DocRef, args: ReadArgs) {
  // 书籍章节可能极长：单窗上限压到 8000，避免连续扩读把上下文打满
  const after = Math.min(clampWindow(args.after), 8000);
  const before = clampBefore(args.before);

  if (args.spine != null) {
    const canonical = await readBookSectionCanonical(doc.id, { spine: args.spine });
    if (canonical.kind !== "ok") throw new Error(`未找到书籍 spine=${args.spine} 对应的正文`);
    const window = readCanonicalWindow(canonical.text, {
      offset: args.offset ?? 0,
      before: args.offset == null ? 0 : before,
      after,
    });
    return {
      anchor: { kind: "spine", spine: args.spine, heading: canonical.matchedTitle },
      range: { start: window.start, end: window.end },
      text: window.text,
      totalChars: canonical.totalChars,
      nextOffset: window.nextOffset,
      truncated: window.truncated,
      note: window.truncated ? `章节较长，已截断；用 offset=${window.nextOffset ?? 0} 续读` : "",
      bookImageSource: { ...canonical, windowStart: window.start },
    };
  }

  if (args.heading) {
    const canonical = await readBookSectionCanonical(doc.id, { heading: args.heading }).catch((error) => {
      console.warn("[readDocument] 书籍 JS canonical 读取失败:", error);
      return null;
    });
    if (canonical?.kind === "ambiguous") {
      throw new Error(
        `标题「${args.heading}」有 ${canonical.total} 个候选：${canonical.candidates
          .map((candidate) => candidate.label)
          .join("；")}`,
      );
    }
    if (canonical?.kind === "ok") {
      const window = readCanonicalWindow(canonical.text, {
        offset: args.offset ?? 0,
        before: args.offset == null ? 0 : before,
        after,
      });
      return {
        anchor: { kind: "heading", heading: canonical.matchedTitle },
        range: { start: window.start, end: window.end },
        text: window.text,
        totalChars: canonical.totalChars,
        nextOffset: window.nextOffset,
        truncated: window.truncated,
        note: window.truncated ? `章节较长，已截断；用 offset=${window.nextOffset ?? 0} 续读` : "",
        bookImageSource: { ...canonical, windowStart: window.start },
      };
    }
    if (args.offset != null) {
      throw new Error(
        "书籍 canonical 读取失败，不能将 canonical offset 回退到不兼容的 Rust 文本；请重试或改用 spine 锚点",
      );
    }
    return readBookHeadingFromRust(doc, args.heading, 0, 0, after);
  }

  if (args.position) {
    const snapshot = await resolveLiveReadingPosition("reader", doc.id);
    if (!snapshot) throw new Error("当前没有可用的书籍阅读位置（该书可能未在阅读器中打开）");
    const positionedSnapshot = args.offset == null ? snapshot : { ...snapshot, charOffset: args.offset };
    const window = await readPositionWindow(positionedSnapshot, { before, after });
    return {
      anchor: { kind: "position", label: snapshot.label, md_file: shortMdPath(snapshot.mdRelPath) },
      range: { start: window.start, end: window.start + window.text.length },
      // 仅供图片相对路径解析用（不进入工具返回结构）
      mdRelPath: snapshot.mdRelPath,
      text: window.text,
      totalChars: window.totalLength,
      nextOffset: window.nextOffset,
      truncated: window.nextOffset != null,
      note: `位置窗口：字符 ${window.start}–${window.start + window.text.length}`,
    };
  }

  if (args.offset != null) {
    const canonical = await readBookDocumentCanonical(doc.id);
    const window = readCanonicalWindow(canonical.text, { offset: args.offset, before, after });
    return {
      anchor: { kind: "offset", offset: args.offset },
      range: { start: window.start, end: window.end },
      text: window.text,
      totalChars: canonical.totalChars,
      nextOffset: window.nextOffset,
      truncated: window.truncated,
      note: "",
      bookImageSource: { ...canonical, windowStart: window.start },
    };
  }

  throw new Error(
    "书籍文档需要 heading、spine、position 或显式 offset 锚点：请先传章节标题（可先用 getDocumentInfo 看目录）",
  );
}

/** 读原文时探测图片用的文件系统适配（Tauri 插件；失败一律当作不存在）。 */
const DOC_IMAGE_FS: DocImageFs = {
  exists: (path: string) => exists(path).catch(() => false),
  listDir: async (path: string) => {
    try {
      const entries = await readDir(path);
      return entries.filter((entry) => entry.isDirectory).map((entry) => entry.name);
    } catch {
      return [];
    }
  },
};

/**
 * new 模式读原文后，把 Markdown/HTML 图片引用里的相对路径重写为绝对路径
 * （readImage 只收绝对路径：书在 mdbook src/图片目录、论文在 paper 目录 images/）。
 * 解析不到或文件不存在时保留原文，不编造；不改变返回结构（只改 text 内容）。
 */
async function withResolvedImagePaths(text: string, doc: DocRef, mdRelPath?: string): Promise<string> {
  if (!text || (!text.includes("![") && !/<img/i.test(text))) return text;
  try {
    const appData = (await appDataDir()).replace(/\\/g, "/");
    const ctx: DocImageContext = { kind: doc.kind, docDir: `${appData}/books/${doc.id}`, mdRelPath };
    return await rewriteDocumentImagePaths(text, ctx, DOC_IMAGE_FS);
  } catch (error) {
    console.warn("[readDocument] 图片相对路径解析失败，保留原文:", error);
    return text;
  }
}

async function readPaperWindow(doc: DocRef, args: ReadArgs) {
  const window = await readPaperWindowRaw(doc, args);
  return { ...window, text: await withResolvedImagePaths(window.text, doc) };
}

async function readBookWindow(doc: DocRef, args: ReadArgs) {
  const window = await readBookWindowRaw(doc, args);
  if ("bookImageSource" in window && window.bookImageSource) {
    return {
      ...window,
      text: await resolveBookWindowImages(doc.id, window.text, window.bookImageSource),
    };
  }
  return {
    ...window,
    text: await withResolvedImagePaths(window.text, doc, "mdRelPath" in window ? window.mdRelPath : undefined),
  };
}

export const createReadDocumentTool = (ctx: AgentDocScope) =>
  tool({
    description:
      "按文档 + 锚点读取原文窗口（通用阅读原语）。\n\n📖 **使用场景**：\n• 跨文献：在用户划定的检索范围内直接读库里的另一篇论文/另一本书，不需要先打开它\n• 任意文档的小节/位置/字符窗口读取，支持分页续读\n\n🚫 **范围约束**：只能读用户当前选择范围内的文档（本书 / 图书馆 / 图书馆+论文库）；越界 doc 会被明确拒绝，不要改路径绕过。需要更广范围时请用户切侧栏下拉。\n\n🎯 **参数**：\n• doc：book:<id> 或 paper:<id>；省略 = 当前文档\n• heading：按标题定位（先 getDocumentInfo 拿目录）\n• spine：按书籍 EPUB spine 定位（searchLibrary 命中可直接回传）\n• offset：从文档字符偏移开始（论文为正文绝对坐标；书籍 heading/spine 为节内坐标、无 heading/spine 为全书 canonical、position 为当前 md 文件坐标）\n• position：从当前阅读位置开始（仅当前打开的文档）\n• before/after：窗口大小（默认 after=6000）\n\n📌 **用法**：先 getDocumentInfo 拿目录；能按 heading 精读就别用 offset 从头连续读全文（总结全文除外）。单窗默认 6000 字符（书籍上限 8000）；同一节最多读 1-2 窗，信息够用立刻作答，不要连续扩读 3 次以上。\n\n📊 **返回**：{doc, anchor, range, read, text, total_chars, next_offset, truncated}；range 是本窗半开字符区间，read 可原样重放，next_offset 用于续读。\n\n🚫 **不要**用 readLocalFile/runCommand 到文献库目录翻文件；用 doc 参数直接读。",
    inputSchema: z.object({
      reasoning: z.string().min(1).describe("调用此工具的原因和目的"),
      doc: z.string().optional().describe("文档引用：book:<id> 或 paper:<id>；省略 = 当前文档"),
      heading: z.string().optional().describe("章节标题（论文/书籍通用；支持模糊匹配）"),
      spine: z.number().int().min(0).optional().describe("书籍 EPUB spine 索引；与 offset 组合时为节内坐标"),
      offset: z.number().int().min(0).optional().describe("从第 N 个字符开始读（续读：把上次 next_offset 原样传入）"),
      position: z.boolean().optional().describe("从当前阅读位置开始读（仅当前打开的文档）"),
      before: z.number().int().min(0).max(8000).optional().describe("位置/偏移之前保留的字符数，默认 0"),
      after: z.number().int().min(500).max(12000).optional().describe("读取的字符数，默认 6000"),
    }),
    execute: async (args: ReadArgs) => {
      const doc = resolveDocRef(args.doc, ctx);
      // 用户划圈优先于模型参数：越界直读直接给明确错误，不静默降级
      assertDocInRetrievalScope(doc, ctx);
      const metadata = await readDocMetadata(doc);
      const window = doc.kind === "paper" ? await readPaperWindow(doc, args) : await readBookWindow(doc, args);
      const indexed = doc.kind === "paper" ? await paperIndexed(doc.id) : await bookIndexed(doc.id);
      const indexInfo = indexed
        ? { status: "indexed" as const }
        : {
            status: "not_indexed" as const,
            note: "本篇/本书未建向量索引，本次按原文读取（较慢）；如果用户在意速度，可在回答里提醒向量化后可提速。",
          };
      const replay = {
        doc: docRefString(doc),
        ...(args.heading ? { heading: args.heading } : {}),
        ...(args.spine != null ? { spine: args.spine } : {}),
        ...(args.offset != null ? { offset: args.offset } : {}),
        ...(args.position ? { position: true } : {}),
        before: clampBefore(args.before),
        after: doc.kind === "book" ? Math.min(clampWindow(args.after), 8000) : clampWindow(args.after),
      };
      return {
        doc: { ref: docRefString(doc), kind: doc.kind, id: doc.id, title: metadata.title ?? null },
        index: indexInfo,
        anchor: window.anchor,
        range: { ...window.range, unit: "char" as const },
        read: replay,
        text: window.text,
        total_chars: window.totalChars,
        next_offset: window.nextOffset,
        truncated: window.truncated,
        note: window.note || undefined,
        meta: { reasoning: args.reasoning },
      };
    },
  });
