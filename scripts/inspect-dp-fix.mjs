// 对比 旧成本 vs 组大小缩放成本 的 DP 路径（块39=错位现场, 块219=有正当合并）
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
const outDir = mkdtempSync(join(tmpdir(), "dpfix-"));
const bundle = async (e, n) => {
  const f = join(outDir, n);
  await esbuild.build({ entryPoints: [e], bundle: true, format: "esm", jsx: "automatic", outfile: f });
  return import(pathToFileURL(f).href);
};
const { cutPaperBlocks } = await bundle(join(root, "packages/app/src/pages/paper-reader/paper-blocks.ts"), "pb.mjs");
const { segmentSentences } = await bundle(join(root, "packages/app/src/pages/paper-reader/paper-sentences.ts"), "ps.mjs");

// 两种成本函数的 DP（复制 alignDP 逻辑，参数化成本）
function alignDP(sim, maxGroup, scaled) {
  const n = sim.length, m = sim[0]?.length ?? 0;
  if (!n || !m) return [];
  const cells = Array.from({ length: n + 1 }, () => Array.from({ length: m + 1 }, () => ({ cost: Infinity, move: null })));
  cells[0][0] = { cost: 0, move: null };
  const groupScore = (i, j, s, t) => {
    let sum = 0;
    for (let a = i; a < i + s; a++) for (let b = j; b < j + t; b++) sum += sim[a][b];
    return sum / (s * t);
  };
  const relax = (i, j, s, t) => {
    const w = scaled ? (s + t) / 2 : 1;
    const cost = cells[i][j].cost + (1 - groupScore(i, j, s, t)) * w;
    const target = cells[i + s][j + t];
    if (cost < target.cost) { target.cost = cost; target.move = { s, t }; }
  };
  for (let i = 0; i <= n; i++) for (let j = 0; j <= m; j++) {
    if (!Number.isFinite(cells[i][j].cost)) continue;
    for (let s = 1; s <= Math.min(maxGroup, n - i); s++)
      for (let t = 1; t <= Math.min(maxGroup, m - j); t++) {
        if (s > 1 && t > 1) continue;
        relax(i, j, s, t);
      }
  }
  const pairs = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    const mv = cells[i][j].move;
    if (!mv) break;
    pairs.unshift({ si: i - mv.s, sc: mv.s, ti: j - mv.t, tc: mv.t, score: groupScore(i - mv.s, j - mv.t, mv.s, mv.t) });
    i -= mv.s; j -= mv.t;
  }
  return pairs;
}

const md = readFileSync("C:/Users/20995/AppData/Roaming/com.xincmm.sageread.dev/books/a27b187c6bd02d3c/paper.md", "utf-8");
const blocks = cutPaperBlocks(md);
const tr = JSON.parse(readFileSync("C:/Users/20995/AppData/Roaming/com.xincmm.sageread.dev/books/a27b187c6bd02d3c/translation-zh.json", "utf-8"));
const cfg = JSON.parse(readFileSync("C:/Users/20995/AppData/Roaming/com.xincmm.sageread.dev/llama-store.json", "utf-8"));
const vm = cfg.state.vectorModels.find((x) => x.id === cfg.state.selectedVectorModelId) ?? cfg.state.vectorModels[0];

async function embed(texts) {
  const res = await fetch(vm.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${vm.apiKey}` },
    body: JSON.stringify({ model: vm.modelId, input: texts }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 150)}`);
  const json = await res.json();
  return [...json.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding);
}
const norm = (v) => Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;

for (const idx of [39, 219]) {
  const src = blocks[idx].sourceText, tgt = tr.blocks[String(idx)].text;
  const srcSents = segmentSentences(src).map((s) => src.slice(s.start, s.end));
  const tgtSents = segmentSentences(tgt).map((s) => tgt.slice(s.start, s.end));
  const vecs = await embed([...srcSents, ...tgtSents]);
  const n = srcSents.length, m = tgtSents.length;
  const sim = Array.from({ length: n }, (_, i) =>
    Array.from({ length: m }, (_, j) => {
      const a = vecs[i], b = vecs[n + j];
      return a.reduce((s, x, k) => s + x * b[k], 0) / (norm(a) * norm(b));
    }));
  const fmt = (pairs) => pairs.map((p) => `${p.si}${p.sc > 1 ? "+" + (p.sc - 1) : ""}↔${p.ti}${p.tc > 1 ? "+" + (p.tc - 1) : ""}(${p.score.toFixed(2)})`).join(" ");
  console.log(`\n块 ${idx}: EN ${n} 句 / ZH ${m} 句`);
  console.log("  旧成本:", fmt(alignDP(sim, 2, false)));
  console.log("  缩放后:", fmt(alignDP(sim, 2, true)));
}
