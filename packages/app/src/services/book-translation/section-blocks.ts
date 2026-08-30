/**
 * 书籍翻译的段落枚举与译文注入（共享契约模块，docs/book-translation-plan.md）。
 *
 * 定位键 = spineIndex（章序）+ 段序号 + 段文本 hash。段序号的契约保障是**结构性的**：
 * 翻译服务（createDocument 读原文）与渲染注入 transformer（transform 管道的 XHTML 字符串）
 * 必须共用本模块的同一套 parse → enumerate → [inject] → serialize——枚举者与注入者是
 * 同一段代码，从结构上杜绝错位（替代论文侧 test-paper-blocks-consistency 的契约测试）。
 *
 * 两端输入有已知的可容忍差异：transform 管道先经 rawmath/punctuation/footnote 变换
 * （可能改写标点/加 class），因此**注入侧按段序号取译文、不校验 hash**；hash 仅用于
 * 翻译服务的幂等续翻（对原文计）与对齐缓存键。EPUB 原文件入库后不变，段序号稳定。
 *
 * 一期边界：EPUB 弹出脚注（aside[epub:type=footnote 族）不翻译；译文为纯文本
 * （textContent 提取，原文内联格式不保留）——二期词句对齐交互层同此坐标系。
 */

/** 块级候选选择器（与 use-annotator 块级容器、论文侧 TRANSLATION_SELECTOR 口径对齐） */
const BLOCK_SELECTOR = "p, li, h1, h2, h3, h4, h5, h6, blockquote, dd, dt, td, th, figcaption";

/** 注入译文块的标记属性（枚举时排除自身，避免二次翻译/二次注入） */
export const TRANSLATION_ATTR = "data-book-translation";

const XHTML_NS = "http://www.w3.org/1999/xhtml";

export interface SectionBlock {
  /** 章内段序号（0 起，仅对 translatable 的块连续编号——与译本 JSON 的 blocks 键一致） */
  index: number;
  /** 规范化空白后的段源文本（翻译输入 + hash 基准） */
  sourceText: string;
  el: Element;
}

export interface ParsedSection {
  doc: Document;
  /** true = XML 解析成功（XHTML）；false = parsererror 回退 text/html（烂 EPUB 兜底） */
  isXml: boolean;
}

/** 解析章节 XHTML：优先 XML 模式（与 foliate-js EPUB parser 同口径），parsererror 回退 text/html */
export function parseSectionDocument(content: string): ParsedSection {
  const xml = new DOMParser().parseFromString(content, "application/xhtml+xml");
  if (!xml.querySelector("parsererror")) return { doc: xml, isXml: true };
  // 烂 XHTML 兜底：HTML 模式宽容解析（foliate 渲染端 iframe 同样宽容），枚举坐标系不漂移
  const html = new DOMParser().parseFromString(content, "text/html");
  return { doc: html, isXml: false };
}

/** 包装既有 Document（翻译/对齐服务走 foliate createDocument 直读原文时的入口；
 *  isXml 按 contentType 判定——XML 模式解析产物为 application/xhtml+xml / application/xml） */
export function wrapSectionDocument(doc: Document): ParsedSection {
  const type = doc.contentType ?? "";
  return { doc, isXml: !type.startsWith("text/html") };
}

/** 序列化回字符串（transformer 写回管道；isXml 决定序列化器） */
export function serializeSectionDocument(parsed: ParsedSection): string {
  if (parsed.isXml) return new XMLSerializer().serializeToString(parsed.doc);
  return parsed.doc.documentElement.outerHTML;
}

/** 空白规范化：\s+ → 单空格 + trim（hash 与翻译输入的稳定形态） */
function normalizeBlockText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

const FOOTNOTE_EPUB_TYPES = new Set(["footnote", "endnote", "note", "rearnote"]);

/** 段落是否处于脚注 aside 内（EPUB 弹出脚注一期不翻译） */
function isInFootnoteAside(el: Element): boolean {
  for (const aside of Array.from(el.closest("body")?.querySelectorAll("aside") ?? [])) {
    if (!el.contains(aside) && aside.contains(el)) {
      const type = aside.getAttribute("epub:type") ?? aside.getAttribute("type") ?? "";
      if (type.split(/\s+/).some((t) => FOOTNOTE_EPUB_TYPES.has(t))) return true;
    }
  }
  return false;
}

/** 段源文本：排除已注入译文块的文本（td 场景译文是子元素，textContent 会混入；
 *  无译文块时零开销直读） */
function blockTextWithoutTranslations(el: Element): string {
  if (!el.querySelector(`[${TRANSLATION_ATTR}]`)) return el.textContent ?? "";
  const clone = el.cloneNode(true) as Element;
  for (const node of Array.from(clone.querySelectorAll(`[${TRANSLATION_ATTR}]`))) node.remove();
  return clone.textContent ?? "";
}

const HAS_CONTENT_RE = /[A-Za-z0-9\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

/** 可翻译判定：规范化后有实际内容（≥2 字符且含字母/数字/CJK，排除纯标点/页码装饰） */
function isTranslatableText(text: string): boolean {
  return text.length >= 2 && HAS_CONTENT_RE.test(text);
}

/**
 * 枚举章节可翻译段落（文档顺序，跳过嵌套外层块——li>p 只翻 p、纯文本 li 翻 li；
 * 跳过注入的译文块与脚注 aside）。段序号 = 可翻译块的文档序号（连续）。
 */
export function enumerateSectionBlocks(parsed: ParsedSection): SectionBlock[] {
  const blocks: SectionBlock[] = [];
  const candidates = Array.from(parsed.doc.querySelectorAll(BLOCK_SELECTOR));
  for (const el of candidates) {
    if (el.closest(`[${TRANSLATION_ATTR}]`)) continue; // 已注入的译文块（重入幂等）
    if (el.querySelector(BLOCK_SELECTOR)) continue; // 外层容器块：只取叶子块，避免重复翻译同段文字
    if (isInFootnoteAside(el)) continue; // EPUB 弹出脚注一期不翻译
    const sourceText = normalizeBlockText(blockTextWithoutTranslations(el));
    if (!isTranslatableText(sourceText)) continue;
    blocks.push({ index: blocks.length, sourceText, el });
  }
  return blocks;
}

// ─── 段内偏移映射（二期批次 4：交互层地基） ───
// 对齐表（align/alignW）的偏移基于规范化段文本（normalizeBlockText：\s+ 折叠单空格+trim），
// 而渲染 DOM 的 textContent 含原始空白且分布在多个文本节点（内联标签）——交互层
// （hover 联动/划词卡）需要两侧坐标双向换算。映射基于**真实 DOM 文本节点**构建
// （caret 命中的是真实偏移），排除译文块子树（td 场景译文是子元素）。

export interface BlockTextMap {
  /** 规范化文本（=== 该段的 sourceText 坐标系） */
  norm: string;
  /** norm[i] 在 raw 中的下标 */
  normToRaw: number[];
  /** raw[i] 在 norm 中的下标（折叠/前导空白为 -1 或最近前保留位） */
  rawToNorm: number[];
  /** 参与拼接的真实文本节点及各自在 raw 坐标系的起点（Range 定位用） */
  nodes: { node: Text; start: number }[];
}

/** 收集元素下的文本节点（文档序，排除 [data-book-translation] 子树——td 场景译文是子元素；
 *  手写递归而非 TreeWalker：文本节点须属于所在 iframe 文档的 Node 常量域，跨 doc 安全） */
function collectTextNodes(el: Element): Text[] {
  const out: Text[] = [];
  const isText = (node: Node) => node.nodeType === 3; // TEXT_NODE
  const isElement = (node: Node) => node.nodeType === 1; // ELEMENT_NODE
  const walk = (node: Node) => {
    if (isText(node)) {
      out.push(node as Text);
      return;
    }
    if (isElement(node) && (node as Element).hasAttribute(TRANSLATION_ATTR)) return; // 译文块子树不参与
    for (const child of Array.from(node.childNodes)) walk(child);
  };
  walk(el);
  return out;
}

const textMapCache = new WeakMap<Element, BlockTextMap>();

/** 构建段内偏移映射（per-element WeakMap 缓存；章节重载后 el 引用变化自动失效） */
export function buildBlockTextMap(el: Element): BlockTextMap {
  const cached = textMapCache.get(el);
  if (cached) return cached;

  const nodes: { node: Text; start: number }[] = [];
  let raw = "";
  let norm = "";
  const normToRaw: number[] = [];
  const rawToNorm: number[] = [];

  for (const node of collectTextNodes(el)) {
    nodes.push({ node, start: raw.length });
    for (const ch of node.data) {
      const rawIdx = raw.length;
      raw += ch;
      if (/\s/.test(ch)) {
        // 折叠：norm 已有内容且末尾非空白 → 保留一个空格；否则跳过（前导/连续空白）
        if (norm.length > 0 && !norm.endsWith(" ")) {
          rawToNorm.push(norm.length);
          norm += " ";
          normToRaw.push(rawIdx);
        } else {
          rawToNorm.push(norm.length > 0 ? norm.length - 1 : -1); // 折叠空白归属前一保留字符
        }
      } else {
        rawToNorm.push(norm.length);
        norm += ch;
        normToRaw.push(rawIdx);
      }
    }
  }
  // trim 尾部：构造中尾部空格可能已保留，剥掉
  while (norm.endsWith(" ")) {
    norm = norm.slice(0, -1);
    normToRaw.pop();
  }

  const map: BlockTextMap = { norm, normToRaw, rawToNorm, nodes };
  textMapCache.set(el, map);
  return map;
}

/** caret 命中（文本节点 + 节点内偏移）→ raw 坐标偏移；节点不属于该段返回 null */
export function rawOffsetOf(el: Element, node: Node, nodeOffset: number): number | null {
  const map = buildBlockTextMap(el);
  for (const entry of map.nodes) {
    if (entry.node === node) return entry.start + nodeOffset;
  }
  return null;
}

/** raw 偏移 → norm 偏移（折叠/前导空白吸附到最近保留位；越界钳制） */
export function rawToNormOffset(map: BlockTextMap, rawOffset: number): number {
  const clamped = Math.max(0, Math.min(rawOffset, map.rawToNorm.length - 1));
  const normIdx = map.rawToNorm[clamped];
  if (normIdx === -1) return 0;
  return Math.min(normIdx, map.norm.length - 1);
}

/** norm 半开区间 [start, end) → 反侧文本节点坐标系中的 Range；区间退化返回 null */
export function normToRange(el: Element, map: BlockTextMap, start: number, end: number): Range | null {
  if (end <= start || map.nodes.length === 0) return null;
  const s = Math.max(0, Math.min(start, map.norm.length - 1));
  const e = Math.max(s + 1, Math.min(end, map.norm.length));
  const rawStart = map.normToRaw[s];
  const rawEnd = (map.normToRaw[e - 1] ?? map.normToRaw[map.normToRaw.length - 1]) + 1;
  const doc = el.ownerDocument;
  if (!doc) return null;

  const locate = (rawOffset: number): { node: Text; offset: number } | null => {
    for (const entry of map.nodes) {
      const len = entry.node.data.length;
      if (rawOffset <= entry.start + len) return { node: entry.node, offset: Math.max(0, rawOffset - entry.start) };
    }
    const last = map.nodes[map.nodes.length - 1];
    return { node: last.node, offset: last.node.data.length };
  };
  const from = locate(rawStart);
  const to = locate(rawEnd);
  if (!from || !to) return null;
  try {
    const range = doc.createRange();
    range.setStart(from.node, Math.min(from.offset, from.node.data.length));
    range.setEnd(to.node, Math.min(to.offset, to.node.data.length));
    return range;
  } catch {
    return null;
  }
}

/** 段的既有译文块：td/th 场景在段内部，其余场景是紧随其后的兄弟节点 */
function findExistingTranslation(el: Element, index: number): Element | null {
  const inside = el.querySelector(`[${TRANSLATION_ATTR}][data-block-index="${index}"]`);
  if (inside) return inside;
  const next = el.nextElementSibling;
  if (next?.hasAttribute(TRANSLATION_ATTR) && next.getAttribute("data-block-index") === String(index)) {
    return next;
  }
  return null;
}

/**
 * 向章节文档注入译文块：每个有译文的段落挂一个
 * `<div class="translation-target translation-target-block" data-book-translation>`（纯文本填充，
 * 天然免 XSS）。td/th 内部 append（表格行间插 div 非法），其余 after。
 * 替换/更新语义：同段已有译文块时更新其文本（重入不重复）；无译文的段若有旧块则移除。
 * 原文段同步标注 `translation-source` 类 + `data-block-index`（译文模式隐藏原文的钩子，
 * 由 getTranslationStyles 按 bookViewMode 编译；td/th 不加——整格隐藏会连译文一起藏，
 * 表格段在译文模式下原文照常显示，属已知取舍；data-block-index 供交互层定位）。
 * 显示与否由 CSS 控制——开关切换即时生效，无需重载章节。
 */
export function injectSectionTranslations(
  parsed: ParsedSection,
  blocks: SectionBlock[],
  translations: Record<string, { text: string }>,
): number {
  const doc = parsed.doc;
  const isCell = (el: Element) => {
    const tag = el.tagName.toLowerCase();
    return tag === "td" || tag === "th";
  };
  let injected = 0;
  for (const block of blocks) {
    const entry = translations[String(block.index)];
    const existing = findExistingTranslation(block.el, block.index);
    if (!entry?.text) {
      existing?.remove(); // 译文被清空（force 重翻中途态）：旧块移除
      block.el.classList.remove("translation-source");
      block.el.removeAttribute("data-block-index");
      continue;
    }
    // 定位标两种段都加（交互层配对用）；隐藏钩子只加非表格段（td 整格隐藏会连译文一起藏）
    block.el.setAttribute("data-block-index", String(block.index));
    if (!isCell(block.el)) {
      block.el.classList.add("translation-source"); // 译文模式隐藏原文的钩子（display:none 由 CSS 编译）
    }
    if (existing) {
      existing.textContent = entry.text; // 更新语义：重入不重复
      injected += 1;
      continue;
    }
    const div = doc.createElementNS(XHTML_NS, "div");
    div.setAttribute("class", "translation-target translation-target-block");
    div.setAttribute(TRANSLATION_ATTR, "");
    div.setAttribute("data-block-index", String(block.index));
    div.textContent = entry.text;
    if (isCell(block.el)) block.el.appendChild(div);
    else block.el.after(div);
    injected += 1;
  }
  return injected;
}
