import {
  type DocImageContext,
  type DocImageFs,
  isLocalRelativeImageRef,
  resolveDocumentImagePath,
  rewriteDocumentImagePaths,
} from "@/ai/tools/document/image-paths";
import type { BookDoc, SectionItem } from "@/lib/document";
import { appDataDir } from "@tauri-apps/api/path";
import { extractStructuredText } from "./extract-structured-text";

type BookTranslationModule = typeof import("@/services/book-translation/book-translation-service");

const loadFs = () => import("@tauri-apps/plugin-fs");

// 复用同一 openBookDocument，但避免 paper-only readDocument 加载 provider 依赖较重的翻译服务。
async function openBookDocument(bookId: string) {
  const modules = import.meta.glob("../book-translation/book-translation-service.ts") as Record<
    string,
    () => Promise<BookTranslationModule>
  >;
  const load = modules["../book-translation/book-translation-service.ts"];
  if (!load) throw new Error("书籍打开模块加载失败");
  const module = await load();
  return module.openBookDocument(bookId);
}

export interface EpubSection extends SectionItem {
  resolveHref?: (href: string) => string;
}

export interface EpubBookDoc extends BookDoc {
  sections?: EpubSection[];
  loadBlob?: (href: string) => Promise<Blob | null>;
}

export interface BookCanonicalSegment {
  spineIndex: number;
  sectionId: string;
  mdRelPath: string;
  start: number;
  end: number;
  section: EpubSection;
}

export interface BookCanonicalText {
  text: string;
  totalChars: number;
  bookDoc: EpubBookDoc;
  segments: BookCanonicalSegment[];
}

export interface BookSectionQuery {
  heading?: string;
  spine?: number;
  fragment?: string | null;
}

export type BookSectionMatchKind = "hit" | "number" | "fallback" | "spine";

export type BookSectionCanonical =
  | (BookCanonicalText & {
      kind: "ok";
      matchedTitle: string;
      matchKind: BookSectionMatchKind;
      matchedQuery?: string;
      spineIndex: number;
    })
  | { kind: "ambiguous"; candidates: TocEntry[]; total: number }
  | { kind: "none" };

interface TocEntry {
  label: string;
  href?: string;
  subitems?: TocEntry[];
}

interface FlatTocEntry {
  label: string;
  href: string;
}

type TocMatch =
  | { kind: "none" }
  | { kind: "ambiguous"; candidates: FlatTocEntry[]; total: number }
  | { kind: "hit" | "number" | "fallback"; entry: FlatTocEntry; matchedQuery?: string };

const normalize = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();

function flattenToc(items: TocEntry[] | undefined, out: FlatTocEntry[] = []): FlatTocEntry[] {
  for (const item of items ?? []) {
    if (item?.href) out.push({ label: item.label ?? "", href: item.href });
    if (item?.subitems?.length) flattenToc(item.subitems, out);
  }
  return out;
}

const leadingNumber = (value: string) => normalize(value).match(/^\d+(\.\d+)*/)?.[0] ?? null;

function matchTocEntry(entries: FlatTocEntry[], query: string): TocMatch {
  const q = normalize(query);
  if (!q) return { kind: "none" };
  const exact = entries.filter((entry) => normalize(entry.label) === q);
  if (exact.length) return { kind: "hit", entry: exact[0]! };
  const prefix = entries.filter((entry) => normalize(entry.label).startsWith(q));
  if (prefix.length) return { kind: "hit", entry: prefix[0]! };
  const contains = entries.filter((entry) => normalize(entry.label).includes(q));
  if (contains.length === 1) return { kind: "hit", entry: contains[0]! };
  if (contains.length > 1) {
    return {
      kind: "ambiguous",
      candidates: [...contains].sort((a, b) => a.label.length - b.label.length).slice(0, 20),
      total: contains.length,
    };
  }
  const queryNumber = leadingNumber(q);
  if (queryNumber) {
    const byNumber = entries.filter((entry) => leadingNumber(entry.label) === queryNumber);
    if (byNumber.length) return { kind: "number", entry: byNumber[0]!, matchedQuery: queryNumber };
    const segments = queryNumber.split(".");
    for (let length = segments.length - 1; length >= 1; length--) {
      const parent = segments.slice(0, length).join(".");
      const hit = entries.filter((entry) => leadingNumber(entry.label) === parent);
      if (hit.length) return { kind: "fallback", entry: hit[0]!, matchedQuery: parent };
    }
  }
  return { kind: "none" };
}

function resolveHref(bookDoc: EpubBookDoc, href: string): { spineIndex: number; fragment: string | null } | null {
  const [file, fragment] = href.split("#");
  const sections = bookDoc.sections ?? [];
  const norm = (path: string) => path.replace(/^\.\//, "").replace(/\\/g, "/");
  const target = norm(file ?? "");
  let index = sections.findIndex((section) => norm(section.id ?? "") === target);
  if (index < 0) {
    index = sections.findIndex(
      (section) => target.endsWith(norm(section.id ?? "")) || norm(section.id ?? "").endsWith(target),
    );
  }
  if (index < 0) {
    index = sections.findIndex((section) => (section.id ?? "").split("/").pop() === target.split("/").pop());
  }
  if (index < 0) return null;
  return { spineIndex: index, fragment: fragment || null };
}

function mdRelPathOf(sectionId: string): string {
  const bare = sectionId
    .split("#")[0]!
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment && segment !== ".")
    .join("/");
  return /\.x?html$/i.test(bare) ? bare.replace(/\.x?html$/i, ".md") : bare;
}

async function readResolvedSection(
  bookDoc: EpubBookDoc,
  spineIndex: number,
  fragment: string | null,
  matchedTitle: string,
  matchKind: BookSectionMatchKind,
  matchedQuery?: string,
): Promise<BookSectionCanonical> {
  const section = bookDoc.sections?.[spineIndex];
  const doc = await section?.createDocument?.();
  if (!section || !doc) return { kind: "none" };
  const anchor = fragment ? doc.getElementById(fragment) : null;
  const { text, totalChars } = extractStructuredText(doc, anchor);
  return {
    kind: "ok",
    text,
    totalChars,
    bookDoc,
    matchedTitle,
    matchKind,
    matchedQuery,
    spineIndex,
    segments: [
      {
        spineIndex,
        sectionId: section.id,
        mdRelPath: mdRelPathOf(section.id),
        start: 0,
        end: text.length,
        section,
      },
    ],
  };
}

export async function readBookSectionCanonical(
  bookId: string,
  query: string | BookSectionQuery,
): Promise<BookSectionCanonical> {
  const { bookDoc: opened } = await openBookDocument(bookId);
  const bookDoc = opened as EpubBookDoc;
  const request = typeof query === "string" ? { heading: query } : query;
  const entries = flattenToc(bookDoc.toc);

  if (request.spine != null) {
    const spineIndex = request.spine;
    const section = bookDoc.sections?.[spineIndex];
    if (!section || !Number.isInteger(spineIndex)) return { kind: "none" };
    const fragment = request.fragment ?? null;
    const matched =
      entries.find((entry) => {
        const resolved = resolveHref(bookDoc, entry.href);
        return resolved?.spineIndex === spineIndex && (!fragment || resolved.fragment === fragment);
      }) ?? entries.find((entry) => resolveHref(bookDoc, entry.href)?.spineIndex === spineIndex);
    return readResolvedSection(bookDoc, spineIndex, fragment, matched?.label ?? `spine ${spineIndex + 1}`, "spine");
  }

  const match = matchTocEntry(entries, request.heading ?? "");
  if (match.kind === "ambiguous") {
    return { kind: "ambiguous", candidates: match.candidates, total: match.total };
  }
  if (match.kind === "none") return { kind: "none" };
  const resolved = resolveHref(bookDoc, match.entry.href);
  if (!resolved) return { kind: "none" };
  return readResolvedSection(
    bookDoc,
    resolved.spineIndex,
    resolved.fragment,
    match.entry.label,
    match.kind,
    match.matchedQuery,
  );
}

async function buildBookDocumentCanonical(bookId: string): Promise<BookCanonicalText> {
  const { bookDoc: opened } = await openBookDocument(bookId);
  const bookDoc = opened as EpubBookDoc;
  const segments: BookCanonicalSegment[] = [];
  let text = "";
  for (const [spineIndex, section] of (bookDoc.sections ?? []).entries()) {
    if (section.linear === "no") continue;
    const doc = await section.createDocument?.();
    if (!doc) continue;
    const extracted = extractStructuredText(doc, null).text;
    if (!extracted) continue;
    if (segments.length > 0) text += "\n\n";
    const start = text.length;
    text += extracted;
    segments.push({
      spineIndex,
      sectionId: section.id,
      mdRelPath: mdRelPathOf(section.id),
      start,
      end: text.length,
      section,
    });
  }
  return { text, totalChars: text.length, bookDoc, segments };
}

const FULL_BOOK_CACHE_SIZE = 2;
const fullBookCache = new Map<string, BookCanonicalText>();
const fullBookPending = new Map<string, Promise<BookCanonicalText>>();

export async function readBookDocumentCanonical(bookId: string): Promise<BookCanonicalText> {
  const cached = fullBookCache.get(bookId);
  if (cached) {
    fullBookCache.delete(bookId);
    fullBookCache.set(bookId, cached);
    return cached;
  }
  const pending = fullBookPending.get(bookId);
  if (pending) return pending;

  const building = buildBookDocumentCanonical(bookId);
  fullBookPending.set(bookId, building);
  try {
    const canonical = await building;
    fullBookCache.set(bookId, canonical);
    while (fullBookCache.size > FULL_BOOK_CACHE_SIZE) {
      const oldest = fullBookCache.keys().next().value;
      if (oldest === undefined) break;
      fullBookCache.delete(oldest);
    }
    return canonical;
  } finally {
    fullBookPending.delete(bookId);
  }
}

export interface BookImageWindow extends BookCanonicalText {
  /** 返回切片在原 canonical 中的起点；图片 occurrence 用它找回所属 spine。 */
  windowStart?: number;
}

const DOC_IMAGE_FS: DocImageFs = {
  exists: async (path: string) => (await loadFs()).exists(path).catch(() => false),
  listDir: async (path: string) => {
    try {
      const fs = await loadFs();
      const entries = await fs.readDir(path);
      return entries.filter((entry) => entry.isDirectory).map((entry) => entry.name);
    } catch {
      return [];
    }
  },
};

function segmentAt(source: BookImageWindow, position: number): BookCanonicalSegment | null {
  return (
    source.segments.find((segment) => position >= segment.start && position < segment.end) ??
    source.segments.find((segment) => position >= segment.start && position <= segment.end) ??
    null
  );
}

function resolveEpubHref(section: EpubSection, ref: string): string | null {
  try {
    if (section.resolveHref) return section.resolveHref(ref).split("#")[0] || null;
    const url = new URL(ref, `https://invalid.invalid/${section.id}`);
    url.search = "";
    url.hash = "";
    return decodeURI(url.pathname.replace(/^\//, "")) || null;
  } catch {
    return null;
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function materializeEpubImage(
  bookId: string,
  source: BookImageWindow,
  segment: BookCanonicalSegment,
  ref: string,
  appData: string,
): Promise<string | null> {
  if (!source.bookDoc.loadBlob || !isLocalRelativeImageRef(ref)) return null;
  const href = resolveEpubHref(segment.section, ref);
  if (!href) return null;
  const hash = await sha256(`${bookId}\0${href}`);
  const extension = /(?:\.[a-z0-9]{1,8})$/i.exec(href)?.[0].toLowerCase() ?? ".img";
  const safeBookId = bookId.replace(/[^A-Za-z0-9_-]/g, "_");
  const directory = `${appData}/image-cache/epub/${safeBookId}`;
  const path = `${directory}/${hash}${extension}`;
  if (await DOC_IMAGE_FS.exists(path)) return path;
  try {
    const blob = await source.bookDoc.loadBlob(href);
    if (!blob) return null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const fs = await loadFs();
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path, bytes);
    return path;
  } catch {
    return null;
  }
}

/** 仅解析已经切好的窗口；缺盘图片才按窗口 occurrence 读取对应 foliate blob。 */
export async function resolveBookWindowImages(bookId: string, text: string, source: BookImageWindow): Promise<string> {
  if (!text || (!text.includes("![") && !/<img/i.test(text))) return text;
  try {
    const appData = (await appDataDir()).replace(/\\/g, "/").replace(/\/+$/, "");
    const docDir = `${appData}/books/${bookId}`;
    const ctx: DocImageContext = {
      kind: "book",
      docDir,
      resolveOccurrence: async (ref, index) => {
        const segment = segmentAt(source, (source.windowStart ?? 0) + index);
        if (!segment) return null;
        return resolveDocumentImagePath(ref, { kind: "book", docDir, mdRelPath: segment.mdRelPath }, DOC_IMAGE_FS);
      },
      resolveMissing: async (ref, index) => {
        const segment = segmentAt(source, (source.windowStart ?? 0) + index);
        return segment ? materializeEpubImage(bookId, source, segment, ref, appData) : null;
      },
    };
    return await rewriteDocumentImagePaths(text, ctx, DOC_IMAGE_FS);
  } catch {
    return text;
  }
}
