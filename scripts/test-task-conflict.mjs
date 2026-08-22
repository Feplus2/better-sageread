// 冲突矩阵单测：纯函数 conflictKinds（9 格矩阵 + 边界）
import assert from "node:assert";

let esbuildPkgPath;
{
  const { readdirSync } = await import("node:fs");
  const root = new URL("../node_modules/.pnpm/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  for (const dir of readdirSync(root)) {
    if (dir.startsWith("esbuild@")) esbuildPkgPath = new URL(`../node_modules/.pnpm/${dir}/node_modules/esbuild`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  }
}
const esbuild = (await import(`file://${esbuildPkgPath}/lib/main.js`)).default ?? (await import(`file://${esbuildPkgPath}`));

const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const tmp = mkdtempSync(join(tmpdir(), "task-conflict-"));

// 抽 conflictKinds 纯函数（避免整文件引入 zustand）
const src = readFileSync(new URL("../packages/app/src/store/paper-task-registry.ts", import.meta.url), "utf8");
const fnStart = src.indexOf("export function conflictKinds");
const fnEnd = src.indexOf("\n}", fnStart) + 2;
writeFileSync(join(tmp, "matrix.ts"), src.slice(fnStart, fnEnd).replace("export function", "function") + "\nexport { conflictKinds };\n");
const out = join(tmp, "matrix.mjs");
await esbuild.build({ entryPoints: [join(tmp, "matrix.ts")], bundle: true, format: "esm", outfile: out });
const { conflictKinds } = await import(`file://${out.replaceAll("\\", "/")}`);

let pass = 0;
let fail = 0;
const eq = (a, b, msg) => {
  try {
    assert.deepStrictEqual([...a].sort(), [...b].sort());
    pass++;
  } catch {
    fail++;
    console.error(`FAIL: ${msg}（得 ${JSON.stringify(a)} 期 ${JSON.stringify(b)}）`);
  }
};

// 9 格矩阵
eq(conflictKinds("parse", []), [], "parse × 空 → 无冲突");
eq(conflictKinds("parse", ["parse"]), ["parse"], "parse × parse → 冲突");
eq(conflictKinds("parse", ["vectorize"]), ["vectorize"], "parse × vectorize → 冲突");
eq(conflictKinds("parse", ["translate"]), ["translate"], "parse × translate → 冲突");
eq(conflictKinds("vectorize", ["parse"]), ["parse"], "vectorize × parse → 冲突");
eq(conflictKinds("vectorize", ["vectorize"]), ["vectorize"], "vectorize × vectorize → 幂等冲突");
eq(conflictKinds("vectorize", ["translate"]), [], "vectorize × translate → 并行");
eq(conflictKinds("translate", ["parse"]), ["parse"], "translate × parse → 冲突");
eq(conflictKinds("translate", ["vectorize"]), [], "translate × vectorize → 并行");
eq(conflictKinds("translate", ["translate"]), ["translate"], "translate × translate → 幂等冲突");
// 组合
eq(conflictKinds("parse", ["parse", "vectorize", "translate"]), ["parse", "vectorize", "translate"], "parse × 全忙");
eq(conflictKinds("vectorize", ["translate", "parse"]), ["parse"], "vectorize × 翻译+解析 → 只挡解析");
eq(conflictKinds("translate", ["vectorize", "parse"]), ["parse"], "translate × 向量化+解析 → 只挡解析");

console.log(`\n${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
