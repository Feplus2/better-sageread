/**
 * 书籍阅读器翻译下拉（docs/book-translation-plan.md 一期入口）。
 *
 * 与论文侧 PaperTranslationDropdown 同构的三区：显示模式（radio，书籍一期两态——
 * 原文/逐段对照，"译文模式"二期）+ 翻译入口/进度/取消 + 句对齐状态与重建。
 * 视觉与交互逐项对齐（Label/RadioItem/MenuItem/Separator、主题色进度条、busy 触发器旋转）。
 *
 * 译文上屏双通道：章节加载时由 translation transformer 注入；任务收尾广播
 * book-translation-updated → 此处对当前显示章节直接 DOM 注入（同章 goTo 走 blob URL
 * 缓存不重流 transform；与 transformer 同一函数，契约不破）。
 */

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getBookStatus } from "@/services/book-service";
import { summarizeBookAlignment } from "@/services/book-translation/book-alignment";
import {
  listBookTranslationSectionIndexes,
  loadBookTranslationSection,
} from "@/services/book-translation/book-translation-service";
import {
  enumerateSectionBlocks,
  injectSectionTranslations,
  wrapSectionDocument,
} from "@/services/book-translation/section-blocks";
import { enqueueBookTranslate } from "@/services/task-executors/book-translate";
import { useAppSettingsStore } from "@/store/app-settings-store";
import { selectChannelAggregate, useTaskCenterStore } from "@/store/task-center-store";
import type { BookViewModeType } from "@/types/book";
import type { BookTranslationMeta } from "@/types/simple-book";
import { getStyles, resolveBookViewMode } from "@/utils/style";
import { AlignLeft, Columns3, FileText, Languages, Loader2, Play, RefreshCw, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useReaderStore, useReaderStoreApi } from "./reader-provider";

/** 显示模式三态（批次 2，语义对齐论文侧；论文侧同款图标） */
const MODE_ITEMS: { value: BookViewModeType; label: string; icon: typeof FileText }[] = [
  { value: "original", label: "原文", icon: FileText },
  { value: "translated", label: "译文", icon: Languages },
  { value: "bilingual", label: "逐段对照", icon: Columns3 },
];

const TranslateDropdown = () => {
  const bookId = useReaderStore((state) => state.bookId);
  const bookData = useReaderStore((state) => state.bookData);
  const openDropdown = useReaderStore((state) => state.openDropdown);
  const setOpenDropdown = useReaderStore((state) => state.setOpenDropdown);
  const store = useReaderStoreApi();

  const { settings, setSettings } = useAppSettingsStore();
  const viewMode = resolveBookViewMode(settings.globalViewSettings);

  // 当前书的翻译任务态（book-translate 通道并发 1；alignOnly 任务同样占用此通道）。
  // selectChannelAggregate 每次返回新对象，不能直接作 zustand 选择器（getSnapshot 须缓存，
  // 否则无限重渲染黑屏）——订阅稳定的 tasks/order 引用再 useMemo 聚合（global-convert-progress 同款）
  const taskCenterTasks = useTaskCenterStore((s) => s.tasks);
  const taskCenterOrder = useTaskCenterStore((s) => s.order);
  const aggregate = useMemo(
    () => selectChannelAggregate({ tasks: taskCenterTasks, order: taskCenterOrder }, "book-translate"),
    [taskCenterTasks, taskCenterOrder],
  );
  const activeTask = aggregate.current && aggregate.current.targetId === bookId ? aggregate.current : null;
  const taskPayload = (activeTask?.payload ?? {}) as { alignOnly?: boolean };
  const busy = activeTask !== null;

  const [translationMeta, setTranslationMeta] = useState<BookTranslationMeta | null>(null);
  const [sectionCount, setSectionCount] = useState(0);
  const [alignInfo, setAlignInfo] = useState<{ aligned: number; alignedW: number; total: number } | null>(null);
  const hasTranslation = sectionCount > 0;

  const isTranslateDropdownOpen = openDropdown === "translate";
  // 注意 format 在 bookData.book（BookDataState 顶层无 format 字段）；语言用全仓约定字段
  // primaryLanguage（bookConvert.ts:33 由 DB language 映射，search-bar.tsx 同款读法）
  const bookFormat = bookData?.book?.format;
  const isFixedLayout = bookData?.bookDoc?.rendition?.layout === "pre-paginated";
  const language = (bookData?.book?.primaryLanguage ?? "").toLowerCase();
  const looksChinese = language.includes("zh") || language.includes("chi") || language.includes("中文");
  const guardReason =
    bookFormat !== "EPUB"
      ? "仅 EPUB 书籍支持对照翻译"
      : isFixedLayout
        ? "固定版式（fixed-layout）书籍不支持对照翻译"
        : looksChinese
          ? "中文书籍无需对照翻译"
          : null;

  const refreshStatus = useCallback(async () => {
    if (!bookId) return;
    try {
      const status = await getBookStatus(bookId);
      setTranslationMeta(status?.metadata?.translation ?? null);
      setSectionCount((await listBookTranslationSectionIndexes(bookId)).length);
      setAlignInfo(await summarizeBookAlignment(bookId));
    } catch {
      /* 状态行为可缺省 */
    }
  }, [bookId]);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  // 下拉打开时刷新状态行（任务结算后重开口径）；不用订阅——进度高频 patch 会造成 IPC 刷新风暴
  useEffect(() => {
    if (isTranslateDropdownOpen) refreshStatus();
  }, [isTranslateDropdownOpen, refreshStatus]);

  // 任务收尾广播：对当前显示章节直接注入译文（不重渲染、不闪动）
  useEffect(() => {
    if (!bookId) return;
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail as { bookId?: string };
      if (detail?.bookId !== bookId) return;
      refreshStatus();
      void (async () => {
        const view = store.getState().view;
        try {
          for (const content of view?.renderer?.getContents?.() ?? []) {
            if (content.index === undefined) continue;
            const file = await loadBookTranslationSection(bookId, content.index);
            if (!file) continue;
            const parsed = wrapSectionDocument(content.doc);
            injectSectionTranslations(parsed, enumerateSectionBlocks(parsed), file.blocks);
          }
        } catch (error) {
          console.warn("注入译文到当前章节失败（翻章后自然生效）:", error);
        }
      })();
    };
    window.addEventListener("book-translation-updated", handler);
    return () => window.removeEventListener("book-translation-updated", handler);
  }, [bookId, refreshStatus, store]);

  const handleToggleDropdown = (isOpen: boolean) => {
    setOpenDropdown?.(isOpen ? "translate" : null);
  };

  const handleViewModeChange = (mode: BookViewModeType) => {
    if (mode !== "original" && !hasTranslation) {
      toast.info("暂无译本，请先翻译全书");
      return;
    }
    const { settings: current } = useAppSettingsStore.getState();
    // bookViewMode 为准，translationEnabled 同步派生（旧字段兼容读者，无迁移代码）
    const updated = {
      ...current.globalViewSettings,
      bookViewMode: mode,
      translationEnabled: mode !== "original",
    };
    setSettings({ ...current, globalViewSettings: updated });
    store.getState().view?.renderer.setStyles?.(getStyles(updated));
  };

  const handleTranslate = (force: boolean) => {
    if (!bookId || !bookData?.book || guardReason) return;
    const result = enqueueBookTranslate({ id: bookId, title: bookData.book.title, force });
    if (!result.ok) toast.info(result.detail ?? "已在翻译队列中");
  };

  const handleAlign = (phase: "sentence" | "words", force: boolean) => {
    if (!bookId || !bookData?.book) return;
    const result = enqueueBookTranslate({
      id: bookId,
      title: bookData.book.title,
      alignOnly: true,
      alignPhase: phase,
      force,
    });
    if (!result.ok) toast.info(result.detail ?? "已在队列中");
  };

  const handleCancel = () => {
    if (activeTask) useTaskCenterStore.getState().cancelTask(activeTask.taskId);
  };

  // 对齐阶段（翻译任务 percent=100 或 alignOnly 任务）：非确定进度，条满格
  const alignPhase = busy && (taskPayload.alignOnly || activeTask.percent >= 100);
  const percent = alignPhase ? 100 : (activeTask?.percent ?? 0);

  if (!bookData) return null;

  return (
    <DropdownMenu open={isTranslateDropdownOpen} onOpenChange={handleToggleDropdown}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              className="btn btn-ghost flex h-6 w-6 items-center justify-center rounded-full p-0 outline-none focus:outline-none focus-visible:ring-0"
              disabled={bookFormat !== "EPUB"}
            >
              {busy ? (
                <Loader2 size={16} className="animate-spin text-base-content" />
              ) : (
                <Languages size={18} className="text-base-content" />
              )}
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">翻译</TooltipContent>
      </Tooltip>
      <DropdownMenuContent className="w-60 p-2" align="end" side="bottom" sideOffset={4}>
        {/* 区 1：显示模式（radio 语义，与论文侧同款；书籍一期两态，译文模式二期） */}
        <DropdownMenuLabel className="px-2 py-1 text-neutral-500 text-xs dark:text-neutral-400">
          显示模式
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={viewMode}
          onValueChange={(value) => handleViewModeChange(value as BookViewModeType)}
        >
          {MODE_ITEMS.map((item) => (
            <DropdownMenuRadioItem key={item.value} value={item.value} className="text-sm">
              <item.icon className="size-4 text-neutral-500 dark:text-neutral-400" />
              {item.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator className="my-2" />

        {/* 区 2：翻译（守卫原因行 / 翻译中进度条+取消 / 入口项，论文侧同款形态） */}
        <DropdownMenuLabel className="px-2 py-1 text-neutral-500 text-xs dark:text-neutral-400">翻译</DropdownMenuLabel>
        {busy && !taskPayload.alignOnly ? (
          <div className="px-2 py-1.5">
            <div className="mb-1.5 flex items-center justify-between text-neutral-600 text-xs dark:text-neutral-400">
              <span>{alignPhase ? "句对齐中…" : `${activeTask.detail || "翻译中…"}（${percent}%）`}</span>
              <button
                type="button"
                className="flex items-center gap-0.5 text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
                onClick={handleCancel}
              >
                <X className="size-3.5" />
                取消
              </button>
            </div>
            {/* 进度条颜色跟随全局主题主色 --primary（与论文侧同一主题跟随写法） */}
            <div
              className="h-1.5 w-full overflow-hidden rounded-full"
              style={{ backgroundColor: "color-mix(in oklab, var(--primary) 15%, transparent)" }}
            >
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{ width: `${percent}%`, backgroundColor: "var(--primary)" }}
              />
            </div>
          </div>
        ) : guardReason ? (
          <div className="px-2 py-1 text-neutral-500 text-xs dark:text-neutral-400">{guardReason}</div>
        ) : (
          <>
            {/* 译本身份行：完整/不完整 + 段数计数（translationMeta 回写自 book_status.metadata.translation） */}
            {hasTranslation && translationMeta && (
              <div className="px-2 py-1 text-neutral-500 text-xs dark:text-neutral-400">
                {translationMeta.status === "complete"
                  ? `译本完整 · ${translationMeta.doneBlocks}/${translationMeta.totalBlocks} 段`
                  : `译本不完整（可续翻） · ${translationMeta.doneBlocks}/${translationMeta.totalBlocks} 段`}
                {translationMeta.failedBatches ? ` · ${translationMeta.failedBatches} 批失败` : ""}
              </div>
            )}
            <DropdownMenuItem className="text-sm" onSelect={() => handleTranslate(false)}>
              <Play className="size-4" />
              {hasTranslation ? "继续翻译（跳过已翻）" : "翻译全书"}
            </DropdownMenuItem>
            {hasTranslation && (
              <DropdownMenuItem className="text-sm" onSelect={() => handleTranslate(true)}>
                <RotateCcw className="size-4" />
                重新翻译（全部重翻）
              </DropdownMenuItem>
            )}
          </>
        )}

        {/* 区 3：句对齐 + 词对齐（08-29 裁定拆开独立模块——书籍词级嵌入贵，成本可见可控）。
            依赖规则：词依赖句（触发词对齐时句级缺失的段自动补算）；重建句对齐牵连作废旧词级；
            重建词对齐不碰句缓存。运行中（对齐任务在跑）两模块的按钮都禁用。 */}
        {hasTranslation && !busy && (
          <>
            <DropdownMenuSeparator className="my-2" />
            <DropdownMenuLabel className="px-2 py-1 text-neutral-500 text-xs dark:text-neutral-400">
              句对齐
            </DropdownMenuLabel>
            <div className="flex items-center gap-1.5 px-2 py-1 text-neutral-500 text-xs dark:text-neutral-400">
              <AlignLeft className="size-3.5" />
              {alignInfo ? `句 ${alignInfo.aligned}/${alignInfo.total} 已对齐` : "对齐状态检查中…"}
            </div>
            <DropdownMenuItem className="text-sm" onSelect={() => handleAlign("sentence", true)}>
              <RefreshCw className="size-4" />
              重建句对齐
            </DropdownMenuItem>

            <DropdownMenuSeparator className="my-2" />
            <DropdownMenuLabel className="px-2 py-1 text-neutral-500 text-xs dark:text-neutral-400">
              词对齐
            </DropdownMenuLabel>
            <div className="flex items-center gap-1.5 px-2 py-1 text-neutral-500 text-xs dark:text-neutral-400">
              <AlignLeft className="size-3.5" />
              {alignInfo ? `词 ${alignInfo.alignedW}/${alignInfo.total} 已对齐` : "对齐状态检查中…"}
            </div>
            <DropdownMenuItem
              className="text-sm"
              onSelect={() => handleAlign("words", alignInfo ? alignInfo.alignedW > 0 : false)}
            >
              {alignInfo && alignInfo.alignedW > 0 ? <RefreshCw className="size-4" /> : <Play className="size-4" />}
              {alignInfo && alignInfo.alignedW > 0 ? "重建词对齐" : "构建词对齐"}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default TranslateDropdown;
