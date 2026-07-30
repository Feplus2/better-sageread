// 悬浮覆盖层 rect 合并单测：esbuild 打包 paper-hover-rects.ts → node 断言
// 运行：node scripts/test-paper-hover-rects.mjs
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
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

const outDir = mkdtempSync(join(tmpdir(), "paper-hover-rects-"));
const outfile = join(outDir, "paper-hover-rects.mjs");
await esbuild.build({
  entryPoints: [join(root, "packages/app/src/pages/paper-reader/paper-hover-rects.ts")],
  bundle: true,
  format: "esm",
  outfile,
});
const { mergeOverlappingRects } = await import(pathToFileURL(outfile).href);

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL - ${name}: ${error.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
const r = (x, y, width, height) => ({ x, y, width, height });
function eq(actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(a === e, `expected ${e}, got ${a}`);
}

check("空数组 / 单 rect 原样返回", () => {
  eq(mergeOverlappingRects([]), []);
  eq(mergeOverlappingRects([r(10, 10, 100, 20)]), [r(10, 10, 100, 20)]);
});

check("完全相同的 rect（KaTeX MathML 副本同位叠加）合并为 1 个", () => {
  eq(mergeOverlappingRects([r(10, 10, 100, 20), r(10, 10, 100, 20)]), [r(10, 10, 100, 20)]);
});

check("部分重叠（::marker 叠在行首上）合并为外包矩形", () => {
  eq(mergeOverlappingRects([r(20, 10, 30, 19), r(0, 10, 200, 19)]), [r(0, 10, 200, 19)]);
});

check("KaTeX 可见 span + MathML 副本 + 前后文本 → 整行一个 rect", () => {
  const out = mergeOverlappingRects([
    r(50, 100, 80, 18), // 可见公式
    r(50, 100, 80, 18), // MathML 副本（同位）
    r(0, 100, 50, 18), // 前文文本
    r(130, 100, 70, 18), // 后文文本
  ]);
  eq(out, [r(0, 100, 200, 18)]);
});

check("同行相邻片段（文本/sup/文本 x 贴边）合并为连续整行", () => {
  // sup 抬升盒 y 与行相交、x 与前后片段贴边 → 并入行带，外包矩形覆盖抬升高度
  eq(mergeOverlappingRects([r(0, 10, 100, 19), r(100, 4, 20, 13), r(120, 10, 180, 19)]), [r(0, 4, 300, 25)]);
});

check("跨行 rect 不合并：两行保持 2 个，且不出现覆盖两行的超大矩形", () => {
  const line1 = r(0, 10, 300, 19);
  const line2 = r(0, 38, 120, 19);
  const out = mergeOverlappingRects([line1, line2]);
  eq(out, [line1, line2]);
  assert(
    out.every((o) => o.height <= 19),
    "出现了跨行超大矩形",
  );
});

check("跨行句子含 sup：sup 并入所在行，不与上一行拼合", () => {
  const out = mergeOverlappingRects([
    r(0, 10, 300, 19), // 第一行
    r(0, 38, 60, 19), // 第二行文本前段
    r(60, 33, 15, 12), // sup 抬升盒（与第二行 y 相交，与第一行不相交）
    r(75, 38, 45, 19), // 第二行文本后段
  ]);
  eq(out, [r(0, 10, 300, 19), r(0, 33, 120, 24)]);
});

check("相邻两行仅亚像素贴边（gap 0.5px）不合并", () => {
  const out = mergeOverlappingRects([r(0, 10, 300, 19), r(0, 29.5, 100, 19)]);
  assert(out.length === 2, `expected 2 rects, got ${out.length}`);
});

check("同一行带内 x 相离（gap > 1px）不合并", () => {
  const out = mergeOverlappingRects([r(0, 10, 100, 19), r(105, 10, 50, 19)]);
  assert(out.length === 2, `expected 2 rects, got ${out.length}`);
});

check("乱序输入也按行带正确合并（贴边片段乱序给入）", () => {
  const out = mergeOverlappingRects([r(100, 10, 200, 19), r(0, 38, 120, 19), r(0, 10, 100, 19)]);
  eq(out, [r(0, 10, 300, 19), r(0, 38, 120, 19)]);
});

check("不修改入参数组", () => {
  const input = [r(10, 10, 100, 20), r(10, 10, 100, 20)];
  const snapshot = JSON.stringify(input);
  mergeOverlappingRects(input);
  assert(JSON.stringify(input) === snapshot, "入参被修改");
});

rmSync(outDir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length > 0 ? 1 : 0);
