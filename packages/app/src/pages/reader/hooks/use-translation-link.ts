/**
 * 书籍翻译交互层（二期批次 4b/5，docs/book-translation-plan.md）：hover 句词级双向联动 + 右键句选。
 * （批次 4c 划词对照卡 2026-08-29 用户裁定撤销——hover 联动已覆盖该需求，不保留冗余入口。）
 *
 * 挂载方式与 foliate-viewer-manager 的 iframe 事件先例一致：宿主监听 foliate view 的
 * load 事件 → 对章节 iframe 文档直接挂 mousemove/mouseleave/contextmenu（handler 闭包在宿主上下文执行）。
 * **冷启动**：hook 生效时当前章多半已加载完（load 事件早已错过），须对 renderer.getContents()
 * 的现有章节立即补挂——只在翻译显示模式（非 original）下挂载，切换模式即重挂/卸载。
 * iframe 文档替换时旧文档连同监听器一起丢弃，无需显式清理。
 *
 * hover 联动：caret 定位 → 块内偏移映射（section-blocks 契约模块，norm 坐标=对齐表坐标）
 * → 词级优先/句级吸附查对齐表 → 双侧 Range。
 * **呈现（批次 5 用户实测反馈改版）**：::highlight(book-align-hover) 退役——CSS Custom Highlight
 * 不支持圆角/box-shadow（视觉对齐论文侧的需求硬约束），改为覆盖层方案（论文侧
 * .paper-sentence-hover-rect 同款，paper-reader.tsx updateHoverRects）：句子 Range 的
 * getClientRects 逐行渲染圆角 div（圆角 4px + 背景 tint + 柔和阴影），容器 position:fixed
 * inset:0 pointer-events:none 挂在 iframe body 上。样式规则（主题色真值）仍由
 * getTranslationStyles 注入 iframe；常驻的标注镜像层（book-align-mirror-*）保持 ::highlight
 * 不动（要常驻自动重绘，use-annotation-mirror.ts）。
 * foliate 分栏翻页在宿主容器滚动（paginator 重派发 scroll 到 renderer），iframe 内坐标不变；
 * 滚动/翻页/重排时清掉覆盖层即可（hover 是即态，鼠标再动即重算重绘）。
 *
 * 右键句选（批次 5）：contextmenu → caret 定位 → 句边界（有对齐句对用 align 区间；无对齐数据
 * 用论文侧切句器 paper-sentences 对块 norm 文本现场切，未翻译书/未对齐块也可用）→
 * normToRange 得句子 Range → programmatic selection。随后的右键 mouseup 由 annotator 既有
 * 监听拾起选区 → 走与原路径相同的标注弹窗（实证见批次 5 验收）。命中已有标注（overlayer
 * hitTest）→ 派发 foliate show-annotation 同一事件路径回显既有标注弹窗；图片/链接/脚注
 * aside 保留系统菜单（img 由宿主 handleImageContextMenu 接管，互不冲突）。
 */

import type { PaperAlignPair } from "@/pages/paper-reader/paper-cross-anchor";
import { mergeOverlappingRects } from "@/pages/paper-reader/paper-hover-rects";
import { findSentenceAt, segmentSentences } from "@/pages/paper-reader/paper-sentences";

/** 无对齐书的切句缓存（WeakMap 键=块元素）：块文本在章文档生命周期内不变，惰性首切后终身命中；
 *  foliate 重建章节（翻章/重排/休眠唤醒）时旧元素被 GC，缓存自动失效——零手动作失效管理 */
const SENTENCE_SPAN_CACHE = new WeakMap<Element, ReturnType<typeof segmentSentences>>();
const sentenceSpansOf = (el: Element, norm: string): ReturnType<typeof segmentSentences> => {
  let spans = SENTENCE_SPAN_CACHE.get(el);
  if (!spans) {
    spans = segmentSentences(norm);
    SENTENCE_SPAN_CACHE.set(el, spans);
  }
  return spans;
};
import {
  type BookTranslationSectionFile,
  loadBookTranslationSection,
} from "@/services/book-translation/book-translation-service";
import {
  TRANSLATION_ATTR,
  buildBlockTextMap,
  enumerateSectionBlocks,
  normToRange,
  rawOffsetOf,
  rawToNormOffset,
  wrapSectionDocument,
} from "@/services/book-translation/section-blocks";
import { useEffect, useRef } from "react";
import { useReaderStore, useReaderStoreApi } from "../components/reader-provider";

/** 覆盖层类名（样式规则由 getTranslationStyles 注入 iframe，主题色真值） */
const HOVER_LAYER_CLASS = "book-align-hover-layer";
const HOVER_RECT_CLASS = "book-align-hover-rect";
/** foliate 搜索结果高亮也登记在同一 overlayer 里（view.js SEARCH_PREFIX），标注命中测试须排除 */
const SEARCH_PREFIX = "foliate-search:";

/** overlayer.hitTest 的最小结构（types/view.ts 里 getContents 的 overlayer 是 unknown） */
type OverlayerLike = { hitTest: (point: { x: number; y: number }) => [string?, Range?] };

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
  // 订阅 view：useFoliateViewer 的视图是异步创建的，hook 首次 effect 时 view 必为 null——
  // 不订阅则挂载监听永不执行（08-29 用户实测"hover 完全没生效"的根因，2026-08-30 CDP 实证）
  const view = useReaderStore((state) => state.view);
  const sectionCache = useRef(new Map<number, BookTranslationSectionFile | null>());
  const lastKey = useRef("");

  // 换书清缓存
  // biome-ignore lint/correctness/useExhaustiveDependencies: bookId 是缓存作废的触发源（ref 不计入使用）
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: store 仅作稳定标识入 deps（zustand api 引用不变）；view 订阅是视图就绪后重挂载的触发源
  useEffect(() => {
    if (!bookId || !enabled) return;
    if (!view) return; // 视图未就绪：等 view 状态到达后 effect 重跑（见上方订阅注释）

    /** 已挂监听的文档（load 事件与冷启动双路径防重复挂载） */
    const attached = new WeakSet<Document>();
    /** 各文档的 hover 清除函数：effect 卸载（切回 original/换书/视图重建）时移除存活文档的覆盖层 */
    const clearFns = new Set<() => void>();
    const clearAll = () => {
      for (const fn of Array.from(clearFns)) fn();
    };
    /** 文档监听器的生命周期闸：effect 卸载即 abort——切模式不重载章节文档（CSS 编译切换），
     *  不 abort 则旧监听在 original 模式下仍会响应 hover/右键（且重挂后双监听双覆盖层） */
    const ac = new AbortController();

    /** 本章的 foliate overlayer（已有标注命中测试用；types/view.ts 未导出结构，窄化取用） */
    const overlayerOf = (index: number): OverlayerLike | null => {
      try {
        for (const content of view.renderer?.getContents?.() ?? []) {
          if (content.index === index && content.overlayer) return content.overlayer as OverlayerLike;
        }
      } catch {
        /* renderer 尚未就绪时静默 */
      }
      return null;
    };

    const attachDoc = (doc: Document, index: number, file: BookTranslationSectionFile | null) => {
      if (attached.has(doc)) return;
      const win = doc.defaultView;
      if (!win) return;
      attached.add(doc);

      /** hover 覆盖层容器（懒创建；foliate 不重建已加载文档，层随文档存活） */
      let layer: HTMLDivElement | null = null;
      /** mousemove 的 rAF 节流状态（每帧最多处理一次，取最新坐标，论文侧 handleMouseMove 同款） */
      let rafId = 0;
      let lastMouse: { x: number; y: number; target: EventTarget | null } | null = null;
      /** 未翻译书的块表（无 data-block-index 时的枚举契约回退）：惰性枚举一次并缓存，
       *  章文档生命周期内稳定（foliate 重建文档则 attachDoc 重跑重建） */
      let allBlocksCache: ReturnType<typeof enumerateSectionBlocks> | null = null;
      const allBlocks = () => (allBlocksCache ??= enumerateSectionBlocks(wrapSectionDocument(doc)));

      const removeLayer = () => {
        layer?.remove();
        layer = null;
      };
      const clearHover = () => {
        lastKey.current = "";
        lastMouse = null;
        if (rafId) {
          win.cancelAnimationFrame(rafId);
          rafId = 0;
        }
        removeLayer();
      };
      clearFns.add(clearHover);

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

      /** 双侧 Range → 覆盖层逐行 rect（mergeOverlappingRects 求并防半透明叠色，论文侧同款）。
       *  CSS zoom（阅读缩放，作用于 body 子树）下 getClientRects 返回缩放后的可视坐标，
       *  覆盖层 div 同在 body 内，几何属性除回 zoom（默认 zoomLevel=100 → 1，无除算影响） */
      const renderOverlay = (ranges: Range[]) => {
        const zoom = Number.parseFloat(win.getComputedStyle(doc.body).getPropertyValue("zoom")) || 1;
        const rects = mergeOverlappingRects(
          ranges
            .flatMap((r) => Array.from(r.getClientRects()))
            .filter((r) => r.width > 0 && r.height > 0)
            .map((r) => ({ x: r.left / zoom, y: r.top / zoom, width: r.width / zoom, height: r.height / zoom })),
        );
        if (rects.length === 0) return removeLayer();
        if (!layer) {
          layer = doc.createElement("div");
          layer.className = HOVER_LAYER_CLASS;
          layer.setAttribute("aria-hidden", "true");
          doc.body.appendChild(layer);
        }
        layer.replaceChildren(
          ...rects.map((r) => {
            const div = doc.createElement("div");
            div.className = HOVER_RECT_CLASS;
            div.style.left = `${r.x}px`;
            div.style.top = `${r.y}px`;
            div.style.width = `${r.width}px`;
            div.style.height = `${r.height}px`;
            return div;
          }),
        );
      };

      const processHover = (x: number, y: number, target: EventTarget | null) => {
        // 有非折叠选区 / 悬在图片、代码块、链接上时不联动（论文侧 processHover 同款守卫）
        const sel = doc.getSelection();
        if (sel && !sel.isCollapsed) return clearHover();
        const el = target as Element | null;
        if (el?.closest?.("img, pre, a")) return clearHover();
        const caret = caretOffset(doc, x, y);
        if (!caret) return clearHover();
        // 块定位：data-block-index（有译文注入的书）优先；未翻译书没有该属性，回退枚举契约
        // （块表按文档惰性枚举一次并缓存，章文档生命周期内稳定）
        let blockEl = el?.closest?.("[data-block-index]") ?? null;
        if (!blockEl) blockEl = allBlocks().find((b) => b.el.contains(caret.node))?.el ?? null;
        if (!blockEl) return clearHover();
        const rawOff = rawOffsetOf(blockEl, caret.node, caret.offset);
        if (rawOff === null) return clearHover();
        const map = buildBlockTextMap(blockEl);
        const normOff = rawToNormOffset(map, rawOff);
        const tgtSide = Boolean(blockEl.closest(`[${TRANSLATION_ATTR}]`));
        const idx = blockEl.getAttribute("data-block-index");
        const entry = idx !== null ? file?.blocks[idx] : undefined;
        // 词级优先，句级吸附（论文侧 mapSrcRangeToTgt 同款取舍）；有对齐数据 → 双侧联动
        const pair =
          (entry?.alignW && findPair(entry.alignW, normOff, tgtSide)) ||
          (entry?.align ? findPair(entry.align, normOff, tgtSide) : undefined);
        if (pair) {
          const key = `${index}:${idx}:${tgtSide ? "t" : "s"}:${pair.ss}:${pair.ts}`;
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
          if (ranges.length === 0) return removeLayer();
          renderOverlay(ranges);
          return;
        }
        // 无对齐回退（未翻译书/未对齐段）：单侧句级高亮——句界走缓存切句器，
        // hover 全句即「这句是什么」的通用阅读增强，不依赖翻译
        const span = findSentenceAt(sentenceSpansOf(blockEl, map.norm), normOff);
        if (!span) return clearHover();
        const blockKey = idx ?? `enum${allBlocks().findIndex((b) => b.el === blockEl)}`;
        const key = `${index}:${blockKey}:${span.start}:${span.end}`;
        if (key === lastKey.current) return;
        lastKey.current = key;
        const range = normToRange(blockEl, map, span.start, span.end);
        if (!range) return clearHover();
        renderOverlay([range]);
      };

      const onMove = (ev: MouseEvent) => {
        lastMouse = { x: ev.clientX, y: ev.clientY, target: ev.target };
        if (rafId) return;
        rafId = win.requestAnimationFrame(() => {
          rafId = 0;
          const m = lastMouse;
          if (m) processHover(m.x, m.y, m.target);
        });
      };

      /** 右键点的整句 Range：有对齐句对用 align 区间；无对齐数据用论文侧切句器现场切 */
      const sentenceRangeAt = (x: number, y: number, target: EventTarget | null): Range | null => {
        const caret = caretOffset(doc, x, y);
        if (!caret) return null;
        const el = target as Element | null;
        let blockEl = el?.closest?.("[data-block-index]") ?? null;
        if (!blockEl) {
          // 未注入译文的文档没有 data-block-index（未翻译书）：按枚举契约找 caret 所在叶子块
          // （Node.contains 含自身，caret 落在块元素/块内文本均覆盖）
          blockEl = enumerateSectionBlocks(wrapSectionDocument(doc)).find((b) => b.el.contains(caret.node))?.el ?? null;
          if (!blockEl) return null;
        }
        const rawOff = rawOffsetOf(blockEl, caret.node, caret.offset);
        if (rawOff === null) return null;
        const map = buildBlockTextMap(blockEl);
        const normOff = rawToNormOffset(map, rawOff);
        const tgtSide = Boolean(blockEl.closest(`[${TRANSLATION_ATTR}]`));
        // 句对优先（对齐坐标系即 norm 坐标系，直接可用）
        const idx = blockEl.getAttribute("data-block-index");
        const entry = idx !== null ? file?.blocks[idx] : undefined;
        if (entry?.align?.length) {
          const pair = findPair(entry.align, normOff, tgtSide);
          if (pair) {
            const [s, e] = tgtSide ? [pair.ts, pair.te] : [pair.ss, pair.se];
            const range = normToRange(blockEl, map, s, e);
            if (range) return range;
          }
        }
        // 切句器回退：块 norm 文本现场切（与论文侧 locateSentenceAtPoint 同源；WeakMap 缓存免重复切）
        const span = findSentenceAt(sentenceSpansOf(blockEl, map.norm), normOff);
        return span ? normToRange(blockEl, map, span.start, span.end) : null;
      };

      /** 右键：已有标注 → 既有标注弹窗；句子上 → 选中全句（随后的右键 mouseup 由 annotator
       *  既有监听拾起，走与原路径相同的标注弹窗）；其余（图片/链接/脚注/非句子）保留系统菜单 */
      const onContextMenu = (ev: MouseEvent) => {
        const el = ev.target as Element | null;
        // 图片/链接/脚注 aside 保留系统菜单（论文侧守卫同款；img 由宿主 handleImageContextMenu 接管）
        if (el?.closest?.("img, a, aside")) return;
        const overlayer = overlayerOf(index);
        if (overlayer) {
          const [value, range] = overlayer.hitTest({ x: ev.clientX, y: ev.clientY });
          if (value && range && !value.startsWith(SEARCH_PREFIX)) {
            ev.preventDefault();
            clearHover();
            // 复用 foliate 标注点击的同一事件路径（view.js #createOverlayer 的 click → show-annotation）
            view.dispatchEvent(new CustomEvent("show-annotation", { detail: { value, index, range } }));
            return;
          }
        }
        const range = sentenceRangeAt(ev.clientX, ev.clientY, ev.target);
        if (!range) return; // 不在句子上：保留系统菜单
        ev.preventDefault();
        clearHover(); // hover 覆盖层是即态，句选成立后让位给选区
        const sel = doc.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        // 同一手势内浮起弹窗（与论文侧 handleContextMenu 单手势选中+弹窗对齐）：annotator 的
        // 弹窗由 doc 的 mouseup 监听驱动（annotator/index.tsx onLoad 挂载），真实右键 gesture
        // 里该 mouseup 与 foliate/宿主事件桥存在时序竞争（用户实测第一次右键只选中不弹窗）——
        // 补一发合成 mouseup 走同一路径；真实 mouseup 若随后也触发，只是同选区的幂等重放
        doc.dispatchEvent(
          new win.MouseEvent("mouseup", {
            bubbles: true,
            cancelable: true,
            clientX: ev.clientX,
            clientY: ev.clientY,
            view: win,
          }),
        );
      };

      // hover/右键监听常驻挂载（hover 有对齐数据时双侧联动、无对齐单侧句级高亮——
      // 未翻译书也生效；signal 随 effect 卸载一并摘除）
      doc.addEventListener("mousemove", onMove, { signal: ac.signal });
      doc.addEventListener("mouseleave", clearHover, { signal: ac.signal });
      // scrolled 模式的文档内滚动 / 窗口重排：覆盖层即态清除（分栏翻页走宿主 scroll，在 effect 层清）
      doc.addEventListener("scroll", clearHover, { capture: true, signal: ac.signal });
      win.addEventListener("resize", clearHover, { signal: ac.signal });
      doc.addEventListener("contextmenu", onContextMenu, { signal: ac.signal });
    };

    /** 章节接入（load 事件与冷启动共用）：取章译本（缓存）→ hover 需要有对齐数据的章文件，右键句选不依赖 */
    const attachSection = (doc: Document, index: number) => {
      void (async () => {
        if (!sectionCache.current.has(index)) {
          const file = await loadBookTranslationSection(bookId, index).catch(() => null);
          sectionCache.current.set(index, file);
        }
        if (ac.signal.aborted || attached.has(doc)) return; // 异步落盘期间 effect 已卸载 / 已被另一路径挂载
        attachDoc(doc, index, sectionCache.current.get(index) ?? null);
      })();
    };

    const handleLoad = (event: Event) => {
      const detail = (event as CustomEvent).detail as { doc?: Document; index?: number } | undefined;
      const { doc, index } = detail ?? {};
      if (!doc || index === undefined) return;
      attachSection(doc, index);
    };

    view.addEventListener("load", handleLoad);
    // 分栏翻页/滚动在宿主容器（paginator 重派发 scroll 到 renderer），iframe 内无滚动事件；
    // relocate 兜底章节切换。覆盖层是 hover 即态：清除即可，鼠标再动即重算重绘。
    view.addEventListener("relocate", clearAll);
    view.renderer?.addEventListener("scroll", clearAll);
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
      view.removeEventListener("relocate", clearAll);
      view.renderer?.removeEventListener("scroll", clearAll);
      ac.abort(); // 摘掉存活文档上的全部监听（切 original 后 hover/右键不再响应）
      // 卸载时清掉所有已挂载文档的 hover 覆盖层（切回 original 后原文在屏，残留覆盖层可见）
      clearAll();
    };
  }, [bookId, enabled, store, view]);
}
