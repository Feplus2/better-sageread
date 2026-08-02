// 公式感知坐标归一（paper-cross-anchor.ts）单测：esbuild 打包 + jsdom 造 live 元素 → node 断言
// 覆盖：normalizeMathText（$...$/$$...$$/多公式/无公式恒等）、
//       归一 ↔ 原坐标往返换算、公式内偏移夹取、
//       normalizeLiveElement（真实 KaTeX 渲染产物/.katex-error/excludeSelector 跳过译文子树）、
//       mapOffsetsMathAware 的 stored ↔ live 词级区间双向对应（含 $\mathrm{LiTMO}_2$ 根因场景）、
//       findAlignPairBySrc/Tgt 的精确/包含/相交查找。
// 运行：node scripts/test-paper-math-normalize.mjs
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
// 应用依赖的 katex（与 rehype-katex 同源，renderToString 产物即 live DOM 结构）
const katexPkg = readdirSync(pnpmDir).find((d) => d.startsWith("katex@0.18"));
if (!katexPkg) throw new Error("node_modules/.pnpm 下未找到 katex@0.18，请先 pnpm install");
const katex = (await import(pathToFileURL(join(pnpmDir, katexPkg, "node_modules", "katex", "dist", "katex.mjs")).href))
  .default;
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>");
const document = dom.window.document;

const outDir = mkdtempSync(join(tmpdir(), "paper-math-normalize-"));
const outfile = join(outDir, "paper-cross-anchor.mjs");
await esbuild.build({
  entryPoints: [join(root, "packages/app/src/pages/paper-reader/paper-cross-anchor.ts")],
  bundle: true,
  format: "esm",
  outfile,
});
const {
  MATH_PLACEHOLDER,
  normalizeMathText,
  normalizeLiveElement,
  normalizeMathOffset,
  denormalizeMathOffset,
  mapOffsetsMathAware,
  mapOffsetsViaTokens,
  mapSourceOffsetsToLive,
  mapTgtRangeToSrc,
  findAlignPairBySrc,
  findAlignPairByTgt,
  tokenizeWords,
} = await import(pathToFileURL(outfile).href);

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
function eqRanges(actual, expected) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

/** 模拟 live 渲染块：源文的 $...$/$$...$$ 用真实 KaTeX 渲染产物替换（结构同 rehype-katex/auto-render） */
function buildLiveElement(sourceText) {
  const { spans } = normalizeMathText(sourceText);
  const div = document.createElement("div");
  let last = 0;
  for (const span of spans) {
    div.appendChild(document.createTextNode(sourceText.slice(last, span.origStart)));
    const raw = sourceText.slice(span.origStart, span.origEnd);
    const display = raw.startsWith("$$");
    const holder = document.createElement("span");
    holder.innerHTML = katex.renderToString(raw.slice(display ? 2 : 1, raw.length - (display ? 2 : 1)), {
      displayMode: display,
      throwOnError: false,
    });
    div.appendChild(holder);
    last = span.origEnd;
  }
  div.appendChild(document.createTextNode(sourceText.slice(last)));
  return div;
}

// ─── normalizeMathText ───

check("归一：$\\mathrm{LiTMO}_2$ 替换为 1 个占位符，spans 坐标正确", () => {
  const text = "氧化物 $\\mathrm{LiTMO}_2$ 表现良好";
  const norm = normalizeMathText(text);
  assert(norm.text === `氧化物 ${MATH_PLACEHOLDER} 表现良好`, `归一文本不符: ${JSON.stringify(norm.text)}`);
  assert(norm.raw === text, "raw 应即入参");
  eqRanges(norm.spans, [{ origStart: 4, origEnd: 4 + "$\\mathrm{LiTMO}_2$".length, normStart: 4 }]);
});

check("归一：无公式恒等（text === raw，spans 为空）", () => {
  const text = "Deep learning models work well. 深度学习模型效果良好。";
  const norm = normalizeMathText(text);
  assert(norm.text === text && norm.spans.length === 0, "无公式应为恒等映射");
});

check("归一：多个公式与 $$...$$ 混排各得 1 个占位符", () => {
  const text = "a $x^2$ b $$y_1$$ c $z$ d";
  const norm = normalizeMathText(text);
  assert(
    norm.text === `a ${MATH_PLACEHOLDER} b ${MATH_PLACEHOLDER} c ${MATH_PLACEHOLDER} d`,
    `归一文本不符: ${JSON.stringify(norm.text)}`,
  );
  // 归一文本 "a ␣ b ␣ c ␣ d"（␣=占位符），占位符位置为归一坐标 2/5/8
  eqRanges(
    norm.spans.map((s) => [s.origStart, s.origEnd, s.normStart]),
    [
      [2, 7, 2],
      [10, 17, 6],
      [20, 23, 10],
    ],
  );
});

// ─── 归一 ↔ 原坐标换算 ───

check("偏移换算：token 边界归一 ↔ 原坐标往返一致", () => {
  const text = "general formula $\\mathrm{LiTMO}_2$ have represented";
  const norm = normalizeMathText(text);
  for (const token of tokenizeWords(norm.text)) {
    const origStart = denormalizeMathOffset(norm, token.start);
    const origEnd = denormalizeMathOffset(norm, token.end);
    assert(
      normalizeMathOffset(norm, origStart) === token.start && normalizeMathOffset(norm, origEnd) === token.end,
      `token ${JSON.stringify(token)} 往返不一致`,
    );
    // 原坐标切片与归一坐标切片是同一个词
    assert(text.slice(origStart, origEnd) === norm.text.slice(token.start, token.end), "往返后词不一致");
  }
});

check("偏移换算：落在公式内部夹到占位符，公式边界精确", () => {
  const text = "ab $x^2$ cd";
  const norm = normalizeMathText(text); // 公式 [3, 8) → 占位符 normStart=3
  assert(normalizeMathOffset(norm, 5) === 3, "公式内部应夹到占位符位置");
  assert(normalizeMathOffset(norm, 3) === 3 && normalizeMathOffset(norm, 8) === 4, "公式边界应精确");
  assert(denormalizeMathOffset(norm, 3) === 3 && denormalizeMathOffset(norm, 4) === 8, "占位符两侧逆归一应精确");
});

// ─── normalizeLiveElement ───

check("live 归一：真实 KaTeX 产物贡献 1 个占位符，raw === textContent", () => {
  const text = "氧化物 $\\mathrm{LiTMO}_2$ 表现良好";
  const el = buildLiveElement(text);
  const norm = normalizeLiveElement(el);
  assert(norm.raw === el.textContent, "raw 应等于元素 textContent");
  assert(norm.text === `氧化物 ${MATH_PLACEHOLDER} 表现良好`, `归一文本不符: ${JSON.stringify(norm.text)}`);
  const katexEl = el.querySelector(".katex");
  eqRanges(norm.spans, [{ origStart: 4, origEnd: 4 + (katexEl.textContent ?? "").length, normStart: 4 }]);
});

check("live 归一：.katex-display 包装递归到内层 .katex，.katex-error 同样归一", () => {
  const text = "能量 $$E=mc^2$$ 守恒";
  const el = buildLiveElement(text);
  assert(el.querySelector(".katex-display .katex"), "前提：display 包装内层 .katex");
  const norm = normalizeLiveElement(el);
  assert(norm.text === `能量 ${MATH_PLACEHOLDER} 守恒`, `display 公式归一不符: ${JSON.stringify(norm.text)}`);
  const err = document.createElement("div");
  err.appendChild(document.createTextNode("甲 "));
  const errSpan = document.createElement("span");
  errSpan.className = "katex-error";
  errSpan.textContent = "\\badcmd";
  err.appendChild(errSpan);
  err.appendChild(document.createTextNode(" 乙"));
  const normErr = normalizeLiveElement(err);
  assert(normErr.text === `甲 ${MATH_PLACEHOLDER} 乙`, `.katex-error 归一不符: ${JSON.stringify(normErr.text)}`);
});

check("live 归一：excludeSelector 跳过 [data-translation] 子树（li 内嵌译文 div）", () => {
  const li = document.createElement("li");
  li.appendChild(document.createTextNode("English text "));
  const holder = document.createElement("span");
  holder.innerHTML = katex.renderToString("\\mathrm{LiTMO}_2", { throwOnError: false });
  li.appendChild(holder);
  const div = document.createElement("div");
  div.setAttribute("data-translation", "");
  div.textContent = "中文译文一句";
  li.appendChild(div);
  const norm = normalizeLiveElement(li, "[data-translation]");
  assert(norm.text === `English text ${MATH_PLACEHOLDER}`, `排除后归一不符: ${JSON.stringify(norm.text)}`);
  assert(norm.raw === `English text ${li.querySelector(".katex")?.textContent ?? ""}`, "排除后 raw 应无译文");
  // 不排除时译文计入（译文在块尾，英文部分仍是前缀，两坐标系对英文区间一致）
  const full = normalizeLiveElement(li);
  assert(full.raw.endsWith("中文译文一句"), "不排除时译文应计入 raw");
});

// ─── mapOffsetsMathAware（根因场景）───

const STORED = "Li-ion layered oxides, with the general formula $\\mathrm{LiTMO}_2$ , have represented the family.";

check("根因：stored 与 live 原始 token 数不等，归一后相等", () => {
  const el = buildLiveElement(STORED);
  const storedTokens = tokenizeWords(STORED).length;
  const liveTokens = tokenizeWords(el.textContent ?? "").length;
  assert(storedTokens !== liveTokens, `前提：原始 token 数应不等（stored ${storedTokens} vs live ${liveTokens}）`);
  const normStored = normalizeMathText(STORED);
  const normLive = normalizeLiveElement(el);
  assert(tokenizeWords(normStored.text).length === tokenizeWords(normLive.text).length, "归一后 token 数应一致");
  // 旧路径在此场景必然返回 null（句级降级的根因），新路径应成功
  assert(mapOffsetsViaTokens(STORED, el.textContent ?? "", 0, 7) === null, "前提：旧路径在含公式块返回 null");
  assert(mapOffsetsMathAware(normStored, normLive, 0, 7) !== null, "新路径应成功");
});

check("词级对应：stored → live 公式两侧单词精确换算", () => {
  const el = buildLiveElement(STORED);
  const live = el.textContent ?? "";
  const normStored = normalizeMathText(STORED);
  const normLive = normalizeLiveElement(el);
  for (const word of ["layered", "formula", "have", "represented"]) {
    const s = STORED.indexOf(word);
    const mapped = mapOffsetsMathAware(normStored, normLive, s, s + word.length);
    assert(
      mapped && live.slice(mapped.start, mapped.end) === word,
      `${word} stored→live 映射不符: ${JSON.stringify(mapped)}`,
    );
  }
});

check("词级对应：live → stored 选区换算（openTranslationPopup 方向）", () => {
  const el = buildLiveElement(STORED);
  const live = el.textContent ?? "";
  const normStored = normalizeMathText(STORED);
  const normLive = normalizeLiveElement(el);
  for (const word of ["layered", "formula", "have"]) {
    const s = live.indexOf(word);
    const mapped = mapOffsetsMathAware(normLive, normStored, s, s + word.length);
    assert(
      mapped && STORED.slice(mapped.start, mapped.end) === word,
      `${word} live→stored 映射不符: ${JSON.stringify(mapped)}`,
    );
  }
});

check("词级区间往返：stored → live → stored 稳定", () => {
  const el = buildLiveElement(STORED);
  const normStored = normalizeMathText(STORED);
  const normLive = normalizeLiveElement(el);
  const s = STORED.indexOf("general");
  const e = s + "general formula".length;
  const toLive = mapOffsetsMathAware(normStored, normLive, s, e);
  assert(toLive, "stored→live 应成功");
  const back = mapOffsetsMathAware(normLive, normStored, toLive.start, toLive.end);
  eqRanges([back], [{ start: s, end: e }]);
});

check("跨公式选区：覆盖 文本+公式+文本 取最小覆盖区间", () => {
  const el = buildLiveElement(STORED);
  const live = el.textContent ?? "";
  const normStored = normalizeMathText(STORED);
  const normLive = normalizeLiveElement(el);
  // "formula $\mathrm{LiTMO}_2$ , have" → live 侧从 formula 到 have
  const s = STORED.indexOf("formula");
  const e = STORED.indexOf("have") + "have".length;
  const mapped = mapOffsetsMathAware(normStored, normLive, s, e);
  assert(mapped, "跨公式映射应成功");
  assert(live.slice(mapped.start, mapped.start + 7) === "formula", "起点应在 formula");
  assert(live.slice(mapped.end - 4, mapped.end) === "have", "终点应在 have 之后");
});

check("公式内选区：无 token 命中返回 null（调用方降级）", () => {
  const el = buildLiveElement(STORED);
  const normStored = normalizeMathText(STORED);
  const normLive = normalizeLiveElement(el);
  const s = STORED.indexOf("$\\mathrm");
  assert(mapOffsetsMathAware(normStored, normLive, s + 2, s + 5) === null, "纯公式内选区应返回 null");
});

check("无公式块：与 mapOffsetsViaTokens 行为一致（恒等语义）", () => {
  const stored = "one  two three four";
  const live = "one two three four";
  const a = normalizeMathText(stored);
  const b = normalizeLiveElement(buildLiveElement(live));
  eqRanges([mapOffsetsMathAware(a, b, 5, 8)], [mapOffsetsViaTokens(stored, live, 5, 8)]);
  assert(
    mapOffsetsMathAware(a, b, 3, 4) === null && mapOffsetsViaTokens(stored, live, 3, 4) === null,
    "无命中应一致为 null",
  );
});

// ─── findAlignPairBySrc / findAlignPairByTgt ───

const ALIGN = [
  { ss: 0, se: 10, ts: 0, te: 6 },
  { ss: 10, se: 25, ts: 6, te: 20 }, // 2-1 合译对（覆盖两个英文句的感觉，这里简化为区间）
  { ss: 25, se: 30, ts: 20, te: 26 },
];

check("句对查找：边界精确相等优先", () => {
  eqRanges([findAlignPairBySrc(ALIGN, 10, 25)], [ALIGN[1]]);
  eqRanges([findAlignPairByTgt(ALIGN, 6, 20)], [ALIGN[1]]);
});

check("句对查找：live 切句更细时退化为包含", () => {
  eqRanges([findAlignPairBySrc(ALIGN, 12, 18)], [ALIGN[1]]);
  eqRanges([findAlignPairByTgt(ALIGN, 8, 12)], [ALIGN[1]]);
});

check("句对查找：相交兜底取重叠最大且须过半，边界跨界不误并相邻句对", () => {
  // (8,16) 跨界：pair0 重叠 2、pair1 重叠 6 → 取 pair1（重叠最大且过半）
  eqRanges([findAlignPairBySrc(ALIGN, 8, 16)], [ALIGN[1]]);
  // (0,11) 越界 1 字符到 pair1：pair0 重叠 10 占优 → 仍取 pair0（不并相邻句）
  eqRanges([findAlignPairBySrc(ALIGN, 0, 11)], [ALIGN[0]]);
  // (8,12) 两侧各半：无可信对应 → null（调用方只显本侧）
  assert(findAlignPairBySrc(ALIGN, 8, 12) === null, "各半跨界应返回 null");
  assert(findAlignPairBySrc(ALIGN, 40, 50) === null, "无覆盖应返回 null");
  assert(findAlignPairByTgt([], 0, 5) === null, "空表应返回 null");
});

// ─── mapSourceOffsetsToLive（md 源文坐标 → live DOM 坐标）───

check("源坐标→live：含公式块词级区间精确换算", () => {
  const el = buildLiveElement(STORED);
  const live = el.textContent ?? "";
  const normSrc = normalizeMathText(STORED);
  const normLive = normalizeLiveElement(el);
  for (const word of ["layered", "formula", "have", "represented"]) {
    const s = STORED.indexOf(word);
    const mapped = mapSourceOffsetsToLive(normSrc, normLive, s, s + word.length);
    assert(
      mapped && live.slice(mapped.start, mapped.end) === word,
      `${word} 源坐标→live 不符: ${JSON.stringify(mapped)}`,
    );
  }
  // 覆盖公式的句级区间：覆盖 "formula $...$ , have"
  const s = STORED.indexOf("formula");
  const e = STORED.indexOf("have") + 4;
  const mapped = mapSourceOffsetsToLive(normSrc, normLive, s, e);
  assert(mapped && live.slice(mapped.start, mapped.start + 7) === "formula", "跨公式区间起点应在 formula");
  assert(mapped && live.slice(mapped.end - 4, mapped.end) === "have", "跨公式区间终点应在 have 之后");
});

check("源坐标→live：无公式恒等；空区间 null", () => {
  const text = "one two three four";
  const el = buildLiveElement(text);
  const normSrc = normalizeMathText(text);
  const normLive = normalizeLiveElement(el);
  eqRanges([mapSourceOffsetsToLive(normSrc, normLive, 4, 7)], [{ start: 4, end: 7 }]);
  assert(mapSourceOffsetsToLive(normSrc, normLive, 3, 3) === null, "空区间应返回 null");
});

check("源坐标→live：token 失配退化句索引对应，句界也失配返回 null", () => {
  // live 多一个词（模拟渲染增 token）：token 数不等 → 词级换算失败 → 句索引对应（句数一致）
  const src = "Deep learning works. It helps.";
  const liveEl = document.createElement("div");
  liveEl.textContent = "Deep learning really works. It helps.";
  const normSrc = normalizeMathText(src);
  const normLive = normalizeLiveElement(liveEl);
  const srcSpans = [
    { start: 0, end: 20 },
    { start: 21, end: 30 },
  ];
  const mapped = mapSourceOffsetsToLive(normSrc, normLive, srcSpans[0].start, srcSpans[0].end);
  eqRanges([mapped], [{ start: 0, end: 27 }]); // live 首句 "Deep learning really works."
  // 句内区间（非句界）且 token 失配 → null
  assert(mapSourceOffsetsToLive(normSrc, normLive, 5, 12) === null, "句内区间失配应返回 null");
});

check("中文划线全链路：stored 选区 → 词级映射 → 源坐标 → live cfi 坐标（含公式块）", () => {
  // 模拟 openTranslationPopup 的坐标链：live 中文选区 → stored → alignW 词级 → 源坐标 → live 英文
  const sourceText = "The material $\\mathrm{LiTMO}_2$ shows high Na storage performance today.";
  const stored = "该材料 $\\mathrm{LiTMO}_2$ 展现出高钠储存性能。";
  const align = [{ ss: 0, se: sourceText.length, ts: 0, te: stored.length }];
  const alignW = [
    { ss: 0, se: 38, ts: 0, te: 26 }, // The material $...$ shows ↔ 该材料 $...$ 展现出
    { ss: 38, se: 65, ts: 26, te: 32 }, // high Na storage performance ↔ 高钠储存性能
    { ss: 65, se: sourceText.length, ts: 32, te: stored.length }, // today. ↔ 。
  ];
  assert(sourceText.slice(38, 65) === "high Na storage performance", "前提：词对 src 区间");
  assert(stored.slice(26, 32) === "高钠储存性能", "前提：词对 tgt 区间");
  const tgtEl = buildLiveElement(stored);
  const tgtLive = tgtEl.textContent ?? "";
  // 用户在 live 译文上划 "高钠储存"
  const s = tgtLive.indexOf("高钠储存");
  const storedRange = mapOffsetsMathAware(normalizeLiveElement(tgtEl), normalizeMathText(stored), s, s + 4);
  eqRanges([storedRange], [{ start: 26, end: 30 }]);
  const mapped = mapTgtRangeToSrc(align, storedRange.start, storedRange.end, alignW);
  eqRanges([mapped], [{ ss: 38, se: 65 }]);
  // 修复点：源坐标 → live 英文块坐标（旧代码直接把源坐标存进 cfi，下游按 live 坐标消费导致错位）
  const enEl = buildLiveElement(sourceText);
  const liveOffsets = mapSourceOffsetsToLive(
    normalizeMathText(sourceText),
    normalizeLiveElement(enEl),
    mapped.ss,
    mapped.se,
  );
  assert(liveOffsets, "源坐标→live 应成功");
  assert(
    (enEl.textContent ?? "").slice(liveOffsets.start, liveOffsets.end) === "high Na storage performance",
    `live cfi 切片应为词级英文: ${JSON.stringify(liveOffsets)}`,
  );
});

rmSync(outDir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length > 0 ? 1 : 0);
