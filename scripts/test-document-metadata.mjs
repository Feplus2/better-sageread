// Task 5 L1：getDocumentInfo/readDocMetadata 论文元数据等价与 frontmatter 回退。
// 运行：node scripts/test-document-metadata.mjs
import {
  copyFileSync,
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
if (!esbuildPkg) {
  console.error("FAIL 未找到 esbuild");
  process.exit(1);
}
const esbuild = await import(
  pathToFileURL(join(pnpmDir, esbuildPkg, "node_modules", "esbuild", "lib", "main.js")).href
);

const outDir = mkdtempSync(join(tmpdir(), "document-metadata-"));
process.on("exit", () => rmSync(outDir, { recursive: true, force: true }));
const entry = join(outDir, "entry.ts");
const outfile = join(outDir, "document-metadata.mjs");
const tsPath = (path) => path.replace(/\\/g, "/");
writeFileSync(
  entry,
  [
    `export { readDocMetadata } from "${tsPath(join(src, "ai/tools/document/shared.ts"))}";`,
    `export { createGetDocumentInfoTool } from "${tsPath(join(src, "ai/tools/document/get-document-info.ts"))}";`,
    `export { normalizeAuthors, parsePaperMarkdown } from "${tsPath(join(src, "pages/paper-reader/paper-metadata.ts"))}";`,
  ].join("\n"),
);

const STUBS = {
  "@tauri-apps/api/path": "export const appDataDir = async () => globalThis.__SAGEREAD_TEST_APP_DATA__;",
  "@tauri-apps/api/core": `
    export async function invoke(command) {
      if (command === "plugin:epub|paper_index_status") return { indexed: true, chunkCount: 84 };
      throw new Error("unexpected invoke: " + command);
    }
  `,
  "@tauri-apps/plugin-fs": `
    import { existsSync } from "node:fs";
    import { readFile, readdir } from "node:fs/promises";
    export const exists = async (path) => existsSync(path);
    export const readTextFile = (path) => readFile(path, "utf8");
    export const readDir = async (path) => readdir(path, { withFileTypes: true });
  `,
};
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile,
  alias: { "@": src },
  plugins: [
    {
      name: "document-metadata-test-stubs",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) =>
          STUBS[args.path] ? { path: args.path, namespace: "document-stub" } : null,
        );
        build.onLoad({ filter: /.*/, namespace: "document-stub" }, (args) => ({
          contents: STUBS[args.path],
          loader: "js",
        }));
        build.onResolve({ filter: /^@\/services\/book-translation\/book-translation-service$/ }, () => ({
          path: "book-translation-service",
          namespace: "book-stub",
        }));
        build.onLoad({ filter: /.*/, namespace: "book-stub" }, () => ({
          contents: `export const openBookDocument = async () => { throw new Error("EPUB fallback not used in this test"); };`,
          loader: "js",
        }));
      },
    },
  ],
});
const mod = await import(pathToFileURL(outfile).href);

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
function getInfo(scope, currentId, doc) {
  const tool = mod.createGetDocumentInfoTool({ scope, currentId, retrievalScope: "current" });
  return tool.execute(
    { reasoning: "Task 5 metadata regression", doc: `${scope === "paper" ? "paper" : "book"}:${doc ?? currentId}` },
    { toolCallId: `m${++callId}`, messages: [] },
  );
}
function writeDoc(app, kind, id, files) {
  const dir = join(app, "books", id);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof content === "string" ? content : JSON.stringify(content));
  }
  return dir;
}

console.log("[1] 真实 Rational：作者全量等价、date=2020、abstract 非空");
const appData = process.env.APPDATA;
const rationalId = "a27b187c6bd02d3c";
const rationalApp = appData ? join(appData, "com.bettersageread.dev") : "";
check(
  "真实 Rational metadata/paper 存在",
  !!rationalApp &&
    existsSync(join(rationalApp, "books", rationalId, "metadata.json")) &&
    existsSync(join(rationalApp, "books", rationalId, "paper.md")),
  rationalApp,
);
if (rationalApp && existsSync(join(rationalApp, "books", rationalId, "paper.md"))) {
  globalThis.__SAGEREAD_TEST_APP_DATA__ = rationalApp;
  const info = await getInfo("paper", rationalId);
  const rationalRaw = JSON.parse(readFileSync(join(rationalApp, "books", rationalId, "metadata.json"), "utf8"));
  const expectedAuthors = rationalRaw.author.map((author) => author.name);
  check(
    `Rational authors 与原始 JSON 全量等价（当前 ${expectedAuthors.length} 人）`,
    JSON.stringify(info.metadata.authors) === JSON.stringify(expectedAuthors),
    { expected: expectedAuthors, actual: info.metadata.authors },
  );
  check(
    "Rational 首尾作者正确",
    info.metadata.authors?.[0] === expectedAuthors[0] &&
      info.metadata.authors?.[expectedAuthors.length - 1] === expectedAuthors[expectedAuthors.length - 1],
    { first: info.metadata.authors?.[0], last: info.metadata.authors?.[expectedAuthors.length - 1] },
  );
  check("Rational date=2020", info.metadata.date === "2020", info.metadata.date);
  check(
    "Rational abstract 非空",
    typeof info.metadata.abstract === "string" && info.metadata.abstract.length > 100,
    String(info.metadata.abstract).slice(0, 80),
  );
  check(
    "Rational venue/DOI 保留",
    info.metadata.venue === "Science" && info.metadata.doi === "10.1126/science.aay9972",
    info.metadata,
  );
  check("Rational doc.title 保留", String(info.doc.title).includes("Rational design"), info.doc.title);
}

console.log("[2] 标准论文 metadata.json：author 数组与完整出版字段");
const fixtureApp = join(outDir, "fixture-app");
const standardId = "standard-paper";
const standardAuthors = [
  "Alice String",
  "Bob Object",
  "Author 03",
  "Author 04",
  "Author 05",
  "Author 06",
  "Author 07",
  "Author 08",
  "Author 09",
  "Author 10",
  "Author 11",
  "Author 12",
  "Author 13",
  "Author 14",
  "Author 15",
  "Author 16",
];
writeDoc(fixtureApp, "paper", standardId, {
  "metadata.json": {
    title: "Standard paper",
    author: ["Alice String", { name: "Bob Object", affiliation: "Lab" }, ...standardAuthors.slice(2)],
    date: "2024-05",
    abstract: "A complete abstract.",
    keywords: ["alpha", "beta"],
    volume: "12",
    issue: "3",
    page: "101–119",
    doi: "10.1000/test",
    "container-title": "Journal of Tests",
    lang: "en",
  },
  "paper.md": "---\ntitle: Frontmatter title\n---\n# Abstract\nBody",
});
globalThis.__SAGEREAD_TEST_APP_DATA__ = fixtureApp;
const standard = await getInfo("paper", standardId);
check(
  "字符串/对象混合的 16 作者数组复用 normalizeAuthors",
  standard.metadata.authors?.length === 16 &&
    JSON.stringify(standard.metadata.authors) === JSON.stringify(standardAuthors),
  standard.metadata.authors,
);
check(
  "date/abstract/keywords 完整",
  standard.metadata.date === "2024-05" &&
    standard.metadata.abstract === "A complete abstract." &&
    JSON.stringify(standard.metadata.keywords) === JSON.stringify(["alpha", "beta"]),
  standard.metadata,
);
check(
  "volume/issue/page 完整",
  standard.metadata.volume === "12" && standard.metadata.issue === "3" && standard.metadata.page === "101–119",
  standard.metadata,
);
check(
  "venue/DOI/language 兼容",
  standard.metadata.venue === "Journal of Tests" &&
    standard.metadata.doi === "10.1000/test" &&
    standard.metadata.language === "en",
  standard.metadata,
);
check("date 同时保留 published 兼容字段", standard.metadata.published === "2024-05", standard.metadata.published);

console.log("[3] paper.md frontmatter：独立解析、缺文件与字段级回退");
const fixturePaper = join(root, "fixtures/papers/akter2026atscale/paper.md");
const fixtureRaw = readFileSync(fixturePaper, "utf8");
const parsedFixture = mod.parsePaperMarkdown(fixtureRaw);
check(
  "fixture frontmatter 可独立解析",
  parsedFixture.metadata.title?.startsWith("At-Scale Data-Driven") &&
    mod.normalizeAuthors(parsedFixture.metadata.author).length === 2 &&
    parsedFixture.metadata.date === "2010" &&
    parsedFixture.metadata.abstract?.length > 100,
  { metadata: parsedFixture.metadata, bodyLength: parsedFixture.body.length },
);
const fallbackId = "fallback-paper";
const fallbackDir = join(fixtureApp, "books", fallbackId);
mkdirSync(fallbackDir, { recursive: true });
copyFileSync(fixturePaper, join(fallbackDir, "paper.md"));
const fallback = await getInfo("paper", fallbackId);
check(
  "metadata.json 缺失时回退 frontmatter 作者/date/abstract",
  JSON.stringify(fallback.metadata.authors) === JSON.stringify(["Suchona Akter", "Mohammad R. Momeni"]) &&
    fallback.metadata.date === "2010" &&
    fallback.metadata.abstract?.length > 100,
  fallback.metadata,
);
check(
  "frontmatter 回退也提供 doc.title",
  String(fallback.doc.title).startsWith("At-Scale Data-Driven"),
  fallback.doc.title,
);
const partialId = "partial-paper";
writeDoc(fixtureApp, "paper", partialId, {
  "metadata.json": { title: "JSON title wins", author: [{ name: "JSON Author" }] },
  "paper.md": fixtureRaw,
});
const partial = await getInfo("paper", partialId);
check(
  "已有 JSON 字段优先，缺失字段从 frontmatter 补齐",
  partial.doc.title === "JSON title wins" &&
    JSON.stringify(partial.metadata.authors) === JSON.stringify(["JSON Author"]) &&
    partial.metadata.date === "2010" &&
    partial.metadata.abstract?.length > 100,
  { title: partial.doc.title, metadata: partial.metadata },
);

console.log("[4] 书籍元数据形状保持不变");
const bookId = "metadata-book";
writeDoc(fixtureApp, "book", bookId, {
  "metadata.json": { title: "Book title", author: { name: "Michel Foucault" }, published: "1969", language: "fr" },
  "metadata.md": "# Book\n\n## 目录\n- 第一章\n",
});
const book = await getInfo("reader", bookId);
check(
  "book metadata 仍只返回原 authors/published/language 形状",
  JSON.stringify(book.metadata) === JSON.stringify({ authors: "Michel Foucault", published: "1969", language: "fr" }),
  book.metadata,
);
const rawBook = await mod.readDocMetadata({ kind: "book", id: bookId });
check(
  "book readDocMetadata 原始字段和 author 解析不变",
  rawBook.author === "Michel Foucault" && rawBook.published === "1969" && rawBook.raw?.title === "Book title",
  rawBook,
);

console.log(`\n结果：${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("PASS document-metadata Task 5");
