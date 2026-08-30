/**
 * 书籍翻译交互层（二期批次 4d，docs/book-translation-plan.md）：标注镜像——
 * 书籍标注（book_notes CFI，本体由 foliate overlayer SVG 绘制、只认 CFI 锚点）在对侧语言上的
 * 常驻镜像高亮（原文标注 → 译文对应区间镜像，反向亦然，效果对齐论文阅读器 paper-reader.tsx
 * 的标注镜像 effect）。
 *
 * 锚定链：标注 CFI → view.resolveCFI 反解（与 foliate addAnnotation 同一入口，同步）
 * → 本章 Range → 按 [data-block-index] 段拆分（跨段标注逐段镜像）→ section-blocks 偏移映射
 * （rawBoundaryToNorm 边界换算）得 norm 偏移 → 查对齐表（词级优先/句级吸附回退，复用论文侧
 * mapSrcRangeToTgt/mapTgtRangeToSrc）→ 镜像区间 norm → 对侧段 normToRange → 对侧 Range。
 *
 * 呈现：CSS Custom Highlight 常驻层（注册名 book-align-mirror-*，15 个 = 3 笔触 × 5 色，
 * 见 constants.bookMirrorHighlightName；与 hover 层 book-align-hover 分开）。零 DOM 改动，
 * 不污染 overlayer 坐标系。镜像色与标注同色、透明度弱于本体（规则随 getTranslationStyles
 * 注入 iframe；译文模式原文隐藏时镜像仍落在可见的译文侧——镜像的核心场景）。
 *
 * 时机挂钩（常驻状态全生命周期）：章节 load 事件 + getContents 冷启动补算（4b 同款教训）、
 * 标注增删改（config.booknotes 订阅）、翻译/对齐任务收尾（book-translation-updated → 缓存失效
 * + 重算）、显示模式切换（enabled 变化即重挂/卸载清理）、视图休眠重建（view 订阅重跑）。
 * 翻页/resize 重排无需处理：Range 是活引用、文档不重建，CSS Highlight 随布局自动重绘；
 * 章节文档若被 foliate 重建则走 load 路径重新注册。
 *
 * 护栏：镜像失败/映射缺失/无对齐数据的段一律静默跳过，绝不影响标注本体绘制。
 */

import { mapSrcRangeToTgt, mapTgtRangeToSrc } from "@/pages/paper-reader/paper-cross-anchor";
import {
  type BookTranslationSectionFile,
  loadBookTranslationSection,
} from "@/services/book-translation/book-translation-service";
import {
  type BlockTextMap,
  TRANSLATION_ATTR,
  buildBlockTextMap,
  normToRange,
  rawBoundaryToNorm,
  rawOffsetOf,
} from "@/services/book-translation/section-blocks";
import { BOOK_MIRROR_HIGHLIGHT_NAMES, bookMirrorHighlightName } from "@/services/constants";
import type { BookNote } from "@/types/book";
import type { FoliateView } from "@/types/view";
import { useEffect, useRef, useState } from "react";
import { useReaderStore, useReaderStoreApi } from "../components/reader-provider";

/** Range 端点 → 块内 norm 偏移（边界语义，rawBoundaryToNorm）。
 *  文本节点：rawOffsetOf 定位后边界换算；元素节点：CFI 反解落在文本节点，元素级边界
 *  仅来自跨段拆分的段界钳制 → 段首/段尾。 */
function pointToNormOffset(
  el: Element,
  map: BlockTextMap,
  node: Node,
  offset: number,
  side: "start" | "end",
): number | null {
  if (node.nodeType === 3) {
    const raw = rawOffsetOf(el, node, offset);
    return raw === null ? null : rawBoundaryToNorm(map, raw);
  }
  if (node === el || el.contains(node)) return side === "start" ? 0 : map.norm.length;
  return null;
}

/** 同段的另一侧元素（原文段 / 译文 div，按 data-block-index 配对；td 场景译文是子元素） */
function findCounterpart(doc: Document, el: Element, wantTgt: boolean): Element | null {
  const idx = el.getAttribute("data-block-index");
  if (idx === null) return null;
  for (const cand of Array.from(doc.querySelectorAll(`[data-block-index="${idx}"]`))) {
    if (cand === el) continue;
    if (cand.hasAttribute(TRANSLATION_ATTR) === wantTgt) return cand;
  }
  return null;
}

/** 单段内标注片段 → 对侧镜像 Range 列表（无对齐/无对侧段/映射失败静默跳过） */
function mirrorBlockSegment(
  doc: Document,
  file: BookTranslationSectionFile,
  blockEl: Element,
  segment: Range,
): Range[] {
  const idx = blockEl.getAttribute("data-block-index");
  const entry = idx !== null ? file.blocks[idx] : undefined;
  if (!entry || (!entry.align?.length && !entry.alignW?.length)) return [];
  const counterpart = findCounterpart(doc, blockEl, !blockEl.hasAttribute(TRANSLATION_ATTR));
  if (!counterpart) return [];
  const map = buildBlockTextMap(blockEl);
  const s = pointToNormOffset(blockEl, map, segment.startContainer, segment.startOffset, "start");
  const e = pointToNormOffset(blockEl, map, segment.endContainer, segment.endOffset, "end");
  if (s === null || e === null || e <= s) return [];
  const cMap = buildBlockTextMap(counterpart);
  const out: Range[] = [];
  if (blockEl.hasAttribute(TRANSLATION_ATTR)) {
    // 译文侧标注 → 原文镜像（词级优先、句级吸附回退：mapTgtRangeToSrc 内部同款取舍）
    const mapped = mapTgtRangeToSrc(entry.align ?? [], s, e, entry.alignW);
    if (mapped) {
      const range = normToRange(counterpart, cMap, mapped.ss, mapped.se);
      if (range) out.push(range);
    }
  } else {
    for (const { ts, te } of mapSrcRangeToTgt(entry.align ?? [], s, e, entry.alignW) ?? []) {
      const range = normToRange(counterpart, cMap, ts, te);
      if (range) out.push(range);
    }
  }
  return out;
}

/** 标注 Range → 全部镜像 Range（跨段标注按 [data-block-index] 块拆分钳制，逐段映射） */
function mirrorRangesForRange(
  doc: Document,
  file: BookTranslationSectionFile,
  blockEls: Element[],
  range: Range,
): Range[] {
  const out: Range[] = [];
  for (const blockEl of blockEls) {
    try {
      if (!range.intersectsNode(blockEl)) continue;
      const blockRange = doc.createRange();
      blockRange.selectNodeContents(blockEl);
      // intersectsNode 边界误报（贴边不相交）：完全在块外的跳过
      if (blockRange.comparePoint(range.startContainer, range.startOffset) === 1) continue;
      if (blockRange.comparePoint(range.endContainer, range.endOffset) === -1) continue;
      const segment = range.cloneRange();
      if (blockRange.comparePoint(segment.startContainer, segment.startOffset) === -1)
        segment.setStart(blockRange.startContainer, blockRange.startOffset);
      if (blockRange.comparePoint(segment.endContainer, segment.endOffset) === 1)
        segment.setEnd(blockRange.endContainer, blockRange.endOffset);
      if (segment.collapsed) continue;
      out.push(...mirrorBlockSegment(doc, file, blockEl, segment));
    } catch {
      /* 节点脱离文档等竞态：静默跳过 */
    }
  }
  return out;
}

/** 计算一章的全部镜像：标注 CFI 反解 → 本章 Range → 分块映射 → 按镜像注册名（笔触×颜色）聚合 */
function computeSectionMirrors(
  doc: Document,
  view: FoliateView,
  index: number,
  file: BookTranslationSectionFile,
  annotations: BookNote[],
): Map<string, Range[]> {
  const byName = new Map<string, Range[]>();
  const blockEls = Array.from(doc.querySelectorAll("[data-block-index]"));
  if (blockEls.length === 0) return byName;
  for (const note of annotations) {
    let resolved: { index: number; anchor: (doc: Document) => Range };
    try {
      resolved = view.resolveCFI(note.cfi);
    } catch {
      continue; // 畸形 CFI：静默跳过
    }
    if (!resolved || resolved.index !== index) continue;
    let range: Range;
    try {
      range = resolved.anchor(doc);
    } catch {
      continue; // 锚点失配（章内容变化等）：静默跳过，绝不影响本体
    }
    if (!range || range.collapsed) continue;
    const ranges = mirrorRangesForRange(doc, file, blockEls, range);
    if (ranges.length === 0) continue;
    const name = bookMirrorHighlightName(note.style ?? "highlight", note.color ?? "yellow");
    byName.set(name, [...(byName.get(name) ?? []), ...ranges]);
  }
  return byName;
}

export function useAnnotationMirror(enabled: boolean) {
  const store = useReaderStoreApi();
  const bookId = useReaderStore((state) => state.bookId);
  // 订阅 view：useFoliateViewer 的视图异步创建——不订阅则监听永不挂（4b 实测根因）；
  // 休眠唤醒重建视图时同路径重挂载
  const view = useReaderStore((state) => state.view);
  // 标注增删/换色/评论均经 updateBooknotes 换新数组 → effect 重跑全量重算
  const booknotes = useReaderStore((state) => state.config?.booknotes);
  const sectionCache = useRef(new Map<number, BookTranslationSectionFile | null>());
  const [translationTick, setTranslationTick] = useState(0);

  // 换书清缓存
  // biome-ignore lint/correctness/useExhaustiveDependencies: bookId 是缓存作废的触发源（ref 不计入使用）
  useEffect(() => {
    sectionCache.current.clear();
  }, [bookId]);

  // 翻译/对齐任务收尾（含阅读器 DOM 直注入通道）：章文件缓存失效并触发镜像重算
  useEffect(() => {
    const handler = (event: Event) => {
      if ((event as CustomEvent).detail?.bookId === bookId) {
        sectionCache.current.clear();
        setTranslationTick((t) => t + 1);
      }
    };
    window.addEventListener("book-translation-updated", handler);
    return () => window.removeEventListener("book-translation-updated", handler);
  }, [bookId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: store 仅作稳定标识入 deps（zustand api 引用不变）；view 订阅是视图就绪后重挂载的触发源
  useEffect(() => {
    if (!bookId || !enabled) return;
    if (!view) return;

    const annotations = (booknotes ?? []).filter((note) => note.type === "annotation" && !note.deletedAt && note.style);
    /** 已注册镜像的 iframe window 集合：effect 卸载（切回 original/换书/视图重建）时清残留 */
    const attachedWins = new Set<Window & typeof globalThis>();
    let disposed = false;

    /** 剔除已被 foliate 卸载的章节 iframe（长会话翻章不累积死 window 引用） */
    const pruneDeadWins = () => {
      for (const win of attachedWins) {
        try {
          if (!win.document?.documentElement?.isConnected) attachedWins.delete(win);
        } catch {
          attachedWins.delete(win);
        }
      }
    };

    /** 单章镜像重算：全量重置 15 个注册名（无镜像的 delete，有镜像的 set） */
    const refreshDoc = async (doc: Document, index: number) => {
      const win = doc.defaultView;
      if (!win || !("Highlight" in win) || !win.CSS?.highlights) return; // 异常环境静默跳过
      attachedWins.add(win);
      pruneDeadWins();
      if (!sectionCache.current.has(index)) {
        const file = await loadBookTranslationSection(bookId, index).catch(() => null);
        sectionCache.current.set(index, file);
      }
      if (disposed || doc.defaultView !== win) return; // 等待落盘期间文档已替换/卸载：不写死注册表
      const file = sectionCache.current.get(index);
      const byName =
        file && annotations.length > 0
          ? computeSectionMirrors(doc, view, index, file, annotations)
          : new Map<string, Range[]>();
      for (const name of BOOK_MIRROR_HIGHLIGHT_NAMES) {
        try {
          const ranges = byName.get(name);
          if (ranges?.length) win.CSS.highlights.set(name, new win.Highlight(...ranges));
          else win.CSS.highlights.delete(name);
        } catch {
          /* 文档替换竞态时无害 */
        }
      }
    };

    const handleLoad = (event: Event) => {
      const detail = (event as CustomEvent).detail as { doc?: Document; index?: number } | undefined;
      const { doc, index } = detail ?? {};
      if (!doc || index === undefined) return;
      void refreshDoc(doc, index);
    };

    view.addEventListener("load", handleLoad);
    // 冷启动：当前章在 hook 生效前已加载完（load 事件已错过），对现有内容立即补算
    try {
      for (const content of view.renderer?.getContents?.() ?? []) {
        if (content.doc && content.index !== undefined) void refreshDoc(content.doc, content.index);
      }
    } catch {
      /* renderer 尚未就绪时静默，后续 load 事件会补 */
    }
    return () => {
      disposed = true;
      view.removeEventListener("load", handleLoad);
      for (const win of attachedWins) {
        for (const name of BOOK_MIRROR_HIGHLIGHT_NAMES) {
          try {
            win.CSS.highlights.delete(name);
          } catch {
            /* 文档已销毁时无害 */
          }
        }
      }
    };
  }, [bookId, enabled, store, view, booknotes, translationTick]);
}
