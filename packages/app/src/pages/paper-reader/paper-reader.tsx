import { InlineMathText } from "@/components/markdown/inline-math-text";
import { useAppSettingsStore } from "@/store/app-settings-store";
import type { BookNote, HighlightColor, HighlightStyle } from "@/types/book";
import { save } from "@tauri-apps/plugin-dialog";
import { readFile, writeFile } from "@tauri-apps/plugin-fs";
import { openUrl } from "@tauri-apps/plugin-opener";
import katex from "katex";
import "katex/dist/katex.min.css";
import { ChevronDown, ChevronUp, Copy, Download, ImageOff, Quote, X } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { toast } from "sonner";
import {
  PAPER_CONTEXT_LENGTH,
  anchorToRanges,
  charOffsetToPoint,
  clampRangeToContainer,
  extractContext,
  findBlockForNode,
  findQuoteRange,
  findQuoteRangeExcluding,
  listBlocks,
  offsetFromBlockStart,
  parseAnchor,
  rangeToAnchor,
  serializeAnchor,
} from "./paper-anchors";
import {
  PAPER_ANNO_POPUP_HEIGHT,
  PAPER_ANNO_POPUP_WIDTH,
  PAPER_ANNO_POPUP_WIDTH_COMPACT,
  PaperAnnotationPopup,
} from "./paper-annotation-popup";
import type { PaperBlock, PaperViewMode } from "./paper-blocks";
import {
  type PaperAlignPair,
  type SrcRange,
  findAlignPairBySrc,
  findAlignPairByTgt,
  mapOffsetsMathAware,
  mapSourceOffsetsToLive,
  mapSrcRangeToTgt,
  mapTgtRangeToSrc,
  normalizeLiveElement,
  normalizeMathText,
  tokenizeWords,
} from "./paper-cross-anchor";
import { type PaperHighlightLocation, locateQuoteInPaper } from "./paper-highlight-locator";
import { type HoverRect, mergeOverlappingRects } from "./paper-hover-rects";
import { type PaperMetadata, normalizeAuthors, parsePaperMarkdown } from "./paper-metadata";
import { type SentenceSpan, findSentenceAt, segmentSentences, snapRangeToSentences } from "./paper-sentences";
import { rehypeDelTilde } from "./rehype-del-tilde";
import { renderMathInRawTables } from "./render-math-in-tables";

export interface TocItem {
  id: string;
  text: string;
  level: number;
}

/** 暴露给父组件（顶栏 TOC 下拉 / C2 AI 标亮 / 图表速跳）的容器内定位能力 */
export interface PaperReaderHandle {
  /** 滚动到标题（id = rehype-slug 锚点）；未命中返回 false（笔记位置跳转的降级链用） */
  scrollToHeading: (id: string) => boolean;
  /** C2 AI 标亮：批量 quote → 锚点换算（基于当前渲染 DOM；容器未就绪时全部返回 null） */
  locateQuotes: (quotes: string[]) => (PaperHighlightLocation | null)[];
  /** 图表速跳：图注/表注 quote 全文查找 → 滚动定位 + 闪烁强调；未命中返回 false */
  scrollToQuote: (quote: string) => boolean;
  /** 图表速跳：按图片相对路径（data-paper-src）定位；译文/对照模式图片始终在 DOM，比 quote 可靠 */
  scrollToImage: (src: string) => boolean;
}

/** 新建标注的载荷（paper-reader-view 补上 bookId/type 后落 book_notes） */
export interface PaperAnnotationDraft {
  /** Markdown 锚点 JSON（存 cfi 列，格式见 paper-anchors.ts） */
  cfi: string;
  /** 选中原文（Range.toString 原文，供侧栏展示与 quote 兜底） */
  text: string;
  /** 笔触（highlight/underline/squiggly，与书籍同一三值） */
  style: HighlightStyle;
  color: HighlightColor;
  /** 评论（空串 = 纯标亮，标注与笔记合一） */
  note: string;
  context: { before: string; after: string };
}

/** T2/T3 对齐的译文上下文（paper-reader-view 从译本 JSON 构建；块索引与 listBlocks 枚举一致） */
export interface PaperTranslationContext {
  /** 块索引 → 译文文本（译本 JSON 原文，未经 oneLine/escapeHtml） */
  texts: ReadonlyMap<number, string>;
  /** 块索引 → 句对齐表（无对齐/对齐陈旧的块不在表内） */
  alignments: ReadonlyMap<number, PaperAlignPair[]>;
  /** 块索引 → T3 词对齐表（坐标系同句对齐；无词级对齐的块不在表内，映射回退句级） */
  wordAlignments: ReadonlyMap<number, PaperAlignPair[]>;
}

export interface PaperReaderProps {
  /** 论文目录绝对路径（图片相对路径基于它解析） */
  paperDir: string;
  /** paper.md 原始文本（组件内部自行解析 frontmatter） */
  markdown: string;
  /** 当前阅读位置对应的标题变化时上报（IntersectionObserver 跟踪，供论文助手注入"当前小节"） */
  onActiveHeadingChange?: (heading: { id: string; text: string } | null) => void;
  /** 正文渲染后收集到的 TOC 上报（供顶栏 TOC 下拉使用） */
  onTocChange?: (toc: TocItem[]) => void;
  /** 正文字号（px，作用于 prose 容器，内部 em 相对单位跟随） */
  fontSize?: number;
  /** 正文 font-family（作用于 prose 容器，子元素继承） */
  fontFamily?: string;
  /** 本文内搜索关键词（大小写不敏感；空串清除高亮） */
  searchTerm?: string;
  /** 当前匹配序号（0 起）：单独高亮并滚动定位 */
  activeMatchIndex?: number;
  /** 搜索匹配总数变化时上报（供顶栏搜索下拉显示计数） */
  onSearchMatchesChange?: (count: number) => void;
  /** 本篇论文的全部标注（type=annotation 且未删除）；缺省/空数组时禁用标注交互 */
  annotations?: BookNote[];
  /** 新建标注；返回新建的标注（弹窗创建后切到"已有标注"模式继续改笔触/颜色），失败返回 undefined */
  onCreateAnnotation?: (draft: PaperAnnotationDraft) => Promise<BookNote | undefined>;
  onUpdateAnnotation?: (id: string, update: { color?: HighlightColor; style?: HighlightStyle; note?: string }) => void;
  onDeleteAnnotation?: (id: string) => void;
  /** 弹窗 "Ask AI"：选中文本作为 quote 注入论文助手输入框 */
  onQuoteToChat?: (text: string) => void;
  /** 图片预览"引用"：图片转 dataUrl 注入论文助手输入区附件（J2 补环） */
  onQuoteImageToChat?: (image: { dataUrl: string; mediaType: string; name: string }) => void;
  /** 侧栏点击要求定位的标注 id（处理后经 onAnnotationFocused 回执清零，允许重复点击同一项） */
  focusAnnotationId?: string | null;
  onAnnotationFocused?: () => void;
  /** 显示模式（原文/译文/逐段对照）；译文模式下标注降级为块级着色、禁止新建标注 */
  viewMode?: PaperViewMode;
  /** 元数据译文（metadata.json 的 title_zh/abstract_zh），非原文模式时展示 */
  translatedMeta?: { title_zh?: string; abstract_zh?: string } | null;
  /** T2 译文上下文（译文文本 + 句对齐表）：英文标注的中文侧映射高亮、中文划词标亮、译文 hover */
  translation?: PaperTranslationContext | null;
  /** 原文切块表（cutPaperBlocks 产物）：中文划词标亮时取英文原文/上下文建英文锚点 */
  sourceBlocks?: PaperBlock[] | null;
}

/** 本文内搜索高亮的 CSS Custom Highlight 注册名（样式见 index.css） */
const PAPER_SEARCH_HIGHLIGHT = "paper-search";
const PAPER_SEARCH_CURRENT_HIGHLIGHT = "paper-search-current";
/** 标注高亮注册名：highlight 笔触为 paper-anno-{color}，underline/squiggly 为 paper-anno-{style}-{color}；
 * paper-anno-current 为侧栏定位的闪烁强调 */
const PAPER_ANNO_HIGHLIGHT_PREFIX = "paper-anno-";
const PAPER_ANNO_CURRENT_HIGHLIGHT = "paper-anno-current";
const PAPER_ANNO_COLORS: HighlightColor[] = ["red", "yellow", "green", "blue", "violet"];
const PAPER_ANNO_STYLES: HighlightStyle[] = ["highlight", "underline", "squiggly"];

const annoHighlightName = (style: HighlightStyle, color: HighlightColor) =>
  style === "highlight" ? `${PAPER_ANNO_HIGHLIGHT_PREFIX}${color}` : `${PAPER_ANNO_HIGHLIGHT_PREFIX}${style}-${color}`;

const allAnnoHighlightNames = () =>
  PAPER_ANNO_STYLES.flatMap((style) => PAPER_ANNO_COLORS.map((color) => annoHighlightName(style, color)));

/** T2 映射高亮注册名（英文标注在中文侧的镜像）：同名加 -tgt 后缀，样式见 index.css（透明度略低以区分） */
const annoTgtHighlightName = (style: HighlightStyle, color: HighlightColor) => `${annoHighlightName(style, color)}-tgt`;

const allAnnoTgtHighlightNames = () => allAnnoHighlightNames().map((name) => `${name}-tgt`);

const toHighlightColor = (color: string | undefined): HighlightColor =>
  PAPER_ANNO_COLORS.includes(color as HighlightColor) ? (color as HighlightColor) : "yellow";

const toHighlightStyle = (style: string | undefined): HighlightStyle =>
  PAPER_ANNO_STYLES.includes(style as HighlightStyle) ? (style as HighlightStyle) : "highlight";

/** 新建标注的默认笔触/颜色：与书籍同一处设置（globalReadSettings.highlightStyle/Styles） */
const readDefaultStyleColor = (): { style: HighlightStyle; color: HighlightColor } => {
  const readSettings = useAppSettingsStore.getState().settings.globalReadSettings;
  const style = readSettings.highlightStyle;
  return { style, color: readSettings.highlightStyles[style] };
};

const getHighlightRegistry = () => (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;

/**
 * 标注高亮联合注册表（2026-08-08 修复多 tab 互相清空高亮）：
 * CSS 的 ::highlight() 名是静态的（index.css 固定 15+15 个），多个 PaperReader 实例
 * （多篇论文 tab 同时挂载）若各自 delete→set 同名条目，后跑的实例会把先跑实例的
 * Range 清掉——最后挂载的无标注论文会把全部高亮抹空。
 * 改为每实例维护独立槽位，任何实例更新后把所有存活槽位取并集写入 registry。
 */
const annoUnionSlots = new Map<number, Map<string, Range[]>>();
let annoInstanceSeq = 0;

function applyAnnoHighlightUnion() {
  const registry = getHighlightRegistry();
  if (!registry || typeof Highlight === "undefined") return;
  const union = new Map<string, Range[]>();
  for (const slot of annoUnionSlots.values()) {
    for (const [name, ranges] of slot) {
      if (ranges.length > 0) union.set(name, [...(union.get(name) ?? []), ...ranges]);
    }
  }
  for (const name of [...allAnnoHighlightNames(), ...allAnnoTgtHighlightNames()]) {
    const ranges = union.get(name);
    // J1：注册前去重（同容器同偏移只注册一次，-tgt 镜像重复区间防护）
    if (ranges?.length) registry.set(name, new Highlight(...dedupeRanges(ranges)));
    else registry.delete(name);
  }
}

/** 实例级注册：更新本实例槽位后重算并集；返回的 cleanup 在卸载时移除槽位 */
function registerAnnoHighlightSlot(byStyleColor: Map<string, Range[]>, tgtByStyleColor: Map<string, Range[]>) {
  const id = ++annoInstanceSeq;
  annoUnionSlots.set(id, new Map([...byStyleColor, ...tgtByStyleColor]));
  applyAnnoHighlightUnion();
  return () => {
    annoUnionSlots.delete(id);
    applyAnnoHighlightUnion();
  };
}

/** 搜索高亮同款并集（多 tab 各自带搜索词时不互清） */
const searchUnionSlots = new Map<number, Range[]>();
let searchInstanceSeq = 0;

/** J1：Range 去重（同一容器同偏移视为重复）——历史标注曾出现同一中文区间被多来源
 * 重复推入并集（绿色标注 4 个相同 105 字区间），CSS 高亮重复注册无害但浪费且干扰排查 */
function dedupeRanges(ranges: Range[]): Range[] {
  const seen = new Set<string>();
  const out: Range[] = [];
  for (const r of ranges) {
    const key = `${assignNodeSeq(r.startContainer)}:${r.startOffset}->${assignNodeSeq(r.endContainer)}:${r.endOffset}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

let nodeSeqCounter = 0;
const nodeSeqMap = new WeakMap<Node, number>();
function assignNodeSeq(node: Node): number {
  let seq = nodeSeqMap.get(node);
  if (seq === undefined) {
    seq = ++nodeSeqCounter;
    nodeSeqMap.set(node, seq);
  }
  return seq;
}

function applySearchHighlightUnion() {
  const registry = getHighlightRegistry();
  if (!registry || typeof Highlight === "undefined") return;
  const all: Range[] = [];
  for (const ranges of searchUnionSlots.values()) all.push(...ranges);
  if (all.length > 0) registry.set(PAPER_SEARCH_HIGHLIGHT, new Highlight(...all));
  else registry.delete(PAPER_SEARCH_HIGHLIGHT);
}

function registerSearchHighlightSlot(ranges: Range[]) {
  const id = ++searchInstanceSeq;
  searchUnionSlots.set(id, ranges);
  applySearchHighlightUnion();
  return () => {
    searchUnionSlots.delete(id);
    applySearchHighlightUnion();
  };
}

type BlobUrlCache = Map<string, string>;

const REMOTE_SRC_RE = /^(https?:|data:|blob:)/i;

/**
 * P2 标签页休眠：滚动位置记忆（模块级，按论文目录路径键控）。
 * 休眠卸载前由 handleScroll 持续写入最新值；重挂载后一次性还原并清除，
 * 避免污染后续 viewMode 切换等正常流程。
 */
const paperScrollMemory = new Map<string, number>();

/** 只在内部滚动容器内滚动（scrollIntoView 会连累所有祖先滚动容器，导致整个版面上移） */
function scrollElementInContainer(root: HTMLElement, el: Element, offset = 16) {
  const top = el.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop - offset;
  root.scrollTo({ top, behavior: "smooth" });
}

/**
 * 对照模式：每个译文 div（data-translation）归属的原文块索引。
 * 译文 div 由 buildPaperViewMarkdown 紧随块插入——li/td/th 块的在块内部（祖先即块），
 * p/h1-h6/blockquote 块的是紧随其后的兄弟节点；统一取"文档顺序上最后一个起点在 div 之前的块"。
 * （compareDocumentPosition 的 PRECEDING 位对"前序兄弟"与"祖先"均成立）
 */
function buildTranslationDivMap(container: Element): Map<number, Element> {
  const blocks = listBlocks(container);
  const map = new Map<number, Element>();
  let cursor = 0;
  for (const div of Array.from(container.querySelectorAll("[data-translation]"))) {
    while (cursor < blocks.length && div.compareDocumentPosition(blocks[cursor]) & Node.DOCUMENT_POSITION_PRECEDING) {
      cursor += 1;
    }
    if (cursor > 0) map.set(cursor - 1, div as Element);
  }
  return map;
}

/**
 * 译文 stored 文本偏移 → 译文元素的实时 DOM Range。
 * 对照模式 div.textContent 与 stored 文本一致时直接按偏移建 Range；
 * 不一致（KaTeX 重排了 $...$、译文模式 oneLine 折叠了换行）时：
 *   T2 句界区间按句索引换算（两侧各切句，句数一致则用实时句表对应句边界）；
 *   T3 词级区间（句内偏移）先经公式归一 + 词 token 下标对应（两侧数学段各归一为 1 个
 *   占位符后 token 序列一致，含公式块也能词级精确；oneLine 折叠只动空白同理），
 *   失败再吸附到所在句按句索引换算（精度降级到整句），句数对不上则夹取偏移保底（不 crash）。
 */
function tgtOffsetsToRange(el: Element, storedText: string, ts: number, te: number): Range | null {
  const live = el.textContent ?? "";
  let start = ts;
  let end = te;
  if (live !== storedText) {
    const storedSpans = segmentSentences(storedText);
    const liveSpans = segmentSentences(live);
    const si = storedSpans.findIndex((sp) => sp.start === ts);
    const ei = storedSpans.findIndex((sp) => sp.end === te);
    if (si !== -1 && ei !== -1 && storedSpans.length === liveSpans.length) {
      // T2 句界区间：句索引换算（原逻辑）
      start = liveSpans[si].start;
      end = liveSpans[ei].end;
    } else {
      // T3 词级区间：公式归一 + 词 token 下标对应 → 吸附整句句索引换算 → 夹取保底
      const viaTokens = mapOffsetsMathAware(normalizeMathText(storedText), normalizeLiveElement(el), ts, te);
      if (viaTokens) {
        start = viaTokens.start;
        end = viaTokens.end;
      } else {
        const snapped = snapRangeToSentences(storedSpans, ts, te);
        const ssi = snapped ? storedSpans.findIndex((sp) => sp.start === snapped.start) : -1;
        const sei = snapped ? storedSpans.findIndex((sp) => sp.end === snapped.end) : -1;
        if (ssi !== -1 && sei !== -1 && storedSpans.length === liveSpans.length) {
          start = liveSpans[ssi].start;
          end = liveSpans[sei].end;
        } else {
          start = Math.min(ts, live.length);
          end = Math.min(te, live.length);
        }
      }
    }
  }
  if (end <= start) return null;
  const startPoint = charOffsetToPoint(el, start);
  const endPoint = charOffsetToPoint(el, end);
  if (!startPoint || !endPoint) return null;
  const range = document.createRange();
  range.setStart(startPoint.node, startPoint.offset);
  range.setEnd(endPoint.node, endPoint.offset);
  return range;
}

/**
 * md 源文偏移 → live 英文块 Range（hover 联动/中文侧映射的英文侧定位）。
 * live 块文本与源文一致（无公式）直接按偏移建 Range；不一致（KaTeX 渲染改变了
 * textContent）经 mapSourceOffsetsToLive（公式归一 + 词 token 对应，句索引兜底），
 * 失败返回 null（调用方跳过联动）。excludeSelector 用于跳过块内嵌的译文 div
 * （对照模式 li/td/th；译文在块尾，英文部分是前缀，换算坐标与块 textContent 坐标一致）。
 */
function srcOffsetsToRange(
  block: Element,
  sourceText: string,
  ss: number,
  se: number,
  excludeSelector?: string,
): Range | null {
  const offsets = mapSourceOffsetsToLive(
    normalizeMathText(sourceText),
    normalizeLiveElement(block, excludeSelector),
    ss,
    se,
  );
  if (!offsets || offsets.end <= offsets.start) return null;
  const startPoint = charOffsetToPoint(block, offsets.start);
  const endPoint = charOffsetToPoint(block, offsets.end);
  if (!startPoint || !endPoint) return null;
  const range = document.createRange();
  range.setStart(startPoint.node, startPoint.offset);
  range.setEnd(endPoint.node, endPoint.offset);
  return range;
}

/**
 * live 英文块偏移 → md 源文坐标（标注 cfi 是 live DOM 坐标，align/alignW 是源文坐标）。
 * 无公式（raw 与源文一致）恒等返回；含公式经公式归一 + 词 token 下标对应；
 * 失败返回 null（调用方保留原偏移，维持既有行为）。
 */
function liveSrcOffsetsToSource(
  block: Element,
  sourceText: string,
  s: number,
  e: number,
  excludeSelector?: string,
): { start: number; end: number } | null {
  const normLive = normalizeLiveElement(block, excludeSelector);
  if (normLive.raw === sourceText) return { start: s, end: e };
  return mapOffsetsMathAware(normLive, normalizeMathText(sourceText), s, e);
}

/**
 * 译文模式下英文块不在 DOM 中：按 md 源文重建"若原文渲染成 DOM"的等效元素
 * （公式段用 katex.renderToString 的产物——与 rehype-katex 同源，textContent 结构一致），
 * 供公式归一在 cfi live 坐标 ↔ 源文坐标之间换算。渲染失败按纯文本处理（归一退化为恒等）。
 */
function buildVirtualLiveSrc(sourceText: string): Element {
  const { spans } = normalizeMathText(sourceText);
  const div = document.createElement("div");
  let last = 0;
  for (const span of spans) {
    div.appendChild(document.createTextNode(sourceText.slice(last, span.origStart)));
    const raw = sourceText.slice(span.origStart, span.origEnd);
    const display = raw.startsWith("$$");
    const holder = document.createElement("span");
    try {
      holder.innerHTML = katex.renderToString(raw.slice(display ? 2 : 1, raw.length - (display ? 2 : 1)), {
        displayMode: display,
        throwOnError: false,
      });
    } catch {
      holder.textContent = raw;
    }
    div.appendChild(holder);
    last = span.origEnd;
  }
  div.appendChild(document.createTextNode(sourceText.slice(last)));
  return div;
}

/** 自定义 a：http(s) 外链交给默认浏览器（Tauri opener）；页内 # 锚点交给 onNavigateFragment（id 定位 + quote 兜底，P1 链接重建） */
function createPaperLinkComponent(onNavigateFragment: (id: string, linkText: string) => boolean): Components["a"] {
  return function PaperLink({ href, children, ...props }) {
    const handleClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
      if (!href) return;
      if (/^https?:\/\//i.test(href)) {
        event.preventDefault();
        openUrl(href).catch((error) => console.warn("打开链接失败:", href, error));
        return;
      }
      if (href.startsWith("#")) {
        event.preventDefault();
        onNavigateFragment(decodeURIComponent(href.slice(1)), event.currentTarget.textContent ?? "");
      }
    };
    return (
      <a href={href} {...props} onClick={handleClick}>
        {children}
      </a>
    );
  };
}

/** 自定义 img：相对路径经 plugin-fs 读字节 → blob URL（带缓存），加载中占位、失败显示 alt；点击进大图预览 */
function createPaperImageComponent(
  paperDir: string,
  cache: BlobUrlCache,
  onPreview?: (image: { src: string; alt: string }) => void,
): Components["img"] {
  return function PaperImage({ src, alt, ...props }) {
    const isRemote = typeof src === "string" && REMOTE_SRC_RE.test(src);
    const [status, setStatus] = useState<"loading" | "ready" | "error">(isRemote ? "ready" : "loading");
    const [resolvedSrc, setResolvedSrc] = useState<string>(isRemote && typeof src === "string" ? src : "");

    useEffect(() => {
      if (typeof src !== "string" || !src) {
        setStatus("error");
        return;
      }
      if (REMOTE_SRC_RE.test(src)) {
        setResolvedSrc(src);
        setStatus("ready");
        return;
      }
      const cached = cache.get(src);
      if (cached) {
        setResolvedSrc(cached);
        setStatus("ready");
        return;
      }

      let cancelled = false;
      const fullPath = `${paperDir}/${src}`;
      readFile(fullPath)
        .then((bytes) => {
          if (cancelled) return;
          const url = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer]));
          cache.set(src, url);
          setResolvedSrc(url);
          setStatus("ready");
        })
        .catch((error) => {
          if (cancelled) return;
          console.warn(`论文图片读取失败: ${fullPath}`, error);
          setStatus("error");
        });
      return () => {
        cancelled = true;
      };
    }, [src, paperDir, cache]);

    if (status === "error") {
      return (
        <span className="my-4 flex items-center justify-center gap-2 rounded-lg border border-neutral-200 border-dashed px-4 py-8 text-neutral-400 text-sm dark:border-neutral-700 dark:text-neutral-500">
          <ImageOff className="size-4" />
          图片加载失败：{alt || String(src)}
        </span>
      );
    }
    if (status === "loading") {
      return <span className="my-4 block h-48 w-full animate-pulse rounded-lg bg-neutral-100 dark:bg-neutral-800" />;
    }
    return (
      <span className="my-3 block text-center">
        <img
          src={resolvedSrc}
          alt={alt ?? ""}
          loading="lazy"
          {...props}
          // 图表速跳定位锚：相对路径原样留 DOM（blob src 无法反查），见 PaperReaderHandle.scrollToImage
          data-paper-src={typeof src === "string" ? src : undefined}
          className="mx-auto block max-w-full cursor-zoom-in"
          onClick={() => onPreview?.({ src: resolvedSrc, alt: alt ?? "" })}
        />
        {/* 图注可见化：Papers_Converter 把图注放在 alt 里（切块/RAG 暂不可见，先视觉上兜底显示） */}
        {alt?.trim() && (
          <InlineMathText
            text={alt.trim()}
            className="mt-1.5 block text-center text-neutral-500 text-xs leading-relaxed dark:text-neutral-400"
          />
        )}
      </span>
    );
  };
}

/** 图片大图预览（点开）：居中放大 + 复制 / 保存 / 引用 / 关闭；Esc 与点击背板关闭 */
function PaperImagePreview({
  image,
  onClose,
  onQuote,
}: {
  image: { src: string; alt: string };
  onClose: () => void;
  /** J2 补环：引用到 AI 输入区（转 dataUrl 后上抛，视觉闸在聊天侧判） */
  onQuote?: (image: { dataUrl: string; mediaType: string; name: string }) => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handleCopy = async () => {
    try {
      const blob = await (await fetch(image.src)).blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })]);
      toast.success("图片已复制到剪贴板");
    } catch (error) {
      toast.error(`复制失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const handleQuote = async () => {
    try {
      const blob = await (await fetch(image.src)).blob();
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("读取图片失败"));
        reader.readAsDataURL(blob);
      });
      onQuote?.({
        dataUrl,
        mediaType: blob.type || "image/png",
        name: image.alt || "figure",
      });
      toast.success("已引用到对话输入区");
      onClose();
    } catch (error) {
      toast.error(`引用失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const handleSave = async () => {
    try {
      const base =
        image.alt
          .replace(/[\\/:*?"<>|]/g, "_")
          .slice(0, 60)
          .trim() || "figure";
      const path = await save({
        defaultPath: `${base}.png`,
        filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }],
      });
      if (!path) return;
      const bytes = new Uint8Array(await (await fetch(image.src)).arrayBuffer());
      await writeFile(path, bytes);
      toast.success(`已保存到 ${path}`);
    } catch (error) {
      toast.error(`保存失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    // 背板点击关闭；内容区阻止冒泡
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div className="absolute top-4 right-4 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1.5 rounded-md bg-white/10 px-3 py-1.5 text-sm text-white hover:bg-white/20"
        >
          <Copy className="size-4" />
          复制
        </button>
        <button
          type="button"
          onClick={handleSave}
          className="flex items-center gap-1.5 rounded-md bg-white/10 px-3 py-1.5 text-sm text-white hover:bg-white/20"
        >
          <Download className="size-4" />
          保存
        </button>
        {onQuote && (
          <button
            type="button"
            onClick={handleQuote}
            className="flex items-center gap-1.5 rounded-md bg-white/10 px-3 py-1.5 text-sm text-white hover:bg-white/20"
          >
            <Quote className="size-4" />
            引用
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="flex items-center rounded-md bg-white/10 p-1.5 text-white hover:bg-white/20"
          aria-label="关闭预览"
        >
          <X className="size-4" />
        </button>
      </div>
      <img
        src={image.src}
        alt={image.alt}
        className="max-h-[86vh] max-w-[92vw] object-contain"
        onClick={(e) => e.stopPropagation()}
      />
      {image.alt && (
        <div className="-translate-x-1/2 absolute bottom-4 left-1/2 max-w-[80vw] truncate rounded-md bg-black/60 px-3 py-1.5 text-neutral-200 text-xs">
          {image.alt}
        </div>
      )}
    </div>
  );
}

const AUTHOR_COLLAPSE_COUNT = 6;

/** 正文顶部的元数据块（标题/作者/出处/DOI/摘要/关键词），无 frontmatter 时不渲染 */
function MetadataBlock({
  metadata,
  viewMode = "original",
  translatedMeta,
}: {
  metadata: PaperMetadata;
  viewMode?: PaperViewMode;
  translatedMeta?: { title_zh?: string; abstract_zh?: string } | null;
}) {
  const [authorsExpanded, setAuthorsExpanded] = useState(false);
  const [abstractOpen, setAbstractOpen] = useState(true);
  // 摘要双语切换：非原文模式且有摘要译文时默认显示译文
  const [showOriginalAbstract, setShowOriginalAbstract] = useState(false);

  const authors = normalizeAuthors(metadata.author);
  const shownAuthors = authorsExpanded ? authors : authors.slice(0, AUTHOR_COLLAPSE_COUNT);
  const hiddenCount = authors.length - AUTHOR_COLLAPSE_COUNT;

  const venue = [
    metadata["container-title"],
    metadata.volume && `${metadata.volume}${metadata.issue ? `(${metadata.issue})` : ""}`,
    metadata.page,
  ]
    .filter(Boolean)
    .join(", ");

  const translated = viewMode !== "original";
  const displayTitle = translated && translatedMeta?.title_zh ? translatedMeta.title_zh : metadata.title;
  const displayAbstract =
    translated && translatedMeta?.abstract_zh && !showOriginalAbstract ? translatedMeta.abstract_zh : metadata.abstract;

  return (
    <header data-paper-metadata className="not-prose mb-8 border-b pb-6">
      {displayTitle && (
        <h1 className="font-bold text-2xl text-neutral-900 leading-snug dark:text-neutral-100">
          <InlineMathText text={displayTitle} />
        </h1>
      )}

      {authors.length > 0 && (
        <p className="mt-3 text-neutral-600 text-sm leading-relaxed dark:text-neutral-400">
          {shownAuthors.join(", ")}
          {!authorsExpanded && hiddenCount > 0 && (
            <>
              {" "}
              <button
                type="button"
                className="text-blue-600 hover:underline dark:text-blue-400"
                onClick={() => setAuthorsExpanded(true)}
              >
                等 {authors.length} 人
              </button>
            </>
          )}
          {authorsExpanded && authors.length > AUTHOR_COLLAPSE_COUNT && (
            <>
              {" "}
              <button
                type="button"
                className="text-blue-600 hover:underline dark:text-blue-400"
                onClick={() => setAuthorsExpanded(false)}
              >
                收起
              </button>
            </>
          )}
        </p>
      )}

      {(metadata.date || venue) && (
        <p className="mt-2 text-neutral-500 text-sm dark:text-neutral-500">
          {[metadata.date, venue].filter(Boolean).join(" · ")}
        </p>
      )}

      {metadata.doi && (
        <p className="mt-2 text-sm">
          <a
            href={`https://doi.org/${metadata.doi}`}
            onClick={(event) => {
              event.preventDefault();
              openUrl(`https://doi.org/${metadata.doi}`).catch((error) => console.warn("打开 DOI 链接失败:", error));
            }}
            className="cursor-pointer text-blue-600 hover:underline dark:text-blue-400"
          >
            https://doi.org/{metadata.doi}
          </a>
        </p>
      )}

      {displayAbstract && (
        <div className="mt-4 rounded-xl bg-neutral-50 p-4 dark:bg-neutral-900/60">
          <div className="flex items-center justify-between">
            <button
              type="button"
              className="flex items-center gap-1 font-medium text-neutral-700 text-sm dark:text-neutral-300"
              onClick={() => setAbstractOpen((v) => !v)}
            >
              摘要
              {abstractOpen ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
            </button>
            {translated && translatedMeta?.abstract_zh && metadata.abstract && (
              <button
                type="button"
                className="text-neutral-500 text-xs hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
                onClick={() => setShowOriginalAbstract((v) => !v)}
              >
                {showOriginalAbstract ? "查看译文" : "查看原文"}
              </button>
            )}
          </div>
          {abstractOpen && (
            <p className="mt-2 text-justify text-neutral-600 text-sm leading-relaxed dark:text-neutral-400">
              <InlineMathText text={displayAbstract} />
            </p>
          )}
        </div>
      )}

      {metadata.keywords && metadata.keywords.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {metadata.keywords.map((keyword) => (
            <span
              key={keyword}
              className="rounded-full bg-neutral-100 px-2.5 py-0.5 text-neutral-600 text-xs dark:bg-neutral-800 dark:text-neutral-400"
            >
              {keyword}
            </span>
          ))}
        </div>
      )}
    </header>
  );
}

const PaperReader = forwardRef<PaperReaderHandle, PaperReaderProps>(function PaperReader(
  {
    paperDir,
    markdown,
    onActiveHeadingChange,
    onTocChange,
    fontSize,
    fontFamily,
    searchTerm,
    activeMatchIndex,
    onSearchMatchesChange,
    annotations,
    onCreateAnnotation,
    onUpdateAnnotation,
    onDeleteAnnotation,
    onQuoteToChat,
    onQuoteImageToChat,
    focusAnnotationId,
    onAnnotationFocused,
    viewMode = "original",
    translatedMeta,
    translation = null,
    sourceBlocks = null,
  },
  ref,
) {
  const { metadata, body } = useMemo(() => parsePaperMarkdown(markdown), [markdown]);
  // 原生 HTML 表格内的 $...$ 公式预烘焙为 KaTeX（rehype-katex 不扫 raw HTML 文本）
  const renderedBody = useMemo(() => renderMathInRawTables(body), [body]);
  const hasMetadata = Object.keys(metadata).length > 0;

  const [toc, setToc] = useState<TocItem[]>([]);
  const [activeHeadingId, setActiveHeadingId] = useState<string>("");

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const blobCacheRef = useRef<BlobUrlCache>(new Map());
  // 回调存入 ref，避免父组件内联函数导致 observer/搜索 effect 反复重建
  const onActiveHeadingChangeRef = useRef(onActiveHeadingChange);
  useEffect(() => {
    onActiveHeadingChangeRef.current = onActiveHeadingChange;
  }, [onActiveHeadingChange]);
  const onTocChangeRef = useRef(onTocChange);
  useEffect(() => {
    onTocChangeRef.current = onTocChange;
  }, [onTocChange]);
  const onSearchMatchesChangeRef = useRef(onSearchMatchesChange);
  useEffect(() => {
    onSearchMatchesChangeRef.current = onSearchMatchesChange;
  }, [onSearchMatchesChange]);
  const onAnnotationFocusedRef = useRef(onAnnotationFocused);
  useEffect(() => {
    onAnnotationFocusedRef.current = onAnnotationFocused;
  }, [onAnnotationFocused]);

  // ─── 标注（CSS Custom Highlight API，与本文内搜索同方案；锚点格式见 paper-anchors.ts） ───
  /** 中文划词标亮的载荷：tgt 选区经句对齐映射出的英文锚点（原文永远唯一事实源，text/context 均英文） */
  type CrossHighlight = { cfi: string; text: string; context: { before: string; after: string } };
  type PopupState =
    | {
        kind: "create";
        cfi: string;
        text: string;
        context: { before: string; after: string };
        position: { x: number; y: number };
      }
    | { kind: "existing"; annotation: BookNote; position: { x: number; y: number } }
    // 译文区划词（对照模式译文 div / 译文模式译文块）：完整弹窗（复制/Ask AI/标亮）；
    // highlight 为该段句对齐映射出的英文锚点载荷，null = 该段无对齐（标亮按钮禁用）
    | { kind: "translation"; text: string; highlight: CrossHighlight | null; position: { x: number; y: number } };
  // 每条标注解析出的 Range 集合（重建高亮时刷新，供点击命中与侧栏定位使用）
  const annotationRangesRef = useRef<Map<string, Range[]>>(new Map());
  const [popup, setPopup] = useState<PopupState | null>(null);
  // 弹窗状态的 ref 镜像：异步处理器（创建/保存评论）需要读当前弹窗，不把副作用塞进 setState updater
  const popupRef = useRef<PopupState | null>(null);
  const setPopupState = useCallback((next: PopupState | null) => {
    popupRef.current = next;
    setPopup(next);
  }, []);

  // ─── 句子悬浮高亮 + 右键调弹窗（切句器见 paper-sentences.ts） ───
  // 覆盖层方案：CSS Highlight API 不支持 box-shadow，故按句子 Range 的 getClientRects 渲染叠层 div。
  // 句子表按块懒计算并缓存（WeakMap 随正文 DOM 重建自动失效，textContent 比对兜底就地变更）。
  const sentenceCacheRef = useRef<WeakMap<Element, { text: string; spans: SentenceSpan[] }>>(new WeakMap());
  const hoverRangeRef = useRef<Range | null>(null);
  // 对照模式联动 hover：命中句的对侧对应句 Range（无对齐/换算失败为 null，只显本侧）
  const hoverLinkedRangeRef = useRef<Range | null>(null);
  const [hoverRects, setHoverRects] = useState<HoverRect[] | null>(null);
  const hoverRafRef = useRef(0);
  const lastMouseRef = useRef<{ x: number; y: number; target: EventTarget | null } | null>(null);

  // 清除同步化：取消未消费的 rAF 并丢掉最后坐标——否则 mouseleave 后 pending 帧会
  // 用最后坐标重画覆盖层，形成"残影"（鼠标已离开但高亮常驻）
  const clearHover = useCallback(() => {
    if (hoverRafRef.current) {
      cancelAnimationFrame(hoverRafRef.current);
      hoverRafRef.current = 0;
    }
    lastMouseRef.current = null;
    hoverRangeRef.current = null;
    hoverLinkedRangeRef.current = null;
    setHoverRects(null);
  }, []);

  // 容器坐标换算：与 scrollTo 相同的 getBoundingClientRect 差值 + scrollTop 做法。
  // getClientRects 对 inline 组件（KaTeX/MathML 副本、sup/sub、::marker）会返回互相重叠的
  // 多个 rect，半透明 tint 叠加深色，故渲染前先做几何求并（mergeOverlappingRects，同行才并、跨行不并）。
  // 联动句与本侧句的 rect 并入同一数组求并（两块上下相邻，y 带不相交，不会误并）。
  const updateHoverRects = useCallback(() => {
    const range = hoverRangeRef.current;
    const scroller = scrollRef.current;
    if (!range || !scroller) {
      setHoverRects(null);
      return;
    }
    const base = scroller.getBoundingClientRect();
    const domRects = Array.from(range.getClientRects());
    const linked = hoverLinkedRangeRef.current;
    if (linked) domRects.push(...Array.from(linked.getClientRects()));
    const rects = mergeOverlappingRects(
      domRects
        .filter((r) => r.width > 0 && r.height > 0)
        .map((r) => ({
          x: r.left - base.left + scroller.scrollLeft,
          y: r.top - base.top + scroller.scrollTop,
          width: r.width,
          height: r.height,
        })),
    );
    setHoverRects(rects.length > 0 ? rects : null);
  }, []);

  // 定位 (x, y) 处文本所属句子：caretRangeFromPoint → 切句根元素 → 句表 → 句子 Range。
  // 切句根：对照模式译文 div 内即 div 本身（T2 开放中文侧悬浮，句表按元素 textContent 切句并缓存，
  // 与英文块同一 WeakMap 机制）；否则为 listBlocks 同规则的原文块（译文模式下块内容即译文，天然适用）。
  // 返回 segRoot/span 供对照模式联动 hover 反查对侧句。
  const locateSentenceAtPoint = useCallback(
    (x: number, y: number): { range: Range; segRoot: Element; span: SentenceSpan } | null => {
      const container = contentRef.current;
      if (!container) return null;
      const caret = document.caretRangeFromPoint?.(x, y);
      if (!caret || caret.startContainer.nodeType !== Node.TEXT_NODE) return null;
      const textNode = caret.startContainer as Text;
      if (textNode.parentElement?.closest("a, pre")) return null; // 链接保持可点、代码块不高亮
      const segRoot = textNode.parentElement?.closest("[data-translation]") ?? findBlockForNode(container, textNode);
      if (!segRoot) return null;
      const text = segRoot.textContent ?? "";
      let entry = sentenceCacheRef.current.get(segRoot);
      if (!entry || entry.text !== text) {
        entry = { text, spans: segmentSentences(text) };
        sentenceCacheRef.current.set(segRoot, entry);
      }
      const span = findSentenceAt(entry.spans, offsetFromBlockStart(segRoot, textNode, caret.startOffset));
      if (!span) return null;
      const start = charOffsetToPoint(segRoot, span.start);
      const end = charOffsetToPoint(segRoot, span.end);
      if (!start || !end) return null;
      const range = document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      return { range, segRoot, span };
    },
    [],
  );

  // 对照模式联动 hover：命中句的对侧对应句 Range。
  // 英文句 → 译文句：live 英文句边界换算为 md 源文坐标（句索引对应，失败公式归一 + 词 token），
  //   句级 align 找句对，ts/te 经 tgtOffsetsToRange（内含句索引/公式归一/降级链）换算到 live 译文 div；
  // 中文句 → 英文句：live 译文句边界同法换算到 stored 坐标，句对 ss/se 经 srcOffsetsToRange
  //   换算到 live 英文块。无对齐/换算失败返回 null（只显本侧）；译文模式无需联动（只有中文）。
  const locateLinkedRange = useCallback(
    (segRoot: Element, span: SentenceSpan): Range | null => {
      if (viewMode !== "bilingual") return null;
      const container = contentRef.current;
      if (!container || !translation) return null;
      const blocks = listBlocks(container);
      /** live 句边界（segRoot 坐标）→ 对侧坐标系（stored 译文或 md 源文）：词 token 锚定优先
       * （词级对齐不受两侧切句漂移影响——句索引对应在句数相等但边界错位时会拿错相邻句）；
       * token 换算失败再句索引对应（边界精确 + 句数一致才用）。
       * 英文块排除内嵌译文 div 后，hover 句可能越出英文前缀（英文末句无终止符时与译文粘连）：夹取/放弃联动 */
      const convertSpan = (
        normLive: ReturnType<typeof normalizeLiveElement>,
        otherText: string,
      ): { start: number; end: number } | null => {
        if (span.start >= normLive.raw.length) return null;
        const end = Math.min(span.end, normLive.raw.length);
        const viaTokens = mapOffsetsMathAware(normLive, normalizeMathText(otherText), span.start, end);
        if (viaTokens) return viaTokens;
        const liveSpans = segmentSentences(normLive.raw);
        const otherSpans = segmentSentences(otherText);
        const si = liveSpans.findIndex((sp) => sp.start === span.start && sp.end === end);
        if (si !== -1 && liveSpans.length === otherSpans.length) {
          return { start: otherSpans[si].start, end: otherSpans[si].end };
        }
        return null;
      };
      if (segRoot.hasAttribute("data-translation")) {
        let b = -1;
        for (const [idx, div] of buildTranslationDivMap(container)) {
          if (div === segRoot) {
            b = idx;
            break;
          }
        }
        const align = translation.alignments.get(b);
        const stored = translation.texts.get(b);
        const block = blocks[b];
        const sourceText = sourceBlocks?.[b]?.sourceText;
        if (b < 0 || !align || !stored || !block || sourceText == null) return null;
        const ts = convertSpan(normalizeLiveElement(segRoot), stored);
        const pair = ts ? findAlignPairByTgt(align, ts.start, ts.end) : null;
        // 英文块可能内嵌译文 div（li/td/th）：换算时排除（英文部分是前缀，坐标一致）
        return pair ? srcOffsetsToRange(block, sourceText, pair.ss, pair.se, "[data-translation]") : null;
      }
      const b = blocks.indexOf(segRoot);
      const align = translation.alignments.get(b);
      const stored = translation.texts.get(b);
      const div = buildTranslationDivMap(container).get(b);
      const sourceText = sourceBlocks?.[b]?.sourceText;
      if (b < 0 || !align || !stored || !div || sourceText == null) return null;
      const ss = convertSpan(normalizeLiveElement(segRoot, "[data-translation]"), sourceText);
      const pair = ss ? findAlignPairBySrc(align, ss.start, ss.end) : null;
      return pair ? tgtOffsetsToRange(div, stored, pair.ts, pair.te) : null;
    },
    [viewMode, translation, sourceBlocks],
  );

  const processHover = useCallback(
    (x: number, y: number, target: EventTarget | null) => {
      // 禁用条件：弹窗打开 / 有非折叠选区 / 悬在图片、代码块、链接上
      if (popupRef.current) return clearHover();
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return clearHover();
      if (target instanceof Element && target.closest("img, pre, a")) return clearHover();
      const found = locateSentenceAtPoint(x, y);
      if (!found) return clearHover();
      const { range } = found;
      const prev = hoverRangeRef.current;
      if (
        prev &&
        prev.startContainer === range.startContainer &&
        prev.startOffset === range.startOffset &&
        prev.endContainer === range.endContainer &&
        prev.endOffset === range.endOffset
      ) {
        return; // 同一句子内移动：不重算
      }
      hoverRangeRef.current = range;
      hoverLinkedRangeRef.current = locateLinkedRange(found.segRoot, found.span);
      updateHoverRects();
    },
    [clearHover, locateSentenceAtPoint, locateLinkedRange, updateHoverRects],
  );

  // mousemove 经 rAF 节流：每帧最多处理一次，取最新坐标
  const handleMouseMove = useCallback(
    (event: React.MouseEvent) => {
      lastMouseRef.current = { x: event.clientX, y: event.clientY, target: event.target };
      if (hoverRafRef.current) return;
      hoverRafRef.current = requestAnimationFrame(() => {
        hoverRafRef.current = 0;
        const last = lastMouseRef.current;
        if (last) processHover(last.x, last.y, last.target);
      });
    },
    [processHover],
  );

  // 弹窗打开 / 正文或排版变化时清除悬浮高亮
  useEffect(() => {
    if (popup) clearHover();
  }, [popup, clearHover]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: body/字号/字体变化后正文重排，需要主动清除悬浮高亮
  useEffect(() => {
    clearHover();
  }, [body, fontSize, fontFamily, clearHover]);

  // 布局变化（窗口缩放、字号调整）时按缓存的句子 Range 重算覆盖层位置
  useEffect(() => {
    const container = contentRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      if (hoverRangeRef.current) updateHoverRects();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [updateHoverRects]);

  // 卸载时取消未消费的 rAF
  useEffect(() => {
    return () => {
      if (hoverRafRef.current) cancelAnimationFrame(hoverRafRef.current);
    };
  }, []);

  // 组件卸载时统一释放 blob URL
  useEffect(() => {
    const cache = blobCacheRef.current;
    return () => {
      for (const url of cache.values()) {
        URL.revokeObjectURL(url);
      }
      cache.clear();
    };
  }, []);

  // 图片点开预览（大图 + 复制/保存）
  const [imagePreview, setImagePreview] = useState<{ src: string; alt: string } | null>(null);

  // 渲染完成后从 DOM 收集标题生成 TOC（id 与 rehype-slug 产物天然一致），并上报给顶栏下拉。
  // 译文 div 的公式已在重建时烘焙为 .katex 元素（renderTranslationHtml），不再用 auto-render
  // 改 React 管理的 DOM（那会让译文 div 与 React 重渲染冲突、内容损坏）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 需要在正文变化后重新收集已渲染的标题 DOM
  useEffect(() => {
    const container = contentRef.current;
    if (!container) return;
    const headings = Array.from(container.querySelectorAll("h1, h2, h3, h4, h5, h6"));
    const items = headings.map((el) => ({
      id: el.id,
      text: el.textContent ?? "",
      level: Number(el.tagName.slice(1)),
    }));
    setToc(items);
    onTocChangeRef.current?.(items);
  }, [body]);

  // IntersectionObserver 高亮当前阅读位置对应的标题（并向父组件上报，供论文助手使用）
  useEffect(() => {
    const container = contentRef.current;
    const scrollRoot = scrollRef.current;
    if (!container || !scrollRoot || toc.length === 0) return;

    const headings = Array.from(container.querySelectorAll("h1, h2, h3, h4, h5, h6"));
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveHeadingId(entry.target.id);
            onActiveHeadingChangeRef.current?.({
              id: entry.target.id,
              text: entry.target.textContent ?? "",
            });
          }
        }
      },
      { root: scrollRoot, rootMargin: "0px 0px -75% 0px", threshold: 0 },
    );
    for (const el of headings) {
      observer.observe(el);
    }
    return () => observer.disconnect();
  }, [toc]);

  // P2 标签页休眠还原：重挂载后首次 effect 即恢复记忆位置并清除（一次性消费，
  // 不影响后续 viewMode/译文切换；markdown 首帧与 effect 同周期提交，内容已就位）
  useEffect(() => {
    const saved = paperScrollMemory.get(paperDir);
    if (saved !== undefined && scrollRef.current) {
      scrollRef.current.scrollTop = saved;
      paperScrollMemory.delete(paperDir);
    }
  }, [paperDir]);

  // 只在内部滚动容器内滚动（scrollIntoView 会连累所有祖先滚动容器，导致整个版面上移）
  const scrollToHeading = useCallback((id: string): boolean => {
    setActiveHeadingId(id);
    const root = scrollRef.current;
    const el = document.getElementById(id);
    if (!root || !el) return false;
    scrollElementInContainer(root, el);
    return true;
  }, []);

  // 定位闪烁强调（标注定位 / 图表速跳共用）：paper-anno-current 高亮闪 3 次后清除
  const flashTimerRef = useRef<number | null>(null);
  const flashRanges = useCallback((ranges: Range[]) => {
    const highlightRegistry = getHighlightRegistry();
    if (!highlightRegistry || typeof Highlight === "undefined") return;
    if (flashTimerRef.current !== null) window.clearInterval(flashTimerRef.current);
    let tick = 0;
    flashTimerRef.current = window.setInterval(() => {
      tick += 1;
      if (tick % 2 === 1) {
        highlightRegistry.set(PAPER_ANNO_CURRENT_HIGHLIGHT, new Highlight(...ranges));
      } else {
        highlightRegistry.delete(PAPER_ANNO_CURRENT_HIGHLIGHT);
      }
      if (tick >= 5) {
        if (flashTimerRef.current !== null) window.clearInterval(flashTimerRef.current);
        flashTimerRef.current = null;
        highlightRegistry.delete(PAPER_ANNO_CURRENT_HIGHLIGHT);
      }
    }, 260);
  }, []);
  useEffect(
    () => () => {
      if (flashTimerRef.current !== null) window.clearInterval(flashTimerRef.current);
    },
    [],
  );

  // 图表速跳：图注/表注 quote 全文查找 → 滚动定位（约 1/3 视口）+ 闪烁；未命中返回 false
  const scrollToQuote = useCallback(
    (quote: string): boolean => {
      const container = contentRef.current;
      const root = scrollRef.current;
      if (!container || !root || !quote.trim()) return false;
      const range = findQuoteRange(container, quote);
      if (!range) return false;
      const top =
        range.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop - root.clientHeight / 3;
      root.scrollTo({ top, behavior: "smooth" });
      flashRanges([range]);
      return true;
    },
    [flashRanges],
  );

  // 图表速跳：按图片相对路径定位（img data-paper-src；CSS Highlight 对替换元素不可见，用 outline 动画闪烁）
  const scrollToImage = useCallback((src: string): boolean => {
    const container = contentRef.current;
    const root = scrollRef.current;
    if (!container || !root) return false;
    const img = container.querySelector(`img[data-paper-src="${CSS.escape(src)}"]`);
    if (!root || !img) return false;
    scrollElementInContainer(root, img, root.clientHeight / 4);
    img.classList.remove("paper-image-jump-flash");
    void (img as HTMLElement).offsetWidth; // 强制回流以重启动画（连续点同一图也会闪）
    img.classList.add("paper-image-jump-flash");
    return true;
  }, []);

  // 文内 # 链接跳转（P1 链接重建：#ref-N / #fig-N / #tab-N / #sec-*）：
  // 优先 id 锚点定位 + 闪烁（转换器注入的行内 <a id> 经 rehype-raw 落在 DOM）；
  // 锚点缺失（旧论文未重转/转换器放弃该链）时退到 quote 全文查找兜底——链接文字的
  // 首个命中常是被点击的链接自身或正文公式，须跳过链接/KaTeX/元数据块内的命中；
  // 都失败返回 false，调用方静默不跳（不打断阅读）。
  const scrollToFragment = useCallback(
    (id: string, linkText: string): boolean => {
      const container = contentRef.current;
      const root = scrollRef.current;
      if (!container || !root || !id) return false;
      const el = document.getElementById(id);
      if (el && container.contains(el)) {
        scrollElementInContainer(root, el, root.clientHeight / 4);
        // 空锚点（<a id="ref-N"></a> 无文本）闪宿主块（整条参考文献/图表块），有文本的锚点闪自身
        const target = el.textContent?.trim() ? el : (findBlockForNode(container, el) ?? el);
        const range = document.createRange();
        range.selectNodeContents(target);
        flashRanges([range]);
        return true;
      }
      const range = findQuoteRangeExcluding(container, linkText, "a, .katex, [data-paper-metadata]");
      if (!range) return false;
      const top =
        range.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop - root.clientHeight / 3;
      root.scrollTo({ top, behavior: "smooth" });
      flashRanges([range]);
      return true;
    },
    [flashRanges],
  );

  const components = useMemo<Partial<Components>>(
    () => ({
      img: createPaperImageComponent(paperDir, blobCacheRef.current, setImagePreview),
      a: createPaperLinkComponent(scrollToFragment),
    }),
    [paperDir, scrollToFragment],
  );

  // C2 AI 标亮：侧栏"AI 重点"生成时的批量 quote → 锚点换算（在当前渲染 DOM 上同步执行）
  const locateQuotes = useCallback((quotes: string[]): (PaperHighlightLocation | null)[] => {
    const container = contentRef.current;
    if (!container) return quotes.map(() => null);
    return quotes.map((quote) => locateQuoteInPaper(container, quote));
  }, []);

  useImperativeHandle(ref, () => ({ scrollToHeading, locateQuotes, scrollToQuote, scrollToImage }), [
    scrollToHeading,
    locateQuotes,
    scrollToQuote,
    scrollToImage,
  ]);

  // ─── 本文内搜索（CSS Custom Highlight API，与对话内检索同方案；引擎不支持时降级为仅计数+定位） ───
  const normalizedSearchTerm = (searchTerm ?? "").trim().toLowerCase();
  const matchRangesRef = useRef<Range[]>([]);
  const [matchVersion, setMatchVersion] = useState(0);

  // 计算全部匹配 Range 并注册整体高亮（并集式，多 tab 不互清）
  // biome-ignore lint/correctness/useExhaustiveDependencies: body 变化后正文 DOM 重渲染，需要重新收集匹配
  useEffect(() => {
    const container = contentRef.current;
    const ranges: Range[] = [];
    if (container && normalizedSearchTerm) {
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        const text = node.textContent ?? "";
        const lower = text.toLowerCase();
        let idx = lower.indexOf(normalizedSearchTerm);
        while (idx !== -1) {
          const range = document.createRange();
          range.setStart(node, idx);
          range.setEnd(node, idx + normalizedSearchTerm.length);
          ranges.push(range);
          idx = lower.indexOf(normalizedSearchTerm, idx + normalizedSearchTerm.length);
        }
        node = walker.nextNode();
      }
    }
    matchRangesRef.current = ranges;
    const disposeSearchSlot = registerSearchHighlightSlot(ranges);
    onSearchMatchesChangeRef.current?.(ranges.length);
    setMatchVersion((v) => v + 1);
    return () => {
      disposeSearchSlot();
    };
  }, [body, normalizedSearchTerm]);

  // 当前匹配项：单独高亮 + 容器内滚动定位（约 1/3 视口高度处）
  // biome-ignore lint/correctness/useExhaustiveDependencies: matchVersion 作为匹配集合重算完成的信号触发本 effect（effect 内只读 matchRangesRef）
  useEffect(() => {
    const highlightRegistry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
    highlightRegistry?.delete(PAPER_SEARCH_CURRENT_HIGHLIGHT);
    const ranges = matchRangesRef.current;
    if (ranges.length === 0) return;
    const clamped = Math.min(Math.max(activeMatchIndex ?? 0, 0), ranges.length - 1);
    const current = ranges[clamped];
    if (!current) return;
    if (highlightRegistry && typeof Highlight !== "undefined") {
      highlightRegistry.set(PAPER_SEARCH_CURRENT_HIGHLIGHT, new Highlight(current));
    }
    const root = scrollRef.current;
    if (root) {
      const top =
        current.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop - root.clientHeight / 3;
      root.scrollTo({ top, behavior: "smooth" });
    }
  }, [activeMatchIndex, matchVersion]);

  // 卸载时清理高亮注册
  useEffect(() => {
    return () => {
      const highlightRegistry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
      highlightRegistry?.delete(PAPER_SEARCH_HIGHLIGHT);
      highlightRegistry?.delete(PAPER_SEARCH_CURRENT_HIGHLIGHT);
    };
  }, []);

  // 标注高亮重建：正文渲染完成后（与 TOC 收集同一时机）按锚点解析 Range 并按颜色聚合注册；
  // 锚点块失配时用 text quote 全文模糊兜底。annotations 内容变化（增删改）同样触发重建。
  // T2/T3：对照/译文模式下，每段锚点经对齐映射出中文侧 Range（同色 -tgt 名注册，透明度略低；
  // 有词级对齐精确到词，否则句吸附整句）；
  // 对照模式 = 原文精确 + 译文映射并存；译文模式 = 有对齐的段精确映射、无对齐的段维持 T1 整块降级。
  // 映射高亮并入 annotationRangesRef（点击回显/侧栏定位/闪烁两侧同效）；无对齐的块静默跳过。
  // biome-ignore lint/correctness/useExhaustiveDependencies: body 变化后正文 DOM 重渲染，需要重新解析标注锚点
  useEffect(() => {
    const container = contentRef.current;
    const resolved = new Map<string, Range[]>();
    const byStyleColor = new Map<string, Range[]>();
    const tgtByStyleColor = new Map<string, Range[]>();
    if (container && annotations && annotations.length > 0) {
      const blocks = viewMode === "original" ? null : listBlocks(container);
      const divMap = viewMode === "bilingual" ? buildTranslationDivMap(container) : null;
      // 单段锚点 → 中文侧映射 Range（元素 + stored 译文 + 对齐表齐备才映射，否则空数组）；
      // 有词级对齐时精确到词/字（T3），否则句吸附（T2，mapSrcRangeToTgt 内部回退）。
      // cfi 偏移是 live 英文 DOM（KaTeX）坐标，align/alignW 是 md 源文坐标：含公式块先经
      // 公式归一换算（srcEl 为 live 英文块；译文模式英文不在 DOM，按源文虚拟重建），
      // 换算失败保留原偏移（既有行为）；无公式块归一为恒等，行为零变化。
      const virtualSrcCache = new Map<number, Element>();
      const mapSegment = (
        el: Element | null | undefined,
        srcEl: Element | null,
        b: number,
        s: number,
        e: number,
      ): Range[] => {
        const align = translation?.alignments.get(b);
        const stored = translation?.texts.get(b);
        if (!el || !align || !stored) return [];
        let ss = s;
        let se = e;
        const sourceText = sourceBlocks?.[b]?.sourceText;
        if (sourceText != null) {
          let liveEl = srcEl;
          if (!liveEl) {
            liveEl = virtualSrcCache.get(b) ?? null;
            if (!liveEl) {
              liveEl = buildVirtualLiveSrc(sourceText);
              virtualSrcCache.set(b, liveEl);
            }
          }
          // 对照模式 li/td/th 块内嵌译文 div：换算时排除（英文部分是前缀，坐标一致）
          const mapped = liveSrcOffsetsToSource(liveEl, sourceText, s, e, srcEl ? "[data-translation]" : undefined);
          if (mapped) {
            ss = mapped.start;
            se = mapped.end;
          }
        }
        const ranges: Range[] = [];
        for (const { ts, te } of mapSrcRangeToTgt(align, ss, se, translation?.wordAlignments.get(b)) ?? []) {
          const range = tgtOffsetsToRange(el, stored, ts, te);
          if (range) ranges.push(range);
        }
        return ranges;
      };
      for (const annotation of annotations) {
        const anchor = parseAnchor(annotation.cfi);
        const srcRanges: Range[] = [];
        const tgtRanges: Range[] = [];
        if (viewMode === "translated") {
          // 译文模式：锚点偏移对应英文原文（DOM 已替换为译文），quote 兜底必然失败——逐段映射或整块降级
          if (anchor && blocks) {
            for (const segment of anchor.segments) {
              const block = blocks[segment.b];
              if (!block) continue;
              // 译文模式英文块不在 DOM：srcEl 传 null，mapSegment 内按源文虚拟重建
              const mapped = mapSegment(block, null, segment.b, segment.s, segment.e);
              if (mapped.length > 0) {
                tgtRanges.push(...mapped);
              } else {
                const range = document.createRange();
                range.selectNodeContents(block);
                srcRanges.push(range);
              }
            }
          }
        } else {
          // 原文/对照模式：锚点精确解析，失配用 text quote 全文模糊兜底（原文侧）
          let ranges = anchor ? anchorToRanges(container, anchor) : null;
          if (!ranges && annotation.text) {
            const fallback = findQuoteRange(container, annotation.text);
            if (fallback) ranges = [fallback];
          }
          if (ranges) srcRanges.push(...ranges);
          // 对照模式：为每条锚点段追加译文 div 内的映射高亮（无对齐的块静默跳过）
          if (viewMode === "bilingual" && anchor && divMap && blocks) {
            for (const segment of anchor.segments) {
              tgtRanges.push(
                ...mapSegment(divMap.get(segment.b), blocks[segment.b] ?? null, segment.b, segment.s, segment.e),
              );
            }
          }
        }
        const all = [...srcRanges, ...tgtRanges];
        if (all.length > 0) resolved.set(annotation.id, all);
        const style = toHighlightStyle(annotation.style);
        const color = toHighlightColor(annotation.color);
        if (srcRanges.length > 0) {
          const name = annoHighlightName(style, color);
          byStyleColor.set(name, [...(byStyleColor.get(name) ?? []), ...srcRanges]);
        }
        if (tgtRanges.length > 0) {
          const name = annoTgtHighlightName(style, color);
          tgtByStyleColor.set(name, [...(tgtByStyleColor.get(name) ?? []), ...tgtRanges]);
        }
      }
    }
    annotationRangesRef.current = resolved;
    // 联合注册：本实例槽位并入全局并集（不再直接 delete 共享名，避免多 tab 互清）
    const disposeSlot = registerAnnoHighlightSlot(byStyleColor, tgtByStyleColor);
    return () => {
      disposeSlot();
    };
  }, [body, annotations, viewMode, translation, sourceBlocks]);

  // 侧栏点击标注 → 容器内滚动定位（约 1/3 视口高度处）+ paper-anno-current 闪烁强调（走共用 flashRanges）
  useEffect(() => {
    if (!focusAnnotationId) return;
    // 回执清零，允许侧栏重复点击同一项再次触发
    onAnnotationFocusedRef.current?.();
    const ranges = annotationRangesRef.current.get(focusAnnotationId);
    if (!ranges || ranges.length === 0) return;
    const root = scrollRef.current;
    if (root) {
      const top =
        ranges[0].getBoundingClientRect().top -
        root.getBoundingClientRect().top +
        root.scrollTop -
        root.clientHeight / 3;
      root.scrollTo({ top, behavior: "smooth" });
    }
    flashRanges(ranges);
  }, [focusAnnotationId, flashRanges]);

  // 弹窗位置：选区/高亮上方居中，上方空间不足则放下方，并夹取在视口内（简化版书籍 popup 避让）
  // 宽度按状态自适应（调用方传入）：译文划词最简（两按钮），选区态紧凑（三按钮），已有标注态展开笔触/颜色行
  const computePopupPosition = useCallback((rect: DOMRect, width: number): { x: number; y: number } => {
    const pad = 8;
    let x = rect.left + rect.width / 2 - width / 2;
    x = Math.max(pad, Math.min(x, window.innerWidth - width - pad));
    let y = rect.top - PAPER_ANNO_POPUP_HEIGHT - 10;
    if (y < pad) {
      y = Math.min(rect.bottom + 10, window.innerHeight - PAPER_ANNO_POPUP_HEIGHT - pad);
    }
    return { x, y };
  }, []);

  // 单击（折叠选区）命中已有高亮：caretRangeFromPoint 取点击点，逐条 isPointInRange 检测
  const hitTestAnnotation = useCallback(
    (x: number, y: number): { annotation: BookNote; range: Range } | null => {
      const caret = document.caretRangeFromPoint?.(x, y);
      if (!caret) return null;
      for (const annotation of annotations ?? []) {
        const ranges = annotationRangesRef.current.get(annotation.id);
        if (!ranges) continue;
        for (const range of ranges) {
          try {
            if (range.isPointInRange(caret.startContainer, caret.startOffset)) {
              return { annotation, range };
            }
          } catch {
            // 节点已脱离文档等情况，跳过
          }
        }
      }
      return null;
    },
    [annotations],
  );

  // 选区 → 新建标注弹窗（左键划词与右键句选共用）；选区无法锚定（如落在代码块）时不弹窗
  const openCreatePopupForRange = useCallback(
    (range: Range) => {
      const container = contentRef.current;
      if (!container) return;
      const clamped = clampRangeToContainer(container, range);
      const anchor = clamped ? rangeToAnchor(container, clamped) : null;
      const text = clamped?.toString() ?? "";
      if (clamped && anchor && text.trim()) {
        setPopupState({
          kind: "create",
          cfi: serializeAnchor(anchor),
          text,
          context: extractContext(container, clamped),
          position: computePopupPosition(clamped.getBoundingClientRect(), PAPER_ANNO_POPUP_WIDTH_COMPACT),
        });
      }
    },
    [computePopupPosition, setPopupState],
  );

  // 译文区划词 → 完整弹窗（T2/T3）：复制/Ask AI 用中文选中文本；标亮经对齐把中文选区映射为
  // 英文锚点（原文永远唯一事实源：cfi/text/context 一律英文）。有词级对齐时锚点精确到词（T3），
  // 否则句吸附（T2）；无对齐/映射失败的段 highlight=null（弹窗标亮按钮禁用）。
  // el 为对照模式的译文 div 或译文模式的译文块；range 为其内部选区。
  const openTranslationPopup = useCallback(
    (el: Element, range: Range) => {
      console.debug(`[zh-dbg0] enter ${el.tagName}.${el.className}`);
      const container = contentRef.current;
      if (!container) return;
      const clamped = clampRangeToContainer(el, range);
      const text = clamped?.toString() ?? "";
      if (!clamped || !text.trim()) return;
      // 块索引：对照模式反查译文 div 归属表；译文模式按块枚举定位（el 本身就是块）
      let blockIndex = -1;
      if (el.hasAttribute("data-translation")) {
        for (const [b, div] of buildTranslationDivMap(container)) {
          if (div === el) {
            blockIndex = b;
            break;
          }
        }
      } else {
        blockIndex = listBlocks(container).indexOf(el);
      }
      const align = blockIndex >= 0 ? translation?.alignments.get(blockIndex) : undefined;
      const stored = blockIndex >= 0 ? translation?.texts.get(blockIndex) : undefined;
      const srcBlock = blockIndex >= 0 ? sourceBlocks?.[blockIndex] : undefined;

      let highlight: CrossHighlight | null = null;
      if (align && stored && srcBlock) {
        const live = el.textContent ?? "";
        const s = offsetFromBlockStart(el, clamped.startContainer, clamped.startOffset);
        const e = offsetFromBlockStart(el, clamped.endContainer, clamped.endOffset);
        let mapped: SrcRange | null = null;
        // T3 词级精确路径：live 选区偏移换算回 stored 坐标（一致时直接用；否则公式归一 +
        // 词 token 下标对应，含公式块也能精确），词级映射出英文精确词区间（划中文几个字 → 英文精确词区间）
        const alignW = translation?.wordAlignments.get(blockIndex);
        if (alignW && alignW.length > 0) {
          const normL = normalizeLiveElement(el);
          const normS = normalizeMathText(stored);
          console.debug(
            `[zh-dbg] ${JSON.stringify({
              liveEq: live === stored,
              lTok: tokenizeWords(normL.text).length,
              sTok: tokenizeWords(normS.text).length,
              lSpans: normL.spans.length,
              sSpans: normS.spans.length,
              storedHead: stored.slice(0, 40),
              liveHead: live.slice(0, 40),
            })}`,
          );
          const storedRange = live === stored ? { start: s, end: e } : mapOffsetsMathAware(normL, normS, s, e);
          if (storedRange) mapped = mapTgtRangeToSrc(align, storedRange.start, storedRange.end, alignW);
          console.debug(`[zh-dbg2] ${JSON.stringify({ blockIndex, storedRange, mapped })}`);
        }
        if (!mapped) {
          // T2 句级降级路径：句吸附（划一半中文也映射到整个英文句），再按句索引换算回 stored 译文偏移
          // （live 与 stored 可能差一个 KaTeX 重排/oneLine 折叠；句数对不上时直接用原偏移，live===stored 时恒正确）
          const liveSpans = segmentSentences(live);
          const snapped = snapRangeToSentences(liveSpans, s, e);
          if (snapped) {
            const si = liveSpans.findIndex((sp) => sp.start === snapped.start);
            const ei = liveSpans.findIndex((sp) => sp.end === snapped.end);
            const storedSpans = segmentSentences(stored);
            let ts = snapped.start;
            let te = snapped.end;
            if (si !== -1 && ei !== -1 && storedSpans.length === liveSpans.length) {
              ts = storedSpans[si].start;
              te = storedSpans[ei].end;
            }
            mapped = mapTgtRangeToSrc(align, ts, te);
          }
        }
        if (mapped) {
          // cfi 统一存 live 英文块 DOM 坐标（与英文侧标注一致：anchorToRanges/mapSegment 均按
          // live 坐标消费）；text/context 同步用 live 文本切片（quote 兜底在 live DOM 查找）。
          // 对照模式取真实英文块（排除内嵌译文 div）；译文模式英文不在 DOM，按源文虚拟重建
          // （buildVirtualLiveSrc，与 rehype-katex 同源的 textContent 结构）。换算失败 highlight=null
          // （显式降级，不写源坐标——源坐标会被下游当 live 坐标消费，三处错开）。
          const enBlock = el.hasAttribute("data-translation") ? listBlocks(container)[blockIndex] : null;
          const liveEl = enBlock ?? buildVirtualLiveSrc(srcBlock.sourceText);
          const normLive = normalizeLiveElement(liveEl, enBlock ? "[data-translation]" : undefined);
          const liveOffsets = mapSourceOffsetsToLive(
            normalizeMathText(srcBlock.sourceText),
            normLive,
            mapped.ss,
            mapped.se,
          );
          const enText = liveOffsets ? normLive.raw.slice(liveOffsets.start, liveOffsets.end) : "";
          if (liveOffsets && enText.trim()) {
            highlight = {
              cfi: serializeAnchor({ v: 1, segments: [{ b: blockIndex, s: liveOffsets.start, e: liveOffsets.end }] }),
              text: enText,
              context: {
                before: normLive.raw.slice(Math.max(0, liveOffsets.start - PAPER_CONTEXT_LENGTH), liveOffsets.start),
                after: normLive.raw.slice(liveOffsets.end, liveOffsets.end + PAPER_CONTEXT_LENGTH),
              },
            };
          }
        }
      }
      setPopupState({
        kind: "translation",
        text,
        highlight,
        position: computePopupPosition(clamped.getBoundingClientRect(), PAPER_ANNO_POPUP_WIDTH_COMPACT),
      });
    },
    [computePopupPosition, setPopupState, translation, sourceBlocks],
  );

  // 左键 mouseup：有效选区 → 新建弹窗；折叠选区 → 命中已有高亮则回显弹窗，否则收起
  const handleMouseUp = useCallback(
    (event: React.MouseEvent) => {
      if (event.button !== 0 || !onCreateAnnotation) return;
      const container = contentRef.current;
      if (!container) return;
      const selection = window.getSelection();
      const range = selection && selection.rangeCount > 0 && !selection.isCollapsed ? selection.getRangeAt(0) : null;
      if (range) {
        const startElement =
          range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
        // 对照模式译文 div 划词：完整弹窗（译文不参与块枚举，标亮走句对齐映射而非锚点路径）
        const translationEl = startElement?.closest("[data-translation]");
        if (translationEl) {
          openTranslationPopup(translationEl, range);
          return;
        }
        // 译文模式：块内容即译文（未翻块保持英文）——同样按译文划词处理（有对齐才可标亮）
        if (viewMode === "translated") {
          const block = findBlockForNode(container, range.startContainer);
          if (block) openTranslationPopup(block, range);
          return;
        }
        openCreatePopupForRange(range);
        return;
      }
      const hit = hitTestAnnotation(event.clientX, event.clientY);
      if (hit) {
        setPopupState({
          kind: "existing",
          annotation: hit.annotation,
          position: computePopupPosition(hit.range.getBoundingClientRect(), PAPER_ANNO_POPUP_WIDTH),
        });
      } else {
        setPopupState(null);
      }
    },
    [
      onCreateAnnotation,
      computePopupPosition,
      hitTestAnnotation,
      setPopupState,
      openCreatePopupForRange,
      openTranslationPopup,
      viewMode,
    ],
  );

  // 右键：命中已有标注 → 回显弹窗（优先，与单击路径一致）；否则选中所在句 → 走新建弹窗路径
  const handleContextMenu = useCallback(
    (event: React.MouseEvent) => {
      if (!onCreateAnnotation) return; // 标注交互禁用时不接管右键
      const target = event.target;
      if (target instanceof Element && target.closest("img, pre, a")) return; // 链接/图片/代码块保留系统菜单
      const hit = hitTestAnnotation(event.clientX, event.clientY);
      if (hit) {
        event.preventDefault();
        setPopupState({
          kind: "existing",
          annotation: hit.annotation,
          position: computePopupPosition(hit.range.getBoundingClientRect(), PAPER_ANNO_POPUP_WIDTH),
        });
        return;
      }
      // 译文 div 不参与块枚举（句选无法锚定）：保留系统菜单（译文划词标亮走左键选区路径）
      if (target instanceof Element && target.closest("[data-translation]")) return;
      const found = locateSentenceAtPoint(event.clientX, event.clientY);
      if (!found || viewMode === "translated") return; // 不在句子上（或译文模式禁止句选新建）：保留系统菜单
      event.preventDefault();
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(found.range);
      openCreatePopupForRange(found.range);
    },
    [
      onCreateAnnotation,
      hitTestAnnotation,
      computePopupPosition,
      setPopupState,
      locateSentenceAtPoint,
      openCreatePopupForRange,
      viewMode,
    ],
  );

  // 滚动：关闭弹窗（原行为）；按缓存的句子 Range 同步覆盖层位置；顺手记滚动位置（P2 休眠还原用）
  const handleScroll = useCallback(() => {
    if (popupRef.current) setPopupState(null);
    if (hoverRangeRef.current) updateHoverRects();
    if (scrollRef.current) paperScrollMemory.set(paperDir, scrollRef.current.scrollTop);
  }, [setPopupState, updateHoverRects, paperDir]);

  const closePopup = useCallback(() => setPopupState(null), [setPopupState]);

  // 新建模式点高亮：以默认笔触/颜色创建，随后弹窗切到"已有标注"模式（展开笔触/颜色行，与书籍一致）
  const handlePopupHighlight = useCallback(async () => {
    const current = popupRef.current;
    if (!current) return;
    // 译文划词标亮（T2）：载荷是句对齐映射出的英文锚点（highlight 已由弹窗按钮禁用态保证非空）
    const draft =
      current.kind === "create"
        ? { cfi: current.cfi, text: current.text, context: current.context }
        : current.kind === "translation" && current.highlight
          ? current.highlight
          : null;
    if (!draft) return;
    const { style, color } = readDefaultStyleColor();
    const created = await onCreateAnnotation?.({
      cfi: draft.cfi,
      text: draft.text,
      style,
      color,
      note: "",
      context: draft.context,
    });
    window.getSelection()?.removeAllRanges();
    // 异步期间弹窗可能已被用户关闭（点外部/Escape/滚动），只在仍是同一弹窗时落地结果
    if (popupRef.current !== current) return;
    if (created) {
      setPopupState({ kind: "existing", annotation: created, position: current.position });
    } else {
      setPopupState(null);
    }
  }, [onCreateAnnotation, setPopupState]);

  // 已有模式改笔触/颜色（立即落库 + 弹窗内回显）
  const handlePopupStyleColorChange = useCallback(
    (style: HighlightStyle, color: HighlightColor) => {
      const current = popupRef.current;
      if (!current || current.kind !== "existing") return;
      onUpdateAnnotation?.(current.annotation.id, { style, color });
      setPopupState({ ...current, annotation: { ...current.annotation, style, color } });
    },
    [onUpdateAnnotation, setPopupState],
  );

  // 保存评论：仅"已有标注"回显态可写（更新评论，保存后关闭弹窗）
  const handlePopupSaveNote = useCallback(
    (note: string) => {
      const current = popupRef.current;
      if (!current || current.kind !== "existing") return;
      onUpdateAnnotation?.(current.annotation.id, { note });
      window.getSelection()?.removeAllRanges();
      // 异步期间弹窗可能已切换/关闭，只在仍是同一弹窗时关闭
      if (popupRef.current === current) setPopupState(null);
    },
    [onUpdateAnnotation, setPopupState],
  );

  const handlePopupCopy = useCallback(() => {
    const current = popupRef.current;
    if (!current) return;
    const text = current.kind === "existing" ? (current.annotation.text ?? "") : current.text;
    if (text) {
      navigator.clipboard?.writeText(text);
      toast.success("已复制");
    }
    window.getSelection()?.removeAllRanges();
    setPopupState(null);
  }, [setPopupState]);

  const handlePopupDelete = useCallback(() => {
    const current = popupRef.current;
    if (current?.kind === "existing") {
      onDeleteAnnotation?.(current.annotation.id);
    }
    setPopupState(null);
  }, [onDeleteAnnotation, setPopupState]);

  // Ask AI：选中文本/标注原文/译文划词作为 quote 注入论文助手输入框
  const handlePopupQuoteToChat = useCallback(() => {
    const current = popupRef.current;
    if (!current) return;
    const text = current.kind === "existing" ? (current.annotation.text ?? "") : current.text;
    if (text) onQuoteToChat?.(text);
    window.getSelection()?.removeAllRanges();
    setPopupState(null);
  }, [onQuoteToChat, setPopupState]);

  return (
    <>
      <div
        ref={scrollRef}
        className="relative h-full min-h-0 overflow-y-auto"
        onMouseUp={handleMouseUp}
        onMouseMove={handleMouseMove}
        onMouseLeave={clearHover}
        onContextMenu={handleContextMenu}
        onScroll={handleScroll}
      >
        <div
          ref={contentRef}
          className="paper-content prose prose-neutral dark:prose-invert mx-auto max-w-3xl prose-headings:scroll-mt-4 prose-img:rounded-lg px-8 py-6"
          style={{
            fontSize: fontSize != null ? `${fontSize}px` : undefined,
            fontFamily: fontFamily || undefined,
          }}
        >
          {hasMetadata && <MetadataBlock metadata={metadata} viewMode={viewMode} translatedMeta={translatedMeta} />}
          <ReactMarkdown
            remarkPlugins={[[remarkGfm, { singleTilde: false }], remarkMath]}
            rehypePlugins={[rehypeRaw, rehypeKatex, rehypeSlug, rehypeDelTilde]}
            components={components}
          >
            {renderedBody}
          </ReactMarkdown>
        </div>
        {hoverRects && (
          <div aria-hidden className="pointer-events-none absolute inset-0 z-10">
            {hoverRects.map((rect) => (
              <div
                key={`${rect.x}-${rect.y}`}
                className="paper-sentence-hover-rect"
                style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
              />
            ))}
          </div>
        )}
      </div>
      {popup && (
        <PaperAnnotationPopup
          x={popup.position.x}
          y={popup.position.y}
          annotation={popup.kind === "existing" ? popup.annotation : null}
          highlightDisabled={popup.kind === "translation" && !popup.highlight}
          highlightDisabledReason="该段尚无句对齐"
          onCopy={handlePopupCopy}
          onQuoteToChat={handlePopupQuoteToChat}
          onHighlight={handlePopupHighlight}
          onChangeStyleColor={handlePopupStyleColorChange}
          onSaveNote={handlePopupSaveNote}
          onDelete={popup.kind === "existing" ? handlePopupDelete : undefined}
          onClose={closePopup}
        />
      )}
      {imagePreview && (
        <PaperImagePreview image={imagePreview} onClose={() => setImagePreview(null)} onQuote={onQuoteImageToChat} />
      )}
    </>
  );
});

export default PaperReader;
