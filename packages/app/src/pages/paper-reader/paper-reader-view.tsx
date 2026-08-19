import { PreviewPanel } from "@/components/preview/preview-panel";
import {
  type PaperFigureItem,
  type PaperViewMode,
  buildPaperViewMarkdown,
  cutPaperBlocks,
} from "@/pages/paper-reader/paper-blocks";
import PaperExportDialog from "@/pages/paper-reader/paper-export-dialog";
import PaperHeaderBar from "@/pages/paper-reader/paper-header-bar";
import { PaperNotepadPanel } from "@/pages/paper-reader/paper-notepad-panel";
import PaperReader, {
  type PaperReaderHandle,
  type PaperTranslationContext,
  type TocItem,
} from "@/pages/paper-reader/paper-reader";
import { usePaperAnnotations } from "@/pages/paper-reader/use-paper-annotations";
import { PaperChatPanel } from "@/pages/papers/paper-chat-panel";
import { getBookStatus, updateBookStatus } from "@/services/book-service";
import { iframeService } from "@/services/iframe-service";
import {
  type PaperAlignmentInfo,
  alignPaperTranslation,
  inspectPaperAlignment,
} from "@/services/paper-alignment-service";
import { registerPaperQuoteLocator } from "@/services/paper-locate-service";
import { type Folder, type PaperFolderEntry, getPaperFolderMap, listFolders } from "@/services/paper-service";
import {
  type PaperTranslatedMeta,
  type PaperTranslationFile,
  type TranslateProgress,
  loadPaperTranslatedMeta,
  loadPaperTranslation,
  translatePaper,
} from "@/services/paper-translation-service";
import { buildPaperFontFamily, useAppSettingsStore } from "@/store/app-settings-store";
import { useLayoutStore } from "@/store/layout-store";
import { useThemeStore } from "@/store/theme-store";
import type { Note, NoteLocation, NoteTocItem } from "@/types/note";
import { appDataDir, join } from "@tauri-apps/api/path";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { Resizable } from "re-resizable";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

interface PaperReaderViewProps {
  paperId: string;
  title: string;
  /** P2 标签页休眠：为 true 时只卸载重型正文（PaperReader），顶栏/侧栏/聊天保活 */
  viewSleeping?: boolean;
}

/**
 * 论文标签页视图（与书籍阅读区同款三段式）：
 * 左笔记/标注占位面板 | 中（PaperHeaderBar + PaperReader 正文）| 右论文助手。
 * 消费 swapSidebars（theme-store）：开启时左右面板互换，语义与书籍 reader-layout 一致
 * （手柄方向、间隙方向、排列顺序一并互换）。
 * 字号/字体直接消费 settings.globalViewSettings（与书籍阅读器联动，通用设置开箱即用）。
 * 正文从 {appDataDir}/books/{paperId}/paper.md 读取（appdata 已授权 plugin-fs）。
 */
export default function PaperReaderView({ paperId, title, viewSleeping = false }: PaperReaderViewProps) {
  const { settings, setSettings } = useAppSettingsStore();
  const globalViewSettings = settings.globalViewSettings;
  // 论文显示模式（persist；旧持久化数据无此字段时回退原文）
  const viewMode: PaperViewMode = settings.paperViewMode ?? "original";
  // 侧边栏高度与书籍阅读区同一算法（reader-layout）：横向顶栏 36px / 纵向顶条 32px，另加 p-1 与余量
  const { tabOrientation } = useLayoutStore();
  const { swapSidebars } = useThemeStore();
  const sidebarHeightClass = tabOrientation === "vertical" ? "h-[calc(100dvh-44px)]" : "h-[calc(100dvh-48px)]";

  const [paperDir, setPaperDir] = useState<string | null>(null);
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [members, setMembers] = useState<PaperFolderEntry[]>([]);
  // 面板开关默认值与书籍阅读区一致：左侧笔记面板默认收起、右侧 AI 面板默认展开
  const [notesOpen, setNotesOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(true);
  const [currentHeading, setCurrentHeading] = useState<{ id: string; text: string } | null>(null);
  const [toc, setToc] = useState<TocItem[]>([]);
  // 本文内搜索（非对话内搜索）：状态在此，高亮/定位在 PaperReader，UI 在 PaperHeaderBar
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMatchCount, setSearchMatchCount] = useState(0);
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  // 论文导出对话框（数据在本视图，入口在顶栏）
  const [exportOpen, setExportOpen] = useState(false);
  const paperReaderRef = useRef<PaperReaderHandle>(null);
  // 论文标注（book_notes 表复用）：CRUD 后 invalidate，下传给 PaperReader 与 PaperNotepadPanel
  const {
    annotations,
    createAnnotation,
    updateAnnotation,
    deleteAnnotation,
    toggleStar,
    deleteAnnotations,
    createAiAnnotations,
    clearAiAnnotations,
  } = usePaperAnnotations(paperId);
  // 侧栏点击标注 → PaperReader 滚动定位 + 闪烁（处理完回执清零）
  const [focusAnnotationId, setFocusAnnotationId] = useState<string | null>(null);

  // ─── 翻译：平行译本（translation-zh.json）+ 元数据译文 + 进度/取消 ───
  const [translationFile, setTranslationFile] = useState<PaperTranslationFile | null>(null);
  const [translationMap, setTranslationMap] = useState<ReadonlyMap<number, string> | null>(null);
  const [translatedMeta, setTranslatedMeta] = useState<PaperTranslatedMeta | null>(null);
  const [translating, setTranslating] = useState<TranslateProgress | null>(null);
  const translateAbortRef = useRef<AbortController | null>(null);
  // ─── T2 句对齐：覆盖情况（下拉"重建句对齐"显隐）+ 计算中标志 ───
  const [alignInfo, setAlignInfo] = useState<PaperAlignmentInfo | null>(null);
  const [aligning, setAligning] = useState(false);

  // 加载译本与元数据译文（paperId 切换 / 翻译或对齐完成后重载）
  const reloadTranslation = useCallback(async () => {
    const [file, meta] = await Promise.all([loadPaperTranslation(paperId), loadPaperTranslatedMeta(paperId)]);
    setTranslationFile(file);
    setTranslationMap(
      file ? new Map(Object.entries(file.blocks).map(([index, block]) => [Number(index), block.text])) : null,
    );
    setTranslatedMeta(meta);
  }, [paperId]);

  useEffect(() => {
    setTranslationFile(null);
    setTranslationMap(null);
    setTranslatedMeta(null);
    reloadTranslation().catch((error) => console.warn("加载论文译本失败:", error));
    // 切换论文时取消进行中的翻译（译本是按 paperId 隔离的）
    return () => translateAbortRef.current?.abort();
  }, [reloadTranslation]);

  // T2 句对齐覆盖情况：译本/原文就绪后异步核对（hash 比对），aligned < total 即"无对齐/陈旧"
  useEffect(() => {
    if (!markdown || !translationFile) {
      setAlignInfo(null);
      return;
    }
    let cancelled = false;
    inspectPaperAlignment(markdown, translationFile)
      .then((info) => {
        if (!cancelled) setAlignInfo(info);
      })
      .catch((error) => console.warn("检查句对齐状态失败:", error));
    return () => {
      cancelled = true;
    };
  }, [markdown, translationFile]);

  // T2/T3 传给阅读区的译文上下文（译文文本 + 句/词对齐表；无译本时为 null）
  const readerTranslation = useMemo<PaperTranslationContext | null>(() => {
    if (!translationFile) return null;
    const texts = new Map<number, string>();
    const alignments = new Map<number, NonNullable<PaperTranslationFile["blocks"][string]["align"]>>();
    const wordAlignments = new Map<number, NonNullable<PaperTranslationFile["blocks"][string]["alignW"]>>();
    for (const [index, block] of Object.entries(translationFile.blocks)) {
      texts.set(Number(index), block.text);
      if (block.align && block.align.length > 0) alignments.set(Number(index), block.align);
      if (block.alignW && block.alignW.length > 0) wordAlignments.set(Number(index), block.alignW);
    }
    return { texts, alignments, wordAlignments };
  }, [translationFile]);

  // 原文切块表（中文划词标亮时取英文原文/上下文建英文锚点）
  const sourceBlocks = useMemo(() => (markdown ? cutPaperBlocks(markdown) : null), [markdown]);

  // T2/T3 对齐计算（幂等；force=true 两级全部重算）。翻译完成后自动调用（auto）或下拉手动触发（manual）
  const runAlignment = useCallback(
    async (force: boolean, trigger: "auto" | "manual") => {
      if (!markdown || aligning) return;
      setAligning(true);
      try {
        const result = await alignPaperTranslation({ paperId, markdown, force });
        if (result.reason === "no-vector-capability") {
          // 无嵌入能力：跳过对齐并明确提示（翻译本体不受影响）；手动触发时给配置引导
          toast.info(
            trigger === "manual"
              ? "未配置嵌入模型，无法计算对齐：请先在「设置 → 向量模型」中配置嵌入模型"
              : "未配置嵌入模型，句词对齐已跳过（翻译不受影响；配置后可在翻译菜单重建）",
          );
        } else if (result.status === "partial") {
          if (result.reason === "embed-failed") {
            toast.warning("嵌入服务调用失败，对齐未完成（请检查嵌入模型配置后重建）");
          } else {
            toast.warning(`句对齐部分完成：${result.computed + result.reused}/${result.total} 块已对齐，可稍后重建`);
          }
        } else if (result.computed > 0 || result.words.computed > 0) {
          toast.success(
            `对齐完成：句 新算 ${result.computed} 块（复用 ${result.reused}），词 新算 ${result.words.computed} 块（复用 ${result.words.reused}）`,
          );
        } else if (trigger === "manual") {
          toast.success("句词对齐已是最新，无需重建");
        }
        // 词级相位独立降级：句级成功但词级部分失败时追加提示（不影响句级结果）
        if (result.status !== "skipped" && result.words.status === "partial" && result.status !== "partial") {
          toast.warning("词对齐部分完成，可稍后在翻译菜单重建");
        }
      } catch (error) {
        console.error("论文对齐失败:", error);
        if (trigger === "manual") toast.error("对齐计算失败");
      } finally {
        setAligning(false);
      }
      await reloadTranslation();
    },
    [markdown, paperId, aligning, reloadTranslation],
  );

  const handleRebuildAlign = useCallback(() => {
    runAlignment(true, "manual").catch((error) => console.warn("重建对齐失败:", error));
  }, [runAlignment]);

  // 视图 markdown：原文直传；译文/对照模式用译本重建（块数量顺序与原文一致，锚点天然安全）
  const displayMarkdown = useMemo(() => {
    if (!markdown || viewMode === "original" || !translationMap) return markdown;
    return buildPaperViewMarkdown(markdown, translationMap, viewMode);
  }, [markdown, viewMode, translationMap]);

  const handleViewModeChange = useCallback(
    (mode: PaperViewMode) => {
      if (mode !== "original" && !translationMap) {
        toast.info("本文尚未翻译，请先在翻译菜单中点击「翻译本文」");
        return;
      }
      setSettings({ ...settings, paperViewMode: mode });
    },
    [translationMap, settings, setSettings],
  );

  const handleTranslate = useCallback(
    async (force: boolean) => {
      if (!markdown || translateAbortRef.current) return;
      const controller = new AbortController();
      translateAbortRef.current = controller;
      setTranslating({ done: 0, total: 0 });
      try {
        const result = await translatePaper({
          paperId,
          markdown,
          force,
          signal: controller.signal,
          onProgress: setTranslating,
        });
        await reloadTranslation();
        if (result.cancelled) {
          toast.info(`翻译已取消，已翻译的 ${result.translated} 块已保存，可随时续翻`);
        } else if (result.failedBatches > 0) {
          toast.warning(
            `翻译完成：新翻 ${result.translated} 块，${result.failedBatches} 个批次失败已跳过（可重新翻译补齐）`,
          );
        } else {
          toast.success(
            result.translated > 0
              ? `翻译完成：新翻 ${result.translated} 块，跳过已翻 ${result.skipped} 块`
              : "翻译完成：所有块均已有译文",
          );
        }
        // T2：翻译完成后自动计算句对齐（幂等；无嵌入能力时跳过并提示，不影响翻译本体）
        if (!result.cancelled) await runAlignment(false, "auto");
      } catch (error) {
        if (controller.signal.aborted) {
          toast.info("翻译已取消，已翻译部分已保存，可随时续翻");
          await reloadTranslation();
        } else {
          console.error("论文翻译失败:", error);
          toast.error(error instanceof Error ? error.message : "论文翻译失败");
        }
      } finally {
        translateAbortRef.current = null;
        setTranslating(null);
      }
    },
    [markdown, paperId, reloadTranslation, runAlignment],
  );

  const handleCancelTranslate = useCallback(() => {
    translateAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const base = await appDataDir();
        const dir = await join(base, "books", paperId);
        const content = await readTextFile(await join(dir, "paper.md"));
        if (cancelled) return;
        setPaperDir(dir);
        setMarkdown(content);
      } catch (error) {
        if (cancelled) return;
        console.error("打开论文失败:", error);
        setLoadError(error instanceof Error ? error.message : String(error));
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [paperId]);

  // New 判定：打开即已阅——unread 首次打开时标记 reading（startedAt 只填一次；lastReadAt 每次刷新）
  useEffect(() => {
    (async () => {
      try {
        const status = await getBookStatus(paperId);
        const now = Date.now();
        if (!status || status.status === "unread") {
          await updateBookStatus(paperId, { status: "reading", startedAt: status?.startedAt ?? now, lastReadAt: now });
        } else {
          await updateBookStatus(paperId, { lastReadAt: now });
        }
      } catch (error) {
        console.warn("更新论文阅读状态失败:", error);
      }
    })();
  }, [paperId]);

  // 论文助手的作用域选择器需要文件夹与成员关系（加载失败时降级为仅"本篇论文/全部文献"）
  useEffect(() => {
    Promise.all([listFolders(), getPaperFolderMap()])
      .then(([folderList, memberList]) => {
        setFolders(folderList);
        setMembers(memberList);
      })
      .catch((error) => console.warn("加载论文文件夹信息失败:", error));
  }, []);

  const handleSearchQueryChange = useCallback((query: string) => {
    setSearchQuery(query);
    setActiveMatchIndex(0);
  }, []);

  const handleSearchMatchesChange = useCallback((count: number) => {
    setSearchMatchCount(count);
    setActiveMatchIndex((index) => (count === 0 ? 0 : Math.min(index, count - 1)));
  }, []);

  // 标注弹窗 "Ask AI"：选中文本作为 quote 注入论文助手输入框；
  // 面板折叠时先展开再派发（等 PaperChatPanel 挂载，否则同一 tick 内事件无人接收）
  const handleQuoteToChat = useCallback(
    (text: string) => {
      setChatOpen(true);
      setTimeout(() => iframeService.sendQuoteReferenceRequest(text, paperId), 50);
    },
    [paperId],
  );

  // 图片预览"引用"（J2 补环）：图片 dataUrl 作为附件注入论文助手输入区；同款展开+延迟派发
  const handleQuoteImageToChat = useCallback(
    (image: { dataUrl: string; mediaType: string; name: string }) => {
      setChatOpen(true);
      setTimeout(() => iframeService.sendImageReferenceRequest(image, paperId), 50);
    },
    [paperId],
  );

  // 图表速跳：图片优先（data-paper-src 全视图模式可靠，译文模式原文图注不在 DOM 时仍能定位）；
  // 表格/无图条目走图注 quote，译文模式退回译文 quote；全部未命中给轻提示
  const handleLocateFigure = useCallback(
    (item: PaperFigureItem) => {
      const reader = paperReaderRef.current;
      if (!reader) return;
      if (item.images.length > 0 && reader.scrollToImage(item.images[0])) return;
      if (item.quote && reader.scrollToQuote(item.quote)) return;
      const zh = translationMap?.get(item.blockIndex);
      if (zh && reader.scrollToQuote(zh.trim().slice(0, 80))) return;
      toast.info("未能在正文中定位该图表");
    },
    [translationMap],
  );

  // 聊天引用标跳转（paper-locate-service）：注册本论文的 quote 定位器。
  // reader 未就绪（markdown 加载中/视图休眠）返回 false，请求在总线挂起；
  // 就绪态变化时重注册触发挂起请求重放；就绪但 quote 未命中给轻提示（消费掉，不再重放）
  const handleCitationQuoteLocate = useCallback((quote: string) => {
    const reader = paperReaderRef.current;
    if (!reader) return false;
    if (!reader.scrollToQuote(quote)) toast.info("未能在正文中定位该引用片段");
    return true;
  }, []);
  const citationLocatorReady = markdown !== null && !viewSleeping;
  // biome-ignore lint/correctness/useExhaustiveDependencies: citationLocatorReady 是刻意的触发依赖——就绪态变化时重注册定位器，冲刷总线里挂起的引用标定位请求
  useEffect(
    () => registerPaperQuoteLocator(paperId, handleCitationQuoteLocate),
    [paperId, handleCitationQuoteLocate, citationLocatorReady],
  );

  // 笔记位置捕获：当前 heading → { tag=文本, cfi=slug 锚点, block=TOC 序号（阅读流排序键） }
  const noteLocation = useMemo<NoteLocation | null>(() => {
    if (!currentHeading) return null;
    const block = toc.findIndex((t) => t.id === currentHeading.id);
    return { tag: currentHeading.text, cfi: currentHeading.id, block: block >= 0 ? block : null };
  }, [currentHeading, toc]);

  // 笔记位置选择器的章节清单（与捕获同构：tag=标题文本，cfi=slug，block=TOC 序号）
  const noteTocItems = useMemo<NoteTocItem[]>(() => {
    const minLevel = toc.reduce((min, t) => Math.min(min, t.level), 6);
    return toc.map((t, i) => ({ tag: t.text, cfi: t.id, block: i, depth: Math.max(0, t.level - minLevel) }));
  }, [toc]);

  // 笔记位置跳转：精确锚点（slug）→ TOC 文本匹配（重解析 slug 漂移兜底）→ 全文 quote → 轻提示
  const handleLocateNote = useCallback(
    (note: Note) => {
      const reader = paperReaderRef.current;
      if (!reader) return;
      if (note.locationCfi && reader.scrollToHeading(note.locationCfi)) return;
      const tag = note.locationTag?.trim();
      if (tag) {
        const hit = toc.find((t) => t.text.trim() === tag);
        if (hit && reader.scrollToHeading(hit.id)) return;
        if (reader.scrollToQuote(tag)) return;
      }
      toast.info("未能定位到笔记位置（内容可能已变更）");
    },
    [toc],
  );

  // 笔记面板（位置/宽度边界与书籍 Notepad 一致，可拖拽调宽、可折叠；swap 时换手柄与间隙方向）
  const notepadSidebar = notesOpen && (
    <Resizable
      defaultSize={{
        width: 360,
        height: "100%",
      }}
      minWidth={260}
      maxWidth={800}
      enable={{
        top: false,
        right: !swapSidebars,
        bottom: false,
        left: swapSidebars,
        topRight: false,
        bottomRight: false,
        bottomLeft: false,
        topLeft: false,
      }}
      handleComponent={
        swapSidebars
          ? { left: <div className="custom-resize-handle" /> }
          : { right: <div className="custom-resize-handle custom-resize-handle-left" /> }
      }
      // 手柄感应区收回面板内（默认跨界 10px 会盖住邻居阅读区边缘）
      // 手柄感应区移到面板外侧间隙（0px 时会盖住自身内容滚动条，见 2026-08-04 反馈）
      handleStyles={{ left: { left: "0px" }, right: { right: "-6px" } }}
      className="h-full"
    >
      {/* 与书籍 Notepad 同款包装：region 钩子 + 4px 间隙 + 顶栏对齐高度 */}
      <div
        data-region="notepad-panel"
        className={swapSidebars ? `ml-1 ${sidebarHeightClass}` : `mr-1 ${sidebarHeightClass}`}
      >
        <PaperNotepadPanel
          annotations={annotations}
          paperId={paperId}
          paperTitle={title}
          markdown={markdown}
          onLocateQuotes={(quotes) => paperReaderRef.current?.locateQuotes(quotes) ?? quotes.map(() => null)}
          onCreateAiAnnotations={createAiAnnotations}
          onClearAiAnnotations={clearAiAnnotations}
          onLocateAnnotation={setFocusAnnotationId}
          paperDir={paperDir ?? ""}
          translationMap={translationMap}
          onLocateFigure={handleLocateFigure}
          noteLocation={noteLocation}
          noteTocItems={noteTocItems}
          onLocateNote={handleLocateNote}
          onUpdateNote={(id, note) => updateAnnotation(id, { note })}
          onDeleteAnnotation={deleteAnnotation}
          onToggleStar={toggleStar}
          onDeleteAnnotations={deleteAnnotations}
        />
      </div>
    </Resizable>
  );

  // 论文助手（默认宽度/边界与书籍 AI 面板一致；swap 时换手柄与间隙方向）
  const chatSidebar = chatOpen && (
    <Resizable
      defaultSize={{
        width: 370,
        height: "100%",
      }}
      minWidth={320}
      maxWidth={800}
      enable={{
        top: false,
        right: swapSidebars,
        bottom: false,
        left: !swapSidebars,
        topRight: false,
        bottomRight: false,
        bottomLeft: false,
        topLeft: false,
      }}
      handleComponent={
        swapSidebars
          ? { right: <div className="custom-resize-handle custom-resize-handle-left" /> }
          : { left: <div className="custom-resize-handle" /> }
      }
      // 手柄感应区收回面板内（默认跨界 10px 会盖住邻居阅读区边缘的滚动条）
      // 手柄感应区移到面板外侧间隙（0px 时会盖住自身内容滚动条，见 2026-08-04 反馈）
      handleStyles={{ left: { left: "0px" }, right: { right: "-6px" } }}
      className="h-full"
    >
      {/* 与书籍 SideChat 同款包装：四周 4px（顶部除外）间隙 + 顶栏对齐高度 */}
      <div
        className={swapSidebars ? `mr-1 ${sidebarHeightClass} rounded-md` : `m-1 mt-0 ${sidebarHeightClass} rounded-md`}
      >
        <PaperChatPanel
          paperId={paperId}
          paperTitle={title}
          markdown={markdown ?? ""}
          currentHeading={currentHeading}
          folders={folders}
          members={members}
        />
      </div>
    </Resizable>
  );

  return (
    // min-w-0：宽 HTML 表格的 min-content 会把本行撑出视口、把右侧栏挤没（2026-08-05 实测）
    <div className="flex min-h-0 min-w-0 flex-1">
      {/* E5 补挂：预览面板跟随 swapSidebars 互换（与书籍 tab 同款） */}
      {swapSidebars && <PreviewPanel />}
      {swapSidebars ? chatSidebar : notepadSidebar}

      {/* 中：PaperHeaderBar + PaperReader（书籍 ReaderViewer 同款容器） */}
      <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-md border shadow-around">
        <PaperHeaderBar
          notesOpen={notesOpen}
          onToggleNotes={() => setNotesOpen((v) => !v)}
          chatOpen={chatOpen}
          onToggleChat={() => setChatOpen((v) => !v)}
          toc={toc}
          activeHeadingId={currentHeading?.id ?? null}
          onTocSelect={(id) => paperReaderRef.current?.scrollToHeading(id)}
          currentSection={currentHeading?.text ?? ""}
          searchQuery={searchQuery}
          onSearchQueryChange={handleSearchQueryChange}
          searchMatchCount={searchMatchCount}
          activeMatchIndex={activeMatchIndex}
          onActiveMatchIndexChange={setActiveMatchIndex}
          viewMode={viewMode}
          onViewModeChange={handleViewModeChange}
          hasTranslation={translationMap !== null}
          translating={translating}
          onTranslate={handleTranslate}
          onCancelTranslate={handleCancelTranslate}
          alignInfo={alignInfo}
          aligning={aligning}
          onRebuildAlign={handleRebuildAlign}
          onOpenExport={() => setExportOpen(true)}
        />

        {loadError ? (
          <div className="flex flex-1 items-center justify-center">
            <p className="text-neutral-500 text-sm dark:text-neutral-400">论文文件读取失败：{loadError}</p>
          </div>
        ) : markdown === null || paperDir === null ? (
          <div className="flex flex-1 items-center justify-center">
            <div className="text-neutral-600 dark:text-neutral-400">加载中...</div>
          </div>
        ) : viewSleeping ? (
          /* P2 休眠态：卸载重型正文 DOM（公式/译文数万元素），切回时重挂载；滚动位置由 PaperReader 记忆还原 */
          <div className="flex flex-1 items-center justify-center">
            <div className="text-neutral-500 text-xs dark:text-neutral-500">视图已休眠，切回自动恢复</div>
          </div>
        ) : (
          <div className="min-h-0 flex-1">
            <PaperReader
              ref={paperReaderRef}
              paperDir={paperDir}
              markdown={displayMarkdown ?? markdown}
              onActiveHeadingChange={setCurrentHeading}
              onTocChange={setToc}
              fontSize={globalViewSettings.defaultFontSize}
              fontFamily={buildPaperFontFamily(globalViewSettings.serifFont, globalViewSettings.defaultCJKFont)}
              searchTerm={searchQuery}
              activeMatchIndex={activeMatchIndex}
              onSearchMatchesChange={handleSearchMatchesChange}
              annotations={annotations}
              onCreateAnnotation={createAnnotation}
              onUpdateAnnotation={updateAnnotation}
              onDeleteAnnotation={deleteAnnotation}
              onQuoteToChat={handleQuoteToChat}
              onQuoteImageToChat={handleQuoteImageToChat}
              focusAnnotationId={focusAnnotationId}
              onAnnotationFocused={() => setFocusAnnotationId(null)}
              viewMode={viewMode}
              translatedMeta={translatedMeta}
              translation={readerTranslation}
              sourceBlocks={sourceBlocks}
            />
          </div>
        )}
      </div>

      {swapSidebars ? notepadSidebar : chatSidebar}

      {/* E5 补挂：论文 tab 的预览面板（与书籍 tab 同款，跟随 swapSidebars 互换；未打开时自动隐藏） */}
      {!swapSidebars && <PreviewPanel />}

      {/* 论文导出对话框（markdown 加载完成才渲染，保证拿到原文） */}
      {markdown !== null && (
        <PaperExportDialog
          open={exportOpen}
          onOpenChange={setExportOpen}
          paperId={paperId}
          title={title}
          markdown={markdown}
          translationMap={translationMap}
          translationFile={translationFile}
          translatedMeta={translatedMeta}
          annotations={annotations}
          currentViewMode={viewMode}
        />
      )}
    </div>
  );
}
