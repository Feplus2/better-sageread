import AITagConfirmDialog from "@/components/ai/tag-confirm-dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDownloadImage } from "@/hooks/use-download-image";
import { useModelSelector } from "@/hooks/use-model-selector";
import type { BookTag } from "@/pages/library/hooks/use-tags-management";
import { type AITagSuggestion, generateTagsWithAI } from "@/services/ai-tag-service";
import { rebuildCoverAfterDownload } from "@/services/book-service";
import { syncDownloadBook } from "@/services/sync-service";
import { type Tag, createTag, getTags } from "@/services/tag-service";
import { useLayoutStore } from "@/store/layout-store";
import { useTaskCenterStore } from "@/store/task-center-store";
import type { BookWithStatusAndUrls } from "@/types/simple-book";
import { appDataDir, join } from "@tauri-apps/api/path";
import { ask } from "@tauri-apps/plugin-dialog";
import { exists } from "@tauri-apps/plugin-fs";
import { openPath } from "@tauri-apps/plugin-opener";
import { Check, Cloud, MoreHorizontal } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import EditInfo from "./edit-info";
import EmbeddingDialog from "./embedding-dialog";

interface BookUpdateData {
  title?: string;
  author?: string;
  coverPath?: string;
  tags?: string[];
}

/** fixed-layout 探测缓存（bookId → 是否固定版式）：右键菜单翻译守卫用——该信息只在解析 EPUB 后
 *  可知（rendition.layout），对每书每会话至多惰性解析一次；翻译执行器的 assertBookTranslatable
 *  仍是权威兜底（探测失败不置灰，拒翻文案与阅读器下拉一致） */
const fixedLayoutProbeCache = new Map<string, boolean>();
const fixedLayoutProbePending = new Set<string>();

interface BookItemProps {
  book: BookWithStatusAndUrls;
  viewMode?: "grid" | "list";
  availableTags?: BookTag[];
  onDelete?: (book: BookWithStatusAndUrls) => Promise<boolean>;
  onUpdate?: (bookId: string, updates: BookUpdateData) => Promise<boolean>;
  onRefresh?: () => Promise<void>;
  /** 多选模式：点击切换选中而非打开，并显示勾选框 */
  selectionMode?: boolean;
  isSelected?: boolean;
  onToggleSelect?: (bookId: string) => void;
}

export default function BookItem({
  book,
  availableTags = [],
  onDelete,
  onUpdate,
  onRefresh,
  selectionMode = false,
  isSelected = false,
  onToggleSelect,
}: BookItemProps) {
  const [showEditDialog, setShowEditDialog] = useState(false);
  const { downloadImage } = useDownloadImage();

  // AI标签生成相关状态
  const [showAITagDialog, setShowAITagDialog] = useState(false);
  const [aiTagSuggestions, setAiTagSuggestions] = useState<AITagSuggestion[]>([]);
  const [isAITagLoading, setIsAITagLoading] = useState(false);
  const { selectedModel } = useModelSelector();
  const [showEmbeddingDialog, setShowEmbeddingDialog] = useState(false);
  // 向量化排队/运行态读 task-center 的 book-vectorize 通道（P2-2 统一入队；
  // 进度 percent 由通道执行器从 epub://index-progress 事件回写任务上）
  const vectorizeTask = useTaskCenterStore((s) => {
    for (const id of s.order) {
      const t = s.tasks[id];
      if (
        t &&
        t.channel === "book-vectorize" &&
        t.targetId === book.id &&
        (t.status === "queued" || t.status === "running")
      ) {
        return t;
      }
    }
    return null;
  });
  const vectorizeProgress: number | null = vectorizeTask ? vectorizeTask.percent : null;

  // ── 翻译右键入口（与阅读器翻译下拉同通道 book-translate；菜单口径照论文页右键菜单） ──
  // 守卫与阅读器下拉同一套：仅 EPUB；中文书禁（primaryLanguage=DB language 字段判定）；
  // fixed-layout 禁（开菜单时惰性探测，见上模块级缓存）
  const translationMeta = book.status?.metadata?.translation;
  // 论文页口径：仅「已有完整译本」才显示「重新翻译」并 force 全量重翻；未翻译/部分/失败 → 幂等续翻
  const hasCompleteTranslation = translationMeta?.status === "complete";
  const bookLanguage = (book.language ?? "").toLowerCase();
  const looksChinese = bookLanguage.includes("zh") || bookLanguage.includes("chi") || bookLanguage.includes("中文");
  const [isFixedLayout, setIsFixedLayout] = useState(() => fixedLayoutProbeCache.get(book.id) === true);
  const probeTranslateGuard = useCallback(() => {
    if (book.format !== "EPUB" || looksChinese) return;
    const cached = fixedLayoutProbeCache.get(book.id);
    if (cached !== undefined) {
      if (cached !== isFixedLayout) setIsFixedLayout(cached);
      return;
    }
    if (fixedLayoutProbePending.has(book.id)) return;
    fixedLayoutProbePending.add(book.id);
    void import("@/services/book-translation/book-translation-service")
      .then((m) => m.openBookDocument(book.id))
      .then(({ bookDoc }) => {
        const fixed = bookDoc.rendition?.layout === "pre-paginated";
        fixedLayoutProbeCache.set(book.id, fixed);
        setIsFixedLayout(fixed);
      })
      .catch(() => {})
      .finally(() => fixedLayoutProbePending.delete(book.id));
  }, [book.id, book.format, looksChinese, isFixedLayout]);
  const translateGuardReason =
    book.format !== "EPUB"
      ? "仅 EPUB 书籍支持对照翻译"
      : looksChinese
        ? "中文书籍无需对照翻译"
        : isFixedLayout
          ? "固定版式（fixed-layout）书籍不支持对照翻译"
          : null;

  // 数据库标签（供右键菜单“管理标签”子菜单映射真实标签 ID）
  const [databaseTags, setDatabaseTags] = useState<Tag[]>([]);
  useEffect(() => {
    getTags()
      .then(setDatabaseTags)
      .catch((e) => console.error("加载标签失败:", e));
  }, []);

  // 右键菜单受控开关（MoreHorizontal 图标点击也可打开）
  const [, setMenuOpen] = useState(false);

  /** 打开书籍数据目录（{appData}/books/{id}——转换产物 EPUB/paper.md/封面都在这里） */
  const handleOpenFolder = async () => {
    try {
      const dir = await join(await appDataDir(), "books", book.id);
      if (!(await exists(dir))) {
        toast.error("文件夹不存在（可能已被清理）");
        return;
      }
      await openPath(dir);
    } catch (error) {
      console.error("打开文件夹失败:", error);
      toast.error("打开文件夹失败");
    }
  };

  // openBook 必须 selector 订阅：整店订阅会被 activateTab 翻动（tabs/activeTabId 每次必变），
  // 14 张书卡（含各自 Tooltip/ContextMenu/两个对话框子树）每次切 tab 全量重渲——切 tab 残余墙元凶
  const openBook = useLayoutStore((s) => s.openBook);
  const [isCloudOnly, setIsCloudOnly] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  // 封面文件缺失（如云端下载后未重建）时回落占位渐变，而不是破图
  const [coverBroken, setCoverBroken] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: book.id/coverUrl 是刻意的触发依赖（书籍/封面变更时重置破图标记）
  useEffect(() => setCoverBroken(false), [book.id, book.coverUrl]);

  // 检测书籍文件是否仅在云端（本地文件不存在）
  useEffect(() => {
    if (book.filePath) {
      appDataDir()
        .then((base) => exists(`${base}/${book.filePath}`))
        .then((fileExists) => {
          setIsCloudOnly(!fileExists);
        })
        .catch(() => setIsCloudOnly(false));
    }
  }, [book.filePath]);

  const handleClick = useCallback(async () => {
    // 多选模式下点击切换选中，不打开书籍
    if (selectionMode) {
      onToggleSelect?.(book.id);
      return;
    }
    if (isCloudOnly) {
      setIsDownloading(true);
      try {
        toast.info(`正在下载《${book.title}》...`);
        // 150s 前端兜底超时（后端 reqwest 120s）：超时/失败清掉"下载中"并 toast 原因
        await Promise.race([
          syncDownloadBook(book.id),
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error("下载超时（150 秒），请检查网络后重试")), 150_000);
          }),
        ]);
        // 下载只带书文件本体，封面按导入同款逻辑重建到 books/<id>/cover.jpg（失败不阻塞打开）
        await rebuildCoverAfterDownload(book.id, book.format);
        setIsCloudOnly(false);
        openBook(book.id, book.title);
      } catch (error) {
        console.error("下载书籍失败:", error);
        toast.error("下载失败", { description: String(error) });
      } finally {
        setIsDownloading(false);
      }
    } else {
      openBook(book.id, book.title);
    }
  }, [book.id, book.title, book.format, isCloudOnly, openBook, selectionMode, onToggleSelect]);

  const handleAIGenerateTags = useCallback(async () => {
    if (!selectedModel) {
      toast.error("请先在设置中配置AI模型");
      return;
    }

    setIsAITagLoading(true);

    // 显示正在请求的toast
    toast.info("正在请求AI生成标签...");

    try {
      // 获取现有标签
      const existingTags = await getTags();

      // 调用AI生成标签
      const aiResponse = await generateTagsWithAI(book, existingTags, {
        providerId: selectedModel.providerId,
        modelId: selectedModel.modelId,
      });

      setAiTagSuggestions(aiResponse.suggestions);
      setShowAITagDialog(true);
    } catch (error) {
      console.error("AI生成标签失败:", error);
      toast.error(error instanceof Error ? error.message : "AI生成标签失败，请重试");
    } finally {
      setIsAITagLoading(false);
    }
  }, [selectedModel, book]);

  const handleAITagConfirm = useCallback(
    async (selectedTags: { name: string; isExisting: boolean; existingTagId?: string }[]) => {
      if (selectedTags.length === 0) {
        setShowAITagDialog(false);
        return;
      }

      setIsAITagLoading(true);

      try {
        const tagIds: string[] = [];

        for (const tag of selectedTags) {
          if (tag.isExisting && tag.existingTagId) {
            tagIds.push(tag.existingTagId);
          } else {
            const newTag = await createTag({
              name: tag.name,
              color: `#${Math.floor(Math.random() * 16777215).toString(16)}`,
            });
            tagIds.push(newTag.id);
          }
        }

        const currentTags = book.tags || [];
        const updatedTags = Array.from(new Set([...currentTags, ...tagIds]));

        if (onUpdate) {
          const success = await onUpdate(book.id, { tags: updatedTags });

          if (success) {
            toast.success(`成功添加 ${selectedTags.length} 个标签`);

            if (onRefresh) {
              await onRefresh();
            }
          } else {
            toast.error("添加标签失败，请重试");
          }
        }

        setShowAITagDialog(false);
      } catch (error) {
        console.error("添加AI标签失败:", error);
        toast.error(error instanceof Error ? error.message : "添加标签失败，请重试");
      } finally {
        setIsAITagLoading(false);
      }
    },
    [book, onUpdate, onRefresh],
  );

  const handleNativeDelete = useCallback(async () => {
    if (onDelete) {
      try {
        const confirmed = await ask(`确定要删除《${book.title}》吗？\n\n书籍将被移入回收站，可在回收站中恢复。`, {
          title: "确认删除",
          kind: "warning",
        });

        if (confirmed) {
          await onDelete(book);
        }
      } catch (error) {
        console.error("Failed to show delete dialog:", error);
      }
    }
  }, [onDelete, book]);

  const handleDownloadImage = useCallback(async () => {
    if (!book.coverUrl) {
      console.warn("No cover image available for download");
      return;
    }

    await downloadImage(book.coverUrl, {
      title: book.title,
      defaultFileName: `${book.title}_cover`,
    });
  }, [book.coverUrl, book.title, downloadImage]);

  // 向量化（P2-2 统一入队）：进 task-center 的 book-vectorize 通道；同书在队/在跑由队列幂等拒入。
  // 执行/进度/metadata 回写/toast/通知/列表刷新全在执行器（services/task-executors/book-vectorize.ts）。
  const handleVectorizeBook = useCallback(async () => {
    const { enqueueBookVectorize } = await import("@/services/task-executors/book-vectorize");
    const res = enqueueBookVectorize({ id: book.id, title: book.title, solo: true });
    if (res.ok) toast.info("开始向量化...");
    else toast.info(res.detail ?? "该书已在向量化队列中");
  }, [book.id, book.title]);

  // 翻译（book-translate 通道，与阅读器翻译下拉同入口薄壳）：默认幂等续翻；已有完整译本走
  // 「重新翻译」= force 全量重翻，确认框与论文页右键重翻同款（pages/papers/index.tsx handleBatchTranslate）。
  // book-translate × book-vectorize × book-convert 同书互斥由统一冲突检查器拒入（detail 透传 toast）
  const handleTranslateBook = useCallback(async () => {
    if (translateGuardReason) return;
    let force = false;
    if (hasCompleteTranslation) {
      let confirmed = false;
      try {
        confirmed = await ask(`将全量重新翻译《${book.title}》：已有译文作废重翻，耗时与额度消耗与首次翻译相当。`, {
          title: "重新翻译",
          kind: "warning",
        });
      } catch (error) {
        console.error("确认对话框失败:", error);
      }
      if (!confirmed) return;
      force = true;
    }
    const { enqueueBookTranslate } = await import("@/services/task-executors/book-translate");
    const res = enqueueBookTranslate({ id: book.id, title: book.title, force, solo: true });
    if (res.ok) toast.success("已加入翻译队列");
    else toast.info(res.detail ?? "该书已在翻译队列中");
  }, [book.id, book.title, hasCompleteTranslation, translateGuardReason]);

  const handleTagToggle = useCallback(
    async (tagId: string) => {
      if (!onUpdate) return;

      const currentTags = book.tags || [];
      const hasTag = currentTags.includes(tagId);

      let newTags: string[];
      if (hasTag) {
        // 移除标签
        newTags = currentTags.filter((tag) => tag !== tagId);
      } else {
        // 添加标签（去重）
        newTags = Array.from(new Set([...currentTags, tagId]));
      }

      try {
        await onUpdate(book.id, { tags: newTags });
      } catch (error) {
        console.error("Failed to update tags:", error);
      }
    },
    [book.id, book.tags, onUpdate],
  );

  const renderProgress = () => {
    if (!book.status) {
      return null;
    }

    const { status, progressCurrent = 0, progressTotal = 0 } = book.status;

    if (status === "unread") {
      return (
        <div className="inline-block rounded-full bg-neutral-100 px-1.5 py-0.5 text-neutral-600 text-xs dark:bg-neutral-800 dark:text-neutral-300">
          New
        </div>
      );
    }

    if (status === "completed") {
      return (
        <div className="inline-block rounded-full bg-green-100 px-2 py-1 font-medium text-green-600 text-xs dark:bg-green-900 dark:text-green-300">
          Complete
        </div>
      );
    }

    const progress = progressTotal > 0 ? Math.round((progressCurrent / progressTotal) * 100) : 0;
    return (
      <div className="flex items-center gap-1">
        <div className="h-1.5 w-12 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-700">
          <div
            className="h-full bg-primary transition-all duration-300"
            style={{ width: `${Math.min(progress, 100)}%` }}
          />
        </div>
        <span className="text-neutral-500 text-xs dark:text-neutral-400">{progress}%</span>
      </div>
    );
  };

  const renderVectorizationStatus = () => {
    const statusFromMeta = book.status?.metadata?.vectorization?.status ?? "idle";
    const effectiveStatus =
      vectorizeProgress != null && vectorizeProgress >= 0 && vectorizeProgress < 100 ? "processing" : statusFromMeta;

    if (effectiveStatus === "processing") {
      const pct = Math.max(0, Math.min(100, vectorizeProgress ?? 0));
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center gap-1">
              <div className="relative h-4 w-4" aria-label={`processing ${pct}%`}>
                <div
                  className="absolute inset-0 rounded-full"
                  style={{ background: `conic-gradient(#eab308 ${pct}%, rgba(229,231,235,0.6) 0)` }}
                />
                <div className="absolute inset-[2px] rounded-full bg-white dark:bg-neutral-900" />
              </div>
              <span className="text-[10px] text-neutral-500 leading-none dark:text-neutral-400">{pct}%</span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom">{`向量化: processing ${pct}%`}</TooltipContent>
        </Tooltip>
      );
    }

    const colorClass =
      effectiveStatus === "success"
        ? "border-green-500"
        : effectiveStatus === "failed"
          ? "border-red-500"
          : "border-neutral-400 dark:border-neutral-500";
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-1">
            <div className={`h-3.5 w-3.5 rounded-full border-2 ${colorClass}`} />
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom">{`向量化: ${effectiveStatus}`}</TooltipContent>
      </Tooltip>
    );
  };

  const isUnread = !book.status || book.status.status === "unread";
  const currentTags = book.tags || [];
  const vectorMeta = book.status?.metadata?.vectorization;
  const isVectorized = vectorMeta?.status === "success";
  const tagOptions = availableTags.filter((tag) => tag.id !== "all" && tag.id !== "uncategorized");

  const menuContent = (
    <ContextMenuContent>
      <ContextMenuItem onClick={() => handleClick()}>打开</ContextMenuItem>
      <ContextMenuItem onClick={() => void handleOpenFolder()}>打开文件夹</ContextMenuItem>
      <ContextMenuSub>
        <ContextMenuSubTrigger>{isVectorized ? "✓ 向量化" : "向量化"}</ContextMenuSubTrigger>
        <ContextMenuSubContent>
          {isVectorized && (
            <>
              <ContextMenuItem disabled>✓ 已向量化</ContextMenuItem>
              <ContextMenuItem disabled>模型: {vectorMeta?.model || "未知"}</ContextMenuItem>
              <ContextMenuItem disabled>维度: {vectorMeta?.dimension || 0}</ContextMenuItem>
              <ContextMenuItem disabled>分块: {vectorMeta?.chunkCount || 0}</ContextMenuItem>
            </>
          )}
          <ContextMenuItem onClick={() => void handleVectorizeBook()}>
            {isVectorized ? "重新向量化" : "开始向量化"}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => setShowEmbeddingDialog(true)}>向量化测试</ContextMenuItem>
        </ContextMenuSubContent>
      </ContextMenuSub>
      {translateGuardReason ? (
        <Tooltip>
          <TooltipTrigger asChild>
            {/* 置灰项 pointer-events-none，包一层 span 让 tooltip 可悬停（说明禁用原因） */}
            <span className="block">
              <ContextMenuItem disabled>{hasCompleteTranslation ? "重新翻译" : "翻译"}</ContextMenuItem>
            </span>
          </TooltipTrigger>
          <TooltipContent side="right">{translateGuardReason}</TooltipContent>
        </Tooltip>
      ) : (
        <ContextMenuItem onClick={() => void handleTranslateBook()}>
          {hasCompleteTranslation ? "重新翻译" : "翻译"}
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => setShowEditDialog(true)}>编辑信息</ContextMenuItem>
      {book.coverUrl && <ContextMenuItem onClick={() => handleDownloadImage()}>下载图片</ContextMenuItem>}
      <ContextMenuSub>
        <ContextMenuSubTrigger>管理标签</ContextMenuSubTrigger>
        <ContextMenuSubContent>
          <ContextMenuItem onClick={() => handleAIGenerateTags()}>AI 生成</ContextMenuItem>
          {tagOptions.length > 0 && <ContextMenuSeparator />}
          {tagOptions.map((tag) => {
            const tagName = tag.id.startsWith("tag-") ? tag.id.replace("tag-", "") : tag.name;
            const dbTag = databaseTags.find((t) => t.name === tagName);
            const realTagId = dbTag?.id;
            const hasTag = realTagId ? currentTags.includes(realTagId) : false;
            return (
              <ContextMenuItem key={tag.id} onClick={() => realTagId && handleTagToggle(realTagId)}>
                {hasTag ? `✓ ${tagName}` : tagName}
              </ContextMenuItem>
            );
          })}
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => console.log(isUnread ? "Mark as Read clicked" : "Mark as Unread clicked")}>
        {isUnread ? "标记为已读" : "标记为未读"}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem variant="destructive" onClick={() => handleNativeDelete()}>
        删除
      </ContextMenuItem>
    </ContextMenuContent>
  );

  return (
    <>
      <ContextMenu
        onOpenChange={(open) => {
          setMenuOpen(open);
          if (open) probeTranslateGuard();
        }}
      >
        <ContextMenuTrigger asChild>
          <div className="group cursor-pointer" onClick={handleClick}>
            <div
              data-region="book-card"
              className="rounded-r-2xl rounded-l-md border border-neutral-200 bg-white shadow-sm transition-shadow hover:shadow-md dark:border-neutral-700 dark:bg-neutral-800"
            >
              <div className="relative p-2 pb-0">
                <div className="mb-2">
                  <h4 className="truncate text-neutral-600 text-sm leading-tight dark:text-neutral-200">
                    {book.title}
                  </h4>
                </div>

                <div data-region="book-cover" className="relative aspect-[4/5] w-full overflow-hidden">
                  {book.coverUrl && !coverBroken ? (
                    <img
                      src={book.coverUrl}
                      alt={book.title}
                      className="h-full w-full object-cover"
                      onError={() => setCoverBroken(true)}
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-neutral-100 to-neutral-300 dark:from-neutral-700 dark:to-neutral-800">
                      <div className="p-4 text-center">
                        <div className="mb-2 font-bold text-2xl text-neutral-500 dark:text-neutral-400">📖</div>
                        <div className="line-clamp-3 text-neutral-600 text-xs dark:text-neutral-300">{book.title}</div>
                      </div>
                    </div>
                  )}
                  {isCloudOnly && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div className="absolute top-1 right-1 rounded-full bg-black/60 p-1">
                          <Cloud size={12} className="text-white" />
                        </div>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">仅在云端，点击打开时自动下载</TooltipContent>
                    </Tooltip>
                  )}
                  {isDownloading && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                      <span className="text-white text-xs">下载中...</span>
                    </div>
                  )}
                  {selectionMode && (
                    <div
                      className={`motion-enter-pop absolute top-1 left-1 flex size-5 items-center justify-center rounded border transition-colors ${
                        isSelected
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-neutral-300 bg-white/80 dark:border-neutral-500 dark:bg-neutral-800/80"
                      }`}
                    >
                      {isSelected && <Check size={14} />}
                    </div>
                  )}
                </div>
              </div>

              <div className="flex h-8 items-center justify-between space-x-2 p-2 py-0">
                <div className="flex-1">{renderProgress()}</div>
                <div className="flex items-center gap-2">
                  {renderVectorizationStatus()}
                  <DropdownMenu
                    onOpenChange={(open) => {
                      if (open) probeTranslateGuard();
                    }}
                  >
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            onClick={(e) => e.stopPropagation()}
                            className="rounded p-0.5 hover:bg-accent dark:hover:bg-accent"
                          >
                            <MoreHorizontal className="h-4 w-4 text-neutral-500 dark:text-neutral-400" />
                          </button>
                        </DropdownMenuTrigger>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">更多操作</TooltipContent>
                    </Tooltip>
                    <DropdownMenuContent align="end" className="w-48">
                      <DropdownMenuItem onClick={() => handleClick()}>打开</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => void handleOpenFolder()}>打开文件夹</DropdownMenuItem>
                      <DropdownMenuSub>
                        <DropdownMenuSubTrigger>{isVectorized ? "✓ 向量化" : "向量化"}</DropdownMenuSubTrigger>
                        <DropdownMenuSubContent>
                          {isVectorized && (
                            <>
                              <DropdownMenuItem disabled>✓ 已向量化</DropdownMenuItem>
                              <DropdownMenuItem disabled>模型: {vectorMeta?.model || "未知"}</DropdownMenuItem>
                              <DropdownMenuItem disabled>维度: {vectorMeta?.dimension || 0}</DropdownMenuItem>
                              <DropdownMenuItem disabled>分块: {vectorMeta?.chunkCount || 0}</DropdownMenuItem>
                            </>
                          )}
                          <DropdownMenuItem onClick={() => void handleVectorizeBook()}>
                            {isVectorized ? "重新向量化" : "开始向量化"}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setShowEmbeddingDialog(true)}>向量化测试</DropdownMenuItem>
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                      {translateGuardReason ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            {/* 置灰项 pointer-events-none，包一层 span 让 tooltip 可悬停（说明禁用原因） */}
                            <span className="block">
                              <DropdownMenuItem disabled>
                                {hasCompleteTranslation ? "重新翻译" : "翻译"}
                              </DropdownMenuItem>
                            </span>
                          </TooltipTrigger>
                          <TooltipContent side="right">{translateGuardReason}</TooltipContent>
                        </Tooltip>
                      ) : (
                        <DropdownMenuItem onClick={() => void handleTranslateBook()}>
                          {hasCompleteTranslation ? "重新翻译" : "翻译"}
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={() => setShowEditDialog(true)}>编辑信息</DropdownMenuItem>
                      {book.coverUrl && (
                        <DropdownMenuItem onClick={() => handleDownloadImage()}>下载图片</DropdownMenuItem>
                      )}
                      <DropdownMenuSub>
                        <DropdownMenuSubTrigger>管理标签</DropdownMenuSubTrigger>
                        <DropdownMenuSubContent>
                          <DropdownMenuItem onClick={() => handleAIGenerateTags()}>AI 生成</DropdownMenuItem>
                          {tagOptions.length > 0 && <DropdownMenuSeparator />}
                          {tagOptions.map((tag) => {
                            const tagName = tag.id.startsWith("tag-") ? tag.id.replace("tag-", "") : tag.name;
                            const dbTag = databaseTags.find((t) => t.name === tagName);
                            const realTagId = dbTag?.id;
                            const hasTag = realTagId ? currentTags.includes(realTagId) : false;
                            return (
                              <DropdownMenuItem key={tag.id} onClick={() => realTagId && handleTagToggle(realTagId)}>
                                {hasTag ? `✓ ${tagName}` : tagName}
                              </DropdownMenuItem>
                            );
                          })}
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onClick={() => console.log(isUnread ? "Mark as Read clicked" : "Mark as Unread clicked")}
                      >
                        {isUnread ? "标记为已读" : "标记为未读"}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onClick={() => handleNativeDelete()}>
                        删除
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            </div>
          </div>
        </ContextMenuTrigger>
        {menuContent}
      </ContextMenu>

      <EditInfo book={book} isOpen={showEditDialog} onClose={() => setShowEditDialog(false)} onSave={onUpdate} />

      <AITagConfirmDialog
        isOpen={showAITagDialog}
        onClose={() => setShowAITagDialog(false)}
        suggestions={aiTagSuggestions}
        bookTitle={book.title}
        bookAuthor={book.author}
        onConfirm={handleAITagConfirm}
        isLoading={isAITagLoading}
      />

      <EmbeddingDialog isOpen={showEmbeddingDialog} onClose={() => setShowEmbeddingDialog(false)} bookId={book.id} />
    </>
  );
}
