// 切块器 ↔ 渲染器一致性测试（翻译管线工程不变量）：
// react-dom/server 用与 PaperReader 相同的 remark/rehype 链渲染 fixture（zhao2020rational/paper.md），
// jsdom 中跑 listBlocks 枚举，与 cutPaperBlocks 输出逐块比对（数量一致、文本归一化后相等）；
// 再验证译文/对照重建产物的锚点安全性（块枚举不漂移、译文 div 被排除）。
// 运行：node scripts/test-paper-blocks-consistency.mjs
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
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

const outDir = mkdtempSync(join(tmpdir(), "paper-consistency-"));
const bundle = async (entry, name) => {
  const outfile = join(outDir, name);
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    jsx: "automatic",
    outfile,
  });
  return import(pathToFileURL(outfile).href);
};

const { JSDOM } = await import("jsdom");
// remark 链的 decode-named-character-reference 在模块顶层调用 document.createElement，node 下用 jsdom 垫片
const dom = new JSDOM("<!doctype html><html><body></body></html>");
// remark/rehype 链在模块顶层依赖浏览器全局（decode-named-character-reference / hast-util-raw），用 jsdom 垫片
globalThis.document = dom.window.document;
globalThis.DOMParser = dom.window.DOMParser;

const [{ renderPaperBody }, blocksMod, anchorsMod, metadataMod, sentencesMod] = await Promise.all([
  bundle(join(root, "packages/app/scripts/render-paper-entry.tsx"), "render-paper-entry.mjs"),
  bundle(join(root, "packages/app/src/pages/paper-reader/paper-blocks.ts"), "paper-blocks.mjs"),
  bundle(join(root, "packages/app/src/pages/paper-reader/paper-anchors.ts"), "paper-anchors.mjs"),
  bundle(join(root, "packages/app/src/pages/paper-reader/paper-metadata.ts"), "paper-metadata.mjs"),
  bundle(join(root, "packages/app/src/pages/paper-reader/paper-sentences.ts"), "paper-sentences.mjs"),
]);
const { cutPaperBlocks, buildPaperViewMarkdown } = blocksMod;
const { listBlocks } = anchorsMod;
const { parsePaperMarkdown } = metadataMod;
const { segmentSentences } = sentencesMod;

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

/** DOM 侧归一化：KaTeX 双份渲染产物（MathML + HTML）替换回 annotation 里的 TeX 源，再折叠空白 */
function normalizeDomText(el) {
  const clone = el.cloneNode(true);
  for (const katex of clone.querySelectorAll(".katex")) {
    const annotation = katex.querySelector('annotation[encoding="application/x-tex"]');
    katex.replaceWith(dom.window.document.createTextNode(annotation ? annotation.textContent : ""));
  }
  return clone.textContent.replace(/\s+/g, " ").trim();
}

/** 源侧归一化：去掉 extractText 为公式保留的 $ 定界（DOM 侧已还原为裸 TeX），再折叠空白 */
const normalizeSrcText = (text) => text.replace(/\$+/g, "").replace(/\s+/g, " ").trim();

/** 渲染正文并在 jsdom 容器中跑 listBlocks 枚举 */
function enumerateDomBlocks(markdown) {
  const { body } = parsePaperMarkdown(markdown.replace(/\r\n?/g, "\n"));
  const html = renderPaperBody(body);
  const container = dom.window.document.createElement("div");
  container.innerHTML = html;
  return listBlocks(container);
}

const fixturePath = join(root, "fixtures/papers/zhao2020rational/paper.md");
const markdown = (await readFile(fixturePath, "utf8")).replace(/\r\n?/g, "\n");
const cutterBlocks = cutPaperBlocks(markdown);
const domBlocks = enumerateDomBlocks(markdown);

console.log(`fixture 块数：切块器 ${cutterBlocks.length} / DOM 枚举 ${domBlocks.length}`);

check("块数量一致（切块器 vs listBlocks DOM 枚举）", () => {
  assert(cutterBlocks.length === domBlocks.length, `切块器 ${cutterBlocks.length} 块 vs DOM ${domBlocks.length} 块`);
});

check("每块文本归一化后相等", () => {
  assert(cutterBlocks.length === domBlocks.length, "块数不一致，跳过逐块比对");
  const mismatches = [];
  for (let i = 0; i < cutterBlocks.length; i++) {
    const src = normalizeSrcText(cutterBlocks[i].sourceText);
    const domText = normalizeDomText(domBlocks[i]);
    if (src !== domText) {
      mismatches.push(
        `块 ${i}（${cutterBlocks[i].kind}）:\n  源: ${src.slice(0, 120)}\n  DOM: ${domText.slice(0, 120)}`,
      );
    }
  }
  assert(mismatches.length === 0, `${mismatches.length} 块不一致：\n${mismatches.slice(0, 5).join("\n")}`);
});

// ─── 重建产物锚点安全性（假译文全量填充） ───
// 部分块用含空行/单字母行的多段译文：图注类译文的真实形态（用户实测 "B\n\n图1…"、"C\n\nD"），
// 钉死"HTML 块遇空行终止 → 译文拆出新段落 → DOM 块枚举多于切块器"的回归（229 vs 226）。
const translations = new Map();
for (const block of cutterBlocks) {
  if (!block.translatable) continue;
  const i = block.index;
  if (i % 10 === 3) translations.set(i, `B\n\n译文${i} 第二段`);
  else if (i % 10 === 7) translations.set(i, "C\n\nD");
  else if (i % 5 === 4) translations.set(i, `译文${i} 第一段\n\n第二段`);
  else translations.set(i, `译文${i}`);
}
/** 译文 div 内容的期望形态（translationDiv 内 oneLine：换行折叠为空格） */
const oneLine = (text) => text.replace(/\s*\n\s*/g, " ").trim();

check("对照模式：块枚举不漂移，译文 div 全部被 [data-translation] 排除", () => {
  const rebuilt = buildPaperViewMarkdown(markdown, translations, "bilingual");
  const blocks = enumerateDomBlocks(rebuilt);
  assert(blocks.length === cutterBlocks.length, `对照模式块数 ${blocks.length} ≠ 原文 ${cutterBlocks.length}`);
  const container = dom.window.document.createElement("div");
  const { body } = parsePaperMarkdown(rebuilt);
  container.innerHTML = renderPaperBody(body);
  const divs = container.querySelectorAll("[data-translation]");
  assert(divs.length === translations.size, `译文 div 数 ${divs.length} ≠ 译文体块数 ${translations.size}`);
  // 含空行译文不得拆出新段落：每个 div 文本即 oneLine 后的完整译文（未被空行截断）
  const divTexts = new Set(Array.from(divs, (div) => div.textContent));
  for (const [index, text] of translations) {
    assert(divTexts.has(oneLine(text)), `块 ${index} 译文 div 内容被空行拆散: ${JSON.stringify(text.slice(0, 40))}`);
  }
  for (let i = 0; i < cutterBlocks.length; i++) {
    const src = normalizeSrcText(cutterBlocks[i].sourceText);
    const domText = normalizeDomText(blocks[i]);
    // p/h/blockquote 的译文在兄弟 div 中（块文本逐字不变）；li/td/th 的译文追加在块尾（原文保持前缀）
    assert(
      domText === src || domText.startsWith(src),
      `块 ${i} 原文部分被扰动：\n  源: ${src.slice(0, 100)}\n  DOM: ${domText.slice(0, 120)}`,
    );
  }
});

check("译文模式：块数与原文一致，不可翻译块（图片）文本不变", () => {
  const rebuilt = buildPaperViewMarkdown(markdown, translations, "translated");
  const blocks = enumerateDomBlocks(rebuilt);
  assert(blocks.length === cutterBlocks.length, `译文模式块数 ${blocks.length} ≠ 原文 ${cutterBlocks.length}`);
  for (let i = 0; i < cutterBlocks.length; i++) {
    if (cutterBlocks[i].translatable) continue;
    const src = normalizeSrcText(cutterBlocks[i].sourceText);
    const domText = normalizeDomText(blocks[i]);
    assert(domText === src, `不可翻译块 ${i} 被改动：\n  源: ${src}\n  DOM: ${domText}`);
  }
});

// ─── T2 句级对齐的 DOM 映射前提 ───

/** 与 paper-reader.tsx 的 buildTranslationDivMap 同算法：取"文档顺序上最后一个起点在 div 之前的块" */
function buildTranslationDivMap(container) {
  const blocks = listBlocks(container);
  const map = new Map();
  let cursor = 0;
  for (const div of Array.from(container.querySelectorAll("[data-translation]"))) {
    while (
      cursor < blocks.length &&
      div.compareDocumentPosition(blocks[cursor]) & 2 /* PRECEDING（祖先/前序兄弟均成立） */
    ) {
      cursor += 1;
    }
    if (cursor > 0) map.set(cursor - 1, div);
  }
  return map;
}

check("对照模式：译文 div → 块索引映射全部正确（T2 映射高亮/划词标亮的定位前提）", () => {
  const rebuilt = buildPaperViewMarkdown(markdown, translations, "bilingual");
  const container = dom.window.document.createElement("div");
  const { body } = parsePaperMarkdown(rebuilt);
  container.innerHTML = renderPaperBody(body);
  const divMap = buildTranslationDivMap(container);
  // 假译文含块索引（译文${index}）：div 文本（oneLine 后）直接回证归属块
  assert(divMap.size === translations.size, `映射到的译文 div 数 ${divMap.size} ≠ 译文体块数 ${translations.size}`);
  const mismatches = [];
  for (const [index, div] of divMap) {
    const expected = translations.has(index) ? oneLine(translations.get(index)) : null;
    if (expected === null || div.textContent !== expected) {
      mismatches.push(
        `div 归属块 ${index}，但文本为 ${div.textContent?.slice(0, 30)}（期望 ${expected?.slice(0, 30)}）`,
      );
    }
  }
  assert(mismatches.length === 0, `${mismatches.length} 个译文 div 归属错位：\n${mismatches.slice(0, 5).join("\n")}`);
});

check("译文模式：可翻译块的 DOM 文本即对应块译文（块索引对齐，T2 句级精确高亮前提）", () => {
  const rebuilt = buildPaperViewMarkdown(markdown, translations, "translated");
  const blocks = enumerateDomBlocks(rebuilt);
  const mismatches = [];
  for (let i = 0; i < cutterBlocks.length; i++) {
    if (!cutterBlocks[i].translatable) continue;
    if (normalizeDomText(blocks[i]) !== oneLine(translations.get(i))) {
      mismatches.push(
        `块 ${i}: DOM "${normalizeDomText(blocks[i]).slice(0, 30)}" ≠ ${oneLine(translations.get(i)).slice(0, 30)}`,
      );
    }
  }
  assert(mismatches.length === 0, `${mismatches.length} 块译文错位：\n${mismatches.slice(0, 5).join("\n")}`);
});

check("句索引换算：oneLine 折叠换行后切句结果不变（T2 stored ↔ live 偏移换算前提）", () => {
  const oneLine = (text) => text.replace(/\s*\n\s*/g, " ").trim();
  const samples = [
    "First sentence here. Second follows closely.\n第三句是中文内容。第四句接着展开。\nFifth one ends here.",
    "单行无换行的句子。Still same line.",
    "Multi\nline\nbreaks. 中文\n换行\n也多。End.",
  ];
  for (const text of samples) {
    const a = segmentSentences(text);
    const b = segmentSentences(oneLine(text));
    assert(a.length === b.length, `句数漂移: ${a.length} vs ${b.length}（${text.slice(0, 40)}…）`);
    for (let i = 0; i < a.length; i++) {
      const sa = text.slice(a[i].start, a[i].end).replace(/\s+/g, " ");
      const sb = oneLine(text).slice(b[i].start, b[i].end).replace(/\s+/g, " ");
      assert(sa === sb, `第 ${i} 句内容漂移:\n  ${sa}\n  ${sb}`);
    }
  }
});

rmSync(outDir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length > 0 ? 1 : 0);
