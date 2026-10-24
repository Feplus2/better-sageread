// Task 6：书籍高保真 canonical、连续窗口与窗口内 EPUB 图片物化。
// 运行：node scripts/test-book-structured-text.mjs
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, "packages/app/src");
const pnpmDir = join(root, "node_modules", ".pnpm");
const esbuildPkg = readdirSync(pnpmDir).find((d) => d.startsWith("esbuild@"));
if (!esbuildPkg) throw new Error("node_modules/.pnpm 下未找到 esbuild，请先 pnpm install");
const esbuild = await import(
  pathToFileURL(join(pnpmDir, esbuildPkg, "node_modules", "esbuild", "lib", "main.js")).href
);
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.DOMParser = dom.window.DOMParser;
globalThis.XMLSerializer = dom.window.XMLSerializer;
globalThis.Node = dom.window.Node;
globalThis.File = dom.window.File;

const outDir = mkdtempSync(join(tmpdir(), "book-structured-text-"));
process.on("exit", () => rmSync(outDir, { recursive: true, force: true }));
const asUrl = (path) => pathToFileURL(path).href;
const tsPath = (path) => path.replace(/\\/g, "/");

const STUBS = {
  "@tauri-apps/api/path": "export const appDataDir = async () => globalThis.__SAGEREAD_TEST_APP_DATA__;",
  "@tauri-apps/api/core": `
    export async function invoke(command, args) {
      if (command === "plugin:epub|paper_index_status") return { indexed: true, chunkCount: 1 };
      if (command === "plugin:epub|read_book_section") return globalThis.__SAGEREAD_TEST_RUST_READ__(args);
      throw new Error("unexpected invoke: " + command);
    }
  `,
  "@tauri-apps/plugin-fs": `
    import { existsSync } from "node:fs";
    import { mkdir as fsMkdir, readFile, readdir, writeFile as fsWriteFile } from "node:fs/promises";
    export const exists = async (path) => existsSync(path);
    export const readTextFile = (path) => readFile(path, "utf8");
    export const readDir = async (path) => (await readdir(path, { withFileTypes: true })).map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
    }));
    export const mkdir = (path, options) => fsMkdir(path, { recursive: !!options?.recursive });
    export const writeFile = (path, bytes) => fsWriteFile(path, bytes);
  `,
};

async function bundle(entrySource, name) {
  const entry = join(outDir, `${name}-entry.ts`);
  const outfile = join(outDir, `${name}.mjs`);
  writeFileSync(entry, entrySource);
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile,
    alias: { "@": src },
    define: { "import.meta.glob": "globalThis.__SAGEREAD_TEST_VITE_GLOB__" },
    plugins: [
      {
        name: "book-structured-test-stubs",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) =>
            STUBS[args.path] ? { path: args.path, namespace: "book-stub" } : null,
          );
          build.onLoad({ filter: /.*/, namespace: "book-stub" }, (args) => ({
            contents: STUBS[args.path],
            loader: "js",
          }));
          build.onResolve({ filter: /^@\/services\/book-translation\/book-translation-service$/ }, () => ({
            path: "book-translation-service",
            namespace: "book-open-stub",
          }));
          build.onLoad({ filter: /.*/, namespace: "book-open-stub" }, () => ({
            contents: "export const openBookDocument = (id) => globalThis.__SAGEREAD_TEST_OPEN_BOOK__(id);",
            loader: "js",
          }));
          build.onResolve({ filter: /^@\/services\/reading-position\/position-service$/ }, () => ({
            path: "position-service",
            namespace: "position-stub",
          }));
          build.onLoad({ filter: /.*/, namespace: "position-stub" }, () => ({
            contents: `
              export const resolveLiveReadingPosition = (scope, id) => globalThis.__SAGEREAD_TEST_POSITION__(scope, id);
              export const readPositionWindow = (snapshot, options) => globalThis.__SAGEREAD_TEST_READ_POSITION__(snapshot, options);
              export const shortMdPath = (path) => path.split("/").slice(-2).join("/");
            `,
            loader: "js",
          }));
        },
      },
    ],
  });
  return import(asUrl(outfile));
}

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
function brief(value) {
  return {
    error: value?.error,
    textLength: String(value?.text ?? value?.results?.content ?? "").length,
    textStart: String(value?.text ?? value?.results?.content ?? "").slice(0, 90),
    nextOffset: value?.next_offset ?? value?.results?.nextOffset,
  };
}

const appData = join(outDir, "app-data");
globalThis.__SAGEREAD_TEST_APP_DATA__ = appData;
globalThis.__SAGEREAD_TEST_VITE_GLOB__ = (pattern) => ({
  [pattern]: async () => ({ openBookDocument: (id) => globalThis.__SAGEREAD_TEST_OPEN_BOOK__(id) }),
});
const books = new Map();
const openCounts = new Map();
const documentCounts = new Map();
const blobCalls = new Map();
const parse = (xhtml) => new DOMParser().parseFromString(xhtml, "application/xhtml+xml");
const resolveFixtureHref = (ref, sectionId) => {
  const url = new URL(ref, `https://invalid.invalid/${sectionId}`);
  url.search = "";
  url.hash = "";
  return decodeURI(url.pathname.replace(/^\//, ""));
};

function registerBook(id, sectionSources, options = {}) {
  const blobs = options.blobs ?? {};
  const counts = sectionSources.map(() => 0);
  documentCounts.set(id, counts);
  blobCalls.set(id, []);
  const sections = sectionSources.map((source, index) => {
    const sectionId = source.id ?? `text/chapter-${index + 1}.xhtml`;
    return {
      id: sectionId,
      linear: "yes",
      createDocument: async () => {
        counts[index] += 1;
        return parse(source.xhtml);
      },
      resolveHref: (ref) => resolveFixtureHref(ref, sectionId),
    };
  });
  const bookDoc = {
    toc: options.toc ?? sectionSources.map((source, index) => ({
      label: source.label ?? `Chapter ${index + 1}`,
      href: `${sections[index].id}#chapter`,
    })),
    sections,
    loadBlob: async (href) => {
      blobCalls.get(id).push(href);
      const bytes = blobs[href];
      return bytes ? new Blob([bytes], { type: "image/png" }) : null;
    },
  };
  books.set(id, { bookDoc, throwOnOpen: !!options.throwOnOpen });
  openCounts.set(id, 0);
  mkdirSync(join(appData, "books", id), { recursive: true });
  writeFileSync(
    join(appData, "books", id, "metadata.json"),
    JSON.stringify({ title: options.title ?? id, author: "Task 6", language: "en" }),
  );
}

globalThis.__SAGEREAD_TEST_OPEN_BOOK__ = async (id) => {
  openCounts.set(id, (openCounts.get(id) ?? 0) + 1);
  const fixture = books.get(id);
  if (!fixture) throw new Error(`unknown fixture book: ${id}`);
  if (fixture.throwOnOpen) throw new Error("foliate open failed (fixture)");
  return { book: { id, format: "EPUB" }, bookDoc: fixture.bookDoc };
};
globalThis.__SAGEREAD_TEST_RUST_READ__ = async ({ chapterTitle }) => ({
  matchedTitle: chapterTitle,
  text: "Rust flattened fallback",
  truncated: false,
  totalChars: 23,
  pages: 1,
});

const positionText = Array.from({ length: 1600 }, (_, index) => String.fromCharCode(0x4e00 + index)).join("");
const livePosition = { charOffset: 100 };
globalThis.__SAGEREAD_TEST_POSITION__ = async (scope, id) => ({
  scope,
  docId: id,
  label: "Current chapter",
  labelSource: "toc",
  mdRelPath: "text/current.md",
  mdLength: positionText.length,
  charOffset: livePosition.charOffset,
  percentInDoc: 0,
  chunkRange: null,
  chunkTotal: null,
  overallPercent: 0,
  spineIndex: 0,
  spineTotal: 1,
  cfi: null,
});
globalThis.__SAGEREAD_TEST_READ_POSITION__ = async (snapshot, options = {}) => {
  const before = Math.max(0, options.before ?? 0);
  const after = Math.max(500, options.after ?? 6000);
  const start = Math.max(0, snapshot.charOffset - before);
  const end = Math.min(positionText.length, snapshot.charOffset + after);
  return {
    text: positionText.slice(start, end),
    start,
    end,
    totalLength: positionText.length,
    mdRelPath: snapshot.mdRelPath,
    nextOffset: end < positionText.length ? end : null,
  };
};

const STRUCTURED_XHTML = `<html xmlns="http://www.w3.org/1999/xhtml"><body>
<h1 id="chapter">Structured chapter</h1>
<p>Energy <math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mi>E</mi><annotation encoding="application/x-tex">E=mc^2</annotation></semantics></math> and <math xmlns="http://www.w3.org/1998/Math/MathML" alttext="a+b"><mi>ignored</mi></math>.</p>
<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><semantics><mi>U</mi><annotation encoding="application/x-tex">U=\\sum_i m_i</annotation></semantics></math>
<figure><img src="../images/in-window.png" alt="Plot A"/><figcaption>Caption</figcaption></figure>
<table><tbody>
<tr><th>Name</th><th>Formula</th><th>Note</th></tr>
<tr><td rowspan="2">A|B</td><td><math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mi>x</mi><annotation encoding="application/x-tex">x^2</annotation></semantics></math></td><td>one<br/>two</td></tr>
<tr><td colspan="2"><math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><semantics><mi>y</mi><annotation encoding="application/x-tex">y=1</annotation></semantics></math> tail</td></tr>
</tbody></table>
<p>After <img src="../images/outside.png" alt="Outside"/>.</p>
</body></html>`;

const app = await bundle(
  [
    `export { createReadDocumentTool } from "${tsPath(join(src, "ai/tools/document/read-document.ts"))}";`,
    `export { createReadBookSectionTool } from "${tsPath(join(src, "ai/tools/read-book-section.ts"))}";`,
    `export { extractStructuredText, tableToMarkdown } from "${tsPath(join(src, "services/book-content/extract-structured-text.ts"))}";`,
    `export { rewriteDocumentImagePaths } from "${tsPath(join(src, "ai/tools/document/image-paths.ts"))}";`,
  ].join("\n"),
  "book-app",
);

console.log("[1] 真实 DOM 结构化：TeX annotation、表格 inline 公式、图片 src/alt");
const structured = app.extractStructuredText(parse(STRUCTURED_XHTML), null).text;
check("行内公式优先 annotation，alttext 兜底", structured.includes("Energy $E=mc^2$ and $a+b$."), structured.slice(0, 240));
check("display 公式保留 TeX 与 $$ 定界", structured.includes("$$\nU=\\sum_i m_i\n$$"), structured.slice(0, 300));
check("img 输出保留 alt/src 的 Markdown", structured.includes("![Plot A](../images/in-window.png)"), structured.slice(0, 400));
check(
  "表格单元格公式不扁平化，display 在单元格内走 inline",
  structured.includes("| A\\|B | $x^2$ | one two |") && structured.includes("| | $y=1$ tail | |"),
  structured,
);
check(
  "表格首行、分隔行、colspan/rowspan 列数正确",
  structured.includes("| Name | Formula | Note |\n| --- | --- | --- |"),
  structured,
);
check("表格单元格 pipe 转义且 br 不断行", structured.includes("A\\|B") && structured.includes("one two"), structured);

const mixedImages = await app.rewriteDocumentImagePaths(
  '![first](first.png)\n<img alt="second" src="second.png">',
  {
    kind: "paper",
    docDir: join(appData, "books", "mixed-images"),
    resolveMissing: async (ref) => `/cache/${ref}`,
  },
  { exists: async () => false, listDir: async () => [] },
);
check(
  "混合 Markdown/HTML 图片按各自出现序号解析，长度变化不串位",
  mixedImages === '![first](/cache/first.png)\n<img alt="second" src="/cache/second.png">',
  mixedImages,
);

let adapter = null;
let adapterLoadError = "";
try {
  adapter = await bundle(
    `export { readBookDocumentCanonical, readBookSectionCanonical, resolveBookWindowImages } from "${tsPath(join(src, "services/book-content/book-reading-adapter.ts"))}";`,
    "book-reading-adapter",
  );
} catch (error) {
  adapterLoadError = error instanceof Error ? error.message : String(error);
}
check("book-reading-adapter 提供两个 canonical 入口", !!adapter?.readBookDocumentCanonical && !!adapter?.readBookSectionCanonical, adapterLoadError);

const WINDOW_XHTML = `<html xmlns="http://www.w3.org/1999/xhtml"><body>
<h1 id="chapter">Chapter One</h1><p>Intro</p>
<p><img src="../images/in-window.png" alt="Window"/></p>
<p>${"A".repeat(700)}</p>
<p><img src="../images/outside.png" alt="Outside"/></p>
<p>${"B".repeat(700)}</p>
</body></html>`;
const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
registerBook("book-window", [{ xhtml: WINDOW_XHTML, label: "Chapter One" }], {
  blobs: { "images/in-window.png": pngBytes, "images/outside.png": new Uint8Array([9, 9, 9]) },
});
const expectedWindowCanonical = `Chapter One\nIntro\n![Window](../images/in-window.png)\n${"A".repeat(700)}\n![Outside](../images/outside.png)\n${"B".repeat(700)}`;

let callId = 0;
async function execute(tool, args) {
  try {
    return await tool.execute(
      { reasoning: "Task 6 structured book regression", ...args },
      { toolCallId: `b${++callId}`, messages: [] },
    );
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
const makeDocumentTool = (id) => app.createReadDocumentTool({ scope: "reader", currentId: id, retrievalScope: "current" });

console.log("[2] New/Legacy 同章 canonical 与切片后图片物化");
const newFirst = await execute(makeDocumentTool("book-window"), {
  doc: "book:book-window",
  heading: "Chapter One",
  after: 500,
});
check("New heading 使用高保真图片而非 Rust 扁平文本", String(newFirst.text ?? "").includes("![Window]("), brief(newFirst));
check("New heading next_offset 按 canonical 而非绝对路径长度", newFirst.next_offset === 500, brief(newFirst));
const legacyTool = app.createReadBookSectionTool("book-window");
const legacyFirst = await execute(legacyTool, { chapterTitle: "Chapter One", maxChars: 500 });
check(
  "New/Legacy 第一窗文本完全一致",
  legacyFirst.results?.success === true && legacyFirst.results.content === newFirst.text,
  { legacy: brief(legacyFirst), new: brief(newFirst) },
);
check("Legacy heading offset 仍为节内坐标", legacyFirst.results?.nextOffset === 500, brief(legacyFirst));
const firstImagePath = /!\[Window\]\(([^)]+)\)/.exec(String(newFirst.text ?? ""))?.[1] ?? "";
check("窗口图片改写为 EPUB 缓存绝对路径", firstImagePath.includes("/image-cache/epub/book-window/"), firstImagePath);
check("缓存图片已落盘且字节来自 foliate blob", !!firstImagePath && existsSync(firstImagePath) && readFileSync(firstImagePath).equals(Buffer.from(pngBytes)), firstImagePath);
check("只加载窗口内 blob，不整书预提取", JSON.stringify(blobCalls.get("book-window")) === JSON.stringify(["images/in-window.png"]), blobCalls.get("book-window"));
const cacheDir = join(appData, "image-cache", "epub", "book-window");
check("窗口外图片没有物化", !existsSync(cacheDir) || readdirSync(cacheDir).length === 1, existsSync(cacheDir) ? readdirSync(cacheDir) : []);
check("Legacy/New 使用同一确定性缓存路径", !!firstImagePath && String(legacyFirst.results?.content ?? "").includes(firstImagePath), firstImagePath);

if (adapter) {
  const section = await adapter.readBookSectionCanonical("book-window", "Chapter One");
  check("adapter 章节 canonical 保留稳定相对 src", section.kind === "ok" && section.text === expectedWindowCanonical, section.text?.slice(0, 180));
  check("adapter totalChars 是切片前 canonical 长度", section.totalChars === expectedWindowCanonical.length, section.totalChars);
} else {
  check("adapter 章节 canonical 保留稳定相对 src", false, adapterLoadError);
  check("adapter totalChars 是切片前 canonical 长度", false, adapterLoadError);
}

console.log("[2b] Review 图片解析：.html、segment 优先与转义 alt");
registerBook(
  "html-mdbook-book",
  [{
    id: "text/chapter.HTML",
    label: "HTML Chapter",
    xhtml: '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1 id="chapter">HTML Chapter</h1><p><img src="../images/existing.png" alt="Existing"/></p></body></html>',
  }],
  { blobs: { "images/existing.png": pngBytes } },
);
const htmlExistingImage = join(appData, "books", "html-mdbook-book", "mdbook", "book", "src", "images", "existing.png");
mkdirSync(dirname(htmlExistingImage), { recursive: true });
writeFileSync(htmlExistingImage, pngBytes);
const htmlWindow = await execute(makeDocumentTool("html-mdbook-book"), {
  doc: "book:html-mdbook-book",
  heading: "HTML Chapter",
  after: 500,
});
check(
  ".html 既有 mdbook 图片路径可用",
  String(htmlWindow.text ?? "").includes(`![Existing](${tsPath(htmlExistingImage)})`),
  brief(htmlWindow),
);
check(".html 既有图片不调用 blob、不物化", blobCalls.get("html-mdbook-book").length === 0 && !String(htmlWindow.text ?? "").includes("/image-cache/"), blobCalls.get("html-mdbook-book"));
if (adapter) {
  const section = await adapter.readBookSectionCanonical("html-mdbook-book", "HTML Chapter");
  check(".html canonical mdRelPath 大小写不敏感映射为 .md", section.kind === "ok" && section.segments[0].mdRelPath === "text/chapter.md", section.segments?.[0]?.mdRelPath);
} else {
  check(".html canonical mdRelPath 大小写不敏感映射为 .md", false, adapterLoadError);
}

registerBook("segment-images-book", [
  { id: "one/chapter.xhtml", label: "One", xhtml: '<html xmlns="http://www.w3.org/1999/xhtml"><body><p id="chapter"><img src="images/shared.png" alt="One"/></p></body></html>' },
  { id: "two/chapter.xhtml", label: "Two", xhtml: '<html xmlns="http://www.w3.org/1999/xhtml"><body><p id="chapter"><img src="images/shared.png" alt="Two"/></p></body></html>' },
], { blobs: { "one/images/shared.png": pngBytes, "two/images/shared.png": pngBytes } });
const segmentOneImage = join(appData, "books", "segment-images-book", "mdbook", "book", "src", "one", "images", "shared.png");
const segmentTwoImage = join(appData, "books", "segment-images-book", "mdbook", "book", "src", "two", "images", "shared.png");
const segmentDecoyImage = join(appData, "books", "segment-images-book", "images", "shared.png");
for (const [path, bytes] of [[segmentOneImage, new Uint8Array([1])], [segmentTwoImage, new Uint8Array([2])], [segmentDecoyImage, new Uint8Array([99])]]) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}
if (adapter) {
  const full = await adapter.readBookDocumentCanonical("segment-images-book");
  const resolved = await adapter.resolveBookWindowImages("segment-images-book", full.text, { ...full, windowStart: 0 });
  const expected = `![One](${tsPath(segmentOneImage)})\n\n![Two](${tsPath(segmentTwoImage)})`;
  check("相同 src 按 occurrence 使用各自 spine 的 mdbook 图片", resolved === expected, { resolved, expected });
  check("segment 命中优先于同名顶层 fallback decoy", !resolved.includes(tsPath(segmentDecoyImage)) && blobCalls.get("segment-images-book").length === 0, resolved);
} else {
  check("相同 src 按 occurrence 使用各自 spine 的 mdbook 图片", false, adapterLoadError);
  check("segment 命中优先于同名顶层 fallback decoy", false, adapterLoadError);
}

registerBook("segment-fallback-book", [{
  id: "three/chapter.xhtml",
  label: "Three",
  xhtml: '<html xmlns="http://www.w3.org/1999/xhtml"><body><p id="chapter"><img src="images/shared.png" alt="Fallback"/></p></body></html>',
}], { blobs: { "three/images/shared.png": pngBytes } });
const fallbackImage = join(appData, "books", "segment-fallback-book", "images", "shared.png");
mkdirSync(dirname(fallbackImage), { recursive: true });
writeFileSync(fallbackImage, pngBytes);
if (adapter) {
  const full = await adapter.readBookDocumentCanonical("segment-fallback-book");
  const resolved = await adapter.resolveBookWindowImages("segment-fallback-book", full.text, { ...full, windowStart: 0 });
  check("segment 未命中后才应用顶层 fallback，不提前调用 blob", resolved === `![Fallback](${tsPath(fallbackImage)})` && blobCalls.get("segment-fallback-book").length === 0, resolved);
} else {
  check("segment 未命中后才应用顶层 fallback，不提前调用 blob", false, adapterLoadError);
}

registerBook("bracket-alt-book", [{
  id: "text/alt.xhtml",
  label: "Alt",
  xhtml: '<html xmlns="http://www.w3.org/1999/xhtml"><body><p id="chapter"><img src="../images/alt.png" alt="Diagram [A]"/></p></body></html>',
}], { blobs: { "images/alt.png": pngBytes } });
const bracketAltWindow = await execute(makeDocumentTool("bracket-alt-book"), {
  doc: "book:bracket-alt-book",
  heading: "Alt",
  after: 500,
});
const bracketAltText = String(bracketAltWindow.text ?? "");
const bracketAltMarker = "![Diagram \\[A\\]](";
const bracketAltStart = bracketAltText.indexOf(bracketAltMarker);
const bracketAltPathStart = bracketAltStart < 0 ? -1 : bracketAltStart + bracketAltMarker.length;
const bracketAltPathEnd = bracketAltPathStart < 0 ? -1 : bracketAltText.indexOf(")", bracketAltPathStart);
const bracketAltPath = bracketAltPathEnd < 0 ? "" : bracketAltText.slice(bracketAltPathStart, bracketAltPathEnd);
check("转义方括号 alt 的窗口图片完成路径重写", bracketAltPath.includes("/image-cache/epub/bracket-alt-book/"), bracketAltText);
check("转义方括号 alt 图片由窗口 blob 物化且字节正确", !!bracketAltPath && existsSync(bracketAltPath) && readFileSync(bracketAltPath).equals(Buffer.from(pngBytes)) && JSON.stringify(blobCalls.get("bracket-alt-book")) === JSON.stringify(["images/alt.png"]), { path: bracketAltPath, blobs: blobCalls.get("bracket-alt-book") });

console.log("[3] 全书 canonical 绝对 offset：跨 spine 相邻窗口无重不漏");
const alpha = `Alpha 😀 ${"a".repeat(550)}`;
const beta = `Beta ${"b".repeat(550)}`;
registerBook("absolute-book", [
  { label: "One", xhtml: `<html xmlns="http://www.w3.org/1999/xhtml"><body><p id="chapter">${alpha}</p></body></html>` },
  { label: "Two", xhtml: `<html xmlns="http://www.w3.org/1999/xhtml"><body><p id="chapter">${beta}</p></body></html>` },
]);
const expectedAbsolute = `${alpha}\n\n${beta}`;
if (adapter) {
  const full = await adapter.readBookDocumentCanonical("absolute-book");
  check("全书 canonical 以固定边界跨 spine 拼接", full.text === expectedAbsolute && full.totalChars === expectedAbsolute.length, {
    actualLength: full.text?.length,
    expectedLength: expectedAbsolute.length,
  });
  check("全书 segments 保留 spine/canonical 区间", full.segments?.length === 2 && full.segments[1].start === alpha.length + 2, full.segments);
} else {
  check("全书 canonical 以固定边界跨 spine 拼接", false, adapterLoadError);
  check("全书 segments 保留 spine/canonical 区间", false, adapterLoadError);
}
const absoluteTool = makeDocumentTool("absolute-book");
const absoluteFirst = await execute(absoluteTool, { doc: "book:absolute-book", offset: 0, after: 500 });
const absoluteSecond = await execute(absoluteTool, {
  doc: "book:absolute-book",
  offset: absoluteFirst.next_offset,
  after: 500,
});
const absoluteThird = await execute(absoluteTool, {
  doc: "book:absolute-book",
  offset: absoluteSecond.next_offset,
  after: 500,
});
check("显式无 heading offset=0 可读全书", absoluteFirst.text === expectedAbsolute.slice(0, 500), brief(absoluteFirst));
check("第二窗从全书绝对 next_offset 精确续读", absoluteSecond.text === expectedAbsolute.slice(500, 1000), brief(absoluteSecond));
check("第三窗跨 spine 后精确到 EOF", absoluteThird.text === expectedAbsolute.slice(1000) && absoluteThird.next_offset === null, brief(absoluteThird));
check("全书三窗拼接与 canonical 完全一致", `${absoluteFirst.text}${absoluteSecond.text}${absoluteThird.text}` === expectedAbsolute);
check("emoji 的 UTF-16 坐标不重复不遗漏", `${absoluteFirst.text}${absoluteSecond.text}${absoluteThird.text}`.split("😀").length === 2);

registerBook("no-anchor-book", [{ xhtml: WINDOW_XHTML }]);
const noAnchor = await execute(makeDocumentTool("no-anchor-book"), { doc: "book:no-anchor-book", after: 500 });
check("未显式 offset/heading/position 时不构建全书 canonical", !!noAnchor.error && openCounts.get("no-anchor-book") === 0, noAnchor.error);

console.log("[4] position 显式 offset 固定当前 md 文件续读，不回 live 起点");
registerBook("position-book", [{ xhtml: WINDOW_XHTML }]);
const positionTool = makeDocumentTool("position-book");
const positionFirst = await execute(positionTool, { doc: "book:position-book", position: true, after: 500 });
livePosition.charOffset = 0;
const positionSecond = await execute(positionTool, {
  doc: "book:position-book",
  position: true,
  offset: positionFirst.next_offset,
  after: 500,
});
const positionThird = await execute(positionTool, {
  doc: "book:position-book",
  position: true,
  offset: positionSecond.next_offset,
  after: 500,
});
check("position 第一窗从 live 位置开始", positionFirst.text === positionText.slice(100, 600), brief(positionFirst));
check("position+offset 第二窗不从 live 位置重复", positionSecond.text === positionText.slice(600, 1100), brief(positionSecond));
check("position 第三窗精确续到 EOF", positionThird.text === positionText.slice(1100) && positionThird.next_offset === null, brief(positionThird));
check("position 三窗拼接无重不漏", `${positionFirst.text}${positionSecond.text}${positionThird.text}` === positionText.slice(100));
check("position 读取不触发全书 EPUB 构建", openCounts.get("position-book") === 0, openCounts.get("position-book"));

console.log("[5] heading/spine 只读目标 section；全书构建单飞与小 LRU");
if (adapter) {
  documentCounts.get("absolute-book").fill(0);
  const byHeading = await adapter.readBookSectionCanonical("absolute-book", { heading: "One" });
  check("heading 匹配仍支持对象 query", byHeading.kind === "ok" && byHeading.text === alpha, byHeading.kind);
  check("heading 不构建其它 spine", JSON.stringify(documentCounts.get("absolute-book")) === JSON.stringify([1, 0]), documentCounts.get("absolute-book"));
  documentCounts.get("absolute-book").fill(0);
  const bySpine = await adapter.readBookSectionCanonical("absolute-book", { spine: 1 });
  check("可选 spine 直读供后续检索锚点使用", bySpine.kind === "ok" && bySpine.text === beta && bySpine.spineIndex === 1, bySpine.kind);
  check("spine 直读不构建其它章节", JSON.stringify(documentCounts.get("absolute-book")) === JSON.stringify([0, 1]), documentCounts.get("absolute-book"));

  for (const id of ["cache-a", "cache-b", "cache-c"]) {
    registerBook(id, [{ xhtml: `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>${id}</p></body></html>` }]);
  }
  await Promise.all([
    adapter.readBookDocumentCanonical("cache-a"),
    adapter.readBookDocumentCanonical("cache-a"),
    adapter.readBookDocumentCanonical("cache-a"),
  ]);
  check("同一全书 canonical 并发构建单飞", openCounts.get("cache-a") === 1, openCounts.get("cache-a"));
  await adapter.readBookDocumentCanonical("cache-b");
  await adapter.readBookDocumentCanonical("cache-c");
  await adapter.readBookDocumentCanonical("cache-a");
  check("小 LRU 有界并淘汰最旧全书 canonical", openCounts.get("cache-a") === 2, openCounts.get("cache-a"));
} else {
  for (const name of [
    "heading 匹配仍支持对象 query",
    "heading 不构建其它 spine",
    "可选 spine 直读供后续检索锚点使用",
    "spine 直读不构建其它章节",
    "同一全书 canonical 并发构建单飞",
    "小 LRU 有界并淘汰最旧全书 canonical",
  ]) check(name, false, adapterLoadError);
}

console.log("[6] foliate 失败时 New/Legacy 均保留 Rust 失败兜底");
registerBook("rust-book", [{ xhtml: WINDOW_XHTML }], { throwOnOpen: true });
const rustLegacy = await execute(app.createReadBookSectionTool("rust-book"), { chapterTitle: "Fallback", maxChars: 500 });
const rustNew = await execute(makeDocumentTool("rust-book"), { doc: "book:rust-book", heading: "Fallback", after: 500 });
check("Legacy Rust 兜底仍成功", rustLegacy.results?.success === true && rustLegacy.results.content === "Rust flattened fallback", brief(rustLegacy));
check("New JS adapter 失败也回退 Rust", rustNew.text === "Rust flattened fallback", brief(rustNew));

console.log(`\n结果：${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("PASS book-structured-text Task 6");
