/**
 * 书籍翻译交互层（二期批次 4b，docs/book-translation-plan.md）：hover 句词级双向联动。
 * （批次 4c 划词对照卡 2026-08-29 用户裁定撤销——hover 联动已覆盖该需求，不保留冗余入口。）
 *
 * 挂载方式与 foliate-viewer-manager 的 iframe 事件先例一致：宿主监听 foliate view 的
 * load 事件 → 对章节 iframe 文档直接挂 mousemove/mouseleave（handler 闭包在宿主上下文执行）。
 * **冷启动**：hook 生效时当前章多半已加载完（load 事件早已错过），须对 renderer.getContents()
 * 的现有章节立即补挂——只在翻译显示模式（非 original）下挂载，切换模式即重挂/卸载。
 * iframe 文档替换时旧文档连同监听器一起丢弃，无需显式清理。
 *
 * hover 联动：caret 定位 → 块内偏移映射（section-blocks 契约模块，norm 坐标=对齐表坐标）
 * → 词级优先/句级吸附查对齐表 → 双侧 CSS Custom Highlight 高亮（::highlight(book-align-hover)
 * 规则常驻注入 iframe，Highlight 对象按需 set/delete——零 DOM 改动，不污染标注层坐标系）。
 */

import type { PaperAlignPair } from "@/pages/paper-reader/paper-cross-anchor";
import {
  type BookTranslationSectionFile,
  loadBookTranslationSection,
} from "@/services/book-translation/book-translation-service";
import {
  TRANSLATION_ATTR,
  buildBlockTextMap,
  normToRange,
  rawOffsetOf,
  rawToNormOffset,
} from "@/services/book-translation/section-blocks";
import { useEffect, useRef } from "react";
import { useReaderStore, useReaderStoreApi } from "../components/reader-provider";

const HOVER_HIGHLIGHT = "book-align-hover";

/** 词级优先、句级吸附：查覆盖 offset 的对齐对（按 hover 侧坐标系选 ss/se 或 ts/te） */
function findPair(pairs: PaperAlignPair[], offset: number, tgtSide: boolean): PaperAlignPair | undefined {
  return pairs.find((p) => (tgtSide ? p.ts <= offset && offset < p.te : p.ss <= offset && offset < p.se));
}

/** caret 定位（Chromium caretRangeFromPoint 优先，标准 caretPositionFromPoint 兜底） */
function caretOffset(doc: Document, x: number, y: number): { node: Node; offset: number } | null {
  const d = doc as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  if (d.caretRangeFromPoint) {
    const range = d.caretRangeFromPoint(x, y);
    return range ? { node: range.startContainer, offset: range.startOffset } : null;
  }
  const pos = d.caretPositionFromPoint?.(x, y);
  return pos ? { node: pos.offsetNode, offset: pos.offset } : null;
}

export function useTranslationLink(enabled: boolean) {
  const store = useReaderStoreApi();
  const bookId = useReaderStore((state) => state.bookId);
  const sectionCache = useRef(new Map<number, BookTranslationSectionFile | null>());
  const lastKey = useRef("");

  // 换书清缓存
  useEffect(() => {
    sectionCache.current.clear();
    lastKey.current = "";
  }, [bookId]);

  // 翻译/对齐任务收尾后章文件缓存失效（重新加载后数据才最新）
  useEffect(() => {
    const handler = (event: Event) => {
      if ((event as CustomEvent).detail?.bookId === bookId) sectionCache.current.clear();
    };
    window.addEventListener("book-translation-updated", handler);
    return () => window.removeEventListener("book-translation-updated", handler);
  }, [bookId]);

  useEffect(() => {
    if (!bookId || !enabled) return;
    const view = store.getState().view;
    if (!view) return;

    /** 已挂监听的文档（load 事件与冷启动双路径防重复挂载） */
    const attached = new WeakSet<Document>();

    const attachDoc = (doc: Document, index: number, file: BookTranslationSectionFile) => {
      if (attached.has(doc)) return;
      const win = doc.defaultView;
      if (!win || !("Highlight" in win) || !win.CSS?.highlights) return; // WebView2 支持；异常环境静默跳过
      attached.add(doc);
      const clearHover = () => {
        lastKey.current = "";
        try {
          win.CSS.highlights.delete(HOVER_HIGHLIGHT);
        } catch {
          /* 文档替换竞态时无害 */
        }
      };

      /** 同段的另一侧元素（原文段 / 译文 div，按 data-block-index 配对） */
      const counterpartOf = (el: Element, wantTgt: boolean): Element | null => {
        const idx = el.getAttribute("data-block-index");
        if (idx === null) return null;
        for (const cand of Array.from(doc.querySelectorAll(`[data-block-index="${idx}"]`))) {
          if (cand === el) continue;
          const isTgt = cand.hasAttribute(TRANSLATION_ATTR);
          if (isTgt === wantTgt) return cand;
        }
        return null;
      };

      const onMove = (ev: MouseEvent) => {
        const blockEl = (ev.target as Element | null)?.closest?.("[data-block-index]") ?? null;
        if (!blockEl) {
          clearHover();
          return;
        }
        const entry = file.blocks[blockEl.getAttribute("data-block-index") ?? ""];
        if (!entry?.text || !entry.align) {
          clearHover();
          return;
        }
        const caret = caretOffset(doc, ev.clientX, ev.clientY);
        if (!caret) {
          clearHover();
          return;
        }
        const rawOff = rawOffsetOf(blockEl, caret.node, caret.offset);
        if (rawOff === null) {
          clearHover();
          return;
        }
        const map = buildBlockTextMap(blockEl);
        const normOff = rawToNormOffset(map, rawOff);
        const tgtSide = Boolean(blockEl.closest(`[${TRANSLATION_ATTR}]`));
        // 词级优先，句级吸附（论文侧 mapSrcRangeToTgt 同款取舍）
        const pair =
          (entry.alignW && findPair(entry.alignW, normOff, tgtSide)) || findPair(entry.align, normOff, tgtSide);
        if (!pair) {
          clearHover();
          return;
        }
        const key = `${index}:${blockEl.getAttribute("data-block-index")}:${tgtSide ? "t" : "s"}:${pair.ss}:${pair.ts}`;
        if (key === lastKey.current) return; // 同句内移动不重绘
        lastKey.current = key;

        const counterpart = counterpartOf(blockEl, !tgtSide);
        const ranges: Range[] = [];
        // 先解构再显式传参（条件数组字面量推断为 number[]，直接 spread 进固定参数签名会 TS2556）
        const [ownS, ownE] = tgtSide ? [pair.ts, pair.te] : [pair.ss, pair.se];
        const ownRange = normToRange(blockEl, map, ownS, ownE);
        if (ownRange) ranges.push(ownRange);
        if (counterpart) {
          const cMap = buildBlockTextMap(counterpart);
          const [cS, cE] = tgtSide ? [pair.ss, pair.se] : [pair.ts, pair.te];
          const cRange = normToRange(counterpart, cMap, cS, cE);
          if (cRange) ranges.push(cRange);
        }
        if (ranges.length === 0) return;
        try {
          win.CSS.highlights.set(HOVER_HIGHLIGHT, new win.Highlight(...ranges));
        } catch {
          /* 文档替换竞态时无害 */
        }
      };

      doc.addEventListener("mousemove", onMove);
      doc.addEventListener("mouseleave", clearHover);
    };

    /** 章节接入（load 事件与冷启动共用）：取章译本（缓存）→ 有对齐数据才挂监听 */
    const attachSection = (doc: Document, index: number) => {
      void (async () => {
        if (!sectionCache.current.has(index)) {
          const file = await loadBookTranslationSection(bookId, index).catch(() => null);
          sectionCache.current.set(index, file);
        }
        const file = sectionCache.current.get(index);
        if (file && Object.keys(file.blocks).length > 0) attachDoc(doc, index, file);
      })();
    };

    const handleLoad = (event: Event) => {
      const detail = (event as CustomEvent).detail as { doc?: Document; index?: number } | undefined;
      const { doc, index } = detail ?? {};
      if (!doc || index === undefined) return;
      attachSection(doc, index);
    };

    view.addEventListener("load", handleLoad);
    // 冷启动：当前章在 hook 生效前已加载完（load 事件已错过），对现有内容立即补挂
    try {
      for (const content of view.renderer?.getContents?.() ?? []) {
        if (content.doc && content.index !== undefined) attachSection(content.doc, content.index);
      }
    } catch {
      /* renderer 尚未就绪时静默，后续 load 事件会补 */
    }
    return () => {
      view.removeEventListener("load", handleLoad);
    };
  }, [bookId, enabled, store]);
}
