// 块39 真实相似度矩阵 + DP 路径成本分析
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
const outDir = mkdtempSync(join(tmpdir(), "sim-"));
const bundle = async (e, n) => {
  const f = join(outDir, n);
  await esbuild.build({ entryPoints: [e], bundle: true, format: "esm", jsx: "automatic", outfile: f });
  return import(pathToFileURL(f).href);
};
const { cutPaperBlocks } = await bundle(join(root, "packages/app/src/pages/paper-reader/paper-blocks.ts"), "pb.mjs");
const { segmentSentences } = await bundle(join(root, "packages/app/src/pages/paper-reader/paper-sentences.ts"), "ps.mjs");
const { alignSentenceDP } = await bundle(join(root, "packages/app/src/pages/paper-reader/paper-cross-anchor.ts"), "pca.mjs");

const md = readFileSync("C:/Users/20995/AppData/Roaming/com.xincmm.sageread.dev/books/a27b187c6bd02d3c/paper.md", "utf-8");
const blocks = cutPaperBlocks(md);
const tr = JSON.parse(readFileSync("C:/Users/20995/AppData/Roaming/com.xincmm.sageread.dev/books/a27b187c6bd02d3c/translation-zh.json", "utf-8"));
const src = blocks[39].sourceText, tgt = tr.blocks["39"].text;
const srcSents = segmentSentences(src).map((s) => src.slice(s.start, s.end));
const tgtSents = segmentSentences(tgt).map((s) => tgt.slice(s.start, s.end));

const cfg = JSON.parse(readFileSync("C:/Users/20995/AppData/Roaming/com.xincmm.sageread.dev/llama-store.json", "utf-8"));
const vm = cfg.state.vectorModels.find((m) => m.id === cfg.state.selectedVectorModelId) ?? cfg.state.vectorModels[0];
console.log("嵌入模型:", vm.modelId, "|", vm.url.replace(/\/[^/]*$/, "/…"));

const res = await fetch(vm.url, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${vm.apiKey}` },
  body: JSON.stringify({ model: vm.modelId, input: [...srcSents, ...tgtSents] }),
});
if (!res.ok) { console.log("embed HTTP", res.status, (await res.text()).slice(0, 200)); process.exit(1); }
const json = await res.json();
const vecs = [...json.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding);
const n = srcSents.length, m = tgtSents.length;
const norm = (v) => Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
const sim = Array.from({ length: n }, (_, i) =>
  Array.from({ length: m }, (_, j) => {
    const a = vecs[i], b = vecs[n + j];
    return a.reduce((s, x, k) => s + x * b[k], 0) / (norm(a) * norm(b));
  }),
);

console.log("\n相似度矩阵（行=EN 0..6，列=ZH 0..6）:");
process.stdout.write("      " + Array.from({ length: m }, (_, j) => ` ZH${j}   `).join(""));
sim.forEach((row, i) => {
  process.stdout.write(`\nEN${i}  ` + row.map((v) => v.toFixed(3) + "  ").join(""));
});
console.log("\n\n对角线（正确对）:", sim.map((r, i) => r[i].toFixed(3)).join(" "));

const pairs = alignSentenceDP(sim);
console.log("\nDP 选择的句对:", JSON.stringify(pairs.map(p => `EN${p.si}${p.srcCount > 1 ? "+" + (p.srcCount - 1) : ""}↔ZH${p.ti}${p.tgtCount > 1 ? "+" + (p.tgtCount - 1) : ""}(${p.score.toFixed(3)})`)));
const cost = pairs.reduce((s, p) => s + (1 - p.score), 0);
const correctCost = sim.reduce((s, r, i) => s + (1 - r[i]), 0);
console.log("DP 路径总成本:", cost.toFixed(4), "| 全 1:1 对角线路径成本:", correctCost.toFixed(4), "| 差:", (correctCost - cost).toFixed(4));
