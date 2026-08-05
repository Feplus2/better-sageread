// 句对齐质量抽查：对若干块逐对打印 源句 ↔ 译句
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
const outDir = mkdtempSync(join(tmpdir(), "aq-"));
const outfile = join(outDir, "pb.mjs");
await esbuild.build({ entryPoints: [join(root, "packages/app/src/pages/paper-reader/paper-blocks.ts")], bundle: true, format: "esm", jsx: "automatic", outfile });
const { cutPaperBlocks } = await import(pathToFileURL(outfile).href);

const md = readFileSync("C:/Users/20995/AppData/Roaming/com.xincmm.sageread.dev/books/a27b187c6bd02d3c/paper.md", "utf-8");
const blocks = cutPaperBlocks(md);
const tr = JSON.parse(readFileSync("C:/Users/20995/AppData/Roaming/com.xincmm.sageread.dev/books/a27b187c6bd02d3c/translation-zh.json", "utf-8"));

const sampleIdx = process.argv[2] ? [Number(process.argv[2])] : [21, 45, 100, 150];
for (const idx of sampleIdx) {
  const src = blocks[idx]?.sourceText ?? "";
  const entry = tr.blocks[idx];
  if (!entry?.align?.length) { console.log(`\n===== 块 ${idx}: 无对齐 =====`); continue; }
  console.log(`\n===== 块 ${idx} (${entry.align.length} 对) =====`);
  for (const p of entry.align) {
    const s = src.slice(p.ss, p.se).replace(/\s+/g, " ").trim();
    const t = entry.text.slice(p.ts, p.te).replace(/\s+/g, " ").trim();
    console.log(`  EN: ${s.slice(0, 110)}`);
    console.log(`  ZH: ${t.slice(0, 90)}${p.low ? "  [LOW]" : ""}`);
    console.log("  ---");
  }
}
