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
const outDir = mkdtempSync(join(tmpdir(), "seg200-"));
const bundle = async (entry, name) => {
  const outfile = join(outDir, name);
  await esbuild.build({ entryPoints: [entry], bundle: true, format: "esm", jsx: "automatic", outfile });
  return import(pathToFileURL(outfile).href);
};
const { cutPaperBlocks } = await bundle(join(root, "packages/app/src/pages/paper-reader/paper-blocks.ts"), "pb.mjs");
const { segmentSentences } = await bundle(join(root, "packages/app/src/pages/paper-reader/paper-sentences.ts"), "ps.mjs");
const md = readFileSync("C:/Users/20995/AppData/Roaming/com.xincmm.sageread.dev/books/a27b187c6bd02d3c/paper.md", "utf-8");
const src = cutPaperBlocks(md)[200].sourceText;
console.log("源文全文:", JSON.stringify(src));
console.log("\n切句结果:");
segmentSentences(src).forEach((s, i) => console.log(`  [${i}] (${s.start}..${s.end})`, JSON.stringify(src.slice(s.start, s.end))));
