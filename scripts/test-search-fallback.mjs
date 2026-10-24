// Task 7：检索锚点、参数恢复与未索引互补回退。
// 运行：node scripts/test-search-fallback.mjs
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, "packages/app/src");
const pnpmDir = join(root, "node_modules", ".pnpm");
const esbuildPkg = readdirSync(pnpmDir).find((d) => d.startsWith("esbuild@"));
if (!esbuildPkg) {
  console.error("FAIL 未找到 esbuild");
  process.exit(1);
}
const esbuild = await import(pathToFileURL(join(pnpmDir, esbuildPkg, "node_modules", "esbuild", "lib", "main.js")).href);

const outDir = mkdtempSync(join(tmpdir(), "search-fallback-"));
process.on("exit", () => rmSync(outDir, { recursive: true, force: true }));
const fixtureApp = join(outDir, "fixture-app");
const asUrl = (path) => pathToFileURL(path).href;
const tsPath = (path) => path.replace(/\\/g, "/");

globalThis.__SAGEREAD_SEARCH_TEST__ = {
  appData: fixtureApp,
  vectorConfig: { embeddingsUrl: "http://vector.test/v1/embeddings", model: "test-embed", apiKey: null, dimension: 1024 },
  vectorError: null,
  paperIndexError: null,
  indexedPapers: new Set(),
  invokeCalls: [],
  paperSearch: null,
  bookSearch: null,
  allBooksSearch: null,
  epubSearch: null,
  epubDelay: 0,
  epubActive: 0,
  epubMaxActive: 0,
  books: Object.create(null),
  bookSectionReads: [],
  fullBookReads: [],
  fsFailures: [],
  canonicalFailures: new Set(),
};
const state = globalThis.__SAGEREAD_SEARCH_TEST__;

const STUBS = {
  "@tauri-apps/api/path": "export const appDataDir = async () => globalThis.__SAGEREAD_SEARCH_TEST__.appData;",
  "@/utils/model": `
    export async function getCurrentVectorModelConfig() {
      const state = globalThis.__SAGEREAD_SEARCH_TEST__;
      if (state.vectorError) throw new Error(state.vectorError);
      return state.vectorConfig;
    }
  `,
  "@tauri-apps/api/core": `
    async function defaultEpubSearch(bookId, args) {
      const state = globalThis.__SAGEREAD_SEARCH_TEST__;
      const book = state.books[bookId];
      if (!book) throw new Error("missing book fixture: " + bookId);
      state.epubActive += 1;
      state.epubMaxActive = Math.max(state.epubMaxActive, state.epubActive);
      if (state.epubDelay) await new Promise((resolve) => setTimeout(resolve, state.epubDelay));
      try {
        const cap = args.maxSections == null ? book.sections.length : Math.min(args.maxSections, book.sections.length);
        const results = [];
        const needle = String(args.query || "").toLowerCase();
        for (let spine = 0; spine < cap; spine++) {
          const section = book.sections[spine];
          const headingAt = section.heading.toLowerCase().indexOf(needle);
          const bodyAt = section.text.toLowerCase().indexOf(needle);
          if (headingAt < 0 && bodyAt < 0) continue;
          const at = bodyAt >= 0 ? bodyAt : 0;
          results.push({
            heading: section.heading,
            spine,
            snippet: section.text.slice(Math.max(0, at - 80), at + 220),
            match_kind: headingAt >= 0 ? "title" : "keyword",
          });
          if (results.length >= (args.limit || 6)) break;
        }
        return { results, scannedSections: cap, scanned_sections: cap, partial: cap < book.sections.length };
      } finally {
        state.epubActive -= 1;
      }
    }
    export async function invoke(command, args) {
      const state = globalThis.__SAGEREAD_SEARCH_TEST__;
      state.invokeCalls.push({ command, args });
      if (command === "plugin:epub|paper_index_status") {
        if (state.paperIndexError) throw new Error(state.paperIndexError);
        const indexed = state.indexedPapers.has(args.paperId);
        return { indexed, chunkCount: indexed ? 10 : 0 };
      }
      if (command === "plugin:epub|search_papers_db") {
        return state.paperSearch ? state.paperSearch(args) : [];
      }
      if (command === "plugin:epub|search_db") {
        if (state.bookSearch) return state.bookSearch(args.bookId, args);
        return [];
      }
      if (command === "plugin:epub|search_all_books_db") {
        return state.allBooksSearch ? state.allBooksSearch(args) : [];
      }
      if (command === "plugin:epub|search_epub_text") {
        return state.epubSearch ? state.epubSearch(args.bookId, args) : defaultEpubSearch(args.bookId, args);
      }
      if (command === "plugin:epub|read_book_section") {
        const text = "Incompatible flattened Rust text";
        return { matchedTitle: args.chapterTitle, text, truncated: false, totalChars: text.length, pages: 1 };
      }
      throw new Error("unexpected invoke: " + command);
    }
  `,
  "@tauri-apps/plugin-fs": `
    import { existsSync } from "node:fs";
    import { readFile, readdir } from "node:fs/promises";
    function throwFsFailure(kind, path) {
      const state = globalThis.__SAGEREAD_SEARCH_TEST__;
      const normalized = String(path).split(String.fromCharCode(92)).join("/");
      const failure = state.fsFailures.find((rule) => rule.kind === kind && normalized.includes(rule.match));
      if (failure) throw Object.assign(new Error(failure.code + " injected " + kind + " failure"), { code: failure.code });
    }
    export const exists = async (path) => {
      throwFsFailure("exists", path);
      return existsSync(path);
    };
    export const readTextFile = (path) => {
      throwFsFailure("readTextFile", path);
      return readFile(path, "utf8");
    };
    export const readDir = async (path) => {
      throwFsFailure("readDir", path);
      return (await readdir(path, { withFileTypes: true })).map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
      }));
    };
  `,
  "@/services/book-translation/book-translation-service": `
    export async function openBookDocument(bookId) {
      const book = globalThis.__SAGEREAD_SEARCH_TEST__.books[bookId];
      if (!book) throw new Error("missing book fixture: " + bookId);
      return { bookDoc: { toc: book.sections.map((section) => ({ label: section.heading, subitems: [] })) } };
    }
  `,
};

async function bundle() {
  const entry = join(outDir, "search-fallback-entry.ts");
  const outfile = join(outDir, "search-fallback.mjs");
  writeFileSync(
    entry,
    [
      `export { createSearchLibraryTool } from "${tsPath(join(src, "ai/tools/document/search-library.ts"))}";`,
      `export { createReadDocumentTool } from "${tsPath(join(src, "ai/tools/document/read-document.ts"))}";`,
      `export { createGetDocumentInfoTool } from "${tsPath(join(src, "ai/tools/document/get-document-info.ts"))}";`,
      `export { parsePaperSections } from "${tsPath(join(src, "pages/paper-reader/markdown-sections.ts"))}";`,
      `export { searchKeywordFallback } from "${tsPath(join(src, "ai/tools/document/search-fallback.ts"))}";`,
    ].join("\n"),
  );
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile,
    alias: { "@": src },
    plugins: [
      {
        name: "search-fallback-test-stubs",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) =>
            STUBS[args.path] ? { path: args.path, namespace: "search-stub" } : null,
          );
          build.onLoad({ filter: /.*/, namespace: "search-stub" }, (args) => ({
            contents: STUBS[args.path],
            loader: "js",
          }));
          build.onResolve({ filter: /^@\/services\/reading-position\/position-service$/ }, () => ({
            path: "position-service",
            namespace: "position-stub",
          }));
          build.onLoad({ filter: /.*/, namespace: "position-stub" }, () => ({
            contents: `
              export const resolveLiveReadingPosition = async () => null;
              export const readPositionWindow = async () => { throw new Error("position not used in this test"); };
              export const shortMdPath = (path) => path;
            `,
            loader: "js",
          }));
          build.onResolve({ filter: /^@\/services\/book-content\/book-reading-adapter$/ }, () => ({
            path: "book-reading-adapter",
            namespace: "book-stub",
          }));
          build.onLoad({ filter: /.*/, namespace: "book-stub" }, () => ({
            contents: `
              function sectionResult(book, spine, fragment) {
                const section = book.sections[spine];
                if (!section) return { kind: "none" };
                const text = fragment && section.fragmentText != null ? section.fragmentText : section.text;
                return {
                  kind: "ok",
                  text,
                  totalChars: text.length,
                  matchedTitle: section.heading,
                  matchKind: fragment ? "hit" : "spine",
                  spineIndex: spine,
                  bookDoc: {},
                  segments: [{ spineIndex: spine, sectionId: section.id, mdRelPath: section.id.replace(/\\.x?html$/, ".md"), start: 0, end: text.length, section: {} }],
                };
              }
              export async function readBookSectionCanonical(bookId, query) {
                const state = globalThis.__SAGEREAD_SEARCH_TEST__;
                state.bookSectionReads.push({ bookId, query });
                const book = state.books[bookId];
                if (!book) throw new Error("missing canonical book: " + bookId);
                const request = typeof query === "string" ? { heading: query } : query;
                if (request.spine == null && state.canonicalFailures.has(bookId)) throw new Error("injected canonical failure");
                const spine = request.spine != null
                  ? request.spine
                  : book.sections.findIndex((section) => section.heading === request.heading || section.heading.includes(request.heading || "\u0000"));
                const section = book.sections[spine];
                const fragment = request.spine != null
                  ? request.fragment ?? null
                  : section?.href?.includes("#")
                    ? section.href.split("#")[1]
                    : null;
                return sectionResult(book, spine, fragment);
              }
              export async function readBookDocumentCanonical(bookId) {
                const state = globalThis.__SAGEREAD_SEARCH_TEST__;
                state.fullBookReads.push(bookId);
                const book = state.books[bookId];
                if (!book) throw new Error("missing canonical book: " + bookId);
                let text = "";
                const segments = [];
                for (let spine = 0; spine < book.sections.length; spine++) {
                  if (spine > 0) text += "\\n\\n";
                  const section = book.sections[spine];
                  const start = text.length;
                  text += section.text;
                  segments.push({ spineIndex: spine, sectionId: section.id, mdRelPath: section.id.replace(/\\.x?html$/, ".md"), start, end: text.length, section: {} });
                }
                return { text, totalChars: text.length, segments, bookDoc: {} };
              }
              export async function resolveBookWindowImages(_bookId, text) { return text; }
            `,
            loader: "js",
          }));
        },
      },
    ],
  });
  return import(asUrl(outfile));
}

const mod = await bundle();
let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  PASS ${name}`);
  } else {
    failed += 1;
    const suffix = detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
    console.log(`  FAIL ${name}${suffix}`);
  }
}
let callId = 0;
function execute(tool, args) {
  return tool.execute({ reasoning: "Task 7 search fallback", ...args }, { toolCallId: `sf${++callId}`, messages: [] });
}
function searchTool(scope, currentId, retrievalScope) {
  return mod.createSearchLibraryTool({ scope, currentId, retrievalScope });
}
function readTool(scope, currentId, retrievalScope) {
  return mod.createReadDocumentTool({ scope, currentId, retrievalScope });
}
async function readHit(tool, hit, extra = {}) {
  if (!hit?.read) return null;
  return execute(tool, { ...hit.read, before: 24, after: 500, ...extra });
}
function writeDoc(id, files) {
  const dir = join(fixtureApp, "books", id);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof content === "string" ? content : JSON.stringify(content));
  }
  return dir;
}
function makePaper(id, title, body) {
  writeDoc(id, { "metadata.json": { title }, "paper.md": `---\ntitle: ${JSON.stringify(title)}\n---\n${body}` });
  return readFileText(id);
}
function readFileText(id) {
  return state.paperTexts[id];
}
function registerBook(id, title, sections, indexed = false) {
  writeDoc(id, {
    "metadata.json": { title },
    "book.epub": "IPC fixture; real EPUB coverage is in reader.rs",
    ...(indexed ? { "vectors.sqlite": "indexed fixture" } : {}),
  });
  state.books[id] = { title, sections: sections.map((section, index) => ({ id: `OEBPS/ch${index + 1}.xhtml`, ...section })) };
}
function calls(command) {
  return state.invokeCalls.filter((call) => call.command === command);
}
function hitShape(hit) {
  return !!hit && typeof hit.source === "string" && typeof hit.index?.status === "string" && !!hit.read?.doc && typeof hit.anchor_precision === "string";
}

state.paperTexts = Object.create(null);
const PAPER_A = "paper-a-indexed";
const paperABody = `# Alpha\n${"Before ".repeat(80)}\nAlpha   beta\n\tgamma 😀 tail\nRepeated   phrase\nand Repeated   phrase\n# Beta\n${"Other text ".repeat(80)}`;
state.paperTexts[PAPER_A] = `---\ntitle: "Indexed paper"\n---\n${paperABody}`;
writeDoc(PAPER_A, { "metadata.json": { title: "Indexed paper" }, "paper.md": state.paperTexts[PAPER_A] });
state.indexedPapers.add(PAPER_A);
const parsedA = mod.parsePaperSections(state.paperTexts[PAPER_A]);

const PAPER_B = "paper-b-unindexed";
const paperBBody = `# Results and discussion\n${"Prefix ".repeat(30)}dehydration changes the framework.\n# References\nReferenceOnlyNeedle, Example Author, 2024.`;
state.paperTexts[PAPER_B] = `---\ntitle: "Dehydration mechanisms"\n---\n${paperBBody}`;
writeDoc(PAPER_B, { "metadata.json": { title: "Dehydration mechanisms" }, "paper.md": state.paperTexts[PAPER_B] });

const BOOK_A = "book-a-indexed";
registerBook(BOOK_A, "Indexed book", [{ heading: "第一章", text: "Before\nAlpha   beta\n\tgamma 😀 tail" }], true);
const BOOK_B = "book-b-unindexed";
const bookBHitText = `${"前".repeat(180)}意思表示 是法律行为的核心。${"后".repeat(80)}`;
registerBook(BOOK_B, "民法总论", [
  { heading: "第一章 法律行为", text: "导论" },
  { heading: "第二章 法律效果", text: bookBHitText },
]);
const BOOK_FRAGMENT = "book-fragment-indexed";
const fragmentText = `Fragment start\n${"lead ".repeat(30)}Normalized   fragment needle\n${"tail ".repeat(100)}`;
const fragmentSpineText = `${"Spine prefix ".repeat(140)}${fragmentText}`;
registerBook(BOOK_FRAGMENT, "Fragment book", [
  { heading: "Chapter 1", href: "OEBPS/ch1.xhtml#section", text: fragmentSpineText, fragmentText },
], true);
const BOOK_OFFSET_FAILURE = "book-offset-failure";
registerBook(BOOK_OFFSET_FAILURE, "Offset fallback book", [{ heading: "Fallback", text: "Canonical body" }], true);

console.log("[1] 已索引论文/书籍 canonical 命中 → readDocument 精确窗口");
state.paperSearch = async () => [
  { paper_id: PAPER_A, book_title: "Indexed paper", book_author: "", content: "Alpha beta gamma 😀", similarity: 0.91, chunk_id: 1 },
];
const paperAnchorSearch = await execute(searchTool("paper", PAPER_A, "current"), { doc: `paper:${PAPER_A}`, query: "semantic anchor" });
const paperAnchorHit = paperAnchorSearch.results?.find((hit) => hit.doc === `paper:${PAPER_A}`);
const expectedPaperOffset = parsedA.body.indexOf("Alpha   beta");
check("论文命中完整 source/index/read/anchor_precision", hitShape(paperAnchorHit), paperAnchorHit);
check(
  "论文归一化片段恢复正文绝对 UTF-16 offset",
  paperAnchorHit?.read?.offset === expectedPaperOffset && paperAnchorHit?.anchor_precision === "exact" && paperAnchorHit?.index?.status === "indexed",
  { expectedPaperOffset, hit: paperAnchorHit },
);
const paperAnchorRead = await readHit(readTool("paper", PAPER_A, "current"), paperAnchorHit);
check(
  "hit.read 叠加 before/after 后覆盖命中且不回章首",
  paperAnchorRead?.text?.includes("Alpha   beta") && paperAnchorRead?.range?.start === expectedPaperOffset - 24 && paperAnchorRead?.range?.end === expectedPaperOffset + 500,
  { range: paperAnchorRead?.range, text: paperAnchorRead?.text?.slice(0, 100) },
);
check(
  "readDocument 返回 range/read 下一跳参数",
  paperAnchorRead?.range?.unit === "char" && paperAnchorRead?.read?.doc === `paper:${PAPER_A}` && paperAnchorRead?.read?.offset === expectedPaperOffset,
  paperAnchorRead?.read,
);

state.bookSearch = async (bookId) =>
  bookId === BOOK_A
    ? [{ book_title: "Indexed book", book_author: "", related_chapter_titles: "第一章", content: "Alpha beta gamma 😀", similarity: 0.88, chunk_id: 2 }]
    : [];
const bookAnchorSearch = await execute(searchTool("reader", BOOK_A, "current"), { doc: `book:${BOOK_A}`, query: "semantic anchor" });
const bookAnchorHit = bookAnchorSearch.results?.find((hit) => hit.doc === `book:${BOOK_A}`);
check("已索引书籍命中保留完整标题", bookAnchorHit?.title === "Indexed book" && hitShape(bookAnchorHit), bookAnchorHit);
check(
  "书籍命中恢复章节内 offset",
  bookAnchorHit?.read?.heading === "第一章" && bookAnchorHit?.read?.offset === state.books[BOOK_A].sections[0].text.indexOf("Alpha   beta") && bookAnchorHit?.anchor_precision === "exact",
  bookAnchorHit,
);
const bookAnchorRead = await readHit(readTool("reader", BOOK_A, "current"), bookAnchorHit);
check("书籍 hit.read 窗口包含命中", bookAnchorRead?.text?.includes("Alpha   beta"), bookAnchorRead?.range);

state.bookSearch = async (bookId) =>
  bookId === BOOK_FRAGMENT
    ? [{ book_title: "Fragment book", book_author: "", related_chapter_titles: "Chapter 1", content: "Normalized fragment needle", similarity: 0.93, chunk_id: 3 }]
    : [];
const fragmentSearch = await execute(searchTool("reader", BOOK_FRAGMENT, "current"), { doc: `book:${BOOK_FRAGMENT}`, query: "semantic fragment" });
const fragmentHit = fragmentSearch.results?.find((hit) => hit.doc === `book:${BOOK_FRAGMENT}`);
const fragmentUsesSpine = typeof fragmentHit?.read?.spine === "number";
const fragmentExpectedOffset = (fragmentUsesSpine ? fragmentSpineText : fragmentText).indexOf("Normalized   fragment needle");
check(
  "href#fragment 命中 offset 与回放坐标系一致",
  fragmentHit?.anchor_precision === "exact" && fragmentHit?.read?.offset === fragmentExpectedOffset,
  { fragmentUsesSpine, fragmentExpectedOffset, hit: fragmentHit },
);
const fragmentRead = await readHit(readTool("reader", BOOK_FRAGMENT, "current"), fragmentHit);
check(
  "href#fragment hit.read 扩窗真实包含匹配文本",
  fragmentRead?.text?.includes("Normalized   fragment needle") && fragmentRead?.range?.start === fragmentExpectedOffset - 24,
  { range: fragmentRead?.range, read: fragmentRead?.read, text: fragmentRead?.text?.slice(0, 100) },
);

state.canonicalFailures.add(BOOK_OFFSET_FAILURE);
let offsetFallbackResult = null;
let offsetFallbackError = "";
try {
  offsetFallbackResult = await execute(readTool("reader", BOOK_OFFSET_FAILURE, "current"), {
    doc: `book:${BOOK_OFFSET_FAILURE}`,
    heading: "Fallback",
    offset: 2,
    after: 500,
  });
} catch (error) {
  offsetFallbackError = String(error);
}
state.canonicalFailures.delete(BOOK_OFFSET_FAILURE);
check(
  "canonical offset 不回退到不兼容的 Rust 扁平文本",
  /canonical|offset/i.test(offsetFallbackError),
  { offsetFallbackError, offsetFallbackResult },
);

console.log("[2] 不唯一论文片段只给章节精度，不伪造 offset");
state.paperSearch = async () => [
  { paper_id: PAPER_A, book_title: "Indexed paper", book_author: "", content: "Repeated phrase", similarity: 0.8, chunk_id: 3 },
];
const ambiguousSearch = await execute(searchTool("paper", PAPER_A, "current"), { doc: `paper:${PAPER_A}`, query: "semantic ambiguous" });
const ambiguousHit = ambiguousSearch.results?.find((hit) => hit.doc === `paper:${PAPER_A}`);
check(
  "重复片段降级 heading 且无 offset",
  ambiguousHit?.anchor_precision === "section" && ambiguousHit?.read?.heading === "Alpha" && !("offset" in (ambiguousHit?.read || {})),
  ambiguousHit,
);
const ambiguousRead = await readHit(readTool("paper", PAPER_A, "current"), ambiguousHit, { after: 1200 });
check("章节精度仍可直接扩窗", ambiguousRead?.text?.includes("Repeated   phrase"), ambiguousRead?.anchor);

console.log("[3] 无向量配置：未索引 Paper B / Book B 关键词回退与扩窗");
state.vectorError = "vector disabled for Task 7";
state.paperSearch = async () => [];
state.bookSearch = async () => {
  throw new Error("not indexed");
};
const paperFallbackSearch = await execute(searchTool("paper", PAPER_B, "current"), { doc: `paper:${PAPER_B}`, query: "dehydration" });
const paperFallbackHit = paperFallbackSearch.results?.find((hit) => hit.doc === `paper:${PAPER_B}` && hit.source === "keyword");
check(
  "Paper B 无向量也有 keyword + not_indexed",
  paperFallbackHit?.source === "keyword" && paperFallbackHit?.index?.status === "not_indexed" && hitShape(paperFallbackHit),
  paperFallbackSearch,
);
const expectedFallbackOffset = mod.parsePaperSections(state.paperTexts[PAPER_B]).body.indexOf("dehydration");
check("Paper B 关键词 offset 经原文验证", paperFallbackHit?.read?.offset === expectedFallbackOffset && paperFallbackHit?.anchor_precision === "exact", paperFallbackHit);
const paperFallbackRead = await readHit(readTool("paper", PAPER_B, "current"), paperFallbackHit);
check(
  "Paper B 回退命中可直接扩窗且 range 覆盖命中",
  paperFallbackRead?.text?.toLowerCase().includes("dehydration") && paperFallbackRead?.range?.start <= expectedFallbackOffset && paperFallbackRead?.range?.end > expectedFallbackOffset,
  { range: paperFallbackRead?.range, read: paperFallbackRead?.read },
);

const bookFallbackSearch = await execute(searchTool("reader", BOOK_B, "current"), { doc: `book:${BOOK_B}`, query: "意思表示" });
const bookFallbackHit = bookFallbackSearch.results?.find((hit) => hit.doc === `book:${BOOK_B}` && hit.source === "keyword");
check(
  "Book B 无向量也有 keyword + not_indexed + spine",
  bookFallbackHit?.index?.status === "not_indexed" && bookFallbackHit?.read?.spine === 1 && bookFallbackHit?.anchor_precision === "exact" && hitShape(bookFallbackHit),
  bookFallbackSearch,
);
check(
  "Book B offset 来自 JS canonical 而非 Rust 字符坐标",
  bookFallbackHit?.read?.offset === 180 && bookFallbackHit?.read?.doc === `book:${BOOK_B}`,
  bookFallbackHit,
);
const bookFallbackRead = await readHit(readTool("reader", BOOK_B, "current"), bookFallbackHit);
check(
  "Book B spine+offset 可直接扩窗且 read 保留 spine",
  bookFallbackRead?.text?.includes("意思表示") && bookFallbackRead?.range?.start === 156 && bookFallbackRead?.read?.spine === 1,
  { range: bookFallbackRead?.range, read: bookFallbackRead?.read },
);
const currentEpubCall = calls("plugin:epub|search_epub_text").find((call) => call.args.bookId === BOOK_B);
check("指定 doc 允许完整 EPUB 扫描", !!currentEpubCall && currentEpubCall.args.maxSections == null && currentEpubCall.args.maxDurationMs == null, currentEpubCall);

const unindexedPaperInfo = await execute(mod.createGetDocumentInfoTool({ scope: "paper", currentId: PAPER_B, retrievalScope: "current" }), { doc: `paper:${PAPER_B}` });
const unindexedBookInfo = await execute(mod.createGetDocumentInfoTool({ scope: "reader", currentId: BOOK_B, retrievalScope: "current" }), { doc: `book:${BOOK_B}` });
state.paperIndexError = "index status unavailable for Task 8";
const unknownPaperInfo = await execute(mod.createGetDocumentInfoTool({ scope: "paper", currentId: PAPER_B, retrievalScope: "current" }), { doc: `paper:${PAPER_B}` });
state.paperIndexError = null;
const documentInfoNotes = [unindexedPaperInfo.index.note, unindexedBookInfo.index.note, unknownPaperInfo.index.note];
check(
  "getDocumentInfo 未索引/状态未知仍保留 not_indexed 语义",
  [unindexedPaperInfo, unindexedBookInfo, unknownPaperInfo].every((info) => info.index.status === "not_indexed"),
  [unindexedPaperInfo.index, unindexedBookInfo.index, unknownPaperInfo.index],
);
check(
  "getDocumentInfo notes 说明关键词/标题回退与目录原文互补且保留较慢提示",
  documentInfoNotes.every((note) =>
    ["searchLibrary", "关键词/标题", "getDocumentInfo", "readDocument", "互补", "较慢"].every((token) => note.includes(token)) &&
    !/只能按(?:目录\/)?原文读取|向量化后再检索/.test(note)
  ),
  documentInfoNotes,
);

console.log("[3.5] outer merge 丢弃与书籍 section-local cursor key");
state.vectorError = null;
state.paperSearch = async () => [
  { paper_id: PAPER_A, book_title: "Indexed paper", book_author: "", content: "Alpha beta gamma 😀", similarity: 0.99, chunk_id: 99 },
];
state.bookSearch = async () => [];
const exhaustedFallback = await mod.searchKeywordFallback({ kind: "paper", query: "dehydration changes", topK: 1, includeReferences: false });
check("outer-merge 夹具：fallback 自身已耗尽且无 nextCursor", exhaustedFallback.nextCursor == null, exhaustedFallback.nextCursor);
const outerFirst = await execute(searchTool("paper", PAPER_A, "library"), { query: "dehydration changes", scope: "library", topK: 1 });
check(
  "indexed 填满 topK 且 outer merge 丢弃 fallback 时仍合成 next_cursor",
  outerFirst.results?.length === 1 && outerFirst.results[0].source === "hybrid" && typeof outerFirst.next_cursor === "string",
  outerFirst,
);
const outerSecond = await execute(searchTool("paper", PAPER_A, "library"), { query: "dehydration changes", scope: "library", topK: 1, cursor: outerFirst.next_cursor });
const outerHits = [...outerFirst.results, ...outerSecond.results];
check(
  "后续页恰好补回 dropped fallback 且不重复 indexed 命中",
  outerSecond.results?.filter((hit) => hit.doc === `paper:${PAPER_B}` && hit.source === "keyword").length === 1 &&
    outerHits.filter((hit) => hit.source === "hybrid").length === 1 &&
    outerHits.filter((hit) => hit.doc === `paper:${PAPER_B}`).length === 1 &&
    outerSecond.next_cursor == null,
  { first: outerFirst, second: outerSecond, combined: outerHits },
);

const BOOK_COLLISION = "book-section-collision";
registerBook(BOOK_COLLISION, "Section collision book", [
  { heading: "First section", text: "sharedNeedle first body" },
  { heading: "Second section", text: "sharedNeedle second body" },
  { heading: "Heading only", text: "nothing to match" },
]);
state.epubSearch = async (bookId) => bookId === BOOK_COLLISION
  ? {
      results: [
        { heading: "First section", spine: 0, snippet: "sharedNeedle first body", match_kind: "keyword" },
        { heading: "Second section", spine: 1, snippet: "sharedNeedle second body", match_kind: "keyword" },
        { heading: "Heading only", spine: 2, snippet: "unverifiable heading snippet", match_kind: "title" },
      ],
      scanned_sections: 3,
      partial: false,
    }
  : { results: [], scanned_sections: 0, partial: false };
const collisionHits = [];
let collisionCursor;
for (let page = 0; page < 5; page += 1) {
  const result = await execute(searchTool("reader", BOOK_B, "library"), { query: "sharedNeedle", scope: "library", topK: 1, ...(collisionCursor ? { cursor: collisionCursor } : {}) });
  collisionHits.push(...result.results);
  if (!result.next_cursor) break;
  collisionCursor = result.next_cursor;
}
check(
  "同书两个 offset=0 section 与 heading-only 命中都经 cursor 返回",
  collisionHits.length === 3 && ["First section", "Second section", "Heading only"].every((heading) => collisionHits.some((hit) => hit.read?.heading === heading)),
  collisionHits,
);
const collisionKeys = collisionHits.map((hit) => `${hit.doc}|${hit.read?.spine ?? hit.read?.heading ?? ""}|${hit.read?.offset ?? "heading-only"}`);
check("section-aware cursor key 无碰撞且 replay 无重复", new Set(collisionKeys).size === collisionHits.length, { collisionKeys, collisionHits });
state.epubSearch = null;
state.paperSearch = async () => [];

console.log("[3.6] RRF 实际发出去重与 dropped channel 续页");
state.vectorError = null;
state.paperSearch = async () => [
  { paper_id: PAPER_A, book_title: "Indexed paper", book_author: "", content: "Alpha beta gamma 😀", similarity: 0.99, chunk_id: 99 },
];
state.allBooksSearch = async () => [];
const BOOK_RRF_DROP = "book-rrf-drop";
registerBook(BOOK_RRF_DROP, "RRF drop book", [{ heading: "Chapter 1", text: "rrfBookNeedle body" }]);
const rrfFallback = await mod.searchKeywordFallback({ kind: "book", query: "rrfBookNeedle", topK: 1, includeReferences: false });
check("RRF 夹具：book fallback 自身已耗尽", rrfFallback.nextCursor == null, rrfFallback.nextCursor);
const rrfFirst = await execute(searchTool("central", undefined, "all"), { query: "rrfBookNeedle", scope: "all", topK: 1 });
const rrfFirstCursor = rrfFirst.next_cursor ? JSON.parse(rrfFirst.next_cursor) : {};
check(
  "central/all topK=1 RRF 仅发 paper 时 dropped book 仍保留续页",
  rrfFirst.results?.length === 1 && rrfFirst.results[0].kind === "paper" && typeof rrfFirstCursor.book === "string",
  rrfFirst,
);
const rrfSecond = await execute(searchTool("central", undefined, "all"), { query: "rrfBookNeedle", scope: "all", topK: 1, cursor: rrfFirst.next_cursor });
const rrfHits = [...rrfFirst.results, ...rrfSecond.results];
check(
  "第二页恰好发出 dropped book 且 paper 不重复，随后结束",
  rrfSecond.results?.length === 1 && rrfSecond.results[0].kind === "book" && rrfSecond.results[0].doc === `book:${BOOK_RRF_DROP}` &&
    rrfHits.filter((hit) => hit.doc === `paper:${PAPER_A}`).length === 1 &&
    rrfHits.filter((hit) => hit.doc === `book:${BOOK_RRF_DROP}`).length === 1 && rrfSecond.next_cursor == null,
  { first: rrfFirst, second: rrfSecond, combined: rrfHits },
);

for (let index = 0; index < 3; index += 1) {
  const suffix = String(index).padStart(2, "0");
  const paperId = `paper-rrf-${suffix}`;
  state.paperTexts[paperId] = `---\ntitle: "paper-rrf-${suffix}"\n---\n# Body\nmixedNeedle paper ${index}`;
  writeDoc(paperId, { "metadata.json": { title: `paper-rrf-${suffix}` }, "paper.md": state.paperTexts[paperId] });
  registerBook(`book-rrf-${suffix}`, `book-rrf-${suffix}`, [{ heading: "Chapter 1", text: `mixedNeedle book ${index}` }]);
}
const mixedFirst = await execute(searchTool("central", undefined, "all"), { query: "mixedNeedle", scope: "all", topK: 1 });
const mixedFirstCursor = mixedFirst.next_cursor ? JSON.parse(mixedFirst.next_cursor) : {};
check(
  "混合 RRF 首页 paper/book 两个 dropped channel 都保留 replay cursor",
  mixedFirst.results?.length === 1 && mixedFirst.results[0].kind === "paper" && typeof mixedFirstCursor.paper === "string" && typeof mixedFirstCursor.book === "string",
  mixedFirst,
);
const mixedHits = [...mixedFirst.results];
const mixedHitKey = (hit) => hit.kind === "book"
  ? `${hit.doc}|spine:${hit.read?.spine ?? ""}|heading:${hit.read?.heading ?? ""}|${hit.read?.offset ?? "heading-only"}`
  : `${hit.doc}|${hit.read?.offset ?? "heading-only"}`;
const mixedKeys = new Set(mixedFirst.results.map(mixedHitKey));
let mixedDuplicates = 0;
let mixedCursor = mixedFirst.next_cursor;
let mixedLast = mixedFirst;
for (let page = 0; page < 20; page += 1) {
  const result = await execute(searchTool("central", undefined, "all"), { query: "mixedNeedle", scope: "all", topK: 1, cursor: mixedCursor });
  mixedLast = result;
  for (const hit of result.results || []) {
    const key = mixedHitKey(hit);
    if (mixedKeys.has(key)) mixedDuplicates += 1;
    mixedKeys.add(key);
    mixedHits.push(hit);
  }
  if (!result.next_cursor) break;
  mixedCursor = result.next_cursor;
}
check(
  "混合多页最终覆盖全部 6 个 RRF 夹具且 indexed/各 fallback 均不重复",
  ["paper-rrf-00", "paper-rrf-01", "paper-rrf-02", "book-rrf-00", "book-rrf-01", "book-rrf-02"].every((id) => mixedHits.some((hit) => hit.doc === `${id.startsWith("paper") ? "paper" : "book"}:${id}`)) &&
    mixedHits.filter((hit) => hit.doc === `paper:${PAPER_A}`).length === 1 && mixedDuplicates === 0 && mixedLast.next_cursor == null,
  { mixedHits, mixedDuplicates, final: mixedLast },
);
check("混合 RRF section-aware key 数等于实际发出命中数", mixedKeys.size === mixedHits.length, { keys: mixedKeys.size, hits: mixedHits.length });
state.paperSearch = async () => [];
state.allBooksSearch = async () => [];

console.log("[4] includeReferences 对真实未索引原文产生差异");
const refsExcluded = await execute(searchTool("paper", PAPER_B, "current"), { doc: `paper:${PAPER_B}`, query: "ReferenceOnlyNeedle", includeReferences: false });
const refsIncluded = await execute(searchTool("paper", PAPER_B, "current"), { doc: `paper:${PAPER_B}`, query: "ReferenceOnlyNeedle", includeReferences: true });
check("参考文献专有词 false/true 结果不同", refsExcluded.total === 0 && refsIncluded.results?.some((hit) => hit.read?.offset > paperBBody.indexOf("# References")), { excluded: refsExcluded, included: refsIncluded });

console.log("[5] topK=30、权重和 includeReferences 真正传到三类 Rust 检索");
state.vectorError = null;
state.paperSearch = async () => [];
state.bookSearch = async () => [];
state.allBooksSearch = async () => [];
await execute(searchTool("paper", PAPER_A, "current"), { doc: `paper:${PAPER_A}`, query: "parameters", topK: 30, vectorWeight: 0.2, bm25Weight: 0.8, includeReferences: true });
await execute(searchTool("reader", BOOK_A, "current"), { doc: `book:${BOOK_A}`, query: "parameters", topK: 30, vectorWeight: 0.2, bm25Weight: 0.8, includeReferences: true });
await execute(searchTool("central", undefined, "all"), { query: "parameters", scope: "all", topK: 30, vectorWeight: 0.2, bm25Weight: 0.8, includeReferences: true });
const paperParameterCall = calls("plugin:epub|search_papers_db").at(-1);
const bookParameterCall = calls("plugin:epub|search_db").at(-1);
const allParameterCall = calls("plugin:epub|search_all_books_db").at(-1);
check(
  "search_papers_db 收到 topK/权重/includeReferences",
  paperParameterCall?.args.topK === 30 && paperParameterCall?.args.vectorWeight === 0.2 && paperParameterCall?.args.bm25Weight === 0.8 && paperParameterCall?.args.includeReferences === true,
  paperParameterCall,
);
check(
  "search_db 收到 limit/权重/includeReferences",
  bookParameterCall?.args.limit === 30 && bookParameterCall?.args.vectorWeight === 0.2 && bookParameterCall?.args.bm25Weight === 0.8 && bookParameterCall?.args.includeReferences === true,
  bookParameterCall,
);
check(
  "search_all_books_db 收到 limit/权重/includeReferences",
  allParameterCall?.args.limit === 30 && allParameterCall?.args.vectorWeight === 0.2 && allParameterCall?.args.bm25Weight === 0.8 && allParameterCall?.args.includeReferences === true,
  allParameterCall,
);
let schemaTopK = false;
try {
  const parsed = await searchTool("paper", PAPER_A, "current").inputSchema.parseAsync({ reasoning: "schema", query: "x", topK: 30 });
  schemaTopK = parsed.topK === 30 && parsed.vectorWeight === 0.7 && parsed.bm25Weight === 0.3 && parsed.includeReferences === false;
} catch {}
check("inputSchema 接受 topK=30 且默认权重保持不变", schemaTopK, schemaTopK);
await execute(searchTool("paper", PAPER_A, "current"), { doc: `paper:${PAPER_A}`, query: "parameters", topK: 99 });
check("直接 execute 超上限也按 topK=30 调用 Rust", calls("plugin:epub|search_papers_db").at(-1)?.args.topK === 30, calls("plugin:epub|search_papers_db").at(-1));
state.paperSearch = async () => {
  throw new Error("index channel offline");
};
const indexRejected = await execute(searchTool("paper", PAPER_B, "current"), { doc: `paper:${PAPER_B}`, query: "dehydration" });
check("索引通道失败但回退成功时 partial=true", indexRejected.results?.some((hit) => hit.source === "keyword") && indexRejected.partial === true, indexRejected);
state.paperSearch = async () => [];
state.fsFailures = [{ kind: "readDir", match: "/books", code: "EACCES" }];
const enumerationFailure = await execute(searchTool("paper", PAPER_A, "library"), { query: "dehydration", scope: "library" });
check(
  "library 枚举 I/O 失败向外传播且 partial",
  enumerationFailure.partial === true && enumerationFailure.fallback?.paper === null && /关键词回退失败|EACCES/.test(String(enumerationFailure.note || "")),
  enumerationFailure,
);
state.fsFailures = [{ kind: "exists", match: "paper-a-indexed/paper.md", code: "EACCES" }];
const probeFailure = await execute(searchTool("paper", PAPER_A, "library"), { query: "dehydration", scope: "library" });
check(
  "单文档探测失败计入 errors/partial 且不阻断其它文档",
  probeFailure.results?.some((hit) => hit.doc === `paper:${PAPER_B}` && hit.source === "keyword") && probeFailure.fallback?.paper?.errors === 1 && probeFailure.partial === true,
  probeFailure,
);
state.fsFailures = [];

console.log("[6] frontmatter 标题发现与 metadata 错误诊断");
state.vectorError = null;
state.paperSearch = async () => [];
const FRONTMATTER_ONLY = "paper-frontmatter-only";
state.paperTexts[FRONTMATTER_ONLY] = `---\ntitle: "FrontmatterNeedle real title"\n---\n# Body\nFrontmatterNeedle body`;
writeDoc(FRONTMATTER_ONLY, { "paper.md": state.paperTexts[FRONTMATTER_ONLY] });
const frontmatterResult = await execute(searchTool("paper", PAPER_A, "library"), { query: "FrontmatterNeedle", scope: "library", topK: 30 });
check(
  "无 metadata.json 的 frontmatter-only 论文按真实标题命中且 not-found 非错误",
  frontmatterResult.results?.some((hit) => hit.doc === `paper:${FRONTMATTER_ONLY}` && hit.source === "title" && hit.title === "FrontmatterNeedle real title") &&
    frontmatterResult.fallback?.paper?.errors === 0 && frontmatterResult.partial === false,
  frontmatterResult,
);
const CORRUPT_METADATA = "paper-corrupt-metadata";
state.paperTexts[CORRUPT_METADATA] = `---\ntitle: "CorruptNeedle title"\n---\n# Body\nCorruptNeedle body`;
writeDoc(CORRUPT_METADATA, { "metadata.json": "{not-json", "paper.md": state.paperTexts[CORRUPT_METADATA] });
const corruptResult = await execute(searchTool("paper", PAPER_A, "library"), { query: "CorruptNeedle", scope: "library", topK: 30 });
check(
  "损坏 metadata 不吞错：保留 frontmatter 标题并计 errors/partial",
  corruptResult.results?.some((hit) => hit.doc === `paper:${CORRUPT_METADATA}` && hit.source === "title" && hit.title === "CorruptNeedle title") &&
    corruptResult.fallback?.paper?.errors >= 1 && corruptResult.partial === true,
  corruptResult,
);
state.fsFailures = [{ kind: "readTextFile", match: `${CORRUPT_METADATA}/metadata.json`, code: "EACCES" }];
const unreadMetadataResult = await execute(searchTool("paper", PAPER_A, "library"), { query: "CorruptNeedle", scope: "library", topK: 30 });
check(
  "不可读 metadata 同样计 errors/partial 且不从库中消失",
  unreadMetadataResult.results?.some((hit) => hit.doc === `paper:${CORRUPT_METADATA}`) && unreadMetadataResult.fallback?.paper?.errors >= 1 && unreadMetadataResult.partial === true,
  unreadMetadataResult,
);
state.fsFailures = [];

console.log("[7] library 标题完整、正文扫描有界并诚实标 partial/truncated");
state.vectorError = "vector disabled for bounded scan";
for (let index = 0; index < 14; index++) {
  const id = `paper-extra-${String(index).padStart(2, "0")}`;
  const title = index === 13 ? "bodyOnlyNeedle late title" : `Extra paper ${index}`;
  state.paperTexts[id] = `---\ntitle: ${JSON.stringify(title)}\n---\n# Body\n${index === 13 ? "no body hit" : "bodyOnlyNeedle"}`;
  writeDoc(id, { "metadata.json": { title }, "paper.md": state.paperTexts[id] });
}
const boundedPaper = await execute(searchTool("paper", PAPER_A, "library"), { query: "bodyOnlyNeedle", scope: "library", topK: 30 });
check(
  "论文标题扫描覆盖未进入正文预算的文档",
  boundedPaper.results?.some((hit) => hit.doc === "paper:paper-extra-13" && hit.source === "title" && hit.title === "bodyOnlyNeedle late title"),
  boundedPaper.results?.filter((hit) => hit.source === "title"),
);
check(
  "论文 library 正文文档数/并发预算有界且 partial",
  boundedPaper.fallback?.paper?.candidate_documents > boundedPaper.fallback?.paper?.scanned_documents && boundedPaper.fallback?.paper?.scanned_documents <= 8 && boundedPaper.partial === true,
  boundedPaper.fallback,
);
check("论文结果上限与 truncated 诚实", boundedPaper.total <= 30 && boundedPaper.truncated === true, { total: boundedPaper.total, truncated: boundedPaper.truncated, fallback: boundedPaper.fallback });

for (let index = 0; index < 10; index++) {
  const id = `book-extra-${String(index).padStart(2, "0")}`;
  registerBook(id, index === 9 ? "bookBodyNeedle late title" : `Extra book ${index}`, [
    { heading: "Chapter 1", text: index === 9 ? "no body hit" : `bookBodyNeedle body ${index}` },
    { heading: "Chapter 2", text: "not scanned when capped" },
  ]);
}
state.epubDelay = 25;
state.epubMaxActive = 0;
const boundedBook = await execute(searchTool("reader", BOOK_B, "library"), { query: "bookBodyNeedle", scope: "library", topK: 30 });
check(
  "书籍标题全量且正文 Rust 扫描有界",
  boundedBook.results?.some((hit) => hit.doc === "book:book-extra-09" && hit.source === "title") && boundedBook.fallback?.book?.scanned_documents <= 6 && boundedBook.fallback?.book?.candidate_documents > boundedBook.fallback?.book?.scanned_documents,
  boundedBook.fallback,
);
check("书籍扫描并发<=2 且 partial/truncated", state.epubMaxActive <= 2 && boundedBook.partial === true && boundedBook.truncated === true, { maxActive: state.epubMaxActive, partial: boundedBook.partial, truncated: boundedBook.truncated, fallback: boundedBook.fallback });
check("library 不在 JS 中逐本展开全书 EPUB", calls("plugin:epub|search_epub_text").some((call) => call.args.bookId.startsWith("book-extra-")) && state.fullBookReads.filter((id) => id.startsWith("book-extra-")).length === 0, state.fullBookReads);

console.log("[8] stateless cursor 多页覆盖且不重复");
async function collectCursorPages(role, query) {
  const tool = role === "paper" ? searchTool("paper", PAPER_A, "library") : role === "reader" ? searchTool("reader", BOOK_B, "library") : searchTool("central", undefined, "all");
  const requestedScope = role === "central" ? "all" : "library";
  const pages = [];
  const hits = [];
  const seen = new Set();
  const duplicates = [];
  let cursor;
  for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
    const result = await execute(tool, { query, scope: requestedScope, topK: 4, ...(cursor ? { cursor } : {}) });
    pages.push(result);
    for (const hit of result.results || []) {
      const key = `${hit.doc}|${hit.read?.offset ?? `heading:${hit.read?.heading ?? ""}|spine:${hit.read?.spine ?? ""}`}`;
      if (seen.has(key)) duplicates.push(key);
      seen.add(key);
      hits.push(hit);
    }
    if (!result.next_cursor) break;
    cursor = result.next_cursor;
  }
  return { pages, hits, duplicates, finalCursor: cursor };
}
const paperPages = await collectCursorPages("paper", "bodyOnlyNeedle");
check("论文 partial 首页提供 next_cursor", typeof paperPages.pages[0]?.next_cursor === "string", paperPages.pages[0]);
check(
  "论文多页最终覆盖全部 14 个 extra 夹具且无重复 doc+offset",
  paperPages.pages.length > 1 && Array.from({ length: 14 }, (_, index) => `paper:paper-extra-${String(index).padStart(2, "0")}`).every((doc) => paperPages.hits.some((hit) => hit.doc === doc)) && paperPages.duplicates.length === 0,
  { pages: paperPages.pages.length, duplicates: paperPages.duplicates, docs: [...new Set(paperPages.hits.map((hit) => hit.doc))] },
);
check(
  "论文每页数量/正文扫描上限保持有界且最终游标结束",
  paperPages.pages.every((page) => page.total <= 4 && page.fallback?.paper?.scanned_documents <= 8) && paperPages.pages.at(-1)?.next_cursor == null,
  paperPages.pages.map((page) => ({ total: page.total, next: page.next_cursor, fallback: page.fallback })),
);
const bookPages = await collectCursorPages("reader", "bookBodyNeedle");
check("书籍 partial 首页提供 next_cursor", typeof bookPages.pages[0]?.next_cursor === "string", bookPages.pages[0]);
check(
  "书籍多页最终覆盖全部 10 个 extra 夹具且无重复 doc+offset",
  bookPages.pages.length > 1 && Array.from({ length: 10 }, (_, index) => `book:book-extra-${String(index).padStart(2, "0")}`).every((doc) => bookPages.hits.some((hit) => hit.doc === doc)) && bookPages.duplicates.length === 0,
  { pages: bookPages.pages.length, duplicates: bookPages.duplicates, docs: [...new Set(bookPages.hits.map((hit) => hit.doc))] },
);
check(
  "书籍每页数量/正文扫描上限保持有界且最终游标结束",
  bookPages.pages.every((page) => page.total <= 4 && page.fallback?.book?.scanned_documents <= 6) && bookPages.pages.at(-1)?.next_cursor == null,
  bookPages.pages.map((page) => ({ total: page.total, next: page.next_cursor, fallback: page.fallback })),
);
const centralPages = await collectCursorPages("central", "bodyOnlyNeedle");
check(
  "跨库 cursor 同样可续页且 paper 命中不重复",
  centralPages.pages.length > 1 && centralPages.duplicates.length === 0 && Array.from({ length: 14 }, (_, index) => `paper:paper-extra-${String(index).padStart(2, "0")}`).every((doc) => centralPages.hits.some((hit) => hit.doc === doc)),
  { pages: centralPages.pages.length, duplicates: centralPages.duplicates },
);
const currentWithoutCursor = await execute(searchTool("paper", PAPER_B, "current"), { doc: `paper:${PAPER_B}`, query: "dehydration" });
check("current/doc 原行为不返回 next_cursor", currentWithoutCursor.results?.some((hit) => hit.source === "keyword") && currentWithoutCursor.next_cursor == null, currentWithoutCursor);
let currentCursorError = "";
try {
  await execute(searchTool("paper", PAPER_B, "current"), { doc: `paper:${PAPER_B}`, query: "dehydration", cursor: "opaque-cursor" });
} catch (error) {
  currentCursorError = String(error);
}
check("current/doc 明确拒绝 library cursor 而不改变坐标/扫描语义", /cursor|current|doc/i.test(currentCursorError), currentCursorError);
const searchDescription = searchTool("paper", PAPER_A, "library").description;
check("searchLibrary guidance 说明 partial + next_cursor 可续扫", searchDescription.includes("next_cursor") && /继续|续扫|后续/.test(searchDescription), searchDescription.slice(0, 300));
let schemaCursor = false;
try {
  const parsed = await searchTool("paper", PAPER_A, "library").inputSchema.parseAsync({ reasoning: "schema", query: "x", cursor: "opaque" });
  schemaCursor = parsed.cursor === "opaque";
} catch {}
check("inputSchema 接受可选 cursor", schemaCursor, schemaCursor);

console.log("[9] 同一书同一查询 single-flight");
state.epubDelay = 40;
state.invokeCalls = [];
const flightTool = searchTool("reader", BOOK_B, "current");
await Promise.all([
  execute(flightTool, { doc: `book:${BOOK_B}`, query: "意思表示" }),
  execute(flightTool, { doc: `book:${BOOK_B}`, query: "意思表示" }),
]);
check("并发相同 EPUB 检索只发起一次 Rust 调用", calls("plugin:epub|search_epub_text").filter((call) => call.args.bookId === BOOK_B && call.args.query === "意思表示").length === 1, calls("plugin:epub|search_epub_text"));

check("临时夹具已创建且未触碰真实 AppData", existsSync(fixtureApp) && state.appData === fixtureApp, fixtureApp);
console.log(`\n结果：${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("PASS search-fallback Task 7");
