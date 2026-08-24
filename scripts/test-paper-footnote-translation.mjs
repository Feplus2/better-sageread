// 脚注翻译链路测试（fn:<id> 独立键方案）：
//   extractPaperFootnotes 提取 → buildPaperViewMarkdown 译文/对照重建 → 导出对照重建，
// 全程验证块枚举不漂移（listBlocks vs cutPaperBlocks）、译文落进 GFM 脚注区、孤儿脚注兜底兼容。
// 运行：node scripts/test-paper-footnote-translation.mjs
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
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

const outDir = mkdtempSync(join(tmpdir(), "paper-footnote-"));
const bundle = async (entry, name) => {
  const outfile = join(outDir, name);
  await esbuild.build({ entryPoints: [entry], bundle: true, format: "esm", jsx: "automatic", outfile });
  return import(pathToFileURL(outfile).href);
};

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.document = dom.window.document;
globalThis.DOMParser = dom.window.DOMParser;

const [{ renderPaperBody }, blocksMod, anchorsMod, metadataMod] = await Promise.all([
  bundle(join(root, "packages/app/scripts/render-paper-entry.tsx"), "render-paper-entry.mjs"),
  bundle(join(root, "packages/app/src/pages/paper-reader/paper-blocks.ts"), "paper-blocks.mjs"),
  bundle(join(root, "packages/app/src/pages/paper-reader/paper-anchors.ts"), "paper-anchors.mjs"),
  bundle(join(root, "packages/app/src/pages/paper-reader/paper-metadata.ts"), "paper-metadata.mjs"),
]);
const { cutPaperBlocks, extractPaperFootnotes, buildPaperViewMarkdown, buildPaperBilingualExportMarkdown } = blocksMod;
const { listBlocks } = anchorsMod;
const { parsePaperMarkdown } = metadataMod;

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL - ${name}: ${error.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// 契约产物形态：frontmatter + 正文 + GFM 脚注（被引用 [^1]/[^note] + 孤儿 [^orphan]）
const markdown = `---
title: Footnote Fixture
---

# Introduction

Main text with a cited footnote[^1] and another[^note]. Math here $E=mc^2$ stays.

Second paragraph references nothing.

[^1]: First footnote with $x^2$ inline math.

[^note]: Multi part note
    with continuation line.

[^orphan]: Orphan definition never cited.
`;

const footnotes = extractPaperFootnotes(markdown);

check("extractPaperFootnotes：id 与文本正确（行内公式保留 $ 定界）", () => {
  assert(footnotes.length === 3, `脚注数 ${footnotes.length} ≠ 3`);
  assert(footnotes[0].id === "1" && footnotes[0].text.includes("$x^2$"), `fn 1 文本异常: ${footnotes[0]?.text}`);
  assert(footnotes[1].id === "note", `fn id 异常: ${footnotes[1]?.id}`);
  assert(footnotes[1].text.includes("with continuation line"), `fn note 续行丢失: ${footnotes[1]?.text}`);
  assert(footnotes[2].id === "orphan", `孤儿脚注未提取: ${JSON.stringify(footnotes.map((f) => f.id))}`);
});

const fnTranslations = new Map([
  ["1", "第一条脚注译文 $x^2$ 公式保留"],
  ["note", "多行注释的译文"],
  ["orphan", "孤儿脚注的译文"],
]);
const blockTranslations = new Map();
for (const block of cutPaperBlocks(markdown)) {
  if (block.translatable) blockTranslations.set(block.index, `译文块${block.index}`);
}

/** 渲染 markdown 到 jsdom 容器 */
function renderContainer(md) {
  const { body } = parsePaperMarkdown(md.replace(/\r\n?/g, "\n"));
  const container = dom.window.document.createElement("div");
  container.innerHTML = renderPaperBody(body);
  return container;
}

const baseBlocks = listBlocks(renderContainer(markdown)).length;
const cutterCount = cutPaperBlocks(markdown).length;
console.log(`基线：切块器 ${cutterCount} 块 / DOM 枚举 ${baseBlocks} 块（含脚注区 li）`);

check("译文模式：脚注定义内容替换为译文，块枚举与基线一致", () => {
  const rebuilt = buildPaperViewMarkdown(markdown, blockTranslations, "translated", fnTranslations);
  const refn = extractPaperFootnotes(rebuilt);
  assert(refn.length === 3, `重建后脚注数 ${refn.length} ≠ 3`);
  assert(refn[0].text === "第一条脚注译文 $x^2$ 公式保留", `fn 1 未替换: ${refn[0]?.text}`);
  assert(refn[1].text === "多行注释的译文", `fn note 未替换: ${refn[1]?.text}`);
  // 模型译文丢 [^id] 引用标记时由 restoreFootnoteRefs 补回（否则 GFM 不渲染脚注区，译文脚注成死文本）
  assert(rebuilt.includes("[^1]") && rebuilt.includes("[^note]"), "译文模式脚注引用标记未补回");
  const blocks = listBlocks(renderContainer(rebuilt));
  assert(blocks.length === baseBlocks, `译文模式块数 ${blocks.length} ≠ 基线 ${baseBlocks}`);
  const fnSection = renderContainer(rebuilt).querySelector("[data-footnotes]");
  assert(fnSection, "译文模式脚注区未渲染");
  assert(fnSection.textContent.includes("第一条脚注译文"), "脚注区未见译文");
});

check("对照模式：译文 div 落进脚注区且被块枚举排除，块枚举与基线一致", () => {
  const rebuilt = buildPaperViewMarkdown(markdown, blockTranslations, "bilingual", fnTranslations);
  const container = renderContainer(rebuilt);
  const fnSection = container.querySelector("[data-footnotes]");
  assert(fnSection, "对照模式脚注区未渲染");
  const fnDivs = fnSection.querySelectorAll("[data-translation]");
  assert(fnDivs.length === 2, `脚注区译文 div 数 ${fnDivs.length} ≠ 2（被引用两条）`);
  assert(fnDivs[0].textContent.includes("第一条脚注译文"), `脚注 div 内容异常: ${fnDivs[0]?.textContent}`);
  // 原文保留（对照语义）：脚注区仍含英文原文
  assert(fnSection.textContent.includes("First footnote with"), "对照模式脚注原文丢失");
  const blocks = listBlocks(container);
  assert(blocks.length === baseBlocks, `对照模式块数 ${blocks.length} ≠ 基线 ${baseBlocks}`);
});

check("导出对照 markdown：译文以续块引用收进脚注定义，重解析仍属该定义", () => {
  const exported = buildPaperBilingualExportMarkdown(markdown, blockTranslations, fnTranslations);
  const refn = extractPaperFootnotes(exported);
  assert(refn.length === 3, `导出后脚注数 ${refn.length} ≠ 3`);
  assert(refn[0].text.includes("First footnote with"), "导出弄丢脚注原文");
  assert(refn[0].text.includes("第一条脚注译文"), `导出未见脚注译文: ${refn[0]?.text}`);
});

check("无脚注文档：extractPaperFootnotes 空数组，重建行为不变", () => {
  const plain = "---\ntitle: Plain\n---\n\n# A\n\nHello world.\n";
  assert(extractPaperFootnotes(plain).length === 0, "无脚注文档应返回空数组");
  const rebuilt = buildPaperViewMarkdown(plain, new Map([[1, "你好"]]), "bilingual", undefined);
  assert(rebuilt.includes("Hello world."), "无脚注文档重建异常");
});

console.log(`\n${passed} 通过 / ${failures.length} 失败`);
rmSync(outDir, { recursive: true, force: true });
process.exit(failures.length > 0 ? 1 : 0); // esbuild 服务句柄会挂住事件循环，显式退出
