import { narrowRetrievalScope } from "@/constants/retrieval-scope";
import type { EnhancedSearchItem } from "@/types/document";
import { getCurrentVectorModelConfig } from "@/utils/model";
import { invoke } from "@tauri-apps/api/core";
import { tool } from "ai";
import { z } from "zod";
import { withRagErrorTranslation } from "../rag-error";
import {
  type AgentDocScope,
  type DocRef,
  RetrievalScopeError,
  assertDocInRetrievalScope,
  clipSnippet,
  resolveDocRef,
  resolveRetrievalScope,
  retrievalScopeLabel,
} from "./shared";

interface BookSearchHit {
  bookId: string;
  bookTitle: string;
  content: string;
  similarity: number;
  chapter: string;
  chunkId: number;
  mdFilePath: string;
}

interface PaperSearchItem {
  paper_id: string;
  book_title: string;
  book_author: string;
  content: string;
  similarity: number;
  chunk_id: number;
}

type VectorConfig = Awaited<ReturnType<typeof getCurrentVectorModelConfig>>;

interface LibraryHit {
  doc: string;
  title: string | null;
  chapter?: string | null;
  snippet: string;
  chunk_id: number | null;
  similarity: number;
  kind?: "book" | "paper";
}

async function searchBook(config: VectorConfig, query: string, bookId: string, topK: number): Promise<LibraryHit[]> {
  const rawBook = (await withRagErrorTranslation(() =>
    invoke("plugin:epub|search_db", {
      bookId,
      query,
      limit: topK,
      dimension: config.dimension,
      embeddingsUrl: config.embeddingsUrl,
      model: config.model,
      apiKey: config.apiKey,
      searchMode: "hybrid",
      vectorWeight: 0.7,
      bm25Weight: 0.3,
    }),
  )) as EnhancedSearchItem[];
  return rawBook.map((item) => ({
    doc: `book:${bookId}`,
    title: null,
    chapter: item.related_chapter_titles || null,
    snippet: clipSnippet(item.content, 400),
    chunk_id: item.chunk_id ?? null,
    similarity: Number.parseFloat((item.similarity * 100).toFixed(1)),
  }));
}

async function searchAllBooks(config: VectorConfig, query: string, topK: number): Promise<LibraryHit[]> {
  const rawBooks = (await withRagErrorTranslation(() =>
    invoke("plugin:epub|search_all_books_db", {
      query,
      limit: topK,
      perBookLimit: Math.min(4, topK),
      embeddingsUrl: config.embeddingsUrl,
      model: config.model,
      apiKey: config.apiKey,
    }),
  )) as BookSearchHit[];
  return rawBooks.map((item) => ({
    doc: `book:${item.bookId}`,
    title: item.bookTitle,
    chapter: item.chapter || null,
    snippet: clipSnippet(item.content, 400),
    chunk_id: item.chunkId,
    similarity: Number.parseFloat((item.similarity * 100).toFixed(1)),
  }));
}

async function searchPapers(
  config: VectorConfig,
  query: string,
  paperIds: string[] | null,
  topK: number,
): Promise<LibraryHit[]> {
  const raw = (await withRagErrorTranslation(() =>
    invoke("plugin:epub|search_papers_db", {
      query,
      paperIds,
      topK,
      vectorWeight: 0.7,
      bm25Weight: 0.3,
      includeReferences: false,
      embeddingsUrl: config.embeddingsUrl,
      model: config.model,
      apiKey: config.apiKey,
    }),
  )) as PaperSearchItem[];
  return raw.map((item) => ({
    doc: `paper:${item.paper_id}`,
    title: item.book_title,
    snippet: clipSnippet(item.content, 400),
    chunk_id: item.chunk_id,
    similarity: Number.parseFloat((item.similarity * 100).toFixed(1)),
  }));
}

/** 跨库 RRF 融合（书库 + 论文库各取 topK 候选后按排名融合）。 */
function mergeByRrf(paperResults: LibraryHit[], bookResults: LibraryHit[], topK: number): LibraryHit[] {
  return [
    ...paperResults.map((item, index) => ({ ...item, kind: "paper" as const, rank: index + 1 })),
    ...bookResults.map((item, index) => ({ ...item, kind: "book" as const, rank: index + 1 })),
  ]
    .map((item) => ({ ...item, rrf: 1 / (60 + item.rank) }))
    .sort((left, right) => right.rrf - left.rrf)
    .slice(0, topK)
    .map(({ rank: _rank, rrf: _rrf, ...item }) => item);
}

/** 解析模型传的 doc 参数并校验圈：只允许在用户划定的范围内收窄。 */
function resolveScopedDoc(args: { doc?: string; docType?: "paper" | "book" }, ctx: AgentDocScope): DocRef | undefined {
  const requestedDoc = (args.doc ?? "").trim();
  if (requestedDoc) {
    const doc = resolveDocRef(requestedDoc, ctx);
    assertDocInRetrievalScope(doc, ctx);
    return doc;
  }
  // 旧参数兼容：docType=book 只能指阅读助手的当前书（论文助手的 currentId 是论文 id，
  // 不能拿它冒充书籍）；其它情况要求显式 doc=book:<id>，避免用错 id 去搜书。
  if (args.docType === "book") {
    if (ctx.scope !== "reader" || !ctx.currentId) {
      throw new RetrievalScopeError(
        "旧参数 docType=book 只适用于阅读助手的当前书；请改传 doc=book:<id>（需在用户圈定范围内）。",
      );
    }
    const doc: DocRef = { kind: "book", id: ctx.currentId };
    assertDocInRetrievalScope(doc, ctx);
    return doc;
  }
  return undefined;
}

function docScopeLabel(
  target: DocRef | undefined,
  ctx: AgentDocScope,
  circle: ReturnType<typeof resolveRetrievalScope>,
): string {
  if (!target) return retrievalScopeLabel(ctx.scope, circle);
  if (target.kind === "book") {
    return ctx.scope === "reader" && target.id === ctx.currentId ? "本书（doc）" : "指定书籍（doc）";
  }
  return ctx.scope === "paper" && target.id === ctx.currentId ? "本篇论文（doc）" : "指定论文（doc）";
}

export const createSearchLibraryTool = (ctx: AgentDocScope) => {
  const circle = resolveRetrievalScope(ctx);
  const scopeLine =
    ctx.scope === "central"
      ? "用户范围：全部（图书馆 + 论文库；全局助手无下拉）。"
      : `用户当前范围：「${retrievalScopeLabel(ctx.scope, circle)}」。`;
  const roleRule =
    ctx.scope === "reader"
      ? "• 阅读助手：current=当前书（search_db）；library=图书馆全部书籍（search_all_books_db，不含论文）；all=图书馆+论文库（RRF 融合）。"
      : ctx.scope === "paper"
        ? "• 论文助手：current=当前论文；library=论文库全部论文；all=论文库+图书馆（RRF 融合）。"
        : "• 全局助手：恒为图书馆+论文库（无下拉）。";

  return tool({
    description: `在用户划定的检索范围内做语义+关键词混合检索，返回「文档锚点 + 有界片段」，不是全文。命中后建议先 getDocumentInfo(doc) 看目录，再用 readDocument(doc, heading/offset) 精读，不要一次读全文。\n\n${scopeLine}\n${roleRule}\n🚫 **范围铁律**：scope/doc 参数只能在用户圈内收窄，不能放大；越界 doc 会直接报错。需要更广范围时不要绕路——请让用户切侧栏顶部的范围下拉。\n\n📖 **使用场景**：\n• 跨论文主题检索、找哪篇论文讨论过某个方法\n• 在阅读助手的「图书馆+论文库」范围做跨库合并检索（RRF 融合，结果带 kind=book/paper）\n• 在某本书内部找某个概念/人物（doc=book:<id>，需要该书已建索引）\n• 定位到片段后，用 readDocument(doc, heading/offset) 精读\n\n🎯 **scope**：current=当前文档；library=当前角色的资料库（阅读=全部书籍；论文=全部论文）；all=书库+论文库。省略时按用户选择的范围。\n\n📄 **doc**：可选，在圈内指定单篇文档：paper:<id> / book:<id>；省略时按范围检索。\n\n📊 **返回**：{results:[{doc, title, snippet(≤400 字符), chapter?, chunk_id, similarity, kind?}], total}；引用要注明文档标题/章节。\n\n🔍 论文正文为英文，请用英文术语构造 query；复杂问题拆 2-3 个子查询。`,
    inputSchema: z.object({
      reasoning: z.string().min(1).describe("调用此工具的原因和目的"),
      query: z.string().min(1).describe("检索问题（英文术语命中率更高）"),
      scope: z
        .enum(["current", "library", "all"])
        .optional()
        .describe(
          "可选，只能收窄用户圈定范围：current=当前文档；library=当前角色的资料库（阅读=全部书籍；论文=全部论文）；all=书库+论文库。越界会被拒绝。",
        ),
      doc: z
        .string()
        .optional()
        .describe("在圈内指定单篇文档：paper:<id> 或 book:<id>（书需已建索引）；省略时按 scope 检索"),
      docType: z.enum(["paper", "book"]).optional().describe("兼容旧参数：book=当前书（需在圈内）；建议改用 doc"),
      topK: z.number().int().min(1).max(12).default(6).describe("返回片段数，默认 6"),
    }),
    execute: async (args: {
      reasoning: string;
      query: string;
      scope?: "current" | "library" | "all";
      doc?: string;
      docType?: "paper" | "book";
      topK?: number;
    }) => {
      const topK = args.topK ?? 6;
      // 用户圈定值 > 模型参数：requested 只能比 circle 更窄；doc 越界直接抛明确错误
      const requested = ctx.scope === "central" ? "all" : narrowRetrievalScope(circle, args.scope);
      const target = resolveScopedDoc(args, ctx);
      const label = docScopeLabel(target, ctx, circle);
      const meta = { reasoning: args.reasoning, retrieval_scope: target ? circle : requested };

      try {
        const config = await getCurrentVectorModelConfig();

        if (target?.kind === "book") {
          const results = await searchBook(config, args.query, target.id, topK);
          return {
            query: args.query,
            scope: label,
            results,
            total: results.length,
            note:
              results.length === 0
                ? "本书没有命中：换关键词（书中语言的术语命中率更高），或用 getDocumentInfo(doc) 看目录后 readDocument 按章节读。"
                : undefined,
            meta,
          };
        }

        if (target?.kind === "paper") {
          const results = await searchPapers(config, args.query, [target.id], topK);
          return {
            query: args.query,
            scope: label,
            results,
            total: results.length,
            note: results.length === 0 ? "本篇没有命中：换英文关键词，或改用 readDocument 按章节读原文。" : undefined,
            meta,
          };
        }

        if (ctx.scope === "reader" && requested === "current") {
          if (!ctx.currentId) {
            throw new RetrievalScopeError(
              "当前没有打开的书，无法在「本书」范围内检索；请让用户先打开一本书或切换到更广范围。",
            );
          }
          const results = await searchBook(config, args.query, ctx.currentId, topK);
          return {
            query: args.query,
            scope: "本书",
            results,
            total: results.length,
            note:
              results.length === 0
                ? "本书没有命中：换关键词（书中语言的术语命中率更高），或用 getDocumentInfo(doc) 看目录后 readDocument 按章节读。"
                : undefined,
            meta,
          };
        }

        if (ctx.scope === "reader" && requested === "library") {
          const results = await searchAllBooks(config, args.query, topK);
          return {
            query: args.query,
            scope: "图书馆（全部书籍）",
            results,
            total: results.length,
            note: results.length === 0 ? "书库没有命中：换关键词，或用 doc=book:<id> 指定书籍检索。" : undefined,
            meta,
          };
        }

        if (ctx.scope === "paper" && requested === "current") {
          if (!ctx.currentId) {
            throw new RetrievalScopeError("当前没有打开的论文，无法在「本篇」范围内检索；请让用户先打开一篇论文。");
          }
          const results = await searchPapers(config, args.query, [ctx.currentId], topK);
          return {
            query: args.query,
            scope: "本篇论文",
            results,
            total: results.length,
            note: results.length === 0 ? "本篇没有命中：换英文关键词，或改用 readDocument 按章节读原文。" : undefined,
            meta,
          };
        }

        if (ctx.scope === "paper" && requested === "library") {
          const results = await searchPapers(config, args.query, null, topK);
          return {
            query: args.query,
            scope: "论文库（全部论文）",
            results,
            total: results.length,
            note: results.length === 0 ? "论文库没有命中：换英文关键词，或用 doc=paper:<id> 指定论文检索。" : undefined,
            meta,
          };
        }

        // 阅读助手 all / 论文助手 all / 全局助手：书库 + 论文库 RRF 融合
        const [paperSettled, bookSettled] = await Promise.allSettled([
          searchPapers(config, args.query, null, topK),
          searchAllBooks(config, args.query, topK),
        ]);
        const paperResults = paperSettled.status === "fulfilled" ? paperSettled.value : [];
        const bookResults = bookSettled.status === "fulfilled" ? bookSettled.value : [];
        const merged = mergeByRrf(paperResults, bookResults, topK);
        const failureNotes: string[] = [];
        if (paperSettled.status === "rejected") {
          failureNotes.push(`论文库检索失败：${String(paperSettled.reason)}`);
        }
        if (bookSettled.status === "rejected") {
          failureNotes.push(`书库检索失败：${String(bookSettled.reason)}`);
        }
        if (merged.length === 0) {
          failureNotes.push("跨库没有命中：换关键词，或分别用 doc=book:<id> / doc=paper:<id> 指定文档检索");
        }
        return {
          query: args.query,
          scope: "图书馆+论文库",
          results: merged,
          total: merged.length,
          book_total: bookResults.length,
          paper_total: paperResults.length,
          note: failureNotes.length > 0 ? failureNotes.join("；") : undefined,
          meta,
        };
      } catch (error) {
        if (error instanceof RetrievalScopeError) throw error;
        return {
          query: args.query,
          scope: label,
          results: [],
          total: 0,
          note: `语义检索不可用：${error instanceof Error ? error.message : String(error)}。请改用 readDocument 按章节读取。`,
          meta,
        };
      }
    },
  });
};
