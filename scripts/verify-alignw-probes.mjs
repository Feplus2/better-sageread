// 落库 alignW 探针验证（jieba 版重建后）：EN 探针 → alignW 命中的 ZH 区间 vs 期望
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
const outDir = mkdtempSync(join(tmpdir(), "probe-"));
const outfile = join(outDir, "pb.mjs");
await esbuild.build({ entryPoints: [join(root, "packages/app/src/pages/paper-reader/paper-blocks.ts")], bundle: true, format: "esm", jsx: "automatic", outfile });
const { cutPaperBlocks } = await import(pathToFileURL(outfile).href);

const PAPER_DIR = "C:/Users/20995/AppData/Roaming/com.xincmm.sageread.dev/books/a27b187c6bd02d3c";
const blocks = cutPaperBlocks(readFileSync(`${PAPER_DIR}/paper.md`, "utf-8"));
const tr = JSON.parse(readFileSync(`${PAPER_DIR}/translation-zh.json`, "utf-8"));

const PROBES = [
  { block: 39, pairAnchor: "It is worth noting", anchor: "stable structures", expect: "稳定结构" },
  { block: 39, pairAnchor: "It is worth noting", anchor: "), or may", offset: 3, len: 2, expect: "或者" },
  { block: 39, pairAnchor: "It is worth noting", anchor: "rocksalt", expect: "岩盐" },
  { block: 39, pairAnchor: "It is worth noting", anchor: "spinel", expect: "尖晶石" },
  { block: 39, pairAnchor: "It is worth noting", anchor: "ongoing investigations", expect: "进一步研究" },
  { block: 39, pairAnchor: "As a consequence", anchor: "As a consequence", expect: "因此" },
  { block: 39, pairAnchor: "As a consequence", anchor: "mainly", expect: "主要" },
  { block: 39, pairAnchor: "As a consequence", anchor: "crystallizes", expect: "结晶" },
  { block: 21, pairAnchor: "Ionic potential and its use", anchor: "Ionic potential", expect: "离子势" },
  { block: 219, pairAnchor: "Acknowledgments", anchor: "Acknowledgments", expect: "致谢" },
  { block: 219, pairAnchor: "Acknowledgments", anchor: "National Natural Science Foundation", expect: "国家自然科学基金" },
];

let total = 0, score = 0;
for (const probe of PROBES) {
  total += 1;
  const src = blocks[probe.block].sourceText;
  const entry = tr.blocks[String(probe.block)];
  const pair = (entry.align ?? []).find((p) => src.slice(p.ss, p.se).includes(probe.pairAnchor));
  if (!pair) {
    console.log(`"${probe.anchor}" → 句对未找到`);
    continue;
  }
  const pairSrc = src.slice(pair.ss, pair.se);
  const rel = pairSrc.indexOf(probe.anchor) + (probe.offset ?? 0);
  if (rel < (probe.offset ?? 0)) {
    console.log(`"${probe.anchor}" → 探针不在句对内`);
    continue;
  }
  const s = pair.ss + rel;
  const e = s + (probe.len ?? probe.anchor.length);
  let ts = -1, te = -1;
  for (const p of entry.alignW ?? []) {
    if (p.se <= s || p.ss >= e) continue;
    if (ts === -1) ts = p.ts;
    te = Math.max(te, p.te);
  }
  const mapped = ts === -1 ? "(null)" : entry.text.slice(ts, te);
  const sc = mapped === probe.expect ? 1 : mapped.includes(probe.expect) || probe.expect.includes(mapped) ? 0.5 : 0;
  score += sc;
  console.log(`"${probe.anchor}" → 「${mapped}」 期望「${probe.expect}」 [${sc}]`);
}
console.log(`\n总分: ${score}/${total}`);
