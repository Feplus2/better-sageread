// C2「AI 重点标亮」quote → 锚点换算链路实测：
// esbuild 打包 paper-highlight-locator（纯函数核心）+ paper-anchors + paper-sentences + markdown-sections，
// 对 fixtures/papers/zhao2020rational/paper.md 构造真实 quote 验证 匹配 + 句吸附 + 锚点序列化。
// 运行：node scripts/test-paper-ai-highlights.mjs
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
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

const srcDir = join(root, "packages/app/src/pages/paper-reader").replace(/\\/g, "/");
const outDir = mkdtempSync(join(tmpdir(), "paper-ai-highlights-"));
const outfile = join(outDir, "bundle.mjs");
await esbuild.build({
  stdin: {
    contents: `
      export { findQuoteInBlockTexts, snapMatchToSentences, normalizeQuoteForMatch } from "${srcDir}/paper-highlight-locator";
      export { segmentSentences } from "${srcDir}/paper-sentences";
      export { serializeAnchor, parseAnchor } from "${srcDir}/paper-anchors";
      export { parsePaperSections } from "${srcDir}/markdown-sections";
    `,
    resolveDir: root,
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  outfile,
});
const {
  findQuoteInBlockTexts,
  snapMatchToSentences,
  normalizeQuoteForMatch,
  segmentSentences,
  serializeAnchor,
  parseAnchor,
  parsePaperSections,
} = await import(pathToFileURL(outfile).href);

// ─── 从 paper.md 推导"块文本"（近似 react-markdown 渲染后的 textContent）───
// 去 frontmatter/CRLF（parsePaperSections 同口径）→ 按空行切块 → 去图片/heading 标记/数学（KaTeX
// 渲染后 raw tex 不存在于 textContent，无法匹配，故移除近似）→ 去行内标记 + 空白折叠。
function deriveBlockTexts(body) {
  return body
    .split(/\n\s*\n/)
    .map((chunk) => {
      let t = chunk;
      if (/^(\s*!\[[^\]]*\]\([^)]*\)\s*)+$/.test(t)) return null; // 纯图片块（textContent 为空）
      t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
      t = t.replace(/^#{1,6}[ \t]+/gm, "");
      t = t.replace(/\$\$[\s\S]*?\$\$/g, " ").replace(/\$[^$\n]*\$/g, " ");
      t = normalizeQuoteForMatch(t); // 去链接/粗斜体/代码 + 空白折叠
      return t || null;
    })
    .filter(Boolean);
}

const markdown = readFileSync(join(root, "fixtures/papers/zhao2020rational/paper.md"), "utf8");
const { body } = parsePaperSections(markdown);
const blockTexts = deriveBlockTexts(body);
console.log(`blocks: ${blockTexts.length}, body chars: ${body.length}`);

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

/** 完整链路：quote → 块内匹配 → 句吸附，返回 { match, snapped, slice } 或 null */
function locate(quote) {
  const match = findQuoteInBlockTexts(blockTexts, quote);
  if (!match) return null;
  const snapped = snapMatchToSentences(blockTexts[match.block], match.start, match.end);
  if (!snapped) return null;
  return { match, snapped, slice: blockTexts[match.block].slice(snapped.start, snapped.end) };
}

const SENTENCE_A =
  "However, effective guidelines towards the design and preparation of optimal electrode materials are lacking.";

check("普通整句：命中且吸附为原句本身", () => {
  const hit = locate(SENTENCE_A);
  assert(hit, "未命中");
  assert(hit.slice === SENTENCE_A, `吸附结果不符：${JSON.stringify(hit.slice)}`);
});

check("句中片段：吸附扩展为完整句", () => {
  const hit = locate("guidelines towards the design and preparation of optimal electrode materials");
  assert(hit, "未命中");
  assert(hit.slice === SENTENCE_A, `应吸附为整句：${JSON.stringify(hit.slice)}`);
});

check("空白变形（换行/多余空格）仍可命中", () => {
  const mangled =
    "However, effective guidelines towards the design\nand preparation of optimal electrode   materials are lacking.";
  const hit = locate(mangled);
  assert(hit, "未命中");
  assert(hit.slice === SENTENCE_A, `吸附结果不符：${JSON.stringify(hit.slice)}`);
});

check("带 Markdown 粗体标记的 quote：去标记后命中", () => {
  const hit = locate(
    "However, **effective guidelines** towards the design and preparation of optimal electrode materials are lacking.",
  );
  assert(hit, "未命中");
  assert(hit.slice === SENTENCE_A, `吸附结果不符：${JSON.stringify(hit.slice)}`);
});

check("双句 quote：吸附覆盖两句整句", () => {
  const first =
    "In search for electrodes with good chemical/dynamic stability and high Na storage performance, various P2- and O3-type Na-ion layered oxides have been synthesized and investigated(9, 10).";
  const hit = locate(`${first} ${SENTENCE_A}`);
  assert(hit, "未命中");
  assert(hit.slice === `${first} ${SENTENCE_A}`, `吸附结果不符：${JSON.stringify(hit.slice)}`);
});

check("大小写不敏感", () => {
  const hit = locate(SENTENCE_A.toLowerCase());
  assert(hit, "未命中");
  assert(hit.slice === SENTENCE_A, `吸附结果不符：${JSON.stringify(hit.slice)}`);
});

check("不存在的 quote → null（丢弃计数路径）", () => {
  assert(locate("This sentence does not appear anywhere in the paper at all.") === null, "应返回 null");
});

check("含 $...$ 数学的 quote → null（已知限制：KaTeX 渲染后 raw tex 不在 textContent）", () => {
  const withMath =
    "Li-ion layered oxides, with the general formula $\\mathrm{LiTMO}_2$ , have represented the dominant family of electrode materials for Li-ion batteries since 1980(4).";
  assert(locate(withMath) === null, "应返回 null（数学 quote 走丢弃计数）");
});

check("命中区间吸附后与切句器 span 对齐", () => {
  const match = findQuoteInBlockTexts(blockTexts, SENTENCE_A);
  assert(match, "未命中");
  const spans = segmentSentences(blockTexts[match.block]);
  const snapped = snapMatchToSentences(blockTexts[match.block], match.start, match.end);
  assert(
    spans.some((s) => s.start === snapped.start && s.end === snapped.end),
    "吸附结果不是完整句子 span",
  );
});

check("锚点序列化/解析 roundtrip（cfi JSON 形态）", () => {
  const match = findQuoteInBlockTexts(blockTexts, SENTENCE_A);
  assert(match, "未命中");
  const snapped = snapMatchToSentences(blockTexts[match.block], match.start, match.end);
  const anchor = { v: 1, segments: [{ b: match.block, s: snapped.start, e: snapped.end }] };
  const cfi = serializeAnchor(anchor);
  const parsed = parseAnchor(cfi);
  assert(parsed && parsed.segments.length === 1, "解析失败");
  const seg = parsed.segments[0];
  assert(seg.b === match.block && seg.s === snapped.start && seg.e === snapped.end, "roundtrip 不一致");
});

check("短 quote 也能定位（结论句）", () => {
  const quote =
    "The cationic potential correctly predicts the stacking structure for these cases, providing a guideline for the development of Na-ion layered oxides.";
  const hit = locate(quote);
  assert(hit, "未命中");
  assert(hit.slice === quote, `吸附结果不符：${JSON.stringify(hit.slice)}`);
});

rmSync(outDir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length > 0 ? 1 : 0);
