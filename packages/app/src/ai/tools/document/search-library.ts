import type { EnhancedSearchItem } from "@/types/document";
import { getCurrentVectorModelConfig } from "@/utils/model";
import { invoke } from "@tauri-apps/api/core";
import { tool } from "ai";
import { z } from "zod";
import { withRagErrorTranslation } from "../rag-error";
import { type AgentDocScope, clipSnippet } from "./shared";

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

export const createSearchLibraryTool = (ctx: AgentDocScope) =>
  tool({
    description:
      "在文献库（论文）或指定文档内部做语义+关键词混合检索，返回「文档锚点 + 有界片段」，不是全文。命中后建议先 getDocumentInfo(doc) 看目录，再用 readDocument(doc, heading/offset) 精读，不要一次读全文。\n\n📖 **使用场景**：\n• 跨论文主题检索、找哪篇论文讨论过某个方法\n• 在中央助手（central）用 scope=all 时：书库 + 论文库跨库合并检索（RRF 融合），返回两条来源的混合结果\n• 在某本书内部找某个概念/人物（doc=book:<id>，需要该书已建索引）\n• 定位到片段后，用 readDocument(doc, heading/offset) 精读\n\n🎯 **scope**：current=当前论文；collection=面板选定范围（默认）；all=全部文献。跨文献比较时用 all。\n\n📄 **doc**：可选，指定在单篇文档内检索：paper:<id> / book:<id>；省略时按 scope 搜论文库。\n\n📊 **返回**：{results:[{doc, title, snippet(≤400 字符), chapter?, chunk_id, similarity}], total}；引用要注明文档标题/章节。\n\n🔍 论文正文为英文，请用英文术语构造 query；复杂问题拆 2-3 个子查询。",
    inputSchema: z.object({
      reasoning: z.string().min(1).describe("调用此工具的原因和目的"),
      query: z.string().min(1).describe("检索问题（英文术语命中率更高）"),
      scope: z
        .enum(["current", "collection", "all"])
        .default("collection")
        .describe("检索范围：current=当前论文，collection=面板范围，all=全部文献"),
      doc: z
        .string()
        .optional()
        .describe("在单篇文档内检索：paper:<id> 或 book:<id>（书需已建索引）；省略时按 scope 搜论文库"),
      docType: z.enum(["paper", "book"]).optional().describe("兼容旧参数：book=当前书；建议改用 doc"),
      topK: z.number().int().min(1).max(12).default(6).describe("返回片段数，默认 6"),
    }),
    execute: async (args: {
      reasoning: string;
      query: string;
      scope?: "current" | "collection" | "all";
      doc?: string;
      docType?: "paper" | "book";
      topK?: number;
    }) => {
      const requestedDoc = (args.doc ?? "").trim();
      const requestedBookId = requestedDoc.startsWith("book:")
        ? requestedDoc.slice("book:".length)
        : args.docType === "book" && ctx.scope === "reader"
          ? ctx.currentId
          : null;
      if (args.docType === "book" && !requestedBookId) {
        return { results: [], total: 0, note: "当前没有打开的书；请传 doc=book:<id>（需已建索引）。" };
      }
      if (requestedBookId) {
        try {
          const vectorConfig = await getCurrentVectorModelConfig();
          const rawBook = (await withRagErrorTranslation(() =>
            invoke("plugin:epub|search_db", {
              bookId: requestedBookId,
              query: args.query,
              limit: args.topK ?? 6,
              dimension: vectorConfig.dimension,
              embeddingsUrl: vectorConfig.embeddingsUrl,
              model: vectorConfig.model,
              apiKey: vectorConfig.apiKey,
              searchMode: "hybrid",
              vectorWeight: 0.7,
              bm25Weight: 0.3,
            }),
          )) as EnhancedSearchItem[];
          const results = rawBook.map((item) => ({
            doc: `book:${requestedBookId}`,
            title: null,
            chapter: item.related_chapter_titles || null,
            snippet: clipSnippet(item.content, 400),
            chunk_id: item.chunk_id ?? null,
            similarity: Number.parseFloat((item.similarity * 100).toFixed(1)),
            next: `readDocument(doc=book:${requestedBookId}, heading=<chapter> 或 offset=...)`,
          }));
          return {
            query: args.query,
            scope: "本书",
            results,
            total: results.length,
            note:
              results.length === 0
                ? "本书没有命中：换关键词（书中语言的术语命中率更高），或用 getDocumentInfo(doc) 看目录后 readDocument 按章节读。"
                : undefined,
            meta: { reasoning: args.reasoning },
          };
        } catch (error) {
          return {
            query: args.query,
            scope: "本书",
            results: [],
            total: 0,
            note: `本书语义检索不可用：${error instanceof Error ? error.message : String(error)}。可能未建索引，可用 getDocumentInfo(doc) 看目录后 readDocument 按章节读。`,
            meta: { reasoning: args.reasoning },
          };
        }
      }
      const requestedPaperId = requestedDoc.startsWith("paper:") ? requestedDoc.slice("paper:".length) : null;
      const scope = args.scope ?? "collection";
      let paperIds: string[] | null = null;
      let scopeLabel = "全部文献";
      if (requestedPaperId) {
        paperIds = [requestedPaperId];
        scopeLabel = "指定论文（doc）";
      } else if (scope === "current") {
        if (ctx.scope === "paper" && ctx.currentId) {
          paperIds = [ctx.currentId];
          scopeLabel = "当前论文";
        } else {
          scopeLabel = "全部文献（当前没有单篇论文上下文）";
        }
      } else if (scope === "collection") {
        paperIds = ctx.paperScopeIds ?? null;
        scopeLabel = paperIds ? `${paperIds.length} 篇论文（面板范围）` : "全部文献";
      }
      try {
        const config = await getCurrentVectorModelConfig();
        // 中央助手 + scope=all：书库 + 论文库跨库合并（RRF 融合；书库一次 embedding fan-out）
        const includeBooks = ctx.scope === "central" && scope === "all" && !requestedPaperId;
        const bookSearchPromise: Promise<BookSearchHit[]> = includeBooks
          ? (
              invoke("plugin:epub|search_all_books_db", {
                query: args.query,
                limit: 8,
                perBookLimit: 4,
                embeddingsUrl: config.embeddingsUrl,
                model: config.model,
                apiKey: config.apiKey,
              }) as Promise<BookSearchHit[]>
            ).catch(() => [])
          : Promise.resolve([]);
        const [raw, rawBooks] = await Promise.all([
          invoke("plugin:epub|search_papers_db", {
            query: args.query,
            paperIds,
            topK: args.topK ?? 6,
            vectorWeight: 0.7,
            bm25Weight: 0.3,
            includeReferences: false,
            embeddingsUrl: config.embeddingsUrl,
            model: config.model,
            apiKey: config.apiKey,
          }) as Promise<PaperSearchItem[]>,
          bookSearchPromise,
        ]);
        const paperResults = raw.map((item) => ({
          doc: `paper:${item.paper_id}`,
          title: item.book_title,
          snippet: clipSnippet(item.content, 400),
          chunk_id: item.chunk_id,
          similarity: Number.parseFloat((item.similarity * 100).toFixed(1)),
        }));
        if (includeBooks) {
          const bookResults = rawBooks.map((item) => ({
            doc: `book:${item.bookId}`,
            title: item.bookTitle,
            chapter: item.chapter || null,
            snippet: clipSnippet(item.content, 400),
            chunk_id: item.chunkId,
            similarity: Number.parseFloat((item.similarity * 100).toFixed(1)),
          }));
          const merged = [
            ...paperResults.map((item, index) => ({ ...item, kind: "paper" as const, rank: index + 1 })),
            ...bookResults.map((item, index) => ({ ...item, kind: "book" as const, rank: index + 1 })),
          ]
            .map((item) => ({ ...item, rrf: 1 / (60 + item.rank) }))
            .sort((left, right) => right.rrf - left.rrf)
            .slice(0, args.topK ?? 8)
            .map(({ rank, rrf, ...item }) => item);
          return {
            query: args.query,
            scope: `${scopeLabel} + 书库`,
            results: merged,
            total: merged.length,
            book_total: bookResults.length,
            paper_total: paperResults.length,
            note:
              merged.length === 0
                ? "跨库没有命中：换关键词，或分别用 doc=book:<id> / doc=paper:<id> 指定文档检索"
                : undefined,
            meta: { reasoning: args.reasoning },
          };
        }
        return {
          query: args.query,
          scope: scopeLabel,
          results: paperResults,
          total: paperResults.length,
          note: paperResults.length === 0 ? "没有命中：换英文关键词，或把 scope 改为 all 再试" : undefined,
          meta: { reasoning: args.reasoning },
        };
      } catch (error) {
        return {
          query: args.query,
          scope: scopeLabel,
          results: [],
          total: 0,
          note: `语义检索不可用：${error instanceof Error ? error.message : String(error)}。请改用 readDocument 按章节读取。`,
        };
      }
    },
  });
