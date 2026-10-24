import { readPaperMarkdown } from "@/ai/tools/paper/shared";
import { parsePaperSections } from "@/pages/paper-reader/markdown-sections";
import { readBookSectionCanonical } from "@/services/book-content/book-reading-adapter";
import { invoke } from "@tauri-apps/api/core";
import { appDataDir } from "@tauri-apps/api/path";
import { exists, readDir } from "@tauri-apps/plugin-fs";
import { findCanonicalMatch } from "./canonical-match";
import { type DocRef, bookIndexed, clipSnippet, docRefString, paperIndexed, readDocMetadata } from "./shared";

export type LibrarySource = "hybrid" | "bm25" | "keyword" | "title";
export type AnchorPrecision = "exact" | "section";

export interface LibraryReadAnchor {
  doc: string;
  heading?: string;
  spine?: number;
  offset?: number;
}

export interface LibraryHit {
  doc: string;
  title: string | null;
  chapter?: string | null;
  snippet: string;
  chunk_id: number | null;
  similarity: number;
  kind: "book" | "paper";
  source: LibrarySource;
  index: { status: "indexed" | "not_indexed"; note?: string };
  read: LibraryReadAnchor;
  anchor_precision: AnchorPrecision;
}

export interface FallbackStats {
  candidate_documents: number;
  scanned_documents: number;
  title_documents: number;
  scanned_sections: number;
  errors: number;
  partial: boolean;
  truncated: boolean;
}

export interface FallbackCursor {
  v: 1;
  kind: "book" | "paper";
  query: string;
  includeReferences: boolean;
  offset: number;
  seen: string[];
  partial: boolean;
  truncated: boolean;
}

export interface FallbackCursorPage {
  state: FallbackCursor;
  startOffset: number;
  hasMore: boolean;
}

export interface FallbackSearchResult {
  hits: LibraryHit[];
  partial: boolean;
  truncated: boolean;
  stats: FallbackStats;
  nextCursor?: FallbackCursorPage;
}

interface PaperChunkLike {
  paper_id: string;
  book_title: string;
  content: string;
  similarity: number;
  chunk_id: number | null;
}

interface BookChunkLike {
  bookId?: string;
  bookTitle?: string;
  book_title?: string;
  chapter?: string;
  related_chapter_titles?: string;
  content: string;
  similarity: number;
  chunkId?: number | null;
  chunk_id?: number | null;
}

interface DocumentDescriptor {
  doc: DocRef;
  title: string;
  indexed: boolean;
  errors: string[];
}

interface EpubTextHit {
  heading: string;
  spine: number;
  snippet: string;
  match_kind: "keyword" | "title";
}

interface EpubTextSearchResult {
  results: EpubTextHit[];
  scanned_sections?: number;
  scannedSections?: number;
  partial: boolean;
}

export interface KeywordFallbackOptions {
  kind: "book" | "paper";
  target?: DocRef;
  query: string;
  topK: number;
  includeReferences: boolean;
  cursor?: string;
}

const MAX_LIBRARY_PAPERS = 8;
const MAX_LIBRARY_BOOKS = 6;
const MAX_LIBRARY_BOOK_SECTIONS = 24;
const BOOK_SCAN_DURATION_MS = 1200;
const LIBRARY_SCAN_BUDGET_MS = 5000;
const epubInflight = new Map<string, Promise<EpubTextSearchResult>>();

function similarity(value: number): number {
  return Number.parseFloat((value * 100).toFixed(1));
}

function terms(query: string): string[] {
  return query
    .trim()
    .split(/\s+/u)
    .map((term) => term.trim())
    .filter(Boolean);
}

function findInsensitive(text: string, query: string, from = 0): number | null {
  if (!query) return null;
  const foldedText = text.toLowerCase();
  const foldedQuery = query.toLowerCase();
  let at = foldedText.indexOf(foldedQuery, Math.max(0, from));
  while (at >= 0) {
    if (text.slice(at, at + query.length).toLowerCase() === foldedQuery) return at;
    at = foldedText.indexOf(foldedQuery, at + 1);
  }
  return null;
}

function matchesTitle(title: string, query: string): boolean {
  const folded = title.toLowerCase();
  return terms(query).every((term) => folded.includes(term.toLowerCase()));
}

function normalizedSnippet(value: string): string {
  const trimmed = value.trimEnd();
  return (trimmed.endsWith("…") ? trimmed.slice(0, -1) : trimmed).replace(/\s+/gu, " ").trim();
}

function titleHit(descriptor: DocumentDescriptor): LibraryHit {
  const doc = docRefString(descriptor.doc);
  return {
    doc,
    title: descriptor.title,
    chapter: null,
    snippet: clipSnippet(descriptor.title, 400),
    chunk_id: null,
    similarity: 100,
    kind: descriptor.doc.kind,
    source: "title",
    index: { status: descriptor.indexed ? "indexed" : "not_indexed" },
    read: { doc, offset: 0 },
    anchor_precision: "section",
  };
}

function paperHeadingAt(parsed: ReturnType<typeof parsePaperSections>, offset: number): string | null {
  for (let index = 0; index < parsed.headings.length; index += 1) {
    const heading = parsed.headings[index]!;
    const next = parsed.headings[index + 1];
    if (offset >= heading.start && (next == null || offset < next.start)) return heading.text;
  }
  return null;
}

function paperSectionRanges(parsed: ReturnType<typeof parsePaperSections>) {
  const ranges: { heading: string | null; start: number; end: number }[] = [];
  const first = parsed.headings[0];
  if (!first) return [{ heading: null, start: 0, end: parsed.body.length }];
  if (first.start > 0) ranges.push({ heading: null, start: 0, end: first.start });
  for (let index = 0; index < parsed.headings.length; index += 1) {
    const heading = parsed.headings[index]!;
    ranges.push({
      heading: heading.text,
      start: heading.contentStart,
      end: parsed.headings[index + 1]?.start ?? parsed.body.length,
    });
  }
  return ranges.filter((range) => range.end > range.start);
}

function isReferencesHeading(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return /^references\b/.test(normalized) || /^bibliography\b/.test(normalized) || normalized.includes("参考文献");
}

function referenceRanges(parsed: ReturnType<typeof parsePaperSections>) {
  return parsed.headings
    .filter((heading) => isReferencesHeading(heading.text))
    .map((heading) => {
      const index = parsed.headings.indexOf(heading);
      const next = parsed.headings.slice(index + 1).find((item) => item.level <= heading.level);
      return { start: heading.start, end: next?.start ?? parsed.body.length };
    });
}

export async function paperChunkToLibraryHit(item: PaperChunkLike, source: "hybrid" | "bm25"): Promise<LibraryHit> {
  const doc = `paper:${item.paper_id}`;
  const parsed = parsePaperSections(await readPaperMarkdown(item.paper_id));
  const direct = findCanonicalMatch(parsed.body, item.content);
  let read: LibraryReadAnchor = { doc };
  let precision: AnchorPrecision = "section";
  let chapter: string | null = null;

  if (direct.offset != null) {
    read = { doc, offset: direct.offset };
    precision = "exact";
    chapter = paperHeadingAt(parsed, direct.offset);
  } else {
    const candidates: { heading: string; offset: number | null }[] = [];
    for (const range of paperSectionRanges(parsed)) {
      if (!range.heading) continue;
      const text = parsed.body.slice(range.start, range.end);
      const local = findCanonicalMatch(text, item.content);
      if (local.offset != null) candidates.push({ heading: range.heading, offset: range.start + local.offset });
      else if (
        normalizedSnippet(item.content) &&
        text.replace(/\s+/gu, " ").includes(normalizedSnippet(item.content))
      ) {
        candidates.push({ heading: range.heading, offset: null });
      }
    }
    if (candidates.length === 1) {
      const candidate = candidates[0]!;
      chapter = candidate.heading;
      if (candidate.offset != null) {
        read = { doc, offset: candidate.offset };
        precision = "exact";
      } else {
        read = { doc, heading: candidate.heading };
      }
    }
  }

  return {
    doc,
    title: item.book_title || null,
    chapter,
    snippet: clipSnippet(item.content, 400),
    chunk_id: item.chunk_id,
    similarity: similarity(item.similarity),
    kind: "paper",
    source,
    index: { status: "indexed" },
    read,
    anchor_precision: precision,
  };
}

export async function bookChunkToLibraryHit(
  bookId: string,
  item: BookChunkLike,
  source: "hybrid" | "bm25",
): Promise<LibraryHit> {
  const doc = `book:${bookId}`;
  const chapter = item.related_chapter_titles || item.chapter || null;
  let read: LibraryReadAnchor = chapter ? { doc, heading: chapter } : { doc, offset: 0 };
  let precision: AnchorPrecision = "section";
  let matchedChapter = chapter;
  if (chapter) {
    const canonical = await readBookSectionCanonical(bookId, { heading: chapter }).catch(() => null);
    if (canonical?.kind === "ok") {
      const matched = findCanonicalMatch(canonical.text, item.content);
      matchedChapter = canonical.matchedTitle;
      read = { doc, heading: canonical.matchedTitle };
      if (matched.offset != null) {
        read.offset = matched.offset;
        precision = "exact";
      }
    } else if (canonical?.kind === "ambiguous") {
      read = { doc, offset: 0 };
    }
  }
  return {
    doc,
    title: item.bookTitle || item.book_title || null,
    chapter: matchedChapter,
    snippet: clipSnippet(item.content, 400),
    chunk_id: item.chunkId ?? item.chunk_id ?? null,
    similarity: similarity(item.similarity),
    kind: "book",
    source,
    index: { status: "indexed" },
    read,
    anchor_precision: precision,
  };
}

async function mapBounded<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function describeDocument(doc: DocRef): Promise<DocumentDescriptor> {
  const errors: string[] = [];
  const [metadata, indexed] = await Promise.all([
    readDocMetadata(doc, (error) => errors.push(error instanceof Error ? error.message : String(error))),
    doc.kind === "paper" ? paperIndexed(doc.id) : bookIndexed(doc.id),
  ]);
  const title = typeof metadata.title === "string" && metadata.title.trim() ? metadata.title.trim() : doc.id;
  return { doc, title, indexed, errors };
}

export function fallbackHitCursorKey(hit: LibraryHit): string {
  if (typeof hit.read.offset === "number") {
    if (hit.kind === "book") {
      return `${hit.doc}|spine:${hit.read.spine ?? ""}|heading:${hit.read.heading ?? ""}|${hit.read.offset}`;
    }
    return `${hit.doc}|${hit.read.offset}`;
  }
  return `${hit.doc}|heading:${hit.read.heading ?? ""}|spine:${hit.read.spine ?? ""}`;
}

export function encodeFallbackCursor(state: FallbackCursor): string {
  return encodeURIComponent(JSON.stringify(state));
}

export function decodeFallbackCursor(
  options: Pick<KeywordFallbackOptions, "kind" | "query" | "includeReferences" | "cursor">,
): FallbackCursor {
  if (!options.cursor) {
    return {
      v: 1,
      kind: options.kind,
      query: options.query,
      includeReferences: options.includeReferences,
      offset: 0,
      seen: [],
      partial: false,
      truncated: false,
    };
  }
  try {
    const parsed = JSON.parse(decodeURIComponent(options.cursor)) as Partial<FallbackCursor>;
    if (
      parsed.v !== 1 ||
      parsed.kind !== options.kind ||
      parsed.query !== options.query ||
      parsed.includeReferences !== options.includeReferences ||
      typeof parsed.offset !== "number" ||
      !Number.isFinite(parsed.offset) ||
      parsed.offset < 0 ||
      !Array.isArray(parsed.seen) ||
      !parsed.seen.every((key) => typeof key === "string")
    ) {
      throw new Error("cursor shape/query mismatch");
    }
    return {
      v: 1,
      kind: options.kind,
      query: options.query,
      includeReferences: options.includeReferences,
      offset: Math.floor(parsed.offset),
      seen: parsed.seen,
      partial: parsed.partial === true,
      truncated: parsed.truncated === true,
    };
  } catch (error) {
    throw new Error(`检索 cursor 无效或与当前查询不匹配: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isNotFoundError(error: unknown): boolean {
  const code =
    error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  if (code === "ENOENT") return true;
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes("enoent") || message.includes("no such file") || message.includes("os error 2");
}

async function listDocuments(kind: "book" | "paper"): Promise<{ documents: DocumentDescriptor[]; errors: number }> {
  const base = (await appDataDir()).replace(/\\/g, "/").replace(/\/+$/, "");
  const booksDir = `${base}/books`;
  const entries = await readDir(booksDir).catch((error) => {
    if (isNotFoundError(error)) return [];
    throw error;
  });
  const candidates = entries
    .filter((entry) => entry.isDirectory)
    .map((entry) => entry.name)
    .sort()
    .map((id) => ({ kind, id }) as DocRef);
  const probes = await mapBounded(candidates, 4, async (doc) => {
    const marker = kind === "paper" ? "paper.md" : "book.epub";
    try {
      return { doc: (await exists(`${booksDir}/${doc.id}/${marker}`)) ? doc : null, error: false };
    } catch (error) {
      return { doc: null, error: !isNotFoundError(error) };
    }
  });
  const existing = probes.flatMap((probe) => (probe.doc ? [probe.doc] : []));
  const documents = await mapBounded(existing, 4, describeDocument);
  return { documents, errors: probes.filter((probe) => probe.error).length };
}

function keywordMatch(text: string, query: string): number | null {
  const queryTerms = terms(query);
  if (!queryTerms.length) return null;
  const offsets: number[] = [];
  for (const term of queryTerms) {
    const offset = findInsensitive(text, term);
    if (offset == null) return null;
    offsets.push(offset);
  }
  return Math.min(...offsets);
}

async function searchPaperDocument(
  descriptor: DocumentDescriptor,
  query: string,
  includeReferences: boolean,
): Promise<LibraryHit[]> {
  const parsed = parsePaperSections(await readPaperMarkdown(descriptor.doc.id));
  const excluded = includeReferences ? [] : referenceRanges(parsed);
  const doc = docRefString(descriptor.doc);
  const hits: LibraryHit[] = [];
  for (const range of paperSectionRanges(parsed)) {
    if (excluded.some((reference) => range.start >= reference.start && range.start < reference.end)) continue;
    const text = parsed.body.slice(range.start, range.end);
    const localOffset = keywordMatch(text, query);
    if (localOffset == null) continue;
    const offset = range.start + localOffset;
    hits.push({
      doc,
      title: descriptor.title,
      chapter: range.heading ?? paperHeadingAt(parsed, offset),
      snippet: clipSnippet(parsed.body.slice(Math.max(range.start, offset - 160), offset + 240), 400),
      chunk_id: null,
      similarity: 80,
      kind: "paper",
      source: "keyword",
      index: { status: descriptor.indexed ? "indexed" : "not_indexed" },
      read: { doc, offset },
      anchor_precision: "exact",
    });
  }
  return hits;
}

async function invokeEpubTextSearch(
  bookId: string,
  query: string,
  topK: number,
  includeReferences: boolean,
  bounded: boolean,
): Promise<EpubTextSearchResult> {
  const key = JSON.stringify([bookId, query, topK, includeReferences, bounded]);
  const pending = epubInflight.get(key);
  if (pending) return pending;
  const request = invoke<EpubTextSearchResult>("plugin:epub|search_epub_text", {
    bookId,
    query,
    limit: topK,
    maxSections: bounded ? MAX_LIBRARY_BOOK_SECTIONS : null,
    maxDurationMs: bounded ? BOOK_SCAN_DURATION_MS : null,
    includeReferences,
  });
  epubInflight.set(key, request);
  try {
    return await request;
  } finally {
    epubInflight.delete(key);
  }
}

async function searchBookDocument(
  descriptor: DocumentDescriptor,
  query: string,
  topK: number,
  includeReferences: boolean,
  bounded: boolean,
): Promise<{ hits: LibraryHit[]; scannedSections: number; partial: boolean }> {
  const result = await invokeEpubTextSearch(descriptor.doc.id, query, topK, includeReferences, bounded);
  const doc = docRefString(descriptor.doc);
  const hits = await mapBounded(result.results, 3, async (item): Promise<LibraryHit> => {
    let read: LibraryReadAnchor = { doc, spine: item.spine, heading: item.heading };
    let precision: AnchorPrecision = "section";
    let chapter = item.heading;
    const canonical = await readBookSectionCanonical(descriptor.doc.id, { spine: item.spine }).catch(() => null);
    if (canonical?.kind === "ok") {
      chapter = canonical.matchedTitle;
      read = { doc, spine: item.spine, heading: canonical.matchedTitle };
      const matched = findCanonicalMatch(canonical.text, item.snippet);
      if (matched.offset != null) {
        const nearby = canonical.text.slice(matched.offset, matched.offset + item.snippet.length + 400);
        const queryOffset = keywordMatch(nearby, query);
        read.offset = queryOffset == null ? matched.offset : matched.offset + queryOffset;
        precision = "exact";
      }
    }
    return {
      doc,
      title: descriptor.title,
      chapter,
      snippet: clipSnippet(item.snippet || item.heading, 400),
      chunk_id: null,
      similarity: item.match_kind === "title" ? 90 : 80,
      kind: "book",
      source: item.match_kind === "title" ? "title" : "keyword",
      index: { status: descriptor.indexed ? "indexed" : "not_indexed" },
      read,
      anchor_precision: precision,
    };
  });
  return {
    hits,
    scannedSections: result.scanned_sections ?? result.scannedSections ?? 0,
    partial: result.partial,
  };
}

function sortAndClip(hits: LibraryHit[], topK: number): { hits: LibraryHit[]; truncated: boolean } {
  const sorted = hits
    .map((hit, index) => ({ hit, index }))
    .sort((left, right) => right.hit.similarity - left.hit.similarity || left.index - right.index)
    .map(({ hit }) => hit);
  return { hits: sorted.slice(0, topK), truncated: sorted.length > topK };
}

export async function searchKeywordFallback(options: KeywordFallbackOptions): Promise<FallbackSearchResult> {
  const targetMode = options.target != null;
  if (targetMode && options.cursor) throw new Error("current/doc 不支持 library/all cursor；请省略 cursor 重试");
  const cursor = decodeFallbackCursor(options);
  const seen = new Set(cursor.seen);
  const discovery = options.target
    ? { documents: [await describeDocument(options.target)], errors: 0 }
    : await listDocuments(options.kind);
  const descriptors = discovery.documents;
  const hits = descriptors
    .filter((item) => matchesTitle(item.title, options.query))
    .map(titleHit)
    .filter((hit) => !seen.has(fallbackHitCursorKey(hit)));
  const candidates = targetMode ? descriptors : descriptors.filter((item) => !item.indexed);
  const startOffset = targetMode ? 0 : Math.min(cursor.offset, candidates.length);
  const pageSize = options.kind === "paper" ? MAX_LIBRARY_PAPERS : MAX_LIBRARY_BOOKS;
  const endOffset = targetMode ? candidates.length : Math.min(startOffset + pageSize, candidates.length);
  const selected = candidates.slice(startOffset, endOffset);
  const started = Date.now();
  let deadlineStopped = false;
  const outcomes = await mapBounded(selected, options.kind === "paper" ? 3 : 2, async (descriptor) => {
    if (!targetMode && Date.now() - started > LIBRARY_SCAN_BUDGET_MS) {
      deadlineStopped = true;
      return { hits: [] as LibraryHit[], scanned: false, scannedSections: 0, partial: true, error: false };
    }
    try {
      if (options.kind === "paper") {
        const paperHits = await searchPaperDocument(descriptor, options.query, options.includeReferences);
        return { hits: paperHits, scanned: true, scannedSections: 0, partial: false, error: false };
      }
      const bookResult = await searchBookDocument(
        descriptor,
        options.query,
        options.topK,
        options.includeReferences,
        !targetMode,
      );
      return {
        hits: bookResult.hits,
        scanned: true,
        scannedSections: bookResult.scannedSections,
        partial: bookResult.partial,
        error: false,
      };
    } catch {
      return { hits: [] as LibraryHit[], scanned: true, scannedSections: 0, partial: true, error: true };
    }
  });
  for (const outcome of outcomes) hits.push(...outcome.hits.filter((hit) => !seen.has(fallbackHitCursorKey(hit))));
  const scannedDocuments = outcomes.filter((outcome) => outcome.scanned).length;
  const metadataErrors = descriptors.reduce((total, descriptor) => total + descriptor.errors.length, 0);
  const errors = discovery.errors + metadataErrors + outcomes.filter((outcome) => outcome.error).length;
  const remaining = endOffset < candidates.length;
  const partial =
    cursor.partial || deadlineStopped || remaining || outcomes.some((outcome) => outcome.partial) || errors > 0;
  const clipped = sortAndClip(hits, options.topK);
  const stats: FallbackStats = {
    candidate_documents: candidates.length,
    scanned_documents: scannedDocuments,
    title_documents: descriptors.length,
    scanned_sections: outcomes.reduce((total, outcome) => total + outcome.scannedSections, 0),
    errors,
    partial,
    truncated: cursor.truncated || clipped.truncated || partial,
  };
  const hasMore = !targetMode && (remaining || clipped.truncated);
  const nextCursor: FallbackCursorPage | undefined = hasMore
    ? {
        state: {
          v: 1,
          kind: options.kind,
          query: options.query,
          includeReferences: options.includeReferences,
          offset: clipped.truncated ? startOffset : endOffset,
          seen: [...new Set([...seen, ...clipped.hits.map(fallbackHitCursorKey)])],
          partial,
          truncated: stats.truncated,
        },
        startOffset,
        hasMore: true,
      }
    : undefined;
  return { hits: clipped.hits, partial, truncated: stats.truncated, stats, nextCursor };
}
