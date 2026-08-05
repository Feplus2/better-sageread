// 定位 "For more than 100,000 new compositions" 所在块，dump 句对与切句
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = "F:/MyProjects/SageRead";
const pnpmDir = join(root, "node_modules", ".pnpm");
const esbuildPkg = readdirSync(pnpmDir).find((d) => d.startsWith("esbuild@"));
const esbuild = await import(pathToFileURL(join(pnpmDir, esbuildPkg, "node_modules", "esbuild", "lib", "main.js")).href);
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.document = dom.window.document;
globalThis.DOMParser = dom.window.DOMParser;
const outDir = mkdtempSync(join(tmpdir(), "mis-"));
const bundle = async (e, n) => {
  const f = join(outDir, n);
  await esbuild.build({ entryPoints: [e], bundle: true, format: "esm", jsx: "automatic", outfile: f });
  return import(pathToFileURL(f).href);
};
const { cutPaperBlocks } = await bundle(join(root, "packages/app/src/pages/paper-reader/paper-blocks.ts"), "pb.mjs");
const { segmentSentences } = await bundle(join(root, "packages/app/src/pages/paper-reader/paper-sentences.ts"), "ps.mjs");

const md = readFileSync("C:/Users/20995/AppData/Roaming/com.xincmm.sageread.dev/books/a27b187c6bd02d3c/paper.md", "utf-8");
const blocks = cutPaperBlocks(md);
const tr = JSON.parse(readFileSync("C:/Users/20995/AppData/Roaming/com.xincmm.sageread.dev/books/a27b187c6bd02d3c/translation-zh.json", "utf-8"));

const idx = blocks.findIndex((b) => b.sourceText?.includes("100,000 new compositions"));
console.log("块索引:", idx);
const src = blocks[idx].sourceText;
const tgt = tr.blocks[idx].text;
console.log("\n--- 源文切句 ---");
segmentSentences(src).forEach((s, i) => console.log(`  EN[${i}] (${s.start}..${s.end})`, JSON.stringify(src.slice(s.start, s.end).slice(0, 90))));
console.log("--- 译文切句 ---");
segmentSentences(tgt).forEach((s, i) => console.log(`  ZH[${i}] (${s.start}..${s.end})`, JSON.stringify(tgt.slice(s.start, s.end).slice(0, 60))));
console.log("--- 落库句对 ---");
for (const p of tr.blocks[idx].align ?? []) {
  console.log(`  EN(${p.ss}..${p.se})${p.low ? " [LOW]" : ""} ->`, JSON.stringify(src.slice(p.ss, p.se).slice(0, 70)));
  console.log(`  ZH(${p.ts}..${p.te})     ->`, JSON.stringify(tgt.slice(p.ts, p.te).slice(0, 55)));
}
