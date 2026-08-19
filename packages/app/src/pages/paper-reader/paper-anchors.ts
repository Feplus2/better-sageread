/**
 * 论文（Markdown 阅读区）标注锚点工具。
 *
 * 锚点存 book_notes.cfi 列，JSON 格式：
 *   {"v":1,"segments":[{"b":12,"s":5,"e":40},...]}
 * 按文档顺序枚举正文容器的"叶子"块级元素（p/li/h1-h6/blockquote/td/th/figcaption，
 * 只取最外层匹配块，嵌套块如 li>p、blockquote>p 归入祖先块），
 * 记录选区在每个相交块内的字符偏移（基于块 textContent）。
 *
 * 重锚定：同一渲染产物下按同样规则枚举块，用 TreeWalker 在块内按偏移重建 Range；
 * 块失配（论文内容变更导致索引/长度对不上）时返回 null，调用方用 text quote 全文模糊兜底
 * （findQuoteRange：TreeWalker 拼接全文文本查找，与本文内搜索同思路）。
 */

/** 参与锚点枚举的块级元素 */
const BLOCK_SELECTOR = "p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, figcaption";

/** 元数据块（标题/作者/摘要等）的 DOM 标记：内部元素不参与锚点枚举（展开/收起摘要会增删块，必须排除） */
const METADATA_SELECTOR = "[data-paper-metadata]";

/** 对照模式插入的译文块标记：与元数据块同级排除，保证块索引与原文枚举一致（标注/搜索/TOC 不错位） */
const TRANSLATION_SELECTOR = "[data-translation]";

/** 锚点枚举排除标记（元数据块 + 译文块） */
const EXCLUDED_SELECTOR = `${METADATA_SELECTOR}, ${TRANSLATION_SELECTOR}`;

/** 上下文摘录长度（context_before / context_after 各取多少字符） */
export const PAPER_CONTEXT_LENGTH = 50;

export interface PaperAnchorSegment {
  /** 块索引（listBlocks 枚举顺序） */
  b: number;
  /** 选区起点在块 textContent 内的字符偏移 */
  s: number;
  /** 选区终点在块 textContent 内的字符偏移 */
  e: number;
}

export interface PaperAnchor {
  v: 1;
  segments: PaperAnchorSegment[];
}

/**
 * 枚举正文容器内参与锚点的块级元素（文档顺序）。
 * 只保留"最外层"匹配块（祖先已是块的元素归入祖先块，保证各块文本互不重叠）；
 * 跳过元数据块内部的元素。
 */
export function listBlocks(container: Element): Element[] {
  const all = Array.from(container.querySelectorAll(BLOCK_SELECTOR));
  return all.filter((el) => {
    if (el.closest(EXCLUDED_SELECTOR)) return false;
    let node = el.parentElement;
    while (node && node !== container) {
      if (node.matches(BLOCK_SELECTOR)) return false;
      node = node.parentElement;
    }
    return true;
  });
}

/** 节点所属的"最外层"锚点块（与 listBlocks 同一规则：排除元数据块与译文块，嵌套块归祖先）；不在任何块内返回 null */
export function findBlockForNode(container: Element, node: Node): Element | null {
  let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element | null);
  let outer: Element | null = null;
  while (el && el !== container) {
    if (el.matches(BLOCK_SELECTOR)) outer = el;
    el = el.parentElement;
  }
  if (!outer || outer.closest(EXCLUDED_SELECTOR)) return null;
  return outer;
}

/** 块起点到 (node, offset) 边界点的字符数（Range.toString 即 textContent 口径的文本长度） */
export function offsetFromBlockStart(block: Element, node: Node, offset: number): number {
  const range = document.createRange();
  range.selectNodeContents(block);
  range.setEnd(node, offset);
  return range.toString().length;
}

/** 块内字符偏移 → (文本节点, 节点内偏移)；偏移超出块文本长度（块失配）时返回 null */
export function charOffsetToPoint(block: Element, target: number): { node: Text; offset: number } | null {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let chars = 0;
  let node = walker.nextNode() as Text | null;
  while (node) {
    const len = node.data.length;
    if (target <= chars + len) {
      return { node, offset: target - chars };
    }
    chars += len;
    node = walker.nextNode() as Text | null;
  }
  return null;
}

/** 把（可能跨出容器的）选区夹取到容器范围内；完全在容器外或夹取后为空返回 null */
export function clampRangeToContainer(container: Element, range: Range): Range | null {
  const containerRange = document.createRange();
  containerRange.selectNodeContents(container);
  // 注意 compareBoundaryPoints 的历史怪癖：START_TO_END 比较 this.end 与 other.start，END_TO_START 比较 this.start 与 other.end
  if (range.compareBoundaryPoints(Range.START_TO_END, containerRange) <= 0) return null; // 选区在容器之前结束
  if (range.compareBoundaryPoints(Range.END_TO_START, containerRange) >= 0) return null; // 选区在容器之后开始
  const clamped = range.cloneRange();
  if (range.compareBoundaryPoints(Range.START_TO_START, containerRange) < 0) {
    clamped.setStart(container, 0);
  }
  if (range.compareBoundaryPoints(Range.END_TO_END, containerRange) > 0) {
    clamped.setEnd(container, container.childNodes.length);
  }
  return clamped.collapsed ? null : clamped;
}

/** 选区 → 锚点（按块切分；无相交块时返回 null，例如选区落在代码块 pre 内） */
export function rangeToAnchor(container: Element, range: Range): PaperAnchor | null {
  const blocks = listBlocks(container);
  const segments: PaperAnchorSegment[] = [];
  for (let b = 0; b < blocks.length; b++) {
    const block = blocks[b];
    const blockRange = document.createRange();
    blockRange.selectNodeContents(block);
    // compareBoundaryPoints 怪癖同上：START_TO_END 比 this.end/other.start，END_TO_START 比 this.start/other.end
    // 选区在本块之前结束（end <= block.start）→ 后续块不再相交
    if (range.compareBoundaryPoints(Range.START_TO_END, blockRange) <= 0) break;
    // 选区在本块之后开始（start >= block.end）→ 跳过本块
    if (range.compareBoundaryPoints(Range.END_TO_START, blockRange) >= 0) continue;
    const startsInside = range.compareBoundaryPoints(Range.START_TO_START, blockRange) >= 0;
    const endsInside = range.compareBoundaryPoints(Range.END_TO_END, blockRange) <= 0;
    const s = startsInside ? offsetFromBlockStart(block, range.startContainer, range.startOffset) : 0;
    const e = endsInside
      ? offsetFromBlockStart(block, range.endContainer, range.endOffset)
      : (block.textContent ?? "").length;
    if (e > s) segments.push({ b, s, e });
  }
  return segments.length > 0 ? { v: 1, segments } : null;
}

/** 锚点 → 每相交块一个 Range；块索引缺失或偏移越界（块失配）返回 null，调用方走 quote 兜底 */
export function anchorToRanges(container: Element, anchor: PaperAnchor): Range[] | null {
  if (anchor.v !== 1 || anchor.segments.length === 0) return null;
  const blocks = listBlocks(container);
  const ranges: Range[] = [];
  for (const segment of anchor.segments) {
    const block = blocks[segment.b];
    if (!block) return null;
    const start = charOffsetToPoint(block, segment.s);
    const end = charOffsetToPoint(block, segment.e);
    if (!start || !end) return null;
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    ranges.push(range);
  }
  return ranges;
}

/** text quote 兜底：容器全文（跨文本节点、跨块）查找首个匹配，命中返回 Range */
export function findQuoteRange(container: Element, quote: string): Range | null {
  return findQuoteRangeExcluding(container, quote, null);
}

/**
 * findQuoteRange 排除变体：跳过边界点落在 excludeSelector 匹配元素内的命中
 * （文内 # 链接跳转兜底：链接文字的首个命中往往是被点击的链接自身或正文公式，需跳过）。
 */
export function findQuoteRangeExcluding(
  container: Element,
  quote: string,
  excludeSelector: string | null,
): Range | null {
  const needle = quote.trim().toLowerCase();
  if (!needle) return null;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let combined = "";
  let node = walker.nextNode() as Text | null;
  while (node) {
    nodes.push(node);
    combined += node.data;
    node = walker.nextNode() as Text | null;
  }
  const haystack = combined.toLowerCase();
  const locate = (target: number): { node: Text; offset: number } | null => {
    let chars = 0;
    for (const n of nodes) {
      const len = n.data.length;
      if (target <= chars + len) return { node: n, offset: target - chars };
      chars += len;
    }
    return null;
  };
  const excluded = (point: { node: Text } | null) =>
    excludeSelector !== null && point?.node.parentElement?.closest(excludeSelector) != null;
  let searchFrom = 0;
  while (searchFrom <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, searchFrom);
    if (index === -1) return null;
    const start = locate(index);
    const end = locate(index + needle.length);
    if (start && end && !excluded(start) && !excluded(end)) {
      const range = document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      return range;
    }
    searchFrom = index + 1;
  }
  return null;
}

/** 选区前后各截取约 length 字符的上下文（空白折叠，供侧栏 "…before + quote + after…" 展示） */
export function extractContext(
  container: Element,
  range: Range,
  length = PAPER_CONTEXT_LENGTH,
): { before: string; after: string } {
  const beforeRange = document.createRange();
  beforeRange.selectNodeContents(container);
  beforeRange.setEnd(range.startContainer, range.startOffset);
  const afterRange = document.createRange();
  afterRange.selectNodeContents(container);
  afterRange.setStart(range.endContainer, range.endOffset);
  const before = beforeRange.toString().replace(/\s+/g, " ").trimStart().slice(-length);
  const after = afterRange.toString().replace(/\s+/g, " ").trimEnd().slice(0, length);
  return { before, after };
}

/** 解析 cfi 列的锚点 JSON；非法内容返回 null */
export function parseAnchor(cfi: string): PaperAnchor | null {
  try {
    const parsed = JSON.parse(cfi) as PaperAnchor;
    if (parsed?.v !== 1 || !Array.isArray(parsed.segments)) return null;
    const valid = parsed.segments.every(
      (s) => typeof s?.b === "number" && typeof s?.s === "number" && typeof s?.e === "number",
    );
    return valid ? parsed : null;
  } catch {
    return null;
  }
}

/** 序列化锚点（存 cfi 列） */
export function serializeAnchor(anchor: PaperAnchor): string {
  return JSON.stringify(anchor);
}
