// rawmath transformer 单测：esbuild 打包 → node 断言
// 覆盖：真实 EPUB 章节（裸 \(...\) 全渲染、MathML 原样、XML 仍合法）、skip 元素、无配对收尾、快路径
// 运行：node scripts/test-rawmath-transformer.mjs
import { mkdtempSync, readdirSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pnpmDir = join(root, "node_modules", ".pnpm");
const esbuildPkg = readdirSync(pnpmDir).find((d) => d.startsWith("esbuild@"));
if (!esbuildPkg) throw new Error("node_modules/.pnpm 下未找到 esbuild，请先 pnpm install");
const esbuild = await import(pathToFileURL(join(pnpmDir, esbuildPkg, "node_modules", "esbuild", "lib", "main.js")).href);

// outfile 放 packages/app 下：katex 外部化后运行时 import("katex") 要解析 packages/app/node_modules
const outDir = join(root, "packages", "app", ".tmp-rawmath-test");
mkdirSync(outDir, { recursive: true });
const outfile = join(outDir, "rawmath.mjs");

const stubCss = {
  name: "stub-css",
  setup(build) {
    build.onResolve({ filter: /export-paper-katex-css$/ }, () => ({ path: "stub:css", namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: `export const buildInlineKatexCss = () => "/*stub-css*/";`,
    }));
  },
};

await esbuild.build({
  entryPoints: [join(root, "packages/app/src/services/transformers/rawmath.ts")],
  bundle: true,
  format: "esm",
  outfile,
  external: ["katex"],
  plugins: [stubCss],
});
const { rawmathTransformer } = await import(pathToFileURL(outfile).href);

let pass = 0;
let fail = 0;
function ok(name, cond, detail = "") {
  if (cond) pass++;
  else {
    fail++;
    console.log(`✗ ${name} ${detail}`);
  }
}
function eq(name, actual, expected) {
  if (actual === expected) pass++;
  else {
    fail++;
    console.log(`✗ ${name}\n  期望: ${JSON.stringify(expected)}\n  实际: ${JSON.stringify(actual)}`);
  }
}

const ctx = (content) => ({ bookId: "t", viewSettings: {}, content, transformers: [] });

// 1) 快路径：无定界符原样返回（同一字符串引用）
{
  const s = "<p>普通文本 no math</p>";
  const r = await rawmathTransformer.transform(ctx(s));
  ok("快路径原样返回", r === s);
}

// 2) 行内公式渲染 + &lt; 反转义
{
  const r = await rawmathTransformer.transform(ctx("<p>可以用 \\(|f(x) - A| &lt; \\epsilon\\) 来表达</p>"));
  ok("行内含 &lt; 渲染", r.includes('class="katex"') && !r.includes("\\("), r.slice(0, 200));
  ok("行内公式外包 span", r.includes('<span class="sageread-rawmath">'));
  ok("注入样式", r.includes('id="sageread-rawmath-katex"'));
}

// 3) 行间公式 → div + katex-display
{
  const r = await rawmathTransformer.transform(ctx("<p>\\[\\qquad = 1 + \\frac{1}{2^{n}} &lt; 3,\\]</p>"));
  ok("行间渲染 display", r.includes("katex-display") && r.includes('<div class="sageread-rawmath">'));
}

// 4) MathML（m:math）内部不动，外部公式照渲染
{
  const src =
    '<p><span class="formula-inline"><m:math display="inline"><m:mrow><m:mi>\\(f\\)</m:mi></m:mrow></m:math></span> 与 \\(x_{n}&lt;0\\)</p>';
  const r = await rawmathTransformer.transform(ctx(src));
  ok("MathML 内的 \\(...\\) 不被动", r.includes("<m:mi>\\(f\\)</m:mi>"), r.slice(0, 300));
  ok("MathML 外的公式正常渲染", r.includes("sageread-rawmath"));
}

// 5) script/style/code 内的定界符不处理
{
  const src = '<p>a</p><script>var s = "\\(not math\\)";</script><code>\\(also not\\)</code><p>\\(real\\)</p>';
  const r = await rawmathTransformer.transform(ctx(src));
  ok("script 内不动", r.includes('var s = "\\(not math\\)";'));
  ok("code 内不动", r.includes("<code>\\(also not\\)</code>"));
  ok("正文公式仍渲染", r.includes("sageread-rawmath"));
}

// 6) 无配对收尾：裸 \( 保留，后面的正常公式不受影响
{
  const r = await rawmathTransformer.transform(ctx("<p>断开的 \\(x_{n} - a&lt; \\epsilon 和 \\(y_{1}&lt;y_{2}\\)</p>"));
  ok("无收尾开界定符原样保留", r.includes("\\(x_{n} - a&lt; \\epsilon"), r.slice(0, 200));
  ok("后续公式正常渲染", r.includes("sageread-rawmath"));
}

// 7) 嵌套普通括号：\\(\\left(f(x)\\right)\\) 取到最后一个 \\)
{
  const r = await rawmathTransformer.transform(ctx("<p>\\(\\left(f(x)\\right)\\) 完</p>"));
  // 注：katex 的 <annotation> 会内嵌原始 TeX，判"源码已渲染"只能看开界定符是否消失
  ok("嵌套括号配对正确", r.includes("sageread-rawmath") && !r.includes("\\(\\left"), r.slice(0, 200));
}

// 8) 真实 EPUB 章节全量过一遍（裸公式清零、MathML 数量不变、XML 仍合法）
{
  const epub = process.env.RAWMATH_EPUB;
  if (epub) {
    const { execSync } = await import("node:child_process");
    for (const part of ["OEBPS/Text/part006.xhtml", "OEBPS/Text/part009.xhtml"]) {
      const xhtml = execFileSync("python", ["-X", "utf8", "-c", `import zipfile,sys;sys.stdout.write(zipfile.ZipFile(r"${epub}").read("${part}").decode("utf-8"))`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      const mathmlBefore = (xhtml.match(/<m:math/g) || []).length;
      const r = await rawmathTransformer.transform(ctx(xhtml));
      const rawLeft = (r.match(/\\\(|\\\[/g) || []).length;
      const mathmlAfter = (r.match(/<m:math/g) || []).length;
      ok(`${part} 裸公式清零`, rawLeft === 0, `剩 ${rawLeft}`);
      ok(`${part} MathML 数量不变`, mathmlBefore === mathmlAfter, `${mathmlBefore}→${mathmlAfter}`);
      const wf = execFileSync("python", ["-X", "utf8", "-c", "import sys,xml.dom.minidom;xml.dom.minidom.parseString(sys.stdin.buffer.read());print('OK')"], { input: r, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      ok(`${part} XML 合法`, wf.trim() === "OK", wf.trim().slice(0, 120));
    }
  } else {
    console.log("（跳过真实 EPUB 用例：未设 RAWMATH_EPUB）");
  }
}

rmSync(outDir, { recursive: true, force: true });
console.log(`\n${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
