// display 公式归一化（paper-display-math.ts）单测：esbuild 打包 → node 断言
// 覆盖：单行 $$ 段转多行 / 尾编号提 \tag / 下一行行首编号并入 / 幂等 / 非目标不动 / CRLF
// 运行：node scripts/test-paper-display-math.mjs
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

const outDir = mkdtempSync(join(tmpdir(), "paper-display-math-"));
const outfile = join(outDir, "paper-display-math.mjs");
await esbuild.build({
  entryPoints: [join(root, "packages/app/src/pages/paper-reader/paper-display-math.ts")],
  bundle: true,
  format: "esm",
  outfile,
});
const { normalizeDisplayMath } = await import(pathToFileURL(outfile).href);

let pass = 0;
let fail = 0;
function eq(name, actual, expected) {
  if (actual === expected) {
    pass++;
  } else {
    fail++;
    console.log(`✗ ${name}\n  期望: ${JSON.stringify(expected)}\n  实际: ${JSON.stringify(actual)}`);
  }
}
function ok(name, cond, detail = "") {
  if (cond) pass++;
  else {
    fail++;
    console.log(`✗ ${name} ${detail}`);
  }
}

// 1) 单行 $$ 独立段 → 多行围栏（编号不变体）
eq("单行独立段转多行", normalizeDisplayMath("before\n\n$$ FeO_{6} $$\n\nafter"), "before\n\n$$\nFeO_{6}\n$$\n\nafter");

// 2) 单行 $$ 后贴文本（无空行）→ 多行围栏 + 文本仍在下一行（remark 会自动分段）
eq(
  "单行后贴文本",
  normalizeDisplayMath("as follows\n\n$$\\mathrm{NaFeO}_{2}$$\n(1) where the open square"),
  "as follows\n\n$$\n\\mathrm{NaFeO}_{2} \\tag{1}\n$$\n\nwhere the open square",
);

// 3) 尾编号在公式内（多行围栏变体，文献常见形态）→ \tag
eq(
  "多行围栏尾编号提 tag",
  normalizeDisplayMath("text\n\n$$\n\\Phi_{cation} = \\frac{a}{b} (1)\n$$\n\nnext"),
  "text\n\n$$\n\\Phi_{cation} = \\frac{a}{b} \\tag{1}\n$$\n\nnext",
);

// 4) 单行 + 尾编号 → 先转多行再提 tag
eq("单行尾编号一步到位", normalizeDisplayMath("$$x = y (12)$$"), "$$\nx = y \\tag{12}\n$$");

// 5) 编号带字母
eq("编号带字母", normalizeDisplayMath("$$E = mc^2 (3b)$$"), "$$\nE = mc^2 \\tag{3b}\n$$");

// 6) f(2) 调用尾（编号前无空格）不动
eq("f(2) 不提 tag", normalizeDisplayMath("$$f(2)$$"), "$$\nf(2)\n$$");

// 7) 下一行编号行无余文 → 直接吞掉该行
eq("下一行纯编号", normalizeDisplayMath("$$\nx=1\n$$\n(3)"), "$$\nx=1 \\tag{3}\n$$");

// 8) 幂等：标准多行无编号原样
const std = "before\n\n$$\n\\frac{a}{b}\n$$\n\nafter";
eq("幂等", normalizeDisplayMath(std), std);

// 9) 已含 \tag 不再重复提
eq("已有 tag 不重复", normalizeDisplayMath("$$\nx=1 \\tag{5}\n$$\n(3) rest"), "$$\nx=1 \\tag{5}\n$$\n(3) rest");

// 10) 行内 $…$ 不动
eq("行内公式不动", normalizeDisplayMath("the $x^2$ here"), "the $x^2$ here");

// 11) 邻接伪命中 "$_{2}$$^{113}$" 不转
const adj = "Na$_{0.5}$VO$_{2}$$^{113}$ ref";
eq("邻接行内不误转", normalizeDisplayMath(adj), adj);

// 12) 一行两个 $$ 段（含 $ 内容边界）不转
const two = "$$x$$ and $$y$$";
eq("同行双段不误转", normalizeDisplayMath(two), two);

// 13) CRLF 兼容（比较前统一 \r\n → \n，只断言结构）
const crlfNorm = (s) => s.replace(/\r\n/g, "\n");
eq(
  "CRLF 单行段",
  crlfNorm(normalizeDisplayMath("before\r\n\r\n$$x = y (1)$$\r\n\r\nafter")),
  crlfNorm("before\r\n\r\n$$\nx = y \\tag{1}\n$$\r\n\r\nafter"),
);

// 14) 空围栏 $$$$ 不动
eq("空围栏不动", normalizeDisplayMath("a\n\n$$$$\n\nb"), "a\n\n$$$$\n\nb");

// 15) 前后贴文本同段（C 变体）：公式行转多行后文本自动成段
eq(
  "前后贴文本",
  normalizeDisplayMath("text before\n$$\\frac{a}{b}$$\ntext after"),
  "text before\n$$\n\\frac{a}{b}\n$$\ntext after",
);

// 16) 全角括号编号：下一行行首（madler 旧产物 （10）（11）（12））
eq(
  "全角编号下一行",
  normalizeDisplayMath("$$v_{rel}=u_f-v_d$$\n（10） and the gas velocity"),
  "$$\nv_{rel}=u_f-v_d \\tag{10}\n$$\n\nand the gas velocity",
);

// 17) 全角括号编号：公式尾部
eq("全角编号尾部", normalizeDisplayMath("$$x=1 （7）$$"), "$$\nx=1 \\tag{7}\n$$");

// 18) \mum 宏兼容：行内数学段内转换
eq(
  "行内 \\mum 转换",
  normalizeDisplayMath("range of $1.5–20 \\, \\mum$ with"),
  "range of $1.5–20 \\, \\mu\\mathrm{m}$ with",
);

// 19) \mum 在 display 段内也转换
eq("display 内 \\mum 转换", normalizeDisplayMath("$$d = 5 \\mum$$"), "$$\nd = 5 \\mu\\mathrm{m}\n$$");

// 20) 数学段外的 \mum 不动
eq("段外 \\mum 不动", normalizeDisplayMath("宏 \\mum 不在数学段"), "宏 \\mum 不在数学段");

// 21) 字母后缀不误伤（\mumol 不转）
eq("\\mumol 不误伤", normalizeDisplayMath("$5 \\mumol$ here"), "$5 \\mumol$ here");

rmSync(outDir, { recursive: true, force: true });
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
