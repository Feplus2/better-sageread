// dump 块39 alignW（词对），按文档顺序打印 EN 词 ↔ ZH 字
import { readFileSync } from "node:fs";
const tr = JSON.parse(readFileSync("C:/Users/20995/AppData/Roaming/com.xincmm.sageread.dev/books/a27b187c6bd02d3c/translation-zh.json", "utf-8"));
const md = readFileSync("C:/Users/20995/AppData/Roaming/com.xincmm.sageread.dev/books/a27b187c6bd02d3c/paper.md", "utf-8");
// 块39 源文：直接用 align 对的偏移从源文切（避免再 bundle 切块器）
const entry = tr.blocks["39"];
const align = entry.align;
// 从 paper.md 找该块源文（按第一句文本搜索）
const anchor = "It is worth noting that the other parts far away";
const mdPos = md.indexOf(anchor);
const lastPair = align[align.length - 1];
// pair 的 ss/se 是相对块 sourceText 的偏移；块起点 = mdPos - ss_of_lastpair... 需要先求块起点
// 块 sourceText 包含全部 7 句，块起点 = mdPos - lastPair.ss
const blockStart = mdPos - lastPair.ss;
const src = md.slice(blockStart, blockStart + lastPair.se + 400); // 留余量
const en = (p) => JSON.stringify(src.slice(p.ss, p.se));
const zh = (p) => JSON.stringify(entry.text.slice(p.ts, p.te));
console.log("句对范围: EN", lastPair.ss, "..", lastPair.se, "| ZH", lastPair.ts, "..", lastPair.te);
console.log("EN 句:", en(lastPair));
console.log("ZH 句:", zh(lastPair));
// alignW 是该块所有词对的扁平数组，只取落在本句对范围内的
console.log("\n词对（本句对内）:");
for (const p of entry.alignW ?? []) {
  if (p.ss >= lastPair.ss && p.se <= lastPair.se) {
    console.log(`  ${en(p)}${p.low ? " [LOW]" : ""}\n  ↔ ${zh(p)}`);
  }
}
