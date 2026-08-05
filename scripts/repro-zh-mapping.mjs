// 离线复现：stored 译文 → escapeHtml 插入 div → KaTeX auto-render → 归一对比 token
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { tokenizeWords } from "../scripts/pca-bundle.mjs";

const t = JSON.parse(
  readFileSync("C:/Users/20995/AppData/Roaming/com.xincmm.sageread.dev/books/a27b187c6bd02d3c/translation-zh.json", "utf-8"),
).blocks["26"].text;

const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.document = dom.window.document;
const { default: renderMathInElement } = await import("../packages/app/node_modules/katex/dist/contrib/auto-render.mjs");

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const div = dom.window.document.createElement("div");
div.innerHTML = escapeHtml(t);
dom.window.document.body.appendChild(div);
renderMathInElement(div, {
  delimiters: [
    { left: "$$", right: "$$", display: true },
    { left: "$", right: "$", display: false },
  ],
  throwOnError: false,
});

const { normalizeLiveElement, normalizeMathText } = await import(
  "../scripts/pca-bundle.mjs"
);
const normL = normalizeLiveElement(div);
const normS = normalizeMathText(t);
const lt = tokenizeWords(normL.text);
const st = tokenizeWords(normS.text);
console.log("live textContent len:", div.textContent.length, "stored len:", t.length);
console.log("live katex count:", div.querySelectorAll(".katex, .katex-error").length);
console.log("liveTok:", lt.length, "storedTok:", st.length);
console.log("live text head:", JSON.stringify(div.textContent.slice(0, 200)));
console.log("stored head:", JSON.stringify(t.slice(0, 200)));
// 找两侧归一文本的第一个分叉
const a = normL.text, b = normS.text;
let i = 0;
while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
console.log("first divergence at", i);
console.log("live  around:", JSON.stringify(a.slice(Math.max(0, i - 30), i + 60)));
console.log("stored around:", JSON.stringify(b.slice(Math.max(0, i - 30), i + 60)));
