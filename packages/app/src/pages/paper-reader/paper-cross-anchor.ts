/**
 * 论文跨语言对齐（T2 句级 + T3 词级）：对齐表类型、分词、单调 DP 对齐、双向区间映射
 * （纯函数，无 DOM/Tauri 依赖）。
 *
 * 句级对齐表随译本落库（translation-zh.json 的 blocks[idx].align）：
 *   [{ss, se, ts, te, low?}] —— ss/se 为源文（英文）块 textContent 内字符偏移，
 *   ts/te 为译文（中文）块文本内字符偏移；每项覆盖一对句组（1-1 / 2-1 / 1-2），
 *   沿文档顺序单调递增。low=true 表示该句对平均相似度低于置信阈值，UI 可降级展示。
 * 词级对齐表（blocks[idx].alignW）结构相同、坐标系相同，粒度细到词/字：
 *   在每个句对内部计算，词对沿文档顺序单调、两侧 token 全覆盖。
 *
 * 分词（tokenizeWords）：英文按单词（保留偏移），中文按单字——无 jieba 依赖，
 * 单字 + DP 的 (1,k) 合并移动天然覆盖"一词多字"（transformer→变压器）。
 *
 * 对齐计算（alignDP）：两侧取向量余弦相似度矩阵，DP 走 (1,1)/(1,k)/(k,1) 移动
 * （k ≤ maxGroup；句级 k=2，词级 k=4），单步 cost = 1 - 参与单元平均相似度，
 * 目标总 cost 最小；单调约束保证对子顺序一致。
 *
 * 区间映射：英文标注区间 ↔ 中文选区。有词级对齐时按词级精确区间（划中文几个字 →
 * 英文精确词区间）；词级缺失或未命中时回退句级——句对本身是整句边界，映射天然
 * 句吸附（划一半中文也映射到整个英文句）；无任何覆盖时返回 null，调用方静默降级。
 *
 * 公式归一：stored 文本（md 源文，保留 $...$）与 live 渲染 DOM（KaTeX 把公式展开成
 * MathML+HTML，token 数与源文不等）之间的坐标换算，先把两侧各归一成"数学段 = 1 个
 * 占位符"的文本（normalizeMathText / normalizeLiveElement），token 序列一致后再走
 * 词 token 下标对应（mapOffsetsMathAware），归一坐标经 normalizeMathOffset /
 * denormalizeMathOffset 与原坐标互算。无公式时归一为恒等映射。
 */

import { segmentSentences } from "./paper-sentences";

/** 一对句级对齐（src 句组 ↔ tgt 句组，偏移为字符数，半开区间 [s, e)） */
export interface PaperAlignPair {
  /** 源文（英文）句组起点在块 textContent 内的偏移 */
  ss: number;
  /** 源文句组终点偏移（不含） */
  se: number;
  /** 译文（中文）句组起点在译文文本内的偏移 */
  ts: number;
  /** 译文句组终点偏移（不含） */
  te: number;
  /** 低置信句对（平均相似度低于阈值），UI 可降级 */
  low?: boolean;
}

/** DP 产出的对子（句/词下标形式；service 负责换算成字符偏移） */
export interface DpSentencePair {
  /** 源侧起始单元（句/词）下标 */
  si: number;
  /** 源侧单元数（句级 1-2，词级 1-4） */
  srcCount: number;
  /** 目标侧起始单元下标 */
  ti: number;
  /** 目标侧单元数（同 srcCount 范围） */
  tgtCount: number;
  /** 参与单元的平均相似度（越低越不可信） */
  score: number;
}

/** DP 产出的词对：与句对同一结构（同一 DP 核心，仅 maxGroup 不同） */
export type DpWordPair = DpSentencePair;

/** 词级 DP 的组大小上限：(1,k)/(k,1) 移动的 k 上限（覆盖一词多字/一缩多词） */
export const WORD_ALIGN_MAX_GROUP = 4;

interface DpCell {
  cost: number;
  /** 到达本格的移动：源侧消耗单元数 × 目标侧消耗单元数（backtrack 用） */
  move: { src: number; tgt: number } | null;
}

/**
 * 单调 DP 对齐核心：sim[i][j] 为源单元 i 与目标单元 j 的余弦相似度。
 * 每单元必须恰好属于一个对子（翻译场景两侧文本完备），对子沿文档顺序单调。
 * 移动允许 (1,1)/(1,k)/(k,1)（k ≤ maxGroup），单步 cost = 1 - 参与单元平均相似度。
 * 任一侧为空时无单元可对，返回空表；两侧单元数比超过 maxGroup 时无法全覆盖
 * （每步两侧各消耗 ≥1），同样返回空表——调用方按"无对齐"降级（句级回退）。
 *
 * 成本按组大小缩放：cost 乘以移动消耗的单元数均值 (src+tgt)/2，即按"每单元平均成本"
 * 比较。不缩放时（cost=1-avgSim）每步基线恒为 1，合并移动一步顶两步天然省基线——
 * DP 会系统性向"最大合并"漂移，与相似度信号脱节：
 * - 句级：跨语言句向量区分度中等（0.6~0.8）时，正确 1:1 路径的相似度优势补不齐少走
 *   几步省下的基线，乱并句（真实案例：7 句段 5 步错路 1.805 < 7 步正确路 1.900）；
 * - 词级：词向量有真实信号（stable→稳 0.68 / worth→值 0.77 均为全行最高），但旧成本
 *   下整句配成 "(4词)↔(1字)" 的级联错位（"stable structures"↔"根"）。缩放后信号
 *   主导：stable↔稳 / structures↔定结构 / e.g↔例如。
 * 缩放后合并仍可在交叉项确实差时胜出（句级正当合译/拆译、词级一词多字、极端数比），
 * 只是不再享有基线折扣。
 */
function alignDP(sim: number[][], maxGroup: number): DpSentencePair[] {
  const n = sim.length;
  const m = sim[0]?.length ?? 0;
  if (n === 0 || m === 0) return [];

  const cells: DpCell[][] = Array.from({ length: n + 1 }, () =>
    Array.from({ length: m + 1 }, () => ({ cost: Number.POSITIVE_INFINITY, move: null as DpCell["move"] })),
  );
  cells[0][0] = { cost: 0, move: null };

  /** (src,tgt) 移动的参与单元平均相似度 */
  const groupScore = (i: number, j: number, src: number, tgt: number) => {
    let sum = 0;
    for (let a = i; a < i + src; a++) {
      for (let b = j; b < j + tgt; b++) sum += sim[a][b];
    }
    return sum / (src * tgt);
  };

  const relax = (i: number, j: number, src: number, tgt: number) => {
    const weight = (src + tgt) / 2; // 组大小缩放：按每单元平均成本比较（消除少步基线折扣）
    const cost = cells[i][j].cost + (1 - groupScore(i, j, src, tgt)) * weight;
    const target = cells[i + src][j + tgt];
    if (cost < target.cost) {
      target.cost = cost;
      target.move = { src, tgt };
    }
  };

  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      if (!Number.isFinite(cells[i][j].cost)) continue;
      for (let src = 1; src <= Math.min(maxGroup, n - i); src++) {
        for (let tgt = 1; tgt <= Math.min(maxGroup, m - j); tgt++) {
          if (src > 1 && tgt > 1) continue; // 只允许 (1,1)/(1,k)/(k,1)
          relax(i, j, src, tgt);
        }
      }
    }
  }

  // backtrack：从 (n, m) 沿 move 指针回到 (0, 0)
  const pairs: DpSentencePair[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const move = cells[i][j].move;
    if (!move) break; // 不可达（理论上不会发生：1×1 步恒可走到终点）
    const si = i - move.src;
    const ti = j - move.tgt;
    pairs.unshift({ si, srcCount: move.src, ti, tgtCount: move.tgt, score: groupScore(si, ti, move.src, move.tgt) });
    i = si;
    j = ti;
  }
  return pairs;
}

/** 句级对齐：等价于 maxGroup=2 的 DP（移动 (1,1)/(2,1)/(1,2)）；成本按组大小缩放（见 alignDP） */
export function alignSentenceDP(sim: number[][]): DpSentencePair[] {
  return alignDP(sim, 2);
}

/** 词级对齐：maxGroup ≤ 4（默认 WORD_ALIGN_MAX_GROUP），覆盖一词多字/一缩多词；成本同样按组大小缩放 */
export function alignWordDP(sim: number[][], maxGroup: number = WORD_ALIGN_MAX_GROUP): DpWordPair[] {
  return alignDP(sim, maxGroup);
}

// ─── T3 分词（英文按词 / 中文按单字） ───

/** 词 token 的字符偏移（半开区间 [start, end)，与输入文本同坐标系） */
export interface WordToken {
  start: number;
  end: number;
}

/** 拉丁/数字词（内部允许 '’_.- 连接：don't / state-of-the-art / e.g / 2.5）或单个 CJK 字 */
const WORD_TOKEN_RE = /[A-Za-z0-9]+(?:['’_.-][A-Za-z0-9]+)*|[㐀-䶿一-鿿豈-﫿]/g;

/**
 * 分词（纯函数）：英文按单词、中文按单字（无 jieba 依赖；单字 + DP 合并移动天然支持"词"）。
 * 标点/空白/数学符号不成 token——它们不参与对齐，映射时由相邻 token 区间夹出。
 */
export function tokenizeWords(text: string): WordToken[] {
  const tokens: WordToken[] = [];
  for (const match of text.matchAll(WORD_TOKEN_RE)) {
    tokens.push({ start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

/**
 * 经词 token 下标对应换算区间坐标（live 渲染文本 ↔ stored 译本互算）。
 * 两侧 token 序列等长时（oneLine 折叠/markdown 语法渲染只动空白与语法符），
 * [s,e) 命中的 A 侧 token 下标映射为 B 侧对应 token 的最小覆盖区间；
 * 不等长（KaTeX 重排/链接渲染增减 token）或无 token 命中返回 null（调用方降级句级）。
 */
export function mapOffsetsViaTokens(
  aText: string,
  bText: string,
  s: number,
  e: number,
): { start: number; end: number } | null {
  if (s >= e) return null;
  const aTokens = tokenizeWords(aText);
  const bTokens = tokenizeWords(bText);
  if (aTokens.length === 0 || aTokens.length !== bTokens.length) return null;
  let first = -1;
  let last = -1;
  for (let i = 0; i < aTokens.length; i++) {
    const token = aTokens[i];
    if (token.end <= s || token.start >= e) continue;
    if (first === -1) first = i;
    last = i;
  }
  if (first === -1) return null;
  return { start: bTokens[first].start, end: bTokens[last].end };
}

// ─── 公式感知的坐标归一（stored md 源文 ↔ live KaTeX 渲染 DOM） ───

/**
 * 公式归一占位符（Unicode 私用区）：每个 $...$ / $$...$$ 数学段或 .katex 元素在归一文本中
 * 贡献恰好 1 个占位符。占位符不是词 token（不参与对齐），归一后两侧 token 序列一致，
 * mapOffsetsViaTokens 类下标对应法即可用于含公式块的坐标换算。
 */
export const MATH_PLACEHOLDER = String.fromCodePoint(0xe000);

/** 一段被归一的数学段在两种坐标系中的位置（原坐标半开区间 [origStart, origEnd)，归一坐标长度恒为 1） */
export interface MathNormSpan {
  /** 原文本（stored md 源文 / live textContent）中数学段起点 */
  origStart: number;
  /** 原文本中数学段终点（不含） */
  origEnd: number;
  /** 归一文本中占位符位置 */
  normStart: number;
}

/** 归一结果：归一文本 + 各数学段的坐标对照（spans 按文档顺序递增） */
export interface MathNormalized {
  /** 归一文本（数学段各替换为 1 个 MATH_PLACEHOLDER） */
  text: string;
  spans: MathNormSpan[];
  /** 归一前的原始文本（normalizeLiveElement 为排除子树后的等效 textContent；normalizeMathText 即入参） */
  raw: string;
}

/** 行内 $...$ 与行间 $$...$$ 数学段（$$ 优先匹配；单 $ 段不跨行、不含 $） */
export const MATH_SEGMENT_RE = /\$\$[\s\S]+?\$\$|\$[^\n$]+?\$/g;

/**
 * md 源文/stored 译文的公式归一（纯函数）：$$...$$ 与 $...$ 各替换为 1 个占位符。
 * 无公式时 text === raw 且 spans 为空（恒等映射，调用方行为零变化）。
 * 已知取舍："$5 and $10" 这类货币写法会被误判为数学段——KaTeX auto-render 同样会渲染它，
 * 两侧同法归一保持一致；remark-math 侧（闭合 $ 后跟数字不算数学）不一致时仅退回既有降级链。
 */
export function normalizeMathText(text: string): MathNormalized {
  const spans: MathNormSpan[] = [];
  let out = "";
  let last = 0;
  for (const match of text.matchAll(MATH_SEGMENT_RE)) {
    const start = match.index;
    const end = start + match[0].length;
    out += text.slice(last, start);
    spans.push({ origStart: start, origEnd: end, normStart: out.length });
    out += MATH_PLACEHOLDER;
    last = end;
  }
  out += text.slice(last);
  return { text: out, spans, raw: text };
}

/**
 * live 渲染元素的公式归一：遍历子节点，文本节点原样贡献，.katex / .katex-error 元素
 * （rehype-katex / KaTeX auto-render 产物；.katex-display 包装递归到内层 .katex）贡献 1 个
 * 占位符，其余元素递归。raw 为等效 textContent（坐标与 textContent 一致）。
 * excludeSelector（如对照模式的 [data-translation]）命中的子树整体跳过——li/td/th 块内嵌的
 * 译文 div 不计入英文侧文本（译文追加在块尾，英文部分是前缀，两坐标系对英文区间一致）。
 * 只用传入元素的 DOM 接口（childNodes/nodeType/classList），不依赖 document 等全局。
 */
export function normalizeLiveElement(el: Element, excludeSelector?: string): MathNormalized {
  const spans: MathNormSpan[] = [];
  let out = "";
  let raw = "";
  const walk = (node: Element) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        // TEXT_NODE（不用 Node 全局，保持模块无 DOM 依赖）
        const data = (child as Text).data;
        out += data;
        raw += data;
      } else if (child.nodeType === 1) {
        // ELEMENT_NODE
        const cel = child as Element;
        if (excludeSelector && cel.matches(excludeSelector)) continue;
        if (cel.classList.contains("katex") || cel.classList.contains("katex-error")) {
          const text = cel.textContent ?? "";
          spans.push({ origStart: raw.length, origEnd: raw.length + text.length, normStart: out.length });
          out += MATH_PLACEHOLDER;
          raw += text;
        } else {
          walk(cel);
        }
      }
    }
  };
  walk(el);
  return { text: out, spans, raw };
}

/** 原坐标 → 归一坐标（落在数学段内部时夹到该段占位符位置；数学段之后的偏移按累计长度差回缩） */
export function normalizeMathOffset(norm: MathNormalized, offset: number): number {
  let n = offset;
  for (const span of norm.spans) {
    if (offset <= span.origStart) break;
    if (offset < span.origEnd) return span.normStart;
    n -= span.origEnd - span.origStart - 1;
  }
  return n;
}

/** 归一坐标 → 原坐标（输入为词边界，不会落在占位符上；每个前方数学段补偿其原长与占位符之差） */
export function denormalizeMathOffset(norm: MathNormalized, offset: number): number {
  let orig = offset;
  for (const span of norm.spans) {
    if (offset <= span.normStart) break;
    orig += span.origEnd - span.origStart - 1;
  }
  return orig;
}

/**
 * 公式感知的区间换算：A 侧原坐标 [s, e) → B 侧原坐标。
 * 两侧各自归一（数学段 → 占位符）后 token 序列一致，走词 token 下标对应；
 * 命中区间的归一坐标再换算回 B 侧原坐标。无公式时退化为 mapOffsetsViaTokens（恒等语义）。
 * token 数不等（一侧公式未渲染/链接重排）或无 token 命中返回 null（调用方走既有降级链）。
 */
export function mapOffsetsMathAware(
  a: MathNormalized,
  b: MathNormalized,
  s: number,
  e: number,
): { start: number; end: number } | null {
  const ns = normalizeMathOffset(a, s);
  const ne = normalizeMathOffset(a, e);
  if (ns >= ne) return null;
  const mapped = mapOffsetsViaTokens(a.text, b.text, ns, ne);
  if (!mapped) return null;
  return { start: denormalizeMathOffset(b, mapped.start), end: denormalizeMathOffset(b, mapped.end) };
}

/**
 * md 源文坐标 → live 渲染坐标（源文侧区间定位的共用换算）。
 * 两侧 raw 一致（无公式/未渲染差异）恒等返回；否则公式归一 + 词 token 下标对应；
 * 失败退化句索引对应（ss/se 精确命中源文句边界且两侧句数一致）；都失败返回 null。
 */
export function mapSourceOffsetsToLive(
  normSrc: MathNormalized,
  normLive: MathNormalized,
  ss: number,
  se: number,
): { start: number; end: number } | null {
  if (ss >= se) return null;
  if (normSrc.raw === normLive.raw) return { start: ss, end: se };
  const viaTokens = mapOffsetsMathAware(normSrc, normLive, ss, se);
  if (viaTokens) return viaTokens;
  const srcSpans = segmentSentences(normSrc.raw);
  const liveSpans = segmentSentences(normLive.raw);
  const si = srcSpans.findIndex((sp) => sp.start === ss);
  const ei = srcSpans.findIndex((sp) => sp.end === se);
  if (si !== -1 && ei !== -1 && srcSpans.length === liveSpans.length) {
    return { start: liveSpans[si].start, end: liveSpans[ei].end };
  }
  return null;
}

/**
 * 句级 align 中查找覆盖 [s, e) 的句对（hover 联动用）：优先边界精确相等（句对边界即同一切句器
 * 产物）；退化为包含（2-1/1-2 句组：hover 组内一句，句组区间天然包含它）；再退化为重叠最大的
 * 句对且须覆盖区间过半——两侧切句漂移导致区间跨界时，避免"首个相交"把相邻句对误并进来。
 */
function findAlignPairCore(
  align: PaperAlignPair[],
  s: number,
  e: number,
  pick: (pair: PaperAlignPair) => [number, number],
): PaperAlignPair | null {
  let containing: PaperAlignPair | null = null;
  let best: PaperAlignPair | null = null;
  let bestOverlap = 0;
  for (const pair of align) {
    const [ps, pe] = pick(pair);
    if (ps === s && pe === e) return pair;
    if (!containing && ps <= s && pe >= e) containing = pair;
    const overlap = Math.min(pe, e) - Math.max(ps, s);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = pair;
    }
  }
  return containing ?? (best && bestOverlap * 2 > e - s ? best : null);
}

/** 按源侧（英文）区间查找句对（见 findAlignPairCore） */
export function findAlignPairBySrc(align: PaperAlignPair[], ss: number, se: number): PaperAlignPair | null {
  return findAlignPairCore(align, ss, se, (pair) => [pair.ss, pair.se]);
}

/** 按译文侧（中文）区间查找句对（见 findAlignPairCore） */
export function findAlignPairByTgt(align: PaperAlignPair[], ts: number, te: number): PaperAlignPair | null {
  return findAlignPairCore(align, ts, te, (pair) => [pair.ts, pair.te]);
}

/** 对齐表按源侧起点排序的副本（映射查找的前提；service 产出已排序，这里防御性复制） */
function sortedBySrc(align: PaperAlignPair[]): PaperAlignPair[] {
  return [...align].sort((a, b) => a.ss - b.ss);
}

export interface TgtRange {
  ts: number;
  te: number;
}

export interface SrcRange {
  ss: number;
  se: number;
}

/** 命中（区间相交）对子的 tgt 区间并：相交/相接的合并为连续段；无覆盖返回 null */
function collectTgtRanges(pairs: PaperAlignPair[], s: number, e: number): TgtRange[] | null {
  const merged: TgtRange[] = [];
  for (const pair of sortedBySrc(pairs)) {
    if (pair.se <= s) continue;
    if (pair.ss >= e) break;
    const last = merged[merged.length - 1];
    if (last && pair.ts <= last.te) {
      last.te = Math.max(last.te, pair.te);
    } else {
      merged.push({ ts: pair.ts, te: pair.te });
    }
  }
  return merged.length > 0 ? merged : null;
}

/** 命中（区间相交）对子的 src 区间并集（最小覆盖区间）；无覆盖返回 null */
function collectSrcRange(pairs: PaperAlignPair[], t1: number, t2: number): SrcRange | null {
  let ss = -1;
  let se = -1;
  for (const pair of sortedBySrc(pairs)) {
    if (pair.te <= t1 || pair.ts >= t2) continue;
    if (ss === -1) ss = pair.ss;
    se = Math.max(se, pair.se);
  }
  return ss === -1 ? null : { ss, se };
}

/**
 * 英文块内区间 [s, e) → 中文区间列表。
 * 有词级对齐（alignW 非空）时优先词级精确区间（英文标注 → 中文精确词区间渲染）；
 * 词级未命中（如选中区间只含标点）或无 alignW 时回退句级（句吸附整句并集）。
 * 无任何覆盖返回 null。
 */
export function mapSrcRangeToTgt(
  align: PaperAlignPair[],
  s: number,
  e: number,
  alignW?: PaperAlignPair[] | null,
): TgtRange[] | null {
  if (s >= e) return null;
  if (alignW && alignW.length > 0) {
    const wordMapped = collectTgtRanges(alignW, s, e);
    if (wordMapped) return wordMapped;
  }
  return collectTgtRanges(align, s, e);
}

/**
 * 中文区间 [t1, t2) → 英文区间（命中对子的 src 区间并集，即最小覆盖区间）。
 * 有词级对齐（alignW 非空）时优先词级精确区间（划中文几个字 → 英文精确词区间）；
 * 词级未命中或无 alignW 时回退句级（句吸附：划一半中文也映射到整个英文句）。
 * 无任何覆盖返回 null。
 */
export function mapTgtRangeToSrc(
  align: PaperAlignPair[],
  t1: number,
  t2: number,
  alignW?: PaperAlignPair[] | null,
): SrcRange | null {
  if (t1 >= t2) return null;
  if (alignW && alignW.length > 0) {
    const wordMapped = collectSrcRange(alignW, t1, t2);
    if (wordMapped) return wordMapped;
  }
  return collectSrcRange(align, t1, t2);
}
