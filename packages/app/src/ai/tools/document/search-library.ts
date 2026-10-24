import { narrowRetrievalScope } from "@/constants/retrieval-scope";
import type { EnhancedSearchItem } from "@/types/document";
import { getCurrentVectorModelConfig } from "@/utils/model";
import { invoke } from "@tauri-apps/api/core";
import { tool } from "ai";
import { z } from "zod";
import { withRagErrorTranslation } from "../rag-error";
import {
  type FallbackSearchResult,
  type FallbackStats,
  type LibraryHit,
  bookChunkToLibraryHit,
  decodeFallbackCursor,
  encodeFallbackCursor,
  fallbackHitCursorKey,
  paperChunkToLibraryHit,
  searchKeywordFallback,
} from "./search-fallback";
import {
  type AgentDocScope,
  type DocRef,
  RetrievalScopeError,
  assertDocInRetrievalScope,
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
  chunk_id: number | null;
}

type VectorConfig = Awaited<ReturnType<typeof getCurrentVectorModelConfig>>;

interface SearchParams {
  topK: number;
  vectorWeight: number;
  bm25Weight: number;
  includeReferences: boolean;
}

interface MergedHits {
  hits: LibraryHit[];
  truncated: boolean;
}

async function mapConcurrent<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await fn(items[index]!);
      }
    }),
  );
  return results;
}

async function searchBook(
  config: VectorConfig | null,
  query: string,
  bookId: string,
  params: SearchParams,
): Promise<LibraryHit[]> {
  const rawBook = (await withRagErrorTranslation(() =>
    invoke("plugin:epub|search_db", {
      bookId,
      query,
      limit: params.topK,
      dimension: config?.dimension ?? 1024,
      embeddingsUrl: config?.embeddingsUrl ?? "",
      model: config?.model ?? "",
      apiKey: config?.apiKey ?? null,
      searchMode: config ? "hybrid" : "bm25",
      vectorWeight: params.vectorWeight,
      bm25Weight: params.bm25Weight,
      includeReferences: params.includeReferences,
    }),
  )) as EnhancedSearchItem[];
  return mapConcurrent(rawBook, (item) => bookChunkToLibraryHit(bookId, item, config ? "hybrid" : "bm25"));
}

async function searchAllBooks(config: VectorConfig | null, query: string, params: SearchParams): Promise<LibraryHit[]> {
  const rawBooks = (await withRagErrorTranslation(() =>
    invoke("plugin:epub|search_all_books_db", {
      query,
      limit: params.topK,
      perBookLimit: Math.min(4, params.topK),
      embeddingsUrl: config?.embeddingsUrl ?? null,
      model: config?.model ?? null,
      apiKey: config?.apiKey ?? null,
      vectorWeight: params.vectorWeight,
      bm25Weight: params.bm25Weight,
      includeReferences: params.includeReferences,
    }),
  )) as BookSearchHit[];
  return mapConcurrent(rawBooks, (item) => bookChunkToLibraryHit(item.bookId, item, config ? "hybrid" : "bm25"));
}

async function searchPapers(
  config: VectorConfig | null,
  query: string,
  paperIds: string[] | null,
  params: SearchParams,
): Promise<LibraryHit[]> {
  const raw = (await withRagErrorTranslation(() =>
    invoke("plugin:epub|search_papers_db", {
      query,
      paperIds,
      topK: params.topK,
      vectorWeight: params.vectorWeight,
      bm25Weight: params.bm25Weight,
      includeReferences: params.includeReferences,
      embeddingsUrl: config?.embeddingsUrl ?? null,
      model: config?.model ?? null,
      apiKey: config?.apiKey ?? null,
    }),
  )) as PaperSearchItem[];
  return mapConcurrent(raw, (item) => paperChunkToLibraryHit(item, config ? "hybrid" : "bm25"));
}

function hitKey(hit: LibraryHit): string {
  return [
    hit.doc,
    hit.read.spine ?? "",
    hit.read.heading ?? "",
    hit.read.offset ?? "",
    hit.snippet.replace(/\s+/gu, " ").trim(),
  ].join("|");
}

function mergeHits(indexed: LibraryHit[], fallback: LibraryHit[], topK: number): MergedHits {
  const seen = new Set<string>();
  const merged = [...indexed, ...fallback]
    .filter((hit) => {
      const key = hitKey(hit);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((hit, index) => ({ hit, index }))
    .sort((left, right) => right.hit.similarity - left.hit.similarity || left.index - right.index)
    .map(({ hit }) => hit);
  return { hits: merged.slice(0, topK), truncated: merged.length > topK };
}

interface CursorChannels {
  paper?: string | null;
  book?: string | null;
}

function parseCursorChannels(input: string | undefined, kind?: "book" | "paper"): CursorChannels {
  if (!input) return {};
  if (kind) return { [kind]: input };
  try {
    const parsed = JSON.parse(input) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("cursor must be an object");
    for (const [key, value] of Object.entries(parsed)) {
      if ((key !== "paper" && key !== "book") || (value !== null && typeof value !== "string")) {
        throw new Error("unknown cursor channel");
      }
    }
    return parsed as CursorChannels;
  } catch (error) {
    throw new RetrievalScopeError(`跨库检索 cursor 无效: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function finalizeFallbackCursor(
  fallback: FallbackSearchResult | null,
  emittedHits: LibraryHit[],
  previousCursor: string | undefined,
  kind: "book" | "paper",
  query: string,
  includeReferences: boolean,
): string | undefined {
  if (!fallback) return undefined;
  // emittedHits 必须是该通道实际发出的结果；ordinary merge 直接传入，RRF 则先按 kind 过滤最终结果。
  const finalKeys = new Set(emittedHits.map(fallbackHitCursorKey));
  const droppedByOuterMerge = fallback.hits.some((hit) => !finalKeys.has(fallbackHitCursorKey(hit)));
  if (!fallback.nextCursor && !droppedByOuterMerge) return undefined;
  const previousState = previousCursor
    ? decodeFallbackCursor({ kind, query, includeReferences, cursor: previousCursor })
    : null;
  const previousSeen = previousState?.seen ?? [];
  const state = fallback.nextCursor
    ? { ...fallback.nextCursor.state }
    : {
        v: 1 as const,
        kind,
        query,
        includeReferences,
        offset: previousState?.offset ?? 0,
        seen: previousSeen,
        partial: fallback.partial,
        truncated: fallback.truncated,
      };
  if (droppedByOuterMerge) state.offset = fallback.nextCursor?.startOffset ?? previousState?.offset ?? 0;
  state.seen = [...new Set([...previousSeen, ...emittedHits.map(fallbackHitCursorKey)])];
  return encodeFallbackCursor(state);
}

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

function resolveScopedDoc(args: { doc?: string; docType?: "paper" | "book" }, ctx: AgentDocScope): DocRef | undefined {
  const requestedDoc = (args.doc ?? "").trim();
  if (requestedDoc) {
    const doc = resolveDocRef(requestedDoc, ctx);
    assertDocInRetrievalScope(doc, ctx);
    return doc;
  }
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const createSearchLibraryTool = (ctx: AgentDocScope) => {
  const circle = resolveRetrievalScope(ctx);
  const scopeLine =
    ctx.scope === "central"
      ? "用户范围：全部（图书馆 + 论文库；全局助手无下拉）。"
      : `用户当前范围：「${retrievalScopeLabel(ctx.scope, circle)}」。`;
  const roleRule =
    ctx.scope === "reader"
      ? "• 阅读助手：current=当前书（search_db + 关键词回退）；library=图书馆全部书籍（不含论文）；all=图书馆+论文库（RRF 融合）。"
      : ctx.scope === "paper"
        ? "• 论文助手：current=当前论文；library=论文库全部论文；all=论文库+图书馆（RRF 融合）。"
        : "• 全局助手：恒为图书馆+论文库（无下拉）。";

  return tool({
    description: `在用户划定的检索范围内做语义+关键词混合检索；未索引文档自动用标题/关键词互补检索，不要求向量配置。返回「文档锚点 + 有界片段」，不是全文。命中后直接把 hit.read 交给 readDocument，可叠加 before/after 精读。\n\n${scopeLine}\n${roleRule}\n🚫 **范围铁律**：scope/doc 参数只能在用户圈内收窄，不能放大；越界 doc 会直接报错。需要更广范围时不要绕路——请让用户切侧栏顶部的范围下拉。\n\n📖 **使用场景**：\n• 跨论文主题检索、找哪篇论文讨论过某个方法\n• 跨库合并检索（结果带 kind=book/paper）\n• 在某本书/论文内找概念，未建索引也可查标题与关键词\n• 定位片段后用 readDocument(hit.read + before/after) 精读\n\n🎯 **scope**：current=当前文档；library=当前角色的资料库（阅读=全部书籍；论文=全部论文）；all=书库+论文库。省略时按用户选择的范围。\n\n📄 **doc**：可选，在圈内指定单篇文档：paper:<id> / book:<id>；省略时按 scope 检索。\n\n📊 **返回**：{results:[{doc,title,snippet(≤400),chapter?,chunk_id,similarity,kind,source,index,read,anchor_precision}],total,partial,truncated}；exact 才有经验证的 offset，section 只给章节/spine，不编造位置。library/all 正文扫描有界，partial=true 时表示覆盖不完整；若同时返回 next_cursor，可用相同 query/参数与该 cursor 继续扫描后续文档，直到 next_cursor 消失；current/doc 不使用 cursor。\n\n🔍 论文正文为英文，请用英文术语构造 query；复杂问题拆 2-3 个子查询。`,
    inputSchema: z.object({
      reasoning: z.string().min(1).describe("调用此工具的原因和目的"),
      query: z.string().min(1).describe("检索问题（英文术语命中率更高）"),
      scope: z
        .enum(["current", "library", "all"])
        .optional()
        .describe(
          "可选，只能收窄用户圈定范围：current=当前文档；library=当前角色的资料库（阅读=全部书籍；论文=全部论文）；all=书库+论文库。越界会被拒绝。",
        ),
      doc: z.string().optional().describe("在圈内指定单篇文档：paper:<id> 或 book:<id>；省略时按 scope 检索"),
      docType: z.enum(["paper", "book"]).optional().describe("兼容旧参数：book=当前书（需在圈内）；建议改用 doc"),
      topK: z.number().int().min(1).max(30).default(6).describe("返回片段数，默认 6，最多 30"),
      vectorWeight: z.number().min(0).max(1).default(0.7).describe("向量搜索权重，默认 0.7"),
      bm25Weight: z.number().min(0).max(1).default(0.3).describe("关键词搜索权重，默认 0.3"),
      includeReferences: z.boolean().default(false).describe("是否包含参考文献区段，默认 false"),
      cursor: z.string().optional().describe("仅 library/all：上次返回的 next_cursor，用于继续有界扫描"),
    }),
    execute: async (args: {
      reasoning: string;
      query: string;
      scope?: "current" | "library" | "all";
      doc?: string;
      docType?: "paper" | "book";
      topK?: number;
      vectorWeight?: number;
      bm25Weight?: number;
      includeReferences?: boolean;
      cursor?: string;
    }) => {
      const params: SearchParams = {
        topK: Math.min(Math.max(args.topK ?? 6, 1), 30),
        vectorWeight: args.vectorWeight ?? 0.7,
        bm25Weight: args.bm25Weight ?? 0.3,
        includeReferences: args.includeReferences ?? false,
      };
      const requested = ctx.scope === "central" ? "all" : narrowRetrievalScope(circle, args.scope);
      const target = resolveScopedDoc(args, ctx);
      let effectiveTarget = target;
      if (!effectiveTarget && requested === "current" && ctx.scope !== "central") {
        if (!ctx.currentId) {
          throw new RetrievalScopeError(
            ctx.scope === "reader"
              ? "当前没有打开的书，无法在「本书」范围内检索；请让用户先打开一本书或切换到更广范围。"
              : "当前没有打开的论文，无法在「本篇」范围内检索；请让用户先打开一篇论文。",
          );
        }
        effectiveTarget = { kind: ctx.scope === "reader" ? "book" : "paper", id: ctx.currentId };
      }
      const label = effectiveTarget
        ? target
          ? docScopeLabel(target, ctx, circle)
          : ctx.scope === "reader"
            ? "本书"
            : "本篇论文"
        : docScopeLabel(undefined, ctx, circle);
      const meta = {
        reasoning: args.reasoning,
        retrieval_scope: target ? circle : requested,
        search_config: {
          vector_weight: params.vectorWeight,
          bm25_weight: params.bm25Weight,
          include_references: params.includeReferences,
        },
      };
      const configState = await getCurrentVectorModelConfig().then(
        (config) => ({ config, error: null as string | null }),
        (error) => ({ config: null, error: errorText(error) }),
      );
      const config = configState.config;
      const configNote = configState.error ? `向量配置不可用，关键词通道仍已执行：${configState.error}` : null;

      const searchOneKind = async (
        kind: "book" | "paper",
        single: DocRef | undefined,
        scope: string,
        channelCursor?: string,
      ) => {
        const continuing = typeof channelCursor === "string";
        const [indexedSettled, fallbackSettled] = await Promise.allSettled([
          continuing
            ? Promise.resolve([])
            : kind === "paper"
              ? searchPapers(config, args.query, single ? [single.id] : null, params)
              : single
                ? searchBook(config, args.query, single.id, params)
                : searchAllBooks(config, args.query, params),
          searchKeywordFallback({
            kind,
            target: single,
            query: args.query,
            topK: params.topK,
            includeReferences: params.includeReferences,
            cursor: channelCursor,
          }),
        ]);
        const indexed = indexedSettled.status === "fulfilled" ? indexedSettled.value : [];
        const fallback = fallbackSettled.status === "fulfilled" ? fallbackSettled.value : null;
        const merged = mergeHits(indexed, fallback?.hits ?? [], params.topK);
        const notes: string[] = [];
        if (configNote) notes.push(configNote);
        if (indexedSettled.status === "rejected") notes.push(`索引检索失败：${errorText(indexedSettled.reason)}`);
        if (fallbackSettled.status === "rejected") notes.push(`关键词回退失败：${errorText(fallbackSettled.reason)}`);
        if (!merged.hits.length) {
          notes.push(
            kind === "book"
              ? "没有命中：换关键词，或用 getDocumentInfo(doc) 看目录后 readDocument 按章节读。"
              : "没有命中：换关键词，或改用 readDocument 按章节读原文。",
          );
        }
        const fallbackInfo: Partial<Record<"book" | "paper", FallbackStats | null>> = {
          [kind]: fallback?.stats ?? null,
        };
        return {
          query: args.query,
          scope,
          results: merged.hits,
          total: merged.hits.length,
          partial: indexedSettled.status === "rejected" || (fallback?.partial ?? fallbackSettled.status === "rejected"),
          truncated: merged.truncated || (fallback?.truncated ?? false),
          fallback: fallbackInfo,
          next_cursor: finalizeFallbackCursor(
            fallback,
            merged.hits,
            channelCursor,
            kind,
            args.query,
            params.includeReferences,
          ),
          note: notes.length ? notes.join("；") : undefined,
          meta,
        };
      };

      if (effectiveTarget) {
        if (args.cursor) throw new RetrievalScopeError("current/doc 不支持 library/all cursor；请省略 cursor 重试");
        return searchOneKind(effectiveTarget.kind, effectiveTarget, label);
      }
      if (ctx.scope === "reader" && requested === "library") {
        return searchOneKind(
          "book",
          undefined,
          "图书馆（全部书籍）",
          parseCursorChannels(args.cursor, "book").book ?? undefined,
        );
      }
      if (ctx.scope === "paper" && requested === "library") {
        return searchOneKind(
          "paper",
          undefined,
          "论文库（全部论文）",
          parseCursorChannels(args.cursor, "paper").paper ?? undefined,
        );
      }

      const channels = parseCursorChannels(args.cursor);
      const paperActive = channels.paper !== null;
      const bookActive = channels.book !== null;
      const paperContinuing = typeof channels.paper === "string";
      const bookContinuing = typeof channels.book === "string";
      const [paperSettled, bookSettled, paperFallbackSettled, bookFallbackSettled] = await Promise.allSettled([
        paperActive && !paperContinuing ? searchPapers(config, args.query, null, params) : Promise.resolve([]),
        bookActive && !bookContinuing ? searchAllBooks(config, args.query, params) : Promise.resolve([]),
        paperActive
          ? searchKeywordFallback({
              kind: "paper",
              query: args.query,
              topK: params.topK,
              includeReferences: params.includeReferences,
              cursor: channels.paper ?? undefined,
            })
          : Promise.resolve(null),
        bookActive
          ? searchKeywordFallback({
              kind: "book",
              query: args.query,
              topK: params.topK,
              includeReferences: params.includeReferences,
              cursor: channels.book ?? undefined,
            })
          : Promise.resolve(null),
      ]);
      const paperFallback = paperFallbackSettled.status === "fulfilled" ? paperFallbackSettled.value : null;
      const bookFallback = bookFallbackSettled.status === "fulfilled" ? bookFallbackSettled.value : null;
      const paperMerged = mergeHits(
        paperSettled.status === "fulfilled" ? paperSettled.value : [],
        paperFallback?.hits ?? [],
        params.topK,
      );
      const bookMerged = mergeHits(
        bookSettled.status === "fulfilled" ? bookSettled.value : [],
        bookFallback?.hits ?? [],
        params.topK,
      );
      const merged = mergeByRrf(paperMerged.hits, bookMerged.hits, params.topK);
      const emittedPaperHits = merged.filter((hit) => hit.kind === "paper");
      const emittedBookHits = merged.filter((hit) => hit.kind === "book");
      const paperNextCursor = paperActive
        ? finalizeFallbackCursor(
            paperFallback,
            emittedPaperHits,
            channels.paper ?? undefined,
            "paper",
            args.query,
            params.includeReferences,
          )
        : undefined;
      const bookNextCursor = bookActive
        ? finalizeFallbackCursor(
            bookFallback,
            emittedBookHits,
            channels.book ?? undefined,
            "book",
            args.query,
            params.includeReferences,
          )
        : undefined;
      const nextCursor =
        paperNextCursor || bookNextCursor
          ? JSON.stringify({ paper: paperNextCursor ?? null, book: bookNextCursor ?? null })
          : undefined;
      const notes: string[] = [];
      if (configNote) notes.push(configNote);
      if (paperSettled.status === "rejected") notes.push(`论文库检索失败：${errorText(paperSettled.reason)}`);
      if (bookSettled.status === "rejected") notes.push(`书库检索失败：${errorText(bookSettled.reason)}`);
      if (paperFallbackSettled.status === "rejected") {
        notes.push(`论文关键词回退失败：${errorText(paperFallbackSettled.reason)}`);
      }
      if (bookFallbackSettled.status === "rejected") {
        notes.push(`书籍关键词回退失败：${errorText(bookFallbackSettled.reason)}`);
      }
      if (!merged.length) notes.push("跨库没有命中：换关键词，或分别用 doc=book:<id> / doc=paper:<id> 指定文档检索");
      return {
        query: args.query,
        scope: "图书馆+论文库",
        results: merged,
        total: merged.length,
        book_total: bookMerged.hits.length,
        paper_total: paperMerged.hits.length,
        partial:
          paperSettled.status === "rejected" ||
          bookSettled.status === "rejected" ||
          (paperFallback?.partial ?? paperFallbackSettled.status === "rejected") ||
          (bookFallback?.partial ?? bookFallbackSettled.status === "rejected"),
        truncated:
          paperMerged.truncated ||
          bookMerged.truncated ||
          (paperFallback?.truncated ?? false) ||
          (bookFallback?.truncated ?? false) ||
          paperMerged.hits.length + bookMerged.hits.length > params.topK,
        fallback: { paper: paperFallback?.stats ?? null, book: bookFallback?.stats ?? null },
        next_cursor: nextCursor,
        note: notes.length ? notes.join("；") : undefined,
        meta,
      };
    },
  });
};
