/**
 * 流式输出动效揭示层（2026-10-10 施工；选型 demos/streaming-effects-preview.html v3 裁定）。
 *
 * 架构：把"到达"与"显示"解耦——显示文本 = text.slice(0, revealPos)，revealPos 由 rAF 按效果驱动；
 * 对 React 管理的 markdown DOM 只读不写（论文侧教训：客户端改 React DOM 会与重渲染冲突损坏内容，
 * paper-blocks.ts renderTranslationHtml 注释同旨）——视觉全部走不改 DOM 的通道：
 * mist 用 CSS Custom Highlight API 给字符区间挂样式；type 用自管 overlay 光标。
 *
 * 效果（settings.streamReveal，默认 baseline = 现状到达即渲染，用户裁定）：
 * - baseline：直通，零开销（不挂 rAF）；
 * - mist 雾面-水流（demo fxMist 的逐字语义）：chase 缓冲（tau=120ms）；雾边 = 前沿 10 字 smoothstep
 *   透明度 + 模糊连续梯度，到齐后匀速扫尾；水痕 = 字落定后着主题色，前 45% 保持满浓度、之后 smoothstep
 *   褪回正文色（总 1.6s）。所有变化逐帧连续，无瞬时消失；
 * - type 复古打字机：30–56ms/字 + 抖动、句读停顿；主题色光标，结束 0.5s 后熄灭；
 * - scr 密文解码：48 字/s settle + 12 字 scramble 窗口（75ms/帧）；markdown 符号字符不扰码。
 *
 * mist 实现要点：
 * 1) demo 里每字一个 span，应用内正文是 react-markdown 产物不能包 span，故用 Highlight API：按
 *    (雾层级 f, 水痕层级 w) 预注册少量高亮组（CSS 里 color 带透明度、text-shadow 模拟模糊）。
 *    绘制按 30fps 节流、React 提交立即补绘，只有量化分组变化时才重建 Range。
 * 2) DOM 预铺：显示文本比前沿多铺 MIST_AHEAD 个字（字符层级 f=0 全透明），React 提交频率因此从每帧降到
 *    百毫秒级，而逐帧渐变不依赖 React；预铺还让换行提前确定，前沿处不再因半个单词折行而跳动。
 * 3) 字符对应：动画使用 React 渲染后的 DOM 字素坐标，Markdown 源码只决定进度比例；Intl.Segmenter
 *    统一切片与 Range 边界，索引覆盖全部非空白字素，避免长文截尾、链接语法错位和 emoji 断字。
 * 4) 生命周期：追平后暂停与正式结束都扫尾、褪干并停止 rAF/observer；新文本到达再唤醒。
 *    不支持 Highlight API、注册/绘制异常或持续慢帧时降级为 chase 缓冲，正文始终完整。
 * 词组浮入因需要逐词持久元素（与每 tick 重渲染冲突）不在应用内提供，demo 专属。
 */

import { useAppSettingsStore } from "@/store/app-settings-store";
import type { StreamRevealType } from "@/types/settings";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

const TAU = 120;
const DRY = 1600;
const DRY_HOLD = 0.45;
const TYPE_MIN = 30;
const TYPE_JITTER = 26;
const SCR_RATE = 48;
const SCR_WINDOW = 12;
const SCR_FLIP = 75;
/** 雾边宽度（字）：前沿向内这么多字上做透明/模糊梯度 */
const MIST_N = 10;
/** 前沿最强模糊的高斯标准差（px）；text-shadow 模糊半径取其 2 倍 */
const MIST_SIGMA = 4.5;
/** DOM 预铺字数（不可见，等前沿到达才渐显）与补铺触发余量 */
const MIST_AHEAD = 28;
const MIST_CUSHION = 12;
/** 水痕最大着色浓度（%） */
const WET_MAX = 85;
/** 雾层级 / 水痕层级量化档数 */
const HL_F = 9;
const HL_W = 8;
/** 乱码字符池：不含任何 markdown/公式语法字符（# $ * _ > - + = < 等落在行首或成对时会让结构瞬时跳变） */
const SCR_POOL = "01アイウエオカキクケコサシスセソタチツテトナニヌネノabcxyzXYZ/·";
/** markdown 语法字符：scramble 时原样保留，避免瞬时破坏结构 */
const MD_SIGILS = new Set([
  "#",
  "*",
  "_",
  ">",
  "`",
  "[",
  "]",
  "$",
  "\\",
  "|",
  "~",
  "-",
  "+",
  "!",
  "(",
  ")",
  ".",
  " ",
  "\n",
  "\t",
]);
/** 积压加速：待揭示字数每多 N 字，打字机/解码速度额外 +1 倍（模型出字远快于逐字揭示，不加速则流结束后要等很久） */
const BACKLOG_BOOST_CHARS = 90;

interface CrossEntry {
  /** DOM 字素下标区间 [from, end) 在 t 时刻被前沿越过（水痕年龄起点） */
  from: number;
  end: number;
  t: number;
}

interface RevealState {
  text: string;
  disp: number;
  shown: number;
  acc: number;
  nextDelay: number;
  settled: number;
  lastFlip: number;
  lastSet: number;
  lastReceiveAt: number;
  lastStepAt: number;
  doneAt: number;
  sweep: number;
  lastDisplay: string;
  overlays: Map<string, HTMLElement>;
  accent: string;
  /** 本轮揭示已收尾（正式结束或追平后暂停）：叠层/高亮/observer 已清，rAF 停摆，新文本到达时由 kick 唤醒 */
  finished: boolean;
  // ── mist ──
  edge: number;
  cross: CrossEntry[];
  crossEnd: number;
  lastCrossT: number;
  lastPaintAt: number;
  slowFrames: number;
  fg: string;
  tailNodes: Text[];
  tailOffs: number[];
  tailEnds: number[];
  tailPos: number[];
  domLength: number;
  sourceLength: number;
  indexDirty: boolean;
  paintSignature: string;
  owned: { name: string; range: Range }[];
  /** 本实例持有高亮注册的引用（见 acquireHighlights） */
  hlHeld: boolean;
  hlFailed: boolean;
}

function freshState(): RevealState {
  return {
    finished: false,
    text: "",
    disp: 0,
    shown: 0,
    acc: 0,
    nextDelay: 260,
    settled: 0,
    lastFlip: 0,
    lastSet: 0,
    lastReceiveAt: 0,
    lastStepAt: 0,
    doneAt: 0,
    sweep: 0,
    lastDisplay: "",
    overlays: new Map(),
    accent: "",
    edge: 0,
    cross: [],
    crossEnd: 0,
    lastCrossT: 0,
    lastPaintAt: 0,
    slowFrames: 0,
    fg: "",
    tailNodes: [],
    tailOffs: [],
    tailEnds: [],
    tailPos: [],
    domLength: 0,
    sourceLength: 0,
    indexDirty: true,
    paintSignature: "",
    owned: [],
    hlHeld: false,
    hlFailed: false,
  };
}

/** 容器内文本节点（文档序，排除 overlay 子树） */
function textNodesOf(wrap: HTMLElement): Text[] {
  const out: Text[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      out.push(node as Text);
      return;
    }
    if (node.nodeType === 1) {
      if ((node as Element).hasAttribute("data-rv-overlay")) return;
      for (const child of Array.from(node.childNodes)) walk(child);
    }
  };
  walk(wrap);
  return out;
}

/** DOM 中倒数第 back 个非空白字符的视口 rect（back=0 即末字符；只读 Range 测量）。
 *  块间换行文本节点、折叠空白等零高度 rect 自动跳过取前一字符 */
function tailCharRect(wrap: HTMLElement, back = 0): DOMRect | null {
  const nodes = textNodesOf(wrap);
  let skip = back;
  for (let n = nodes.length - 1; n >= 0; n--) {
    const data = nodes[n].data;
    const boundaries = graphemeOffsets(data);
    for (let i = boundaries.length - 2; i >= 0; i--) {
      const from = boundaries[i];
      const end = boundaries[i + 1];
      if (!/\S/.test(data.slice(from, end))) continue;
      if (skip-- > 0) continue;
      const range = document.createRange();
      range.setStart(nodes[n], from);
      range.setEnd(nodes[n], end);
      const rect = range.getBoundingClientRect();
      if (rect.height > 0) return rect;
    }
  }
  return null;
}

function accentColorOf(): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue("--primary").trim();
  return v || "#77bbee";
}

function ensureOverlay(wrap: HTMLElement, s: RevealState, key: string, className: string): HTMLElement {
  const existing = s.overlays.get(key);
  if (existing?.isConnected) return existing;
  const el = document.createElement("div");
  el.className = className;
  el.setAttribute("data-rv-overlay", "");
  wrap.appendChild(el);
  s.overlays.set(key, el);
  return el;
}

function clearOverlays(s: RevealState): void {
  for (const el of s.overlays.values()) el.remove();
  s.overlays.clear();
}

function scrambleTail(text: string): string {
  let out = "";
  for (const ch of text) {
    out += MD_SIGILS.has(ch) ? ch : SCR_POOL[(Math.random() * SCR_POOL.length) | 0];
  }
  return out;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

const graphemeCache = new Map<string, number[]>();

function graphemeOffsets(text: string): number[] {
  const cached = graphemeCache.get(text);
  if (cached) return cached;
  const offsets: number[] = [];
  if (typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    for (const item of segmenter.segment(text)) offsets.push(item.index);
  } else {
    let index = 0;
    for (const char of text) {
      offsets.push(index);
      index += char.length;
    }
  }
  offsets.push(text.length);
  if (graphemeCache.size >= 24) {
    const oldest = graphemeCache.keys().next().value;
    if (oldest !== undefined) graphemeCache.delete(oldest);
  }
  graphemeCache.set(text, offsets);
  return offsets;
}

/** 截断下标落在完整字素边界，避免代理对、ZWJ、国旗和组合附加符号被切开。 */
function safeIndex(text: string, n: number): number {
  if (n <= 0 || n >= text.length) return n;
  const offsets = graphemeOffsets(text);
  let low = 0;
  let high = offsets.length - 1;
  let best = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (offsets[mid] <= n) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return offsets[best];
}

// ─── mist：CSS Custom Highlight API 逐字渐变 ───

function highlightsSupported(): boolean {
  return (
    typeof CSS !== "undefined" &&
    CSS.highlights != null &&
    typeof CSS.highlights.set === "function" &&
    typeof CSS.highlights.delete === "function" &&
    typeof Highlight !== "undefined"
  );
}

const hlGroups = new Map<string, Highlight>();
let hlStyleEl: HTMLStyleElement | null = null;
let hlRefs = 0;

/** 前沿层水痕着色分三档（%）：前沿字都很"新"，通常恒为满浓度，细分无意义；仅流停顿时才会变淡 */
const FRONT_TINTS = [0, 42, WET_MAX];
const frontName = (f: number, c: number) => `rv-mf${f}-${c}`;
const wetName = (w: number) => `rv-mw${w}`;

function mistRule(name: string, f: number, tint: number): string {
  const e = f / (HL_F - 1);
  const g = smooth(Math.max(0, Math.min(1, (e - 0.3) / 0.7)));
  const glyphA = Math.round(e * g * 100);
  const shadowA = Math.min(100, Math.round(e * (1 - g) * 150));
  const blur = ((1 - e) * 2 * MIST_SIGMA).toFixed(2);
  const base = tint > 0 ? `color-mix(in oklab, var(--rv-accent) ${tint}%, var(--rv-fg))` : "var(--rv-fg)";
  let color = base;
  let shadow = "none";
  if (f === 0) {
    color = "transparent";
  } else if (f < HL_F - 1) {
    color = `color-mix(in oklab, ${base} ${glyphA}%, transparent)`;
    if (shadowA > 0) shadow = `0 0 ${blur}px color-mix(in oklab, ${base} ${shadowA}%, transparent)`;
  }
  return `::highlight(${name}){color:${color};text-shadow:${shadow}}`;
}

/**
 * 注册高亮组 + 样式：雾层级 f（0 全透明 … HL_F-2 近乎清晰）× 水痕三档，另有 HL_W-1 个"无雾仅着色"组。
 * 雾层字形/阴影交叉淡化：e 低时字形透明、由 text-shadow 的模糊副本呈现，e 升高时字形淡入、阴影褪去，
 * 近似 demo 的 opacity+filter:blur 组合。颜色取自元素上的 --rv-accent / --rv-fg（hook 在 wrap 上设置）。
 */
function buildMistHighlights(): void {
  const rules: string[] = [];
  const add = (name: string, rule: string) => {
    rules.push(rule);
    if (!hlGroups.has(name)) {
      const hl = new Highlight();
      hlGroups.set(name, hl);
      CSS.highlights.set(name, hl);
    }
  };
  add(frontName(0, 0), mistRule(frontName(0, 0), 0, 0));
  for (let f = 1; f < HL_F - 1; f++) {
    for (let c = 0; c < FRONT_TINTS.length; c++) add(frontName(f, c), mistRule(frontName(f, c), f, FRONT_TINTS[c]));
  }
  for (let w = 1; w < HL_W; w++)
    add(wetName(w), mistRule(wetName(w), HL_F - 1, Math.round((w / (HL_W - 1)) * WET_MAX)));
  hlStyleEl = document.createElement("style");
  hlStyleEl.setAttribute("data-rv-highlights", "");
  hlStyleEl.textContent = rules.join("\n");
  document.head.appendChild(hlStyleEl);
}

function teardownMistHighlights(): void {
  if (typeof CSS !== "undefined" && CSS.highlights && typeof CSS.highlights.delete === "function") {
    for (const name of hlGroups.keys()) CSS.highlights.delete(name);
  }
  hlGroups.clear();
  hlStyleEl?.remove();
  hlStyleEl = null;
}

/**
 * 引用计数式注册：仅当有消息正在做 mist 揭示时才把高亮名注册进 CSS.highlights。
 * 实测（7800 元素的页面）：每个已注册的 ::highlight 名都会让浏览器在每次样式重算时对每个元素逐名解析，
 * 110 个名常驻 → 一次整页样式重算 5.7s（主题注入/换档位/切页面层全部中招）。所以闲置时必须全部注销。
 */
function acquireHighlights(s: RevealState): void {
  if (s.hlHeld) return;
  if (hlRefs === 0) {
    try {
      buildMistHighlights();
    } catch (error) {
      teardownMistHighlights();
      throw error;
    }
  }
  hlRefs += 1;
  s.hlHeld = true;
}

function releaseHighlights(s: RevealState): void {
  hlClear(s);
  if (!s.hlHeld) return;
  s.hlHeld = false;
  hlRefs = Math.max(0, hlRefs - 1);
  if (hlRefs === 0) teardownMistHighlights();
}

function clearMistRuntime(wrap: HTMLElement | null, s: RevealState): void {
  releaseHighlights(s);
  wrap?.style.removeProperty("--rv-accent");
  wrap?.style.removeProperty("--rv-fg");
  s.tailNodes = [];
  s.tailOffs = [];
  s.tailEnds = [];
  s.tailPos = [];
  s.domLength = 0;
  s.sourceLength = 0;
  s.cross = [];
  s.crossEnd = 0;
  s.lastCrossT = 0;
  s.indexDirty = true;
  s.accent = "";
  s.fg = "";
}

function hlClear(s: RevealState): void {
  for (const o of s.owned) hlGroups.get(o.name)?.delete(o.range);
  s.owned = [];
  s.paintSignature = "";
}

/** 取 wrap 的颜色变量：强调色 + 正文前景色（取尾部文本所在元素的计算色，prose 等会覆盖祖先色） */
function setupMistVars(wrap: HTMLElement, s: RevealState): void {
  if (!s.accent) s.accent = accentColorOf();
  wrap.style.setProperty("--rv-accent", s.accent);
  if (!s.fg) {
    const last = s.tailNodes[0]?.parentElement;
    if (last) s.fg = getComputedStyle(last).color;
  }
  if (s.fg) wrap.style.setProperty("--rv-fg", s.fg);
}

/** 索引 React 已渲染的全部 DOM 字素；动画坐标不再与 Markdown 源码下标混用。 */
function indexTail(wrap: HTMLElement, s: RevealState, display: string): void {
  const nodes: Text[] = [];
  const offs: number[] = [];
  const ends: number[] = [];
  const positions: number[] = [];
  let position = 0;
  for (const node of textNodesOf(wrap)) {
    const boundaries = graphemeOffsets(node.data);
    for (let i = 0; i + 1 < boundaries.length; i++) {
      const from = boundaries[i];
      const end = boundaries[i + 1];
      if (!/\S/.test(node.data.slice(from, end))) continue;
      nodes.push(node);
      offs.push(from);
      ends.push(end);
      positions.push(position++);
    }
  }
  s.tailNodes = nodes.reverse();
  s.tailOffs = offs.reverse();
  s.tailEnds = ends.reverse();
  s.tailPos = positions.reverse();
  s.domLength = position;
  s.sourceLength = display.length;
  if (Number.isFinite(s.crossEnd) && s.crossEnd > s.domLength) {
    s.cross = [];
    s.crossEnd = 0;
    s.lastCrossT = 0;
  }
  s.indexDirty = false;
  s.paintSignature = "";
}

/** 按当前前沿位置与各字越界时间分组；只有量化分组变化时才重建 Range。 */
function paintMist(s: RevealState, now: number): void {
  const n = Math.min(s.tailNodes.length, s.tailPos.length);
  if (n === 0) {
    hlClear(s);
    return;
  }
  if (!s.tailNodes[0].isConnected) {
    s.indexDirty = true;
    return;
  }
  s.lastPaintAt = now;
  if (s.crossEnd === Number.POSITIVE_INFINITY) s.crossEnd = s.domLength;
  const edge = s.sourceLength > 0 ? (s.edge / s.sourceLength) * s.domLength : s.domLength;
  const crossed = Math.min(s.domLength, Math.ceil(edge));
  if (crossed > s.crossEnd) {
    s.cross.push({ from: s.crossEnd, end: crossed, t: now });
    s.crossEnd = crossed;
    s.lastCrossT = now;
  }
  const runs: { key: string; start: number; end: number }[] = [];
  let ci = s.cross.length - 1;
  let runKey = "";
  let runStart = 0;
  let k = 0;
  for (; k < n; k++) {
    const j = s.tailPos[k];
    const d = edge - j;
    let f: number;
    if (d <= 0) f = 0;
    else if (d >= MIST_N) f = HL_F - 1;
    else f = Math.round(smooth(d / MIST_N) * (HL_F - 1));
    let w = 0;
    if (f > 0) {
      while (ci + 1 < s.cross.length && s.cross[ci + 1].from <= j) ci++;
      while (ci >= 0 && s.cross[ci].from > j) ci--;
      const ent = ci >= 0 && j < s.cross[ci].end ? s.cross[ci] : null;
      if (ent) {
        const t = (now - ent.t) / DRY;
        if (t < 1) {
          const dry = t < DRY_HOLD ? 0 : smooth((t - DRY_HOLD) / (1 - DRY_HOLD));
          w = Math.round((1 - dry) * (HL_W - 1));
        }
      }
    }
    let key = "";
    if (f < HL_F - 1) key = f === 0 ? frontName(0, 0) : frontName(f, w === 0 ? 0 : w <= (HL_W - 1) / 2 ? 1 : 2);
    else if (w > 0) key = wetName(w);
    if (key !== runKey) {
      if (runKey) runs.push({ key: runKey, start: runStart, end: k });
      runKey = key;
      runStart = k;
    }
    if (!key) break;
  }
  if (runKey) runs.push({ key: runKey, start: runStart, end: k });
  const signature = runs.map((run) => `${run.key}:${run.start}:${run.end}`).join("|");
  if (signature === s.paintSignature) return;
  hlClear(s);
  const doc = s.tailNodes[0].ownerDocument;
  for (const run of runs) {
    const older = run.end - 1;
    const hl = hlGroups.get(run.key);
    if (older < run.start || !hl) continue;
    const range = doc.createRange();
    range.setStart(s.tailNodes[older], s.tailOffs[older]);
    range.setEnd(s.tailNodes[run.start], s.tailEnds[run.start]);
    hl.add(range);
    s.owned.push({ name: run.key, range });
  }
  s.paintSignature = signature;
}

export function useStreamReveal(text: string, streaming: boolean, enabled = true) {
  const setting: StreamRevealType = useAppSettingsStore((s) => s.settings.streamReveal ?? "baseline");
  const effect: StreamRevealType = enabled ? setting : "baseline";
  const active = effect !== "baseline";
  const [display, setDisplay] = useState(text);
  const displayRef = useRef(display);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const stRef = useRef<RevealState>(freshState());
  const textRef = useRef(text);
  const streamingRef = useRef(streaming);
  const kickRef = useRef<(() => void) | null>(null);
  displayRef.current = display;
  textRef.current = text;
  streamingRef.current = streaming;

  // React 提交后同步重建尾部索引并重绘高亮：文本节点被 React 改写会让既有 Range 塌缩，不补绘则新字符裸奔一帧
  useLayoutEffect(() => {
    if (effect !== "mist" || !highlightsSupported()) return;
    const wrap = wrapRef.current;
    const s = stRef.current;
    if (!wrap || s.hlFailed) return;
    // 历史消息 / 已收尾的框：什么都不做（不注册高亮名、不读样式、不写 CSS 变量）
    // s.text 为空 = 初始化 effect 尚未跑过（首次挂载）：此时 shown 还是初始 0，不能据此判为"未揭示完"
    const live = streamingRef.current || (s.text !== "" && s.shown < textRef.current.length);
    if (s.finished || !live) return;
    try {
      acquireHighlights(s);
      indexTail(wrap, s, display);
      setupMistVars(wrap, s);
      paintMist(s, performance.now());
    } catch (error) {
      console.warn("[stream-reveal] Highlight 绘制失败，降级为普通揭示", error);
      s.hlFailed = true;
      clearMistRuntime(wrap, s);
    }
  }, [display, effect]);

  useEffect(() => {
    if (!active) return;
    const s = stRef.current;
    // 历史消息直接显示完整正文；流式挂载即使已收到第一批文本，也必须从揭示起点开始。
    clearOverlays(s);
    releaseHighlights(s);
    const initial = textRef.current;
    const initialPosition = streamingRef.current ? 0 : initial.length;
    Object.assign(s, freshState(), {
      overlays: s.overlays,
      hlFailed: s.hlFailed,
      text: initial,
      disp: initialPosition,
      shown: initialPosition,
      settled: initialPosition,
      lastReceiveAt: performance.now(),
      crossEnd: initialPosition ? Number.POSITIVE_INFINITY : 0,
      edge: initialPosition,
      finished: !streamingRef.current,
    });
    setDisplay(initialPosition ? initial : "");

    let domObserver: MutationObserver | null = null;
    let themeObserver: MutationObserver | null = null;
    const disconnectObservers = () => {
      domObserver?.disconnect();
      themeObserver?.disconnect();
      domObserver = null;
      themeObserver = null;
    };
    const observeMist = () => {
      const wrap = wrapRef.current;
      if (effect !== "mist" || s.hlFailed || !wrap || domObserver) return;
      domObserver = new MutationObserver(() => {
        if (!s.finished) s.indexDirty = true;
      });
      domObserver.observe(wrap, { childList: true, subtree: true, characterData: true });
      themeObserver = new MutationObserver(() => {
        if (s.finished) return;
        s.accent = accentColorOf();
        s.fg = "";
        setupMistVars(wrap, s);
        s.paintSignature = "";
      });
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "style", "data-theme"],
      });
    };

    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(250, now - last);
      last = now;
      try {
        raf = step(s, now, dt) ? 0 : requestAnimationFrame(loop);
      } catch (error) {
        console.warn("[stream-reveal] 动效帧失败，降级为完整正文", error);
        s.hlFailed = true;
        s.finished = true;
        raf = 0;
        disconnectObservers();
        clearMistRuntime(wrapRef.current, s);
        setDisplay(textRef.current);
      }
    };
    kickRef.current = () => {
      if (s.finished && !streamingRef.current && textRef.current.length <= s.shown) return;
      observeMist();
      if (raf) return;
      last = performance.now();
      raf = requestAnimationFrame(loop);
    };

    /** 返回 true = 本轮已收尾，rAF 停摆（新文本/重新流式时 kick 唤醒） */
    const step = (s: RevealState, now: number, dt: number): boolean => {
      const wrap = wrapRef.current;
      const text = textRef.current;
      const received = text.length;
      const streamingNow = streamingRef.current;
      // 新会话/重新生成：文本非旧文本前缀 → 全量复位
      if (!text.startsWith(s.text)) {
        const keep = s.overlays;
        clearOverlays(s);
        releaseHighlights(s);
        Object.assign(s, freshState(), { overlays: keep });
        setDisplay("");
      }
      if (text !== s.text) s.lastReceiveAt = now;
      s.text = text;
      if (s.finished) {
        if (!streamingNow && received <= s.shown) return true;
        s.finished = false;
      }
      if (!wrap) return false;
      if (!s.accent) s.accent = accentColorOf();
      let idle = false;

      if (effect === "mist") {
        if (!s.hlFailed) {
          s.slowFrames = dt > 64 ? s.slowFrames + 1 : 0;
          if (s.slowFrames >= 4) {
            s.hlFailed = true;
            disconnectObservers();
            clearMistRuntime(wrap, s);
          }
        } else {
          s.slowFrames = 0;
        }
        let hl = !s.hlFailed && highlightsSupported();
        if (hl) {
          try {
            acquireHighlights(s);
          } catch (error) {
            console.warn("[stream-reveal] Highlight 注册失败，降级为普通揭示", error);
            s.hlFailed = true;
            clearMistRuntime(wrap, s);
            disconnectObservers();
            hl = false;
          }
        }
        const quiet = streamingNow && now - s.lastReceiveAt >= 450;
        if (streamingNow && !quiet) s.sweep = 0;
        s.disp += (received - s.disp) * (1 - Math.exp(-dt / TAU));
        if (received - s.disp < 0.02) s.disp = received;
        let edge = s.disp;
        // 到齐或暂停追平后雾边匀速扫尾，新文本到达会重新唤醒。
        if ((!streamingNow || quiet) && received - s.disp < 0.5) {
          if (!s.sweep) s.sweep = s.disp;
          s.sweep = Math.min(received + MIST_N, s.sweep + dt * (MIST_N / 250));
          edge = Math.max(s.disp, s.sweep);
        }
        s.edge = edge;
        while (s.cross.length > 0 && now - s.cross[0].t > DRY + 300) s.cross.shift();
        // DOM 补铺：前沿逼近已铺末尾时批量补铺（预铺字符透明，等前沿到达才渐显）
        const need = hl ? Math.min(received, Math.ceil(edge) + MIST_CUSHION) : Math.min(received, Math.ceil(edge));
        if (s.shown < need && now - s.lastSet >= 33) {
          const target = hl
            ? Math.min(received, Math.ceil(edge) + MIST_AHEAD)
            : Math.min(received, Math.ceil(edge / 2) * 2);
          s.shown = target;
          s.lastSet = now;
          setDisplay(text.slice(0, safeIndex(text, target)));
        }
        if (hl && (s.indexDirty || now - s.lastPaintAt >= 32 || (s.tailNodes.length === 0 && displayRef.current))) {
          if (s.indexDirty || (s.tailNodes.length === 0 && displayRef.current)) indexTail(wrap, s, displayRef.current);
          setupMistVars(wrap, s);
          paintMist(s, now);
        }
        const ended = (!streamingNow || quiet) && s.shown >= received;
        idle = ended && edge >= received + (hl ? MIST_N : 0) && (!hl || now - s.lastCrossT >= DRY);
        if (idle) {
          disconnectObservers();
          clearMistRuntime(wrap, s);
        }
      } else if (effect === "type") {
        if (s.shown < received) {
          s.acc += dt;
          const boost = 1 + (received - s.shown) / BACKLOG_BOOST_CHARS;
          let changed = false;
          while (s.shown < received && s.acc >= s.nextDelay) {
            s.acc -= s.nextDelay;
            s.shown += 1;
            changed = true;
            const ch = text[s.shown - 1];
            let d = TYPE_MIN + Math.random() * TYPE_JITTER;
            if ("。！？；…".includes(ch)) d += 240;
            else if ("，、：,.:".includes(ch)) d += 90;
            s.nextDelay = d / boost;
            s.lastStepAt = now;
          }
          if (changed) setDisplay(text.slice(0, safeIndex(text, s.shown)));
        } else {
          s.acc = 0;
        }
        const caret = ensureOverlay(wrap, s, "caret", "rv-caret");
        caret.style.background = s.accent;
        const done = s.shown >= received && !streamingNow;
        if (done) {
          if (!s.doneAt) s.doneAt = now;
          caret.classList.remove("idle");
          if (now - s.doneAt > 500) caret.classList.add("gone");
          idle = now - s.doneAt > 1000; // 500ms 停留 + 0.45s 渐隐
        } else {
          s.doneAt = 0;
          caret.classList.remove("gone");
          caret.classList.toggle("idle", now - s.lastStepAt > 350);
        }
        const rect = tailCharRect(wrap);
        const wrapRect = wrap.getBoundingClientRect();
        if (rect) {
          caret.style.display = "block";
          caret.style.left = `${rect.right - wrapRect.left + 1}px`;
          caret.style.top = `${rect.top - wrapRect.top}px`;
          caret.style.height = `${rect.height}px`;
        } else {
          caret.style.display = "none";
        }
      } else if (effect === "scr") {
        const boost = 1 + (received - s.settled) / BACKLOG_BOOST_CHARS;
        s.settled = Math.min(received, s.settled + (SCR_RATE * boost * dt) / 1000);
        const settledFloor = Math.floor(s.settled);
        const flipping = now - s.lastFlip >= SCR_FLIP;
        if (settledFloor !== s.shown || (flipping && settledFloor < received)) {
          s.lastFlip = now;
          s.shown = settledFloor;
          const cut = safeIndex(text, settledFloor);
          const next =
            settledFloor >= received ? text : text.slice(0, cut) + scrambleTail(text.slice(cut, cut + SCR_WINDOW));
          if (next !== s.lastDisplay) {
            s.lastDisplay = next;
            setDisplay(next);
          }
        }
        idle = !streamingNow && s.shown >= received;
      }

      if (idle) s.finished = true;
      return idle;
    };

    kickRef.current?.();
    return () => {
      cancelAnimationFrame(raf);
      raf = 0;
      kickRef.current = null;
      disconnectObservers();
      clearOverlays(stRef.current);
      clearMistRuntime(wrapRef.current, stRef.current);
    };
  }, [active, effect]);

  // 新文本到达 / 流式状态翻转：唤醒已收尾停摆的 rAF
  // biome-ignore lint/correctness/useExhaustiveDependencies: text/streaming 仅作唤醒触发器
  useEffect(() => {
    kickRef.current?.();
  }, [text, streaming]);

  return { wrapRef, display: active ? display : text };
}
