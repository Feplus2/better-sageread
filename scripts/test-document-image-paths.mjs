// L1 单测：readDocument 图片相对路径 -> 绝对路径重写（2026-10-22）。
// 运行：node scripts/test-document-image-paths.mjs
// 覆盖：书籍 mdbook 相对路径 / ../ 归一化 / 论文 images / 顶层兜底 / HTML <img> /
//      幂等 / 已绝对与外部引用不动 / 普通链接不动 / 文件不存在保留原文 / 越界不重写。
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, "packages/app/src");
const pnpmDir = join(root, "node_modules", ".pnpm");
const { readdirSync } = await import("node:fs");
const esbuildPkg = readdirSync(pnpmDir).find((d) => d.startsWith("esbuild@"));
if (!esbuildPkg) {
  console.error("FAIL 未找到 esbuild");
  process.exit(1);
}
const esbuild = await import(
  pathToFileURL(join(pnpmDir, esbuildPkg, "node_modules", "esbuild", "lib", "main.js")).href
);

const outDir = mkdtempSync(join(tmpdir(), "document-image-paths-"));
const entry = join(outDir, "entry.ts");
writeFileSync(
  entry,
  [
    `export { rewriteDocumentImagePaths, joinImagePath, normalizeImagePath, isLocalRelativeImageRef } from "${join(src, "ai/tools/document/image-paths.ts").replace(/\\/g, "/")}";`,
  ].join("\n"),
);
const outfile = join(outDir, "image-paths.mjs");
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "neutral",
  outfile,
  alias: { "@": src },
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
    console.log(
      `  FAIL ${name}${detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`,
    );
  }
}

/** 大小写不敏感的假文件系统（Windows 语义）；dirs: 目录 -> 子目录名 */
const norm = (p) => String(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
function fakeFs(files, dirs) {
  const fileSet = new Set(files.map(norm));
  const dirMap = new Map(Object.entries(dirs).map(([dir, children]) => [norm(dir), children]));
  return {
    exists: async (p) => fileSet.has(norm(p)) || dirMap.has(norm(p)),
    listDir: async (p) => dirMap.get(norm(p)) ?? [],
    calls: { exists: 0, listDir: 0 },
  };
}

const APP = "C:/Users/test/AppData/Roaming/com.bettersageread.dev";
const BOOK = `${APP}/books/book1`;
const SRC = `${BOOK}/mdbook/book/src`;
const PAPER = `${APP}/books/paper1`;

const bookFiles = [
  `${SRC}/EPUB/images/p049.jpg`,
  `${SRC}/EPUB/images/p050.jpg`,
  `${SRC}/EPUB/images/top.png`,
  `${SRC}/images/root.png`,
  `${BOOK}/images/cover-fallback.png`,
];
const bookDirs = {
  [`${BOOK}/mdbook`]: ["book"],
  [`${BOOK}/mdbook/book`]: ["src"],
  [`${SRC}`]: ["EPUB", "images"],
  [`${SRC}/EPUB`]: ["images", "sub"],
  [`${SRC}/EPUB/images`]: [],
  [`${SRC}/images`]: [],
  [`${SRC}/EPUB/sub`]: [],
  [`${BOOK}/images`]: [],
};
const paperFiles = [`${PAPER}/images/fig1.png`, `${PAPER}/images/fig2.jpg`];
const paperDirs = { [`${PAPER}/images`]: [] };

const bookCtx = { kind: "book", docDir: BOOK, mdRelPath: "EPUB/chapter_003.md" };
const paperCtx = { kind: "paper", docDir: PAPER };

console.log("[1] 书籍 mdbook：相对路径 -> 绝对路径（md 文件目录下的 images/）");
{
  const fs = fakeFs(bookFiles, bookDirs);
  const text = "正文前\n![图 49](images/p049.jpg)\n正文后";
  const out = await mod.rewriteDocumentImagePaths(text, bookCtx, fs);
  check("含绝对路径", out.includes(`![${"图 49"}](${SRC}/EPUB/images/p049.jpg)`), out);
  check("不再含相对路径", !out.includes("(images/p049.jpg)"), out);
  check("正文不动", out.startsWith("正文前") && out.endsWith("正文后"), out);
  check("无标题时保留 alt", out.includes("![图 49]("), out);
}

console.log("[2] 书籍：../ 归一化（从 EPUB/sub 读到 src 根 images/）");
{
  const fs = fakeFs(bookFiles, bookDirs);
  const subCtx = { kind: "book", docDir: BOOK, mdRelPath: "EPUB/sub/chapter.md" };
  const up1 = await mod.rewriteDocumentImagePaths("![](../images/top.png)", subCtx, fs);
  check("../ -> EPUB/images/top.png", up1.includes(`![](${SRC}/EPUB/images/top.png)`), up1);
  const up2 = await mod.rewriteDocumentImagePaths("![](../../images/root.png)", subCtx, fs);
  check("../../ -> src 根 images/root.png", up2.includes(`![](${SRC}/images/root.png)`), up2);
  check(
    "joinImagePath 消 ./ 与 ../",
    mod.joinImagePath(`${SRC}/EPUB/sub`, ".././images/top.png") === `${SRC}/EPUB/images/top.png`,
    mod.joinImagePath(`${SRC}/EPUB/sub`, ".././images/top.png"),
  );
}

console.log("[3] 论文：paper.md 同目录 images/ -> 绝对路径（含 title）");
{
  const fs = fakeFs(paperFiles, paperDirs);
  const text = '![Fig 1](images/fig1.png "caption one")\n正文\n![](images/fig2.jpg)';
  const out = await mod.rewriteDocumentImagePaths(text, paperCtx, fs);
  check("带 title 保留 title", out.includes(`![Fig 1](${PAPER}/images/fig1.png "caption one")`), out);
  check("无 title 的也重写", out.includes(`![](${PAPER}/images/fig2.jpg)`), out);
  check("普通正文不动", out.includes("\n正文\n"), out);
  const parent = await mod.rewriteDocumentImagePaths("![](images/../images/fig1.png)", paperCtx, fs);
  check("论文 ../ 归一化", parent.includes(`![](${PAPER}/images/fig1.png)`), parent);
  const backslash = await mod.rewriteDocumentImagePaths("![](images\\fig1.png)", paperCtx, fs);
  check("反斜杠相对路径同样解析", backslash.includes(`![](${PAPER}/images/fig1.png)`), backslash);
}

console.log("[4] 幂等：已是绝对路径 / 二次重写不再变化");
{
  const fs = fakeFs(bookFiles, bookDirs);
  const once = await mod.rewriteDocumentImagePaths("![](images/p049.jpg)", bookCtx, fs);
  const twice = await mod.rewriteDocumentImagePaths(once, bookCtx, fs);
  check("二次重写字符串不变", twice === once, { once, twice });
  const absolute = `![](${SRC}/EPUB/images/p049.jpg)`;
  const out = await mod.rewriteDocumentImagePaths(absolute, bookCtx, fs);
  check("绝对路径原样返回", out === absolute, out);
  check(
    "外部 URL 原样保留",
    (await mod.rewriteDocumentImagePaths("![x](https://example.com/a.png)", bookCtx, fs)) ===
      "![x](https://example.com/a.png)",
  );
  check(
    "attachment:// 原样保留",
    (await mod.rewriteDocumentImagePaths("![x](attachment://img-1.png)", bookCtx, fs)) ===
      "![x](attachment://img-1.png)",
  );
}

console.log("[5] 只改图片链接：普通链接/正文/缺失文件不动");
{
  const fs = fakeFs(bookFiles, bookDirs);
  const text = [
    "[普通链接](../docs/notes.md)",
    "[外部](https://example.com/a?b=1)",
    "![](images/missing.png)",
    '<a href="images/p049.jpg">链接不是图片</a>',
  ].join("\n");
  const out = await mod.rewriteDocumentImagePaths(text, bookCtx, fs);
  check("普通链接不再改写范围", out === text, out);
  check("缺失图片保留原文", out.includes("![](images/missing.png)"), out);
}

console.log("[6] 书籍顶层兜底：无 mdRelPath 时按 {bookDir}/images/ 解析");
{
  const fs = fakeFs(bookFiles, bookDirs);
  const headingCtx = { kind: "book", docDir: BOOK };
  const out = await mod.rewriteDocumentImagePaths("![](images/cover-fallback.png)", headingCtx, fs);
  check("fallback 命中", out.includes(`![](${BOOK}/images/cover-fallback.png)`), out);
}

console.log("[7] HTML <img src> 重写（双引号/单引号；仅图片标签）");
{
  const fs = fakeFs(bookFiles, bookDirs);
  const doubleQuoted = await mod.rewriteDocumentImagePaths('<img src="images/p049.jpg" alt="fig">', bookCtx, fs);
  check("双引号 src 重写", doubleQuoted.includes(`<img src="${SRC}/EPUB/images/p049.jpg" alt="fig">`), doubleQuoted);
  const singleQuoted = await mod.rewriteDocumentImagePaths("<img alt='f' src='images/p050.jpg'>", bookCtx, fs);
  check("单引号 src 重写", singleQuoted.includes(`src='${SRC}/EPUB/images/p050.jpg'`), singleQuoted);
  const onlyHtml = await mod.rewriteDocumentImagePaths('<img src="images/p049.jpg">', paperCtx, fakeFs([], {}));
  check("HTML-only 且解析失败时原样返回", onlyHtml === '<img src="images/p049.jpg">', onlyHtml);
}

console.log("[8] 安全边界：../ 逃出本书目录不重写；绝对/根路径不重写");
{
  const fs = fakeFs([`${APP}/secret.png`, ...bookFiles], bookDirs);
  const escapeCtx = { kind: "book", docDir: BOOK, mdRelPath: "EPUB/chapter_003.md" };
  const escaped = await mod.rewriteDocumentImagePaths("![](../../../secret.png)", escapeCtx, fs);
  check("../ 越界保留原文", escaped === "![](../../../secret.png)", escaped);
  const rootAbs = "![](/images/p049.jpg)";
  check("根路径不重写", (await mod.rewriteDocumentImagePaths(rootAbs, bookCtx, fs)) === rootAbs);
  check(
    "Windows 绝对路径不重写",
    (await mod.rewriteDocumentImagePaths("![](C:/tmp/x.png)", bookCtx, fs)) === "![](C:/tmp/x.png)",
  );
}

console.log("[9] 体积：只替换链接目标，不追加重复文本");
{
  const fs = fakeFs(bookFiles, bookDirs);
  const text = "一段正文\n![](images/p049.jpg)\n另一段正文";
  const out = await mod.rewriteDocumentImagePaths(text, bookCtx, fs);
  const added = out.length - text.length;
  const prefix = `${SRC}/EPUB/images/p049.jpg`.length - "images/p049.jpg".length;
  check("长度增量恰好等于绝对路径前綴", added === prefix, { added, prefix });
}

console.log(`\n结果：${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("PASS document-image-paths L1");
