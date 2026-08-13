// math-delimiters 单测：esbuild 打包 → node 断言（纯函数无外部依赖）
// 覆盖：\(...\) 转换 / \[...\] 转 display / $$ 多行围栏归位 / \\[6pt] 不误伤 / 代码围栏与行内代码免疫
// 运行：node scripts/test-chat-math-delimiters.mjs
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pnpmDir = join(root, "node_modules", ".pnpm");
const esbuildPkg = readdirSync(pnpmDir).find((d) => d.startsWith("esbuild@"));
if (!esbuildPkg) throw new Error("node_modules/.pnpm 下未找到 esbuild，请先 pnpm install");
const esbuild = await import(pathToFileURL(join(pnpmDir, esbuildPkg, "node_modules", "esbuild", "lib", "main.js")).href);

const outDir = mkdtempSync(join(tmpdir(), "chat-math-"));
const outfile = join(outDir, "math-delimiters.mjs");
await esbuild.build({
  entryPoints: [join(root, "packages/app/src/components/prompt-kit/math-delimiters.ts")],
  bundle: true,
  format: "esm",
  outfile,
});
const { normalizeMathDelimiters } = await import(pathToFileURL(outfile).href);

let pass = 0;
let fail = 0;
function eq(name, actual, expected) {
  if (actual === expected) pass++;
  else {
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

const BS = String.fromCharCode(92);

// 1) \(...\) → $…$
eq(
  "行内 \\(\\) 转换",
  normalizeMathDelimiters(`其中 ${BS}(\\left|f(x) - A\\right| < \\epsilon${BS}) 表示`),
  "其中 $\\left|f(x) - A\\right| < \\epsilon$ 表示",
);

// 2) \[...\] → 围栏独占行的 $$
eq(
  "\\[\\] 转行间",
  normalizeMathDelimiters(`如下：\n${BS}[\\frac{a}{b}${BS}]\n完`),
  "如下：\n\n$$\n\\frac{a}{b}\n$$\n完",
);

// 3) 多行 $$ 围栏与内容同行 → 围栏独占行（cases 方程组，含 \\[6pt] 换行间距）
const cases = `多行方程组\n\n$$${BS}begin{cases}\nA = 1 ${BS}${BS}[6pt]\nB = 2\n${BS}end{cases}$$\n\n以上`;
const casesOut = normalizeMathDelimiters(cases);
ok("cases 开围栏独占行", casesOut.includes(`$$\n${BS}begin{cases}`), casesOut);
ok("cases 闭合围栏独占行", casesOut.includes(`${BS}end{cases}\n$$`), casesOut);
ok("\\\\[6pt] 间距语法不误伤", casesOut.includes(`${BS}${BS}[6pt]`));
ok("cases 前文空行保留", casesOut.startsWith("多行方程组\n\n$$\n"));

// 4) 单行 $$…$$ 原样保留（下游 marked 段落级修补升级）
eq("单行 $$ 不动", normalizeMathDelimiters("公式 $$E = mc^2$$ 很好"), "公式 $$E = mc^2$$ 很好");

// 5) 代码围栏内的定界符不动
const code = "```\n" + `${BS}(not math${BS}) 和 $$x$$` + "\n```\n正文 " + `${BS}(real${BS})`;
eq("代码围栏免疫", normalizeMathDelimiters(code), code.replace(`${BS}(real${BS})`, "$real$"));

// 6) 行内代码免疫
const inline = "看这个 `" + `${BS}(x${BS})` + "` 以及 " + `${BS}(y${BS})`;
eq("行内代码免疫", normalizeMathDelimiters(inline), "看这个 `" + `${BS}(x${BS})` + "` 以及 $y$");

// 7) 无配对收尾的 \( 原样保留
eq("裸 \\( 保留", normalizeMathDelimiters(`断了 ${BS}(x_{n} < \\epsilon 没了`), `断了 ${BS}(x_{n} < \\epsilon 没了`);

// 8) $$ 后同行有内容（闭合后接文字）→ 闭合后补换行
const afterText = `$$x^2\n+y^2$$ 是关键`;
eq("闭合后同行内容补换行", normalizeMathDelimiters(afterText), `$$\nx^2\n+y^2\n$$\n 是关键`);

// 9) 幂等：归一化输出再过一遍不变
{
  const once = normalizeMathDelimiters(cases);
  eq("幂等", normalizeMathDelimiters(once), once);
}

// 10) 行内公式含 $ 的混合段落
eq(
  "混合段落",
  normalizeMathDelimiters(`勾股 $a^2+b^2=c^2$ 与 ${BS}(\\epsilon${BS}) 都对`),
  `勾股 $a^2+b^2=c^2$ 与 $\\epsilon$ 都对`,
);

rmSync(outDir, { recursive: true, force: true });
console.log(`\n${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
