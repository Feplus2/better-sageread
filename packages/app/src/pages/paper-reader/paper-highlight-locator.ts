/**
 * C2「AI 重点句标亮」的 quote → 锚点本地换算器。
 *
 * 模型按 prompt 逐字摘录 Markdown 原文，但渲染后的 textContent 没有行内标记（**粗体**、`代码`、链接），
 * 且段落内换行在 DOM 文本中是空白折叠的——所以匹配前两侧都做"去行内标记 + 空白折叠"归一化：
 *
 * 1) findQuoteInBlockTexts（纯函数，可 node 直测）：逐块（listBlocks 枚举口径，自动跳过元数据/代码块）
 *    在折叠空白后的块文本里查找折叠后的 quote，经下标映射表还原为块 textContent 的原始字符区间；
 * 2) snapRangeToSentences 把命中区间吸附到整句边界（AI 标亮按句着色，避免半句高亮）；
 * 3) DOM 层把吸附后的区间 charOffsetToPoint 成 Range，rangeToAnchor 建锚点、extractContext 取上下文。
 *
 * 逐块匹配不到（quote 跨段落）时退到整容器 findQuoteRange 精确兜底；
 * 兜底命中元数据块/代码块时 rangeToAnchor 返回 null → 丢弃（调用方计数）。
 */

import {
  charOffsetToPoint,
  extractContext,
  findQuoteRange,
  listBlocks,
  rangeToAnchor,
  serializeAnchor,
} from "./paper-anchors";
import { segmentSentences, snapRangeToSentences } from "./paper-sentences";

/** 待落库的锚点换算产物（cfi 存 book_notes.cfi，text/context 供侧栏与重锚定兜底） */
export interface PaperHighlightLocation {
  cfi: string;
  text: string;
  context: { before: string; after: string };
}

/** 块内命中区间（start 含、end 不含，基于块 textContent 原始下标） */
export interface BlockQuoteMatch {
  block: number;
  start: number;
  end: number;
}

/** quote 归一化：去 Markdown 行内标记（对齐 markdown-sections 的 stripInlineMarkdown）+ 空白折叠 */
export function normalizeQuoteForMatch(quote: string): string {
  return quote
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 空白折叠文本 + 折叠下标 → 原始下标的映射表。
 * 折叠出的空格映射到其空白串首字符（句吸附会吸收边界误差，无需精确到空白串末尾）。
 */
function collapseWithMap(text: string): { collapsed: string; map: number[] } {
  let collapsed = "";
  const map: number[] = [];
  let spaceStart = -1;
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) {
      if (collapsed.length > 0 && spaceStart === -1) spaceStart = i;
      continue;
    }
    if (spaceStart !== -1) {
      collapsed += " ";
      map.push(spaceStart);
      spaceStart = -1;
    }
    collapsed += text[i];
    map.push(i);
  }
  return { collapsed, map };
}

/**
 * 逐块模糊匹配 quote（大小写不敏感、空白折叠、去行内标记）。
 * 返回首个命中的块与还原后的原始字符区间；所有块都不命中返回 null（调用方走整容器兜底）。
 */
export function findQuoteInBlockTexts(blockTexts: string[], quote: string): BlockQuoteMatch | null {
  const needle = normalizeQuoteForMatch(quote).toLowerCase();
  if (!needle) return null;
  for (let b = 0; b < blockTexts.length; b++) {
    const { collapsed, map } = collapseWithMap(blockTexts[b]);
    const index = collapsed.toLowerCase().indexOf(needle);
    if (index === -1) continue;
    const start = map[index];
    const end = map[index + needle.length - 1] + 1;
    if (start < end) return { block: b, start, end };
  }
  return null;
}

/** 命中区间吸附到块内整句边界（segmentSentences + snapRangeToSentences，纯函数） */
export function snapMatchToSentences(
  blockText: string,
  start: number,
  end: number,
): { start: number; end: number } | null {
  return snapRangeToSentences(segmentSentences(blockText), start, end);
}

/**
 * quote → 锚点换算主入口（依赖渲染后的正文容器）。
 * 命中但吸附/建锚失败、或只能匹配到元数据块时返回 null（调用方丢弃计数）。
 */
export function locateQuoteInPaper(container: Element, quote: string): PaperHighlightLocation | null {
  const blocks = listBlocks(container);
  const match = findQuoteInBlockTexts(
    blocks.map((block) => block.textContent ?? ""),
    quote,
  );
  if (match) {
    const block = blocks[match.block];
    const snapped = snapMatchToSentences(block.textContent ?? "", match.start, match.end);
    if (snapped) {
      const startPoint = charOffsetToPoint(block, snapped.start);
      const endPoint = charOffsetToPoint(block, snapped.end);
      if (startPoint && endPoint) {
        const range = document.createRange();
        range.setStart(startPoint.node, startPoint.offset);
        range.setEnd(endPoint.node, endPoint.offset);
        const anchor = rangeToAnchor(container, range);
        if (anchor) {
          return { cfi: serializeAnchor(anchor), text: range.toString(), context: extractContext(container, range) };
        }
      }
    }
  }

  // 跨段落 quote 兜底：整容器精确查找（命中元数据/代码块时建锚失败 → null）
  const fallback = findQuoteRange(container, quote.trim());
  if (!fallback) return null;
  const anchor = rangeToAnchor(container, fallback);
  if (!anchor) return null;
  return { cfi: serializeAnchor(anchor), text: fallback.toString(), context: extractContext(container, fallback) };
}
