// 论文导出管线（lib/export-paper.ts）单测：esbuild 打包 + 打桩 tauri/katex-css 依赖 → node 断言
// 覆盖：原文/译文/对照三模式 markdown 构建（frontmatter/标题 H1/译文 div 图片清理/图片剔除）、
//       标注节（排序/星标/评论）、HTML 构建（KaTeX 烘焙/图片 data URI/标注卡片区/无占位符残留）。
// 运行：node scripts/test-paper-export.mjs
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pnpmDir = join(root, "node_modules", ".pnpm");
const esbuildPkg = readdirSync(pnpmDir).find((d) => d.startsWith("esbuild@"));
if (!esbuildPkg) throw new Error("node_modules/.pnpm 下未找到 esbuild，请先 pnpm install");
const esbuild = await import(
  pathToFileURL(join(pnpmDir, esbuildPkg, "node_modules", "esbuild", "lib", "main.js")).href
);

const outDir = mkdtempSync(join(tmpdir(), "paper-export-"));
const dataDir = join(outDir, "appdata"); // 模拟 appDataDir（books/{paperId}/images 落在这里）
mkdirSync(join(dataDir, "books", "test-paper", "images"), { recursive: true });
writeFileSync(join(dataDir, "books", "test-paper", "images", "fig1.jpg"), "fake-jpeg-bytes");
globalThis.__testDataDir = dataDir;

// 打桩：tauri（path/fs/dialog/opener）、sonner、katex-css 模块（?raw/?inline esbuild 不认）
const STUBS = {
  "@tauri-apps/api/path": `
    export const appDataDir = async () => globalThis.__testDataDir;
    export const tempDir = async () => globalThis.__testDataDir;
    export const join = async (...parts) => parts.join("/");
  `,
  "@tauri-apps/api/core": `
    export const invoke = async () => { throw new Error("invoke 未打桩（测试不应触达）"); };
    export const convertFileSrc = (p) => p;
  `,
  "@tauri-apps/plugin-fs": `
    import { readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
    export const readFile = async (path) => new Uint8Array(await fsReadFile(path));
    export const writeFile = (path, contents) => fsWriteFile(path, contents);
    export const writeTextFile = (path, contents) => fsWriteFile(path, contents, "utf8");
  `,
  "@tauri-apps/plugin-dialog": `export const save = async () => null;`,
  "@tauri-apps/plugin-opener": `export const openPath = async () => {};`,
  "js-md5": `export const md5 = () => "md5-stub";`,
  sonner: `export const toast = { success(){}, error(){}, info(){}, warning(){} };`,
};
const stubPlugin = {
  name: "test-stubs",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => (STUBS[args.path] ? { path: args.path, namespace: "stub" } : null));
    build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: STUBS[args.path], loader: "js" }));
    build.onResolve({ filter: /export-paper-katex-css$/ }, (args) => ({ path: args.path, namespace: "katex-stub" }));
    build.onLoad({ filter: /.*/, namespace: "katex-stub" }, () => ({
      contents: `export const buildInlineKatexCss = () => "/*katex-stub*/";`,
      loader: "js",
    }));
  },
};

await esbuild.build({
  entryPoints: [
    join(root, "packages/app/src/lib/export-paper.ts"),
    join(root, "packages/app/src/pages/paper-reader/paper-blocks.ts"),
  ],
  bundle: true,
  format: "esm",
  platform: "node",
  outdir: outDir,
  splitting: true,
  alias: { "@": join(root, "packages/app/src") },
  plugins: [stubPlugin],
});

const { JSDOM } = await import("jsdom");
// remark 链的 decode-named-character-reference 在模块顶层调用 document.createElement，node 下用 jsdom 垫片；
// DOMParser/NodeFilter 供导出 HTML 的标注内联高亮（DOM 包裹 <mark>）使用
const domWindow = new JSDOM("").window;
globalThis.document = domWindow.document;
globalThis.DOMParser = domWindow.DOMParser;
globalThis.NodeFilter = domWindow.NodeFilter;

const { buildPaperExportMarkdown, buildPaperExportHtml } = await import(
  pathToFileURL(join(outDir, "lib", "export-paper.js")).href
);
const { cutPaperBlocks } = await import(pathToFileURL(join(outDir, "pages", "paper-reader", "paper-blocks.js")).href);

// ─── 断言工具 ───
let passed = 0;
const failures = [];
function assert(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.error(`  ✗ ${name}${detail ? `\n    ${detail}` : ""}`);
  }
}
const countOf = (text, needle) => text.split(needle).length - 1;

// ─── fixture ───
const MARKDOWN = `---
title: Test Paper Title
author:
  - Alice Smith
  - Bob Jones
date: "2024"
container-title: Journal of Tests
abstract: This is the abstract.
---

## Introduction

This is a paragraph with inline math $x^2 + y^2 = z^2$ inside.

$$
E = mc^2
$$

![Figure 1](images/fig1.jpg)

- First item
- Second item

> A quote block.

| Col A | Col B |
|-------|-------|
| a     | b     |

## Methods

Another paragraph here.
`;

const blocks = cutPaperBlocks(MARKDOWN);
const indexOf = (needle) => {
  const block = blocks.find((b) => b.sourceText.includes(needle));
  if (!block) throw new Error(`fixture 块未找到: ${needle}`);
  return block.index;
};
// 译文表（无图片引用；translated 模式用）
const TRANSLATIONS = new Map([
  [indexOf("This is a paragraph"), "这是含行内公式 $x^2$ 的段落。"],
  [indexOf("First item"), "第一项"],
  [indexOf("Methods"), "方法"],
  [indexOf("Col A"), "列 A"],
  [indexOf("Another paragraph"), "另一段文字。"],
]);
// 对照模式专用：译文里残留图片引用（模型保留了 ![](...)），导出应被清理
const TRANSLATIONS_WITH_IMG = new Map([
  [indexOf("This is a paragraph"), "这是含行内公式的段落。 ![](images/fig1.jpg)"],
]);

const makeAnnotation = (blockText, text, extra = {}) => ({
  id: `n-${blockText}`,
  cfi: JSON.stringify({ v: 1, segments: [{ b: indexOf(blockText), s: 0, e: 5 }] }),
  text,
  color: "yellow",
  createdAt: 1,
  ...extra,
});
const ANNOTATIONS = [
  makeAnnotation("Methods", "Another paragraph here.", { createdAt: 2 }),
  makeAnnotation("This is a paragraph", "inline math quote", {
    starred: true,
    note: "公式批注",
    context: { before: "before ctx", after: "after ctx" },
    createdAt: 1,
  }),
];

const BASE = { paperId: "test-paper", title: "Test Paper Title", markdown: MARKDOWN };

// ─── 1. 原文 markdown ───
console.log("\n[1] 原文模式 markdown");
{
  const doc = buildPaperExportMarkdown({
    ...BASE,
    mode: "original",
    includeAnnotations: false,
    includeImages: true,
    format: "markdown",
  });
  assert("frontmatter 原样保留", doc.includes("title: Test Paper Title"));
  assert("补标题 H1", doc.includes("# Test Paper Title"));
  assert("正文保留", doc.includes("This is a paragraph"));
  assert("图片引用保留", doc.includes("![Figure 1](images/fig1.jpg)"));
  assert("无标注节", !doc.includes("## 标注"));
}

// ─── 2. 原文 markdown：剔除图片 + 标注节 ───
console.log("\n[2] 原文模式：剔除图片 + 标注节");
{
  const doc = buildPaperExportMarkdown({
    ...BASE,
    mode: "original",
    includeAnnotations: true,
    includeImages: false,
    annotations: ANNOTATIONS,
    format: "markdown",
  });
  assert("图片引用已剔除", !doc.includes("images/fig1.jpg"));
  assert("标注节标题", doc.includes("## 标注（2 条）"));
  const annotationSection = doc.slice(doc.indexOf("## 标注"));
  assert(
    "标注按文档位置排序（块小的在前）",
    annotationSection.indexOf("inline math quote") < annotationSection.indexOf("Another paragraph here."),
  );
  assert("星标渲染", doc.includes("★"));
  assert("评论引用块", doc.includes("> 公式批注"));
  assert("前后文", doc.includes("before ctx"));
}

// ─── 3. 译文模式 markdown ───
console.log("\n[3] 译文模式 markdown");
{
  const doc = buildPaperExportMarkdown({
    ...BASE,
    mode: "translated",
    translationMap: TRANSLATIONS,
    translatedMeta: { title_zh: "测试论文标题" },
    includeAnnotations: false,
    includeImages: true,
    format: "markdown",
  });
  assert("译文替换正文", doc.includes("这是含行内公式 $x^2$ 的段落。"));
  assert("原文段落被替换", !doc.includes("This is a paragraph"));
  assert("标题 H1 用中文标题", doc.includes("# 测试论文标题"));
  assert("图片块保留", doc.includes("![Figure 1](images/fig1.jpg)"));
}

// ─── 4. 对照模式 markdown：原生引用块（非 HTML div） ───
console.log("\n[4] 对照模式 markdown：原生引用块");
{
  const doc = buildPaperExportMarkdown({
    ...BASE,
    mode: "bilingual",
    translationMap: TRANSLATIONS_WITH_IMG,
    includeAnnotations: false,
    includeImages: true,
    format: "markdown",
  });
  assert("无译文 div（markdown 导出不用 HTML）", !doc.includes(`<div class="paper-translation"`));
  assert("译文以引用块插入", doc.includes("> 这是含行内公式的段落。"));
  assert("原文与译文并存", doc.includes("This is a paragraph") && doc.includes("这是含行内公式的段落"));
  assert(
    "译文内图片引用已清理（全文仅原文块 1 处）",
    countOf(doc, "images/fig1.jpg") === 1,
    `实际 ${countOf(doc, "images/fig1.jpg")} 处`,
  );
}

// ─── 4b. 对照模式 markdown：列表项/表格单元格译文 ───
console.log("\n[4b] 对照模式 markdown：列表/表格译文");
{
  const doc = buildPaperExportMarkdown({
    ...BASE,
    mode: "bilingual",
    translationMap: TRANSLATIONS,
    includeAnnotations: false,
    includeImages: true,
    format: "markdown",
  });
  assert("列表项内缩进续行译文", doc.includes("\n  > 第一项"), doc.match(/- First item[^\n]*\n[^\n]*/)?.[0]);
  assert("表格单元格 <br> 译文", doc.includes("Col A <br> 列 A"));
  assert("普通段落译文以引用块插入", doc.includes("> 另一段文字。"));
  assert("译文公式保持 $...$ 文本", doc.includes("> 这是含行内公式 $x^2$ 的段落。"));
}

// ─── 5. HTML 构建（对照 + 标注 + 图片内嵌） ───
console.log("\n[5] HTML 构建");
{
  const html = await buildPaperExportHtml({
    ...BASE,
    mode: "bilingual",
    translationMap: TRANSLATIONS,
    translatedMeta: { title_zh: "测试论文标题" },
    includeAnnotations: true,
    includeImages: true,
    annotations: ANNOTATIONS,
    format: "html",
  });
  assert("完整 HTML 文档", html.startsWith("<!DOCTYPE html>") && html.includes("</html>"));
  assert("KaTeX 样式（桩）内联", html.includes("/*katex-stub*/"));
  assert("文档头中文标题", html.includes("<h1>测试论文标题</h1>"));
  assert("作者信息", html.includes("Alice Smith"));
  assert("公式已 KaTeX 烘焙", html.includes("katex"));
  assert("无公式占位符残留", !html.includes("@@PAPER_MATH"));
  assert("行间公式未被 <p> 包裹（块级对齐）", html.includes("katex-display") && !html.includes('<p><span class="katex-display"'));
  assert("图片已内嵌 data URI", html.includes(`data:image/jpeg;base64,${btoa("fake-jpeg-bytes")}`));
  assert("译文 div 保留", html.includes("paper-translation"));
  assert("标注卡片区", html.includes("annotations-section") && html.includes("标注（2 条）"));
  assert("标注 quote 渲染", html.includes("inline math quote"));
  assert("无 script 注入残留", !/<script(?![^>]*window\.print)/.test(html.replace("window.addEventListener('load', () => window.print());", "")));
}

// ─── 7. HTML 标注内联高亮 ───
console.log("\n[7] HTML 标注内联高亮");
{
  // 锚点覆盖引言段中的 "inline math" 词组（源文坐标，含公式块在其后——验证公式感知换算）
  const introBlock = blocks.find((b) => b.sourceText.includes("This is a paragraph"));
  const s = introBlock.sourceText.indexOf("inline math");
  const inlineAnnotation = {
    id: "n-inline",
    cfi: JSON.stringify({ v: 1, segments: [{ b: introBlock.index, s, e: s + "inline math".length }] }),
    text: "inline math",
    color: "green",
    style: "underline",
    createdAt: 1,
  };
  const html = await buildPaperExportHtml({
    ...BASE,
    mode: "original",
    includeAnnotations: true,
    includeImages: true,
    annotations: [inlineAnnotation],
    format: "html",
  });
  assert(
    "标注内联为 <mark>（underline 笔触 + 颜色变量）",
    /<mark class="pa-mark pa-mark-underline" style="--pa-color:#[0-9a-fA-F]{6}">inline math<\/mark>/.test(html),
    html.match(/.{80}inline math.{80}/)?.[0],
  );
  assert("内联后正文文本未损", html.includes("This is a paragraph with"));

  // 不附标注时不应出现 <mark>
  const htmlNoAnn = await buildPaperExportHtml({
    ...BASE,
    mode: "original",
    includeAnnotations: false,
    includeImages: true,
    annotations: [inlineAnnotation],
    format: "html",
  });
  assert("不附标注时无 <mark>", !htmlNoAnn.includes("<mark"));
}

// ─── 8. 译文模式标注内联（跨语言句词对齐映射） ───
console.log("\n[8] 译文模式标注内联（跨语言映射）");
{
  const intro = blocks.find((b) => b.sourceText.includes("This is a paragraph"));
  const zhText = "这是含行内公式的段落。";
  const s = intro.sourceText.indexOf("inline math");
  const zhS = zhText.indexOf("行内公式");
  // 句对齐覆盖整句 + 词对齐精确命中 "inline math" ↔ "行内公式"
  const translationFile = {
    version: 1,
    lang: "zh",
    updatedAt: "",
    blocks: {
      [String(intro.index)]: {
        hash: "h",
        text: zhText,
        align: [{ ss: 0, se: intro.sourceText.length, ts: 0, te: zhText.length }],
        alignW: [{ ss: s, se: s + "inline math".length, ts: zhS, te: zhS + 4 }],
      },
    },
  };
  const annotation = {
    id: "n-zh",
    cfi: JSON.stringify({ v: 1, segments: [{ b: intro.index, s, e: s + "inline math".length }] }),
    text: "inline math",
    color: "blue",
    createdAt: 1,
  };
  const html = await buildPaperExportHtml({
    ...BASE,
    mode: "translated",
    translationMap: new Map([[intro.index, zhText]]),
    translationFile,
    includeAnnotations: true,
    includeImages: true,
    annotations: [annotation],
    format: "html",
  });
  assert(
    "英文锚点经词级对齐内联到中文「行内公式」",
    /<mark class="pa-mark pa-mark-highlight" style="--pa-color:#[0-9a-fA-F]{6}">行内公式<\/mark>/.test(html),
    html.match(/.{60}行内公式.{60}/)?.[0],
  );
  assert("译文模式英文不被误标", !/<mark[^>]*>inline math<\/mark>/.test(html));

  // 无词级对齐（仅句级）→ 句吸附：整句标亮
  const htmlSent = await buildPaperExportHtml({
    ...BASE,
    mode: "translated",
    translationMap: new Map([[intro.index, zhText]]),
    translationFile: {
      ...translationFile,
      blocks: {
        [String(intro.index)]: {
          hash: "h",
          text: zhText,
          align: [{ ss: 0, se: intro.sourceText.length, ts: 0, te: zhText.length }],
        },
      },
    },
    includeAnnotations: true,
    includeImages: true,
    annotations: [annotation],
    format: "html",
  });
  assert("无词级对齐回退句级（整句标亮）", /<mark[^>]*>这是含行内公式的段落。<\/mark>/.test(htmlSent));

  // 无对齐表 → 跳过内联（不报错，文末节仍在）
  const htmlNoAlign = await buildPaperExportHtml({
    ...BASE,
    mode: "translated",
    translationMap: new Map([[intro.index, zhText]]),
    translationFile: { version: 1, lang: "zh", updatedAt: "", blocks: { [String(intro.index)]: { hash: "h", text: zhText } } },
    includeAnnotations: true,
    includeImages: true,
    annotations: [annotation],
    format: "html",
  });
  assert("无对齐表时跳过内联", !htmlNoAlign.includes("<mark") && htmlNoAlign.includes("annotations-section"));
}

// ─── 9. 对照模式中文侧镜像 ───
console.log("\n[9] 对照模式中文侧镜像");
{
  const intro = blocks.find((b) => b.sourceText.includes("This is a paragraph"));
  const zhText = "这是含行内公式的段落。";
  const s = intro.sourceText.indexOf("inline math");
  const zhS = zhText.indexOf("行内公式");
  const annotation = {
    id: "n-mirror",
    cfi: JSON.stringify({ v: 1, segments: [{ b: intro.index, s, e: s + "inline math".length }] }),
    text: "inline math",
    color: "green",
    createdAt: 1,
  };
  const html = await buildPaperExportHtml({
    ...BASE,
    mode: "bilingual",
    translationMap: new Map([[intro.index, zhText]]),
    translationFile: {
      version: 1,
      lang: "zh",
      updatedAt: "",
      blocks: {
        [String(intro.index)]: {
          hash: "h",
          text: zhText,
          align: [{ ss: 0, se: intro.sourceText.length, ts: 0, te: zhText.length }],
          alignW: [{ ss: s, se: s + "inline math".length, ts: zhS, te: zhS + 4 }],
        },
      },
    },
    includeAnnotations: true,
    includeImages: true,
    annotations: [annotation],
    format: "html",
  });
  assert("英文侧内联保留", /<mark class="pa-mark pa-mark-highlight"[^>]*>inline math<\/mark>/.test(html));
  assert(
    "中文侧镜像（低透明 pa-mark-tgt）",
    /<mark class="pa-mark pa-mark-tgt pa-mark-highlight"[^>]*>行内公式<\/mark>/.test(html),
    html.match(/.{60}行内公式.{60}/)?.[0],
  );
}

// ─── 6. HTML 剔除图片 ───
console.log("\n[6] HTML 剔除图片");
{
  const html = await buildPaperExportHtml({
    ...BASE,
    mode: "original",
    includeAnnotations: false,
    includeImages: false,
    format: "html",
  });
  assert("无图片标签", !html.includes("<img"));
  assert("无图片引用文本", !html.includes("images/fig1.jpg"));
}

// ─── 汇总 ───
rmSync(outDir, { recursive: true, force: true });
console.log(`\n${passed} 通过 / ${failures.length} 失败`);
if (failures.length > 0) {
  console.error(`失败项：${failures.join("、")}`);
  process.exit(1);
}
