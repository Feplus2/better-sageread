// 词级修复实验：块39末句 真实词向量矩阵 × 多种 DP 策略对比
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
const outDir = mkdtempSync(join(tmpdir(), "wsim-"));
const bundle = async (e, n) => {
  const f = join(outDir, n);
  await esbuild.build({ entryPoints: [e], bundle: true, format: "esm", jsx: "automatic", outfile: f });
  return import(pathToFileURL(f).href);
};
const { cutPaperBlocks } = await bundle(join(root, "packages/app/src/pages/paper-reader/paper-blocks.ts"), "pb.mjs");
const { tokenizeWords } = await bundle(join(root, "packages/app/src/pages/paper-reader/paper-cross-anchor.ts"), "pca.mjs");

const md = readFileSync("C:/Users/20995/AppData/Roaming/com.xincmm.sageread.dev/books/a27b187c6bd02d3c/paper.md", "utf-8");
const tr = JSON.parse(readFileSync("C:/Users/20995/AppData/Roaming/com.xincmm.sageread.dev/books/a27b187c6bd02d3c/translation-zh.json", "utf-8"));
const src39 = cutPaperBlocks(md)[39].sourceText;
const entry = tr.blocks["39"];
const last = entry.align[entry.align.length - 1];
const enSent = src39.slice(last.ss, last.se);
const zhSent = entry.text.slice(last.ts, last.te);
const enToks = tokenizeWords(enSent).map((t) => enSent.slice(t.start, t.end));
const zhToks = tokenizeWords(zhSent).map((t) => zhSent.slice(t.start, t.end));
console.log("EN", enToks.length, "tokens | ZH", zhToks.length, "tokens");

const cfg = JSON.parse(readFileSync("C:/Users/20995/AppData/Roaming/com.xincmm.sageread.dev/llama-store.json", "utf-8"));
const vm = cfg.state.vectorModels.find((x) => x.id === cfg.state.selectedVectorModelId) ?? cfg.state.vectorModels[0];
const embed = async (texts) => {
  const out = [];
  for (let i = 0; i < texts.length; i += 64) {
    const res = await fetch(vm.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${vm.apiKey}` },
      body: JSON.stringify({ model: vm.modelId, input: texts.slice(i, i + 64) }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    out.push(...[...json.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding));
  }
  return out;
};
const vecs = await embed([...enToks, ...zhToks]);
const norm = (v) => Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
const n = enToks.length, m = zhToks.length;
const sim = Array.from({ length: n }, (_, i) =>
  Array.from({ length: m }, (_, j) => {
    const a = vecs[i], b = vecs[n + j];
    return a.reduce((s, x, k) => s + x * b[k], 0) / (norm(a) * norm(b));
  }));

// 关键词的相似度信号检查
for (const w of ["stable", "structures", "noting", "worth"]) {
  const i = enToks.indexOf(w);
  if (i < 0) continue;
  const row = sim[i].map((v, j) => [v, j]).sort((a, b) => b[0] - a[0]).slice(0, 5);
  console.log(`sim 最高 5 个 for "${w}":`, row.map(([v, j]) => `${zhToks[j]}(${v.toFixed(2)})`).join(" "));
}

// DP 变体：mode = old(基线1) | scaled(组大小) | prior(缩放+对角先验)
function alignDP(sim, maxGroup, mode) {
  const n = sim.length, m = sim[0]?.length ?? 0;
  if (!n || !m) return [];
  const cells = Array.from({ length: n + 1 }, () => Array.from({ length: m + 1 }, () => ({ cost: Infinity, move: null })));
  cells[0][0] = { cost: 0, move: null };
  const groupScore = (i, j, s, t) => {
    let sum = 0;
    for (let a = i; a < i + s; a++) for (let b = j; b < j + t; b++) sum += sim[a][b];
    return sum / (s * t);
  };
  // 组的对角先验：组中心相对位置与长度比的偏差
  const posPenalty = (i, j, s, t) => {
    const cS = (i + (s - 1) / 2) / n, cT = (j + (t - 1) / 2) / m;
    return Math.abs(cS - cT);
  };
  const relax = (i, j, s, t) => {
    let cost;
    if (mode === "old") cost = cells[i][j].cost + (1 - groupScore(i, j, s, t));
    else if (mode === "scaled") cost = cells[i][j].cost + (1 - groupScore(i, j, s, t)) * ((s + t) / 2);
    else cost = cells[i][j].cost + (1 - groupScore(i, j, s, t)) * ((s + t) / 2) + 1.2 * posPenalty(i, j, s, t);
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
    pairs.unshift({ si: i - mv.s, sc: mv.s, ti: j - mv.t, tc: mv.t });
    i -= mv.s; j -= mv.t;
  }
  return pairs;
}

const show = (mode) => {
  const pairs = alignDP(sim, 4, mode);
  const fmt = (p) => `${enToks.slice(p.si, p.si + p.sc).join(" ")}↔${zhToks.slice(p.ti, p.ti + p.tc).join("")}`;
  // 只打印句尾 1/3（stable structures 所在区域）+ 句首 3 对
  const tail = pairs.filter((p) => p.si >= Math.floor(n * 0.55));
  console.log(`\n[${mode}] 共 ${pairs.length} 对；尾部:`);
  for (const p of tail) console.log("  ", fmt(p));
};
show("old");
show("scaled");
show("prior");
