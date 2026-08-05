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

const outDir = mkdtempSync(join(tmpdir(), "inspect-align-"));
const bundle = async (entry, name) => {
  const outfile = join(outDir, name);
  await esbuild.build({ entryPoints: [entry], bundle: true, format: "esm", jsx: "automatic", outfile });
  return import(pathToFileURL(outfile).href);
};
const { cutPaperBlocks } = await bundle(join(root, "packages/app/src/pages/paper-reader/paper-blocks.ts"), "pb.mjs");
const { segmentSentences } = await bundle(join(root, "packages/app/src/pages/paper-reader/paper-sentences.ts"), "ps.mjs");

const md = readFileSync("C:/Users/20995/AppData/Roaming/com.xincmm.sageread.dev/books/a27b187c6bd02d3c/paper.md", "utf-8");
const blocks = cutPaperBlocks(md);
const tr = JSON.parse(readFileSync("C:/Users/20995/AppData/Roaming/com.xincmm.sageread.dev/books/a27b187c6bd02d3c/translation-zh.json", "utf-8"));

for (const idx of [200, 219]) {
  const src = blocks[idx]?.sourceText ?? "";
  const tgt = tr.blocks[idx]?.text ?? "";
  console.log(`\n===== 块 ${idx} (kind=${blocks[idx]?.kind}) =====`);
  console.log("源文(", src.length, "字符):", JSON.stringify(src.slice(0, 200)));
  console.log("译文(", tgt.length, "字符):", JSON.stringify(tgt.slice(0, 120)));
  const ss = segmentSentences(src), ts = segmentSentences(tgt);
  console.log("源文切句数:", ss.length, "| 译文切句数:", ts.length);
  const al = tr.blocks[idx]?.align ?? [];
  console.log("align 对数:", al.length, "| alignW 对数:", (tr.blocks[idx]?.alignW ?? []).length);
  for (const p of al.filter(x=>x.low)) {
    console.log("  low 对:", JSON.stringify(p));
    console.log("  源句:", JSON.stringify(src.slice(p.ss, p.se)));
    console.log("  译句:", JSON.stringify(tgt.slice(p.ts, p.te)));
  }
}
