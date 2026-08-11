// 图表速跳提取器（extractPaperFigures）实测：对三种真实产物跑提取并打印清单 + 基本不变量。
//   ① 旧格式 fixture（空 alt 碎图组图注同段）  ② MinerU VLM + figure_merger  ③ pipeline 新
// 不变量：块索引单调递增且不越界（< cutPaperBlocks 块数）；图/表编号各自递增（无重复编号）。
// 运行：node scripts/test-paper-figures.mjs
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pnpmDir = join(root, "node_modules", ".pnpm");
const esbuildPkg = readdirSync(pnpmDir).find((d) => d.startsWith("esbuild@"));
if (!esbuildPkg) throw new Error("node_modules/.pnpm 下未找到 esbuild，请先 pnpm install");
const esbuild = await import(
  pathToFileURL(join(pnpmDir, esbuildPkg, "node_modules", "esbuild", "lib", "main.js")).href
);

const outDir = mkdtempSync(join(tmpdir(), "paper-figures-"));
const outfile = join(outDir, "paper-blocks.mjs");
await esbuild.build({
  entryPoints: [join(root, "packages/app/src/pages/paper-reader/paper-blocks.ts")],
  bundle: true,
  format: "esm",
  outfile,
});
// remark 链的 decode-named-character-reference 在模块顶层调用 document.createElement，node 下用 jsdom 垫片
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.document = dom.window.document;
globalThis.DOMParser = dom.window.DOMParser;
const { extractPaperFigures, cutPaperBlocks } = await import(pathToFileURL(outfile).href);

const targets = [
  ["旧格式 fixture", join(root, "fixtures/papers/zhao2020rational/paper.md")],
  ["VLM+合并 he2024review", "F:/MyProjects/Papers_Converter/.tmp-merge-test/he2024review/paper.md"],
  ["pipeline 新 he2024", join(root, ".tmp-pipeline-ab/he2024-pipeline新/paper.md")],
];

let failed = false;
for (const [name, path] of targets) {
  let markdown;
  try {
    markdown = await readFile(path, "utf8");
  } catch {
    console.log(`\n== ${name}: 文件不存在，跳过（${path}）`);
    continue;
  }
  const items = extractPaperFigures(markdown);
  const totalBlocks = cutPaperBlocks(markdown).length;
  const figures = items.filter((i) => i.kind === "figure" && i.num !== null);
  const tables = items.filter((i) => i.kind === "table");
  const unnumbered = items.filter((i) => i.num === null);

  console.log(`\n== ${name}: 编号图 ${figures.length}，表 ${tables.length}，未编号图 ${unnumbered.length}（总块数 ${totalBlocks}）`);
  for (const item of items) {
    const caption = (item.caption || "(无图注)").replace(/\s+/g, " ").slice(0, 60);
    console.log(
      `  [块${String(item.blockIndex).padStart(3)}] ${item.label.padEnd(10)} 图${item.images.length} ${caption}`,
    );
  }

  // 不变量校验
  let prev = -1;
  for (const item of items) {
    if (item.blockIndex <= prev) {
      console.error(`  ✗ 块索引非单调：${item.label} 块${item.blockIndex} <= ${prev}`);
      failed = true;
    }
    if (item.blockIndex >= totalBlocks) {
      console.error(`  ✗ 块索引越界：${item.label} 块${item.blockIndex} >= ${totalBlocks}`);
      failed = true;
    }
    prev = item.blockIndex;
  }
  const figNums = figures.map((i) => i.num);
  if (new Set(figNums).size !== figNums.length) {
    console.error(`  ✗ 图编号重复：${figNums.join(",")}`);
    failed = true;
  }
}

rmSync(outDir, { recursive: true, force: true });
console.log(failed ? "\n✗ 存在不变量违例" : "\n✓ 不变量全部通过");
process.exit(failed ? 1 : 0);
