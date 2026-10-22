import { readPaperMarkdown } from "@/ai/tools/paper/shared";
import { findSectionHeading, parsePaperSections } from "@/pages/paper-reader/markdown-sections";
import {
  readPositionWindow,
  resolveLiveReadingPosition,
  shortMdPath,
} from "@/services/reading-position/position-service";
import { invoke } from "@tauri-apps/api/core";
import { tool } from "ai";
import { z } from "zod";
import {
  type AgentDocScope,
  type DocRef,
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

async function readPaperWindow(doc: DocRef, args: ReadArgs) {
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
    const start = Math.min(Math.max(heading.contentStart + (args.offset ?? 0), heading.contentStart), sectionEnd);
    const end = Math.min(sectionEnd, start + after);
    const text = body.slice(start, end);
    return {
      anchor: { kind: "heading", heading: heading.text },
      text,
      totalChars: body.length,
      nextOffset: end < sectionEnd ? end : null,
      truncated: end < sectionEnd,
      note: next ? `本窗口止于下一个同级/更高级标题「${next.text}」` : "",
    };
  }

  if (args.offset != null) {
    const start = Math.max(0, args.offset - before);
    const end = Math.min(body.length, start + before + after);
    return {
      anchor: { kind: "offset", offset: args.offset },
      text: body.slice(start, end),
      totalChars: body.length,
      nextOffset: end < body.length ? end : null,
      truncated: end < body.length,
      note: "",
    };
  }

  if (args.position) {
    const snapshot = await resolveLiveReadingPosition("paper", doc.id);
    if (!snapshot) throw new Error("当前没有可用的论文阅读位置（该论文可能未打开或尚未定位）");
    const window = await readPositionWindow(snapshot, { before, after });
    return {
      anchor: { kind: "position", label: snapshot.label, md_file: shortMdPath(snapshot.mdRelPath) },
      text: window.text,
      totalChars: window.totalLength,
      nextOffset: window.nextOffset,
      truncated: window.nextOffset != null,
      note: `位置窗口：字符 ${window.start}–${window.start + window.text.length}`,
    };
  }

  const end = Math.min(body.length, after);
  return {
    anchor: { kind: "start" },
    text: body.slice(0, end),
    totalChars: body.length,
    nextOffset: end < body.length ? end : null,
    truncated: end < body.length,
    note: "未指定锚点，从正文开头读取；可用 heading 定位小节",
  };
}

async function readBookWindow(doc: DocRef, args: ReadArgs) {
  // 书籍章节可能极长：单窗上限压到 8000，避免连续扩读把上下文打满
  const after = Math.min(clampWindow(args.after), 8000);
  const before = clampBefore(args.before);

  if (args.heading) {
    const within = Math.max(args.offset ?? 0, 0);
    const result = await invoke<BookSectionResult>("plugin:epub|read_book_section", {
      bookId: doc.id,
      chapterTitle: args.heading,
      maxChars: after + within,
    });
    const text = result.text.slice(within, within + after);
    const nextOffset = within + text.length < result.totalChars ? within + text.length : null;
    return {
      anchor: { kind: "heading", heading: result.matchedTitle },
      text,
      totalChars: result.totalChars,
      nextOffset,
      truncated: nextOffset != null,
      note: result.truncated ? `章节较长，已截断；用 offset=${nextOffset ?? 0} 续读` : "",
    };
  }

  if (args.position) {
    const snapshot = await resolveLiveReadingPosition("reader", doc.id);
    if (!snapshot) throw new Error("当前没有可用的书籍阅读位置（该书可能未在阅读器中打开）");
    const window = await readPositionWindow(snapshot, { before, after });
    return {
      anchor: { kind: "position", label: snapshot.label, md_file: shortMdPath(snapshot.mdRelPath) },
      text: window.text,
      totalChars: window.totalLength,
      nextOffset: window.nextOffset,
      truncated: window.nextOffset != null,
      note: `位置窗口：字符 ${window.start}–${window.start + window.text.length}`,
    };
  }

  throw new Error("书籍文档需要 heading 或 position 锚点：请先传章节标题（可先用 getDocumentInfo 看目录）");
}

export const createReadDocumentTool = (ctx: AgentDocScope) =>
  tool({
    description:
      "按文档 + 锚点读取原文窗口（通用阅读原语）。\n\n📖 **使用场景**：\n• 跨文献：直接读库里另一篇论文/另一本书，不需要先打开它\n• 任意文档的小节/位置/字符窗口读取，支持分页续读\n\n🎯 **参数**：\n• doc：book:<id> 或 paper:<id>；省略 = 当前文档\n• heading：按标题定位（先 getDocumentInfo 拿目录）\n• offset：从文档字符偏移开始（论文按去掉 frontmatter 的正文计）\n• position：从当前阅读位置开始（仅当前打开的文档）\n• before/after：窗口大小（默认 after=6000）\n\n📌 **用法**：先 getDocumentInfo 拿目录；能按 heading 精读就别用 offset 从头连续读全文（总结全文除外）。单窗默认 6000 字符（书籍上限 8000）；同一节最多读 1-2 窗，信息够用立刻作答，不要连续扩读 3 次以上。\n\n📊 **返回**：{doc, anchor, text, total_chars, next_offset, truncated}；next_offset 用于续读。\n\n🚫 **不要**用 readLocalFile/runCommand 到文献库目录翻文件；用 doc 参数直接读。",
    inputSchema: z.object({
      reasoning: z.string().min(1).describe("调用此工具的原因和目的"),
      doc: z.string().optional().describe("文档引用：book:<id> 或 paper:<id>；省略 = 当前文档"),
      heading: z.string().optional().describe("章节标题（论文/书籍通用；支持模糊匹配）"),
      offset: z.number().int().min(0).optional().describe("从第 N 个字符开始读（续读：把上次 next_offset 原样传入）"),
      position: z.boolean().optional().describe("从当前阅读位置开始读（仅当前打开的文档）"),
      before: z.number().int().min(0).max(8000).optional().describe("位置/偏移之前保留的字符数，默认 0"),
      after: z.number().int().min(500).max(12000).optional().describe("读取的字符数，默认 6000"),
    }),
    execute: async (args: ReadArgs) => {
      const doc = resolveDocRef(args.doc, ctx);
      const metadata = await readDocMetadata(doc);
      const window = doc.kind === "paper" ? await readPaperWindow(doc, args) : await readBookWindow(doc, args);
      const indexed = doc.kind === "paper" ? await paperIndexed(doc.id) : await bookIndexed(doc.id);
      const indexInfo = indexed
        ? { status: "indexed" as const }
        : {
            status: "not_indexed" as const,
            note: "本篇/本书未建向量索引，本次按原文读取（较慢）；如果用户在意速度，可在回答里提醒向量化后可提速。",
          };
      return {
        doc: { ref: docRefString(doc), kind: doc.kind, id: doc.id, title: metadata.title ?? null },
        index: indexInfo,
        anchor: window.anchor,
        text: window.text,
        total_chars: window.totalChars,
        next_offset: window.nextOffset,
        truncated: window.truncated,
        note: window.note || undefined,
        meta: { reasoning: args.reasoning },
      };
    },
  });
