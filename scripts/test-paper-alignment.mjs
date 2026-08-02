// 对齐（paper-cross-anchor.ts）单测：esbuild 打包 → node 断言
// 覆盖：句级单调 DP 的 (1,1)/(1,2)/(2,1) 配对与单调性、退化尺寸（1×1/空）、
//       词级单调 DP 的 (1,1)/(1,k)/(k,1)（k≤4）配对与单调性、
//       分词器（英文按词/中文按单字/连接符词）、
//       mapSrcRangeToTgt / mapTgtRangeToSrc 的边界（无覆盖/跨句/句吸附/区间合并/
//       词级精确映射/词级缺失回退句级/词级未命中回退句级）、
//       mapOffsetsViaTokens 的 live↔stored 坐标换算。
// 运行：node scripts/test-paper-alignment.mjs
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

const outDir = mkdtempSync(join(tmpdir(), "paper-alignment-"));
const outfile = join(outDir, "paper-cross-anchor.mjs");
await esbuild.build({
  entryPoints: [join(root, "packages/app/src/pages/paper-reader/paper-cross-anchor.ts")],
  bundle: true,
  format: "esm",
  outfile,
});
const { alignSentenceDP, alignWordDP, mapOffsetsViaTokens, mapSrcRangeToTgt, mapTgtRangeToSrc, tokenizeWords } =
  await import(pathToFileURL(outfile).href);

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
function eq(actual, expected) {
  assert(
    actual.length === expected.length && actual.every((v, i) => v === expected[i]),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}
function eqRanges(actual, expected) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

// ─── 单调 DP ───

check("DP：3×3 对角占优 → 全部 (1,1)", () => {
  const sim = [
    [0.9, 0.1, 0.1],
    [0.1, 0.9, 0.1],
    [0.1, 0.1, 0.9],
  ];
  const pairs = alignSentenceDP(sim);
  eq(
    pairs.map((p) => `${p.si}+${p.srcCount}->${p.ti}+${p.tgtCount}`),
    ["0+1->0+1", "1+1->1+1", "2+1->2+1"],
  );
  assert(
    pairs.every((p) => p.score > 0.85),
    `对角配对应高置信: ${JSON.stringify(pairs)}`,
  );
});

check("DP：(1,2) 配对——一句英文拆成两句中文", () => {
  // 源 2 句 / 目标 3 句：src1 与 tgt1、tgt2 都相似（拆译）
  const sim = [
    [0.9, 0.1, 0.1],
    [0.1, 0.8, 0.7],
  ];
  const pairs = alignSentenceDP(sim);
  eq(
    pairs.map((p) => `${p.si}+${p.srcCount}->${p.ti}+${p.tgtCount}`),
    ["0+1->0+1", "1+1->1+2"],
  );
  assert(Math.abs(pairs[1].score - 0.75) < 1e-9, `(1,2) 句对 score 应为参与句均值: ${pairs[1].score}`);
});

check("DP：(2,1) 配对——两句英文合成一句中文", () => {
  // 源 3 句 / 目标 2 句：src1、src2 与 tgt1 都相似（合译）
  const sim = [
    [0.9, 0.1],
    [0.1, 0.8],
    [0.1, 0.7],
  ];
  const pairs = alignSentenceDP(sim);
  eq(
    pairs.map((p) => `${p.si}+${p.srcCount}->${p.ti}+${p.tgtCount}`),
    ["0+1->0+1", "1+2->1+1"],
  );
});

check("DP：(2,1) 与 (1,2) 组合出现且保持单调", () => {
  // 源 4 句 / 目标 4 句：src0→tgt0；src1+src2→tgt1；src3→tgt2+tgt3
  const sim = [
    [0.9, 0.1, 0.1, 0.1],
    [0.1, 0.8, 0.1, 0.1],
    [0.1, 0.7, 0.1, 0.1],
    [0.1, 0.1, 0.8, 0.7],
  ];
  const pairs = alignSentenceDP(sim);
  eq(
    pairs.map((p) => `${p.si}+${p.srcCount}->${p.ti}+${p.tgtCount}`),
    ["0+1->0+1", "1+2->1+1", "3+1->2+2"],
  );
});

check("DP：单调性与全覆盖（随机矩阵）", () => {
  // 行列数不同 + 随机相似度：句对必须严格递增且两侧全覆盖
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const n = 7;
  const m = 9;
  const sim = Array.from({ length: n }, () => Array.from({ length: m }, () => rand()));
  const pairs = alignSentenceDP(sim);
  assert(pairs.length > 0, "应至少有一对");
  let srcCursor = 0;
  let tgtCursor = 0;
  for (const pair of pairs) {
    assert(pair.si === srcCursor, `源侧须连续单调: pair.si=${pair.si}, expected ${srcCursor}`);
    assert(pair.ti === tgtCursor, `目标侧须连续单调: pair.ti=${pair.ti}, expected ${tgtCursor}`);
    assert(pair.srcCount >= 1 && pair.srcCount <= 2 && pair.tgtCount >= 1 && pair.tgtCount <= 2, "步长仅限 1/2");
    srcCursor += pair.srcCount;
    tgtCursor += pair.tgtCount;
  }
  assert(srcCursor === n && tgtCursor === m, `两侧须全覆盖: src ${srcCursor}/${n}, tgt ${tgtCursor}/${m}`);
});

check("DP：退化尺寸（1×1 / 空侧）", () => {
  const one = alignSentenceDP([[0.42]]);
  eq(
    one.map((p) => `${p.si}+${p.srcCount}->${p.ti}+${p.tgtCount}`),
    ["0+1->0+1"],
  );
  assert(Math.abs(one[0].score - 0.42) < 1e-9, "1×1 score 即唯一相似度");
  eq(alignSentenceDP([]), []);
  eq(alignSentenceDP([[]]), []);
});

check("DP：低相似度 (1,1) 仍成对（由 service 按 score 标 low）", () => {
  const pairs = alignSentenceDP([
    [0.2, 0.1],
    [0.1, 0.2],
  ]);
  eq(
    pairs.map((p) => `${p.si}+${p.srcCount}->${p.ti}+${p.tgtCount}`),
    ["0+1->0+1", "1+1->1+1"],
  );
  assert(
    pairs.every((p) => p.score < 0.5),
    "低相似度句对应由 score 体现",
  );
});

check("DP：组大小缩放成本——中等对角线下不乱并句（块 39 真实矩阵回归）", () => {
  // 真实案例（zhao2020 块 39 的 EN4-6 × ZH4-6 子矩阵，embedding-3 余弦）：
  // 对角线均为行内最大值但区分度中等；旧成本（基线恒 1/步）会错并成
  // (0+1↔0)+(2↔1+2)（5 步总成本低于 6 步），缩放成本必须给出全 1:1
  const sim = [
    [0.651, 0.507, 0.352],
    [0.43, 0.724, 0.297],
    [0.429, 0.414, 0.608],
  ];
  const pairs = alignSentenceDP(sim);
  eq(
    pairs.map((p) => `${p.si}+${p.srcCount}->${p.ti}+${p.tgtCount}`),
    ["0+1->0+1", "1+1->1+1", "2+1->2+1"],
  );
});

check("DP：组大小缩放成本——正当合译保留（交叉项确实差时 (2,1) 仍胜）", () => {
  // src0+src1 都指向 tgt0（合译），tgt1 归 src2；缩放成本下合并仍应胜出
  const sim = [
    [0.85, 0.1],
    [0.75, 0.2],
    [0.15, 0.8],
  ];
  const pairs = alignSentenceDP(sim);
  eq(
    pairs.map((p) => `${p.si}+${p.srcCount}->${p.ti}+${p.tgtCount}`),
    ["0+2->0+1", "2+1->1+1"],
  );
});

// ─── 区间映射 ───

const ALIGN = [
  { ss: 0, se: 10, ts: 0, te: 6 },
  { ss: 10, se: 25, ts: 6, te: 20 },
  { ss: 25, se: 30, ts: 20, te: 26 },
];

check("mapSrcRangeToTgt：句内子区间 → 整个句对 tgt 区间（句吸附）", () => {
  eqRanges(mapSrcRangeToTgt(ALIGN, 3, 8), [{ ts: 0, te: 6 }]);
});

check("mapSrcRangeToTgt：跨句对 → 连续 tgt 区间合并", () => {
  eqRanges(mapSrcRangeToTgt(ALIGN, 8, 12), [{ ts: 0, te: 20 }]);
  eqRanges(mapSrcRangeToTgt(ALIGN, 0, 30), [{ ts: 0, te: 26 }]);
});

check("mapSrcRangeToTgt：无覆盖 / 空区间 → null", () => {
  assert(mapSrcRangeToTgt(ALIGN, 100, 200) === null, "超出覆盖应返回 null");
  assert(mapSrcRangeToTgt(ALIGN, 5, 5) === null, "空区间应返回 null");
  assert(mapSrcRangeToTgt([], 0, 10) === null, "无对齐表应返回 null");
});

check("mapSrcRangeToTgt：tgt 区间有间隙时不强行合并", () => {
  const gapped = [
    { ss: 0, se: 10, ts: 0, te: 6 },
    { ss: 10, se: 20, ts: 10, te: 16 },
  ];
  eqRanges(mapSrcRangeToTgt(gapped, 0, 20), [
    { ts: 0, te: 6 },
    { ts: 10, te: 16 },
  ]);
});

check("mapTgtRangeToSrc：划一半中文 → 整个英文句（句吸附）", () => {
  const r = mapTgtRangeToSrc(ALIGN, 2, 4);
  assert(r && r.ss === 0 && r.se === 10, `expected {ss:0,se:10}, got ${JSON.stringify(r)}`);
});

check("mapTgtRangeToSrc：跨句对 → src 区间并集", () => {
  const r = mapTgtRangeToSrc(ALIGN, 4, 8);
  assert(r && r.ss === 0 && r.se === 25, `expected {ss:0,se:25}, got ${JSON.stringify(r)}`);
  const whole = mapTgtRangeToSrc(ALIGN, 0, 26);
  assert(whole && whole.ss === 0 && whole.se === 30, `全覆盖应到末句: ${JSON.stringify(whole)}`);
});

check("mapTgtRangeToSrc：无覆盖 / 空区间 → null", () => {
  assert(mapTgtRangeToSrc(ALIGN, 50, 60) === null, "超出覆盖应返回 null");
  assert(mapTgtRangeToSrc(ALIGN, 3, 3) === null, "空区间应返回 null");
  assert(mapTgtRangeToSrc([], 0, 5) === null, "无对齐表应返回 null");
});

check("映射：2-1 句对按整组参与", () => {
  const merged = [{ ss: 0, se: 20, ts: 0, te: 8 }];
  // 英文两句合译为一句中文：src 第二句内子区间也映射到整个中文句
  eqRanges(mapSrcRangeToTgt(merged, 12, 18), [{ ts: 0, te: 8 }]);
  const back = mapTgtRangeToSrc(merged, 3, 5);
  assert(back && back.ss === 0 && back.se === 20, `合译句反应覆盖两个英文句: ${JSON.stringify(back)}`);
});

// ─── T3 分词器 ───

const offsets = (tokens) => tokens.map((t) => `${t.start}-${t.end}`);

check("分词：英文按词且保留偏移", () => {
  eq(offsets(tokenizeWords("Hello, world!")), ["0-5", "7-12"]);
});

check("分词：中文按单字", () => {
  eq(offsets(tokenizeWords("深度学习模型")), ["0-1", "1-2", "2-3", "3-4", "4-5", "5-6"]);
});

check("分词：中英混排（英文词 + 中文字）", () => {
  eq(offsets(tokenizeWords("Transformer 模型")), ["0-11", "12-13", "13-14"]);
});

check("分词：连接符词不拆开（don't / state-of-the-art / 2.5）", () => {
  eq(offsets(tokenizeWords("don't panic")), ["0-5", "6-11"]);
  eq(offsets(tokenizeWords("state-of-the-art")), ["0-16"]);
  eq(offsets(tokenizeWords("2.5 GHz")), ["0-3", "4-7"]);
});

check("分词：标点/空白/数学符号不成 token", () => {
  // "（见图 $x^2$），" → 见(1-2) 图(2-3) x(5-6) 2(7-8)
  eq(offsets(tokenizeWords("（见图 $x^2$），")), ["1-2", "2-3", "5-6", "7-8"]);
  eq(offsets(tokenizeWords("")), []);
});

// ─── T3 词级单调 DP ───

check("词 DP：3×3 对角占优 → 全部 (1,1)", () => {
  const sim = [
    [0.9, 0.1, 0.1],
    [0.1, 0.9, 0.1],
    [0.1, 0.1, 0.9],
  ];
  eq(
    alignWordDP(sim).map((p) => `${p.si}+${p.srcCount}->${p.ti}+${p.tgtCount}`),
    ["0+1->0+1", "1+1->1+1", "2+1->2+1"],
  );
});

check("词 DP：(1,3) 配对——一词多字（models → 模型效）", () => {
  const sim = [
    [0.9, 0.1, 0.1, 0.1],
    [0.1, 0.8, 0.8, 0.8],
  ];
  const pairs = alignWordDP(sim);
  eq(
    pairs.map((p) => `${p.si}+${p.srcCount}->${p.ti}+${p.tgtCount}`),
    ["0+1->0+1", "1+1->1+3"],
  );
  assert(Math.abs(pairs[1].score - 0.8) < 1e-9, `(1,3) 词对 score 应为参与 token 均值: ${pairs[1].score}`);
});

check("词 DP：(3,1) 配对——多词一缩（大语言模型 → LLM）", () => {
  const sim = [
    [0.9, 0.1],
    [0.1, 0.8],
    [0.1, 0.8],
    [0.1, 0.8],
  ];
  eq(
    alignWordDP(sim).map((p) => `${p.si}+${p.srcCount}->${p.ti}+${p.tgtCount}`),
    ["0+1->0+1", "1+3->1+1"],
  );
});

check("词 DP：低区分度下不向大合并漂移（块 39 级联错位回归）", () => {
  // 真实案例：词向量信号存在但区分度低（对角 0.6 / 非对角 0.45）时，旧成本
  // （基线恒 1/步）偏好 (3,1)/(1,4) 大合并——步数少总成本低——整句级联错位
  // （"lead to stable structures"↔"根"）；缩放成本下必须给出全 (1,1)
  const sim = Array.from({ length: 6 }, (_, i) =>
    Array.from({ length: 6 }, (_, j) => (i === j ? 0.6 : 0.45)),
  );
  const pairs = alignWordDP(sim);
  eq(
    pairs.map((p) => `${p.si}+${p.srcCount}->${p.ti}+${p.tgtCount}`),
    ["0+1->0+1", "1+1->1+1", "2+1->2+1", "3+1->3+1", "4+1->4+1", "5+1->5+1"],
  );
});

check("词 DP：(1,4) 为合并上限——等比极端下步长 ≤4 且全覆盖", () => {  // 2×6：单步 (1,k) 最多消耗 4 个 tgt，必须多步走完
  const sim = Array.from({ length: 2 }, () => Array.from({ length: 6 }, () => 0.8));
  const pairs = alignWordDP(sim);
  assert(pairs.length > 0, "应至少有一对");
  let srcCursor = 0;
  let tgtCursor = 0;
  for (const pair of pairs) {
    assert(pair.si === srcCursor && pair.ti === tgtCursor, "对子须连续单调");
    assert(pair.srcCount >= 1 && pair.srcCount <= 4 && pair.tgtCount >= 1 && pair.tgtCount <= 4, "步长仅限 1..4");
    assert(pair.srcCount === 1 || pair.tgtCount === 1, "移动仅限 (1,1)/(1,k)/(k,1)");
    srcCursor += pair.srcCount;
    tgtCursor += pair.tgtCount;
  }
  assert(srcCursor === 2 && tgtCursor === 6, `两侧须全覆盖: src ${srcCursor}/2, tgt ${tgtCursor}/6`);
});

check("词 DP：超出合并上限的极端比例 → 空表（调用方回退句级）", () => {
  // 1×6：tgt 最多消耗 1×4=4 < 6，无法全覆盖（句对来自句级 DP，词数比不会这么极端）
  eq(alignWordDP([Array.from({ length: 6 }, () => 0.8)]), []);
});

check("词 DP：maxGroup=1 时退化为纯 (1,1)", () => {
  const pairs = alignWordDP(
    [
      [0.9, 0.8],
      [0.8, 0.9],
    ],
    1,
  );
  eq(
    pairs.map((p) => `${p.si}+${p.srcCount}->${p.ti}+${p.tgtCount}`),
    ["0+1->0+1", "1+1->1+1"],
  );
});

check("词 DP：单调性与全覆盖（随机矩阵，一步至多一侧 >1）", () => {
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const n = 8;
  const m = 13;
  const sim = Array.from({ length: n }, () => Array.from({ length: m }, () => rand()));
  const pairs = alignWordDP(sim);
  assert(pairs.length > 0, "应至少有一对");
  let srcCursor = 0;
  let tgtCursor = 0;
  for (const pair of pairs) {
    assert(pair.si === srcCursor, `源侧须连续单调: si=${pair.si}, expected ${srcCursor}`);
    assert(pair.ti === tgtCursor, `目标侧须连续单调: ti=${pair.ti}, expected ${tgtCursor}`);
    assert(pair.srcCount >= 1 && pair.srcCount <= 4 && pair.tgtCount >= 1 && pair.tgtCount <= 4, "步长仅限 1..4");
    assert(pair.srcCount === 1 || pair.tgtCount === 1, "移动仅限 (1,1)/(1,k)/(k,1)");
    srcCursor += pair.srcCount;
    tgtCursor += pair.tgtCount;
  }
  assert(srcCursor === n && tgtCursor === m, `两侧须全覆盖: src ${srcCursor}/${n}, tgt ${tgtCursor}/${m}`);
});

check("词 DP：退化尺寸（1×1 / 空侧）", () => {
  const one = alignWordDP([[0.42]]);
  eq(
    one.map((p) => `${p.si}+${p.srcCount}->${p.ti}+${p.tgtCount}`),
    ["0+1->0+1"],
  );
  assert(Math.abs(one[0].score - 0.42) < 1e-9, "1×1 score 即唯一相似度");
  eq(alignWordDP([]), []);
  eq(alignWordDP([[]]), []);
});

// ─── T3 词级精确映射（句级回退） ───

// 场景：src "Deep learning models work well"（Deep 0-4, learning 5-13, models 14-20, work 21-25, well 26-30）
//       tgt "深度学习模型效果良好"（深0 度1 学2 习3 模4 型5 效6 果7 良8 好9）
const SENT_ALIGN = [{ ss: 0, se: 30, ts: 0, te: 10 }];
const WORD_ALIGN = [
  { ss: 0, se: 13, ts: 0, te: 4 }, // Deep learning → 深度学习
  { ss: 14, se: 20, ts: 4, te: 6 }, // models → 模型
  { ss: 21, se: 30, ts: 6, te: 10 }, // work well → 效果良好
];

check("词级映射：划中文几个字 → 英文精确词区间（非整句）", () => {
  const r = mapTgtRangeToSrc(SENT_ALIGN, 0, 2, WORD_ALIGN); // 划"深度"
  assert(r && r.ss === 0 && r.se === 13, `expected {ss:0,se:13}(Deep learning), got ${JSON.stringify(r)}`);
  const r2 = mapTgtRangeToSrc(SENT_ALIGN, 4, 6, WORD_ALIGN); // 划"模型"
  assert(r2 && r2.ss === 14 && r2.se === 20, `expected {ss:14,se:20}(models), got ${JSON.stringify(r2)}`);
});

check("词级映射：英文子区间 → 中文精确词区间（非整句）", () => {
  eqRanges(mapSrcRangeToTgt(SENT_ALIGN, 14, 20, WORD_ALIGN), [{ ts: 4, te: 6 }]); // models → 模型
  eqRanges(mapSrcRangeToTgt(SENT_ALIGN, 0, 13, WORD_ALIGN), [{ ts: 0, te: 4 }]); // Deep learning → 深度学习
});

check("词级映射：跨词对选区取并集", () => {
  const r = mapTgtRangeToSrc(SENT_ALIGN, 3, 5, WORD_ALIGN); // 划"习模"（跨"深度学习"与"模型"两对）
  assert(r && r.ss === 0 && r.se === 20, `expected {ss:0,se:20}, got ${JSON.stringify(r)}`);
  eqRanges(mapSrcRangeToTgt(SENT_ALIGN, 10, 25, WORD_ALIGN), [{ ts: 0, te: 10 }]);
});

check("词级映射：无 alignW（undefined/null/空表）回退句级句吸附", () => {
  for (const w of [undefined, null, []]) {
    const r = mapTgtRangeToSrc(SENT_ALIGN, 0, 2, w);
    assert(r && r.ss === 0 && r.se === 30, `无 alignW 应句吸附到整句: ${JSON.stringify(r)}`);
    eqRanges(mapSrcRangeToTgt(SENT_ALIGN, 14, 20, w), [{ ts: 0, te: 10 }]);
  }
});

check("词级映射：alignW 未命中（选中纯标点）回退句级", () => {
  // 词对只覆盖 ts 0-3；句对覆盖 ts 0-6 —— 划 tgt[4,6) 词级未命中 → 句级命中
  const align = [{ ss: 0, se: 10, ts: 0, te: 6 }];
  const alignW = [{ ss: 0, se: 5, ts: 0, te: 3 }];
  const r = mapTgtRangeToSrc(align, 4, 6, alignW);
  assert(r && r.ss === 0 && r.se === 10, `词级未命中应回退句级: ${JSON.stringify(r)}`);
  eqRanges(mapSrcRangeToTgt(align, 7, 10, alignW), [{ ts: 0, te: 6 }]);
});

check("词级映射：alignW 与句级都无覆盖 → null", () => {
  assert(mapTgtRangeToSrc(SENT_ALIGN, 20, 25, WORD_ALIGN) === null, "超出覆盖应返回 null");
  assert(mapSrcRangeToTgt(SENT_ALIGN, 40, 50, WORD_ALIGN) === null, "超出覆盖应返回 null");
});

// ─── T3 live↔stored 坐标换算（词 token 下标对应） ───

check("mapOffsetsViaTokens：等长 token 序列精确换算（空白差异场景）", () => {
  // stored 有多余空白（oneLine 折叠前），live 折叠后 token 序列等长：按下标对应
  const stored = "one  two three";
  const live = "one two three";
  eqRanges([mapOffsetsViaTokens(stored, live, 5, 8)], [{ start: 4, end: 7 }]); // "two"
});

check("mapOffsetsViaTokens：命中范围跨 token 取最小覆盖区间", () => {
  eqRanges([mapOffsetsViaTokens("one two three", "one two three", 2, 10)], [{ start: 0, end: 13 }]);
});

check("mapOffsetsViaTokens：token 数不等（KaTeX 重排）/ 无命中 → null", () => {
  assert(mapOffsetsViaTokens("one two", "one two three", 0, 3) === null, "token 数不等应返回 null");
  assert(mapOffsetsViaTokens("one two", "one two", 3, 4) === null, "只选中空白应返回 null");
  assert(mapOffsetsViaTokens("", "", 0, 1) === null, "空文本应返回 null");
});

rmSync(outDir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
