// 全链路离线复现（block 26）：中文选区 → mapTgtRangeToSrc → mapSourceOffsetsToLive（英文 rehype-katex DOM）
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.document = dom.window.document;

const { cutPaperBlocks, renderTranslationHtml } = await import("../../../scripts/pb-bundle.mjs");
const { normalizeLiveElement, normalizeMathText, mapTgtRangeToSrc, mapSourceOffsetsToLive, tokenizeWords } = await import("../../../scripts/pca-bundle.mjs");

const bookDir = "C:/Users/20995/AppData/Roaming/com.xincmm.sageread.dev/books/a27b187c6bd02d3c";
const md = readFileSync(`${bookDir}/paper.md`, "utf-8");
const trans = JSON.parse(readFileSync(`${bookDir}/translation-zh.json`, "utf-8"));
const entry = trans.blocks["26"];
const srcBlock = cutPaperBlocks(md)[26];
console.log("srcBlock kind:", srcBlock.kind, "len:", srcBlock.sourceText.length);

// 1. 中文选区 [0,6) 直接按 stored 坐标（live===stored 的快路径不适用，走词级映射）
const align = entry.align;
const alignW = entry.alignW;
const mapped = mapTgtRangeToSrc(align, 0, 6, alignW);
console.log("mapped (src coords):", JSON.stringify(mapped));
console.log("mapped text:", JSON.stringify(srcBlock.sourceText.slice(mapped.ss, mapped.se)));

// 2. 英文块经 rehype-katex 渲染（react-dom/server + jsdom 取元素）
const React = (await import("react")).default;
const { renderToStaticMarkup } = await import("react-dom/server");
const ReactMarkdown = (await import("react-markdown")).default;
const remarkGfm = (await import("remark-gfm")).default;
const remarkMath = (await import("remark-math")).default;
const rehypeKatex = (await import("rehype-katex")).default;
const html = renderToStaticMarkup(
  React.createElement(ReactMarkdown, { remarkPlugins: [[remarkGfm], [remarkMath]], rehypePlugins: [[rehypeKatex]] }, srcBlock.sourceText),
);
const wrap = dom.window.document.createElement("div");
wrap.innerHTML = html;
const liveEl = wrap.firstElementChild;

const normLive = normalizeLiveElement(liveEl);
const normSrc = normalizeMathText(srcBlock.sourceText);
console.log("en liveTok:", tokenizeWords(normLive.text).length, "srcTok:", tokenizeWords(normSrc.text).length,
  "liveSpans:", normLive.spans.length, "srcSpans:", normSrc.spans.length);
const liveOffsets = mapSourceOffsetsToLive(normSrc, normLive, mapped.ss, mapped.se);
console.log("liveOffsets:", JSON.stringify(liveOffsets));
if (liveOffsets) console.log("live text:", JSON.stringify(normLive.raw.slice(liveOffsets.start, liveOffsets.end)));
