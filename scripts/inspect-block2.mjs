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

const outDir = mkdtempSync(join(tmpdir(), "inspect2-"));
const outfile = join(outDir, "pb.mjs");
await esbuild.build({ entryPoints: [join(root, "packages/app/src/pages/paper-reader/paper-blocks.ts")], bundle: true, format: "esm", jsx: "automatic", outfile });
const { cutPaperBlocks } = await import(pathToFileURL(outfile).href);

const md = readFileSync("C:/Users/20995/AppData/Roaming/com.xincmm.sageread.dev/books/a27b187c6bd02d3c/paper.md", "utf-8");
const blocks = cutPaperBlocks(md);
console.log("切块数:", blocks.length);
console.log("块200 keys:", Object.keys(blocks[200] ?? {}), "| text 前 60:", JSON.stringify(blocks[200]?.text?.slice(0,60)));
const tr = JSON.parse(readFileSync("C:/Users/20995/AppData/Roaming/com.xincmm.sageread.dev/books/a27b187c6bd02d3c/translation-zh.json", "utf-8"));
const keys = Object.keys(tr.blocks).map(Number);
console.log("译文块 keys:", Math.min(...keys), "..", Math.max(...keys), "共", keys.length);
const missingInTr = blocks.map((b,i)=>i).filter(i=>!tr.blocks[i]);
console.log("切块有但译文没有的块:", missingInTr.slice(0,10));
const extraInTr = keys.filter(k=>k>=blocks.length);
console.log("译文有但切块没有的块:", extraInTr.slice(0,10));
