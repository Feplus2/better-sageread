// 切句器单测：esbuild 打包 paper-sentences.ts → node 断言
// 运行：node scripts/test-paper-sentences.mjs
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

const outDir = mkdtempSync(join(tmpdir(), "paper-sentences-"));
const outfile = join(outDir, "paper-sentences.mjs");
await esbuild.build({
  entryPoints: [join(root, "packages/app/src/pages/paper-reader/paper-sentences.ts")],
  bundle: true,
  format: "esm",
  outfile,
});
const { segmentSentences, findSentenceAt, snapRangeToSentences } = await import(pathToFileURL(outfile).href);

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
/** 切句并还原文本，便于直接对比例句 */
function cut(text) {
  return segmentSentences(text).map((s) => text.slice(s.start, s.end));
}
function eq(actual, expected) {
  assert(
    actual.length === expected.length && actual.every((v, i) => v === expected[i]),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

check("普通两句", () => {
  eq(cut("Hello world. This is fine."), ["Hello world.", "This is fine."]);
});

check("空串", () => {
  eq(cut(""), []);
});

check("单句无终止符", () => {
  eq(cut("a sentence without terminator"), ["a sentence without terminator"]);
});

check("et al. 不切", () => {
  eq(cut("Smith et al. showed this. It worked."), ["Smith et al. showed this.", "It worked."]);
});

check("e.g. / i.e. / U.S. 不切", () => {
  eq(cut("Use e.g. this method, i.e. the U.S. variant. It helps."), [
    "Use e.g. this method, i.e. the U.S. variant.",
    "It helps.",
  ]);
});

check("Fig. 1A 不切", () => {
  eq(cut("As shown in Fig. 1A, the curve rises. We agree."), ["As shown in Fig. 1A, the curve rises.", "We agree."]);
});

check("期刊缩写不切（参考文献条目不被切碎）", () => {
  eq(
    cut(
      "A. K. Kalathil, P. Arunkumar, Influence of $Ti^{4+}$ on Li-Rich Layered Oxides. ACS Appl. Mater. Inter. 7, 7118-7128 (2015).",
    ),
    [
      "A. K. Kalathil, P. Arunkumar, Influence of $Ti^{4+}$ on Li-Rich Layered Oxides.",
      "ACS Appl. Mater. Inter. 7, 7118-7128 (2015).",
    ],
  );
  eq(cut("K. Mizushima et al., $Li_{x}CoO_{2}$ cathode. Mater. Res. Bull. 15, 783-789 (1980). Next one here."), [
    "K. Mizushima et al., $Li_{x}CoO_{2}$ cathode.",
    "Mater. Res. Bull. 15, 783-789 (1980).",
    "Next one here.",
  ]);
});

check("小数点 2.5 不切", () => {
  eq(cut("The value is 2.5 times higher. We note it."), ["The value is 2.5 times higher.", "We note it."]);
});

check("省略号 ... 不切", () => {
  eq(cut("Wait... what happened? We left."), ["Wait... what happened?", "We left."]);
});

check("参考文献编号 [12] 前置于句点归前", () => {
  eq(cut("The method works [12]. We extend it."), ["The method works [12].", "We extend it."]);
});

check("尾随参考文献角标 [12] / (3) 归前一句", () => {
  eq(cut("The method works.[12] We extend it.(3) It helps."), [
    "The method works.[12]",
    "We extend it.(3)",
    "It helps.",
  ]);
});

check("引号闭合归前一句", () => {
  eq(cut('He said "hello." Next sentence.'), ['He said "hello."', "Next sentence."]);
});

check("闭合括号+引号归前（structures(1). 型）", () => {
  const text = '…the crystal structures(1). "Quoted" follows.';
  eq(cut(text), ["…the crystal structures(1).", '"Quoted" follows.']);
});

check("连续终止符 ?! 视作一体", () => {
  eq(cut("Really?! We checked."), ["Really?!", "We checked."]);
});

check("句点后跟小写不切（引号内结尾）", () => {
  eq(cut('"Done." she said. Then left.'), ['"Done." she said.', "Then left."]);
});

check("中文句号/感叹/问号", () => {
  eq(cut("第一句话。第二句话！第三句吗？结束"), ["第一句话。", "第二句话！", "第三句吗？", "结束"]);
});

check("中文闭合引号归前", () => {
  eq(cut("他说“你好。”下一句。"), ["他说“你好。”", "下一句。"]);
});

check("行尾即边界", () => {
  eq(cut("first line.\nsecond starts lowercase"), ["first line.", "second starts lowercase"]);
});

check("单字母大写缩写不切（J. R. R.）", () => {
  eq(cut("By J. R. R. Tolkien. A classic."), ["By J. R. R. Tolkien.", "A classic."]);
});

check("首尾空白 trim", () => {
  const spans = segmentSentences("  Padded sentence.  ");
  assert(spans.length === 1, `expected 1 span, got ${spans.length}`);
  assert(spans[0].start === 2 && spans[0].end === 18, `expected [2,18), got [${spans[0].start},${spans[0].end})`);
});

check("findSentenceAt 命中/空白/段尾", () => {
  const text = "One here. Two here.";
  const spans = segmentSentences(text);
  assert(findSentenceAt(spans, 0) === spans[0], "offset 0 → 第一句");
  assert(findSentenceAt(spans, 5) === spans[0], "offset 5 → 第一句");
  assert(findSentenceAt(spans, 9) === null, "句间空白 → null");
  assert(findSentenceAt(spans, 12) === spans[1], "offset 12 → 第二句");
  assert(findSentenceAt(spans, text.length) === spans[1], "段尾偏移归末句");
  assert(findSentenceAt(spans, 100) === null, "越界 → null");
});

check("snapRangeToSentences 吸附句边界", () => {
  const text = "First sentence. Second one. Third here.";
  const spans = segmentSentences(text);
  // 区间横跨第二句内部 → 吸附为第二句整句
  eq(
    [snapRangeToSentences(spans, 18, 24)].map((s) => text.slice(s.start, s.end)),
    ["Second one."],
  );
  // 跨两句 → 覆盖两句
  eq(
    [snapRangeToSentences(spans, 3, 30)].map((s) => text.slice(s.start, s.end)),
    ["First sentence. Second one. Third here."],
  );
  // 起/终点落在句间空白 → 归入后/前句
  eq(
    [snapRangeToSentences(spans, 15, 28)].map((s) => text.slice(s.start, s.end)),
    ["Second one."],
  );
  // 无交叠（区间全在首部空白）
  assert(snapRangeToSentences(segmentSentences("  Hi."), 0, 1) === null, "全空白区间 → null");
  // start >= end
  assert(snapRangeToSentences(spans, 5, 5) === null, "空区间 → null");
});

rmSync(outDir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length > 0 ? 1 : 0);
