import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { exportAnnotationsToHtml } from "@/lib/export-annotations-html";
import { exportAnnotationsToImage } from "@/lib/export-annotations-image";
import { exportAnnotationsToMarkdown } from "@/lib/export-annotations-markdown";
import { exportAnnotationsToPdf } from "@/lib/export-annotations-pdf";
import { parseAnchor } from "@/pages/paper-reader/paper-anchors";
import type { PaperHighlightLocation } from "@/pages/paper-reader/paper-highlight-locator";
import type { AiAnnotationCreateItem } from "@/pages/paper-reader/use-paper-annotations";
import { HIGHLIGHT_COLOR_HEX, HIGHLIGHT_COLOR_RGBA } from "@/services/constants";
import {
  PAPER_CATEGORY_DEFS,
  PAPER_CATEGORY_ORDER,
  PAPER_KIND_LABELS,
  type PaperKind,
  formatAiAnnotationNote,
  generatePaperHighlights,
} from "@/services/paper-highlight-service";
import { useProviderStore } from "@/store/provider-store";
import type { BookNote } from "@/types/book";
import { ask } from "@tauri-apps/plugin-dialog";
import dayjs from "dayjs";
import { Check, Download, Highlighter, ListChecks, Loader2, NotebookPen, Sparkles, Star, Trash2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";

type PaperNotepadTab = "annotations" | "ai-highlights";

/** 标注导出格式（底栏/头部菜单共用同一导出管线） */
type AnnotationExportFormat = "markdown" | "html" | "image" | "pdf";

/** 论文类型选择：auto=交给辅助模型判定，其余三个为手动指定 */
type PaperKindSelect = PaperKind | "auto";

interface PaperNotepadPanelProps {
  /** 本篇论文的全部标注（type=annotation 且未删除，含 AI 标注） */
  annotations: BookNote[];
  /** 论文标题（导出文档头与文件名用） */
  paperTitle: string;
  /** paper.md 原始文本（AI 重点生成的输入；未加载完成为 null） */
  markdown: string | null;
  /** C2：批量 quote → 锚点换算（注入 PaperReader 的渲染 DOM 能力） */
  onLocateQuotes: (quotes: string[]) => (PaperHighlightLocation | null)[];
  /** C2：批量落库 AI 标注，返回成功条数 */
  onCreateAiAnnotations: (items: AiAnnotationCreateItem[]) => Promise<number>;
  /** C2：清空本篇 AI 标注（仅 source='ai'），返回删除条数 */
  onClearAiAnnotations: () => Promise<number>;
  /** 点击列表项 → 正文滚动定位 + 闪烁强调 */
  onLocateAnnotation: (id: string) => void;
  /** 右键"编辑评论"保存（落 book_notes.note） */
  onUpdateNote: (id: string, note: string) => void;
  onDeleteAnnotation: (id: string) => void;
  /** 切换星标（落 book_notes.starred） */
  onToggleStar: (annotation: BookNote) => void;
  /** 批量删除标注（多选管理模式），逐条删除并统一提示 */
  onDeleteAnnotations: (ids: string[]) => Promise<void>;
}

/** 列表排序键：锚点首个 segment 的块索引（文档位置）；锚点缺失排最后，同块按创建时间升序 */
function annotationSortKey(annotation: BookNote): number {
  const anchor = parseAnchor(annotation.cfi);
  return anchor?.segments[0]?.b ?? Number.MAX_SAFE_INTEGER;
}

/** 展示用文本折叠（Markdown 原文含换行/缩进） */
const collapseWs = (text: string) => text.replace(/\s+/g, " ").trim();

/** 剥掉 AI note 的【类别中文名】前缀（分组标题已展示类别，条目不重复显示） */
const stripCategoryPrefix = (note: string) => note.replace(/^【[^】]*】/, "");

interface PaperAnnotationItemProps {
  annotation: BookNote;
  selectionMode: boolean;
  selected: boolean;
  onLocate: () => void;
  onToggleSelect: () => void;
  onToggleStar: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

/** 标注列表项（呈现对齐书籍 notepad 的 annotation-item：左侧色条 + …before + 高亮 quote + after… + 评论 + 时间） */
function PaperAnnotationItem({
  annotation,
  selectionMode,
  selected,
  onLocate,
  onToggleSelect,
  onToggleStar,
  onEdit,
  onDelete,
}: PaperAnnotationItemProps) {
  const bgColor = annotation.color ? HIGHLIGHT_COLOR_RGBA[annotation.color] : HIGHLIGHT_COLOR_RGBA.yellow;
  const lineColor = annotation.color ? HIGHLIGHT_COLOR_HEX[annotation.color] : HIGHLIGHT_COLOR_HEX.yellow;

  const handleDelete = async () => {
    try {
      const confirmed = await ask(`确定要删除这条标注吗？\n\n"${annotation.text || ""}"\n\n此操作无法撤销。`, {
        title: "确认删除",
        kind: "warning",
      });
      if (confirmed) onDelete();
    } catch (error) {
      console.error("删除标注失败:", error);
    }
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className="group cursor-pointer rounded-lg bg-muted p-2 transition-colors hover:bg-neutral-200/60 dark:bg-neutral-900 dark:hover:bg-neutral-800"
          onClick={selectionMode ? onToggleSelect : onLocate}
        >
          <div className="flex items-stretch gap-2">
            {/* 多选模式：整行点击切换勾选（样式同历史对话多选） */}
            {selectionMode && (
              <span
                className={`flex size-4 flex-shrink-0 items-center justify-center self-center rounded border transition-colors ${
                  selected ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/50"
                }`}
              >
                {selected && <Check size={12} />}
              </span>
            )}
            {/* 左侧 4px 色条（颜色 = 标注色），比整底色更清爽 */}
            <div className="w-1 shrink-0 rounded-full" style={{ backgroundColor: lineColor }} />
            <div className="min-w-0 flex-1">
              {annotation.context && (
                <div className="mb-1 text-sm leading-relaxed">
                  <span className="text-neutral-600 dark:text-neutral-200">
                    ...{collapseWs(annotation.context.before)}
                  </span>
                  <span className="font-medium text-sm" style={{ backgroundColor: bgColor }}>
                    {collapseWs(annotation.text ?? "")}
                  </span>
                  <span className="text-neutral-600 dark:text-neutral-200">
                    {collapseWs(annotation.context.after)}...
                  </span>
                </div>
              )}
              {!annotation.context && (
                <div className="mb-1">
                  <span className="font-medium text-sm" style={{ backgroundColor: bgColor }}>
                    {collapseWs(annotation.text ?? "")}
                  </span>
                </div>
              )}
              {annotation.note && (
                <div className="mt-1 flex items-start gap-1 text-neutral-500 text-xs dark:text-neutral-400">
                  <NotebookPen className="mt-0.5 size-3 shrink-0" />
                  <span className="line-clamp-2">{annotation.note}</span>
                </div>
              )}
              <div className="mt-2 flex items-center gap-2 text-neutral-500 text-xs dark:text-neutral-500">
                <span>{dayjs(annotation.createdAt).format("YYYY-MM-DD HH:mm:ss")}</span>
                {annotation.source === "ai" && (
                  <span className="flex items-center gap-0.5 text-violet-500 dark:text-violet-400">
                    <Sparkles className="size-3" />
                    AI
                  </span>
                )}
                {/* 星标切换（样式同历史对话星标；stopPropagation 不触发定位/勾选） */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      role="button"
                      tabIndex={-1}
                      className={`ml-auto flex-shrink-0 cursor-pointer opacity-40 transition-opacity hover:opacity-100 group-hover:opacity-70 ${
                        annotation.starred ? "opacity-100" : ""
                      }`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleStar();
                      }}
                    >
                      <Star
                        className={`size-3.5 ${annotation.starred ? "fill-amber-400 text-amber-400" : "text-muted-foreground"}`}
                      />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{annotation.starred ? "取消星标" : "星标"}</TooltipContent>
                </Tooltip>
              </div>
            </div>
          </div>
        </div>
      </ContextMenuTrigger>
      {!selectionMode && (
        <ContextMenuContent>
          <ContextMenuItem onClick={onEdit}>编辑评论</ContextMenuItem>
          <ContextMenuItem variant="destructive" onClick={() => handleDelete()}>
            删除
          </ContextMenuItem>
        </ContextMenuContent>
      )}
    </ContextMenu>
  );
}

interface PaperAiHighlightItemProps {
  annotation: BookNote;
  onLocate: () => void;
  onDelete: () => void;
}

/** AI 重点列表项：左侧色条（与标注 tab 一致）+ quote 摘要 + AI note（有则显示）；右键删除 */
function PaperAiHighlightItem({ annotation, onLocate, onDelete }: PaperAiHighlightItemProps) {
  const bgColor = annotation.color ? HIGHLIGHT_COLOR_RGBA[annotation.color] : HIGHLIGHT_COLOR_RGBA.yellow;
  const lineColor = annotation.color ? HIGHLIGHT_COLOR_HEX[annotation.color] : HIGHLIGHT_COLOR_HEX.yellow;
  const aiNote = stripCategoryPrefix(annotation.note ?? "");

  const handleDelete = async () => {
    try {
      const confirmed = await ask(`确定要删除这条 AI 重点标注吗？\n\n"${annotation.text || ""}"`, {
        title: "确认删除",
        kind: "warning",
      });
      if (confirmed) onDelete();
    } catch (error) {
      console.error("删除 AI 标注失败:", error);
    }
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className="cursor-pointer rounded-lg bg-muted p-2 transition-colors hover:bg-neutral-200/60 dark:bg-neutral-900 dark:hover:bg-neutral-800"
          onClick={onLocate}
        >
          <div className="flex items-stretch gap-2">
            <div className="w-1 shrink-0 rounded-full" style={{ backgroundColor: lineColor }} />
            <div className="min-w-0 flex-1">
              <span className="font-medium text-sm leading-relaxed" style={{ backgroundColor: bgColor }}>
                {collapseWs(annotation.text ?? "")}
              </span>
              {aiNote && (
                <div className="mt-1 flex items-start gap-1 text-neutral-500 text-xs dark:text-neutral-400">
                  <Sparkles className="mt-0.5 size-3 shrink-0" />
                  <span className="line-clamp-2">{aiNote}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem variant="destructive" onClick={() => handleDelete()}>
          删除
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * 论文左侧笔记面板：
 * 「标注」tab = 本篇论文的全部标注（人工 + AI，AI 带 Sparkles 徽章；按文档位置排序，点击定位，右键编辑评论/删除）；
 * 「AI 重点」tab = C2 AI 自动标亮：类型选择 + 生成/重新生成 + 按类别分组的 AI 标注列表。
 * 容器与头部结构对齐书籍 NotepadContainer / NotepadHeader（region 钩子在外层 wrapper 上）。
 */
export function PaperNotepadPanel({
  annotations,
  paperTitle,
  markdown,
  onLocateQuotes,
  onCreateAiAnnotations,
  onClearAiAnnotations,
  onLocateAnnotation,
  onUpdateNote,
  onDeleteAnnotation,
  onToggleStar,
  onDeleteAnnotations,
}: PaperNotepadPanelProps) {
  const [activeTab, setActiveTab] = useState<PaperNotepadTab>("annotations");
  const [editing, setEditing] = useState<BookNote | null>(null);
  const [editingNote, setEditingNote] = useState("");
  // 星标筛选 + 多选管理（仅标注 tab）
  const [starFilter, setStarFilter] = useState<"all" | "starred">("all");
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isBatchOperating, setIsBatchOperating] = useState(false);
  // AI 重点：类型选择（auto=辅助模型判定）、生成中状态、最近一次 auto 的判定结果（展示在选项文案里）
  const [kindSelect, setKindSelect] = useState<PaperKindSelect>("auto");
  const [generating, setGenerating] = useState(false);
  const [detectedKind, setDetectedKind] = useState<PaperKind | null>(null);
  // 辅助模型未配置（且聊天模型也没有）时禁用生成，明确引导去设置
  const hasAiModel = useProviderStore((state) => !!(state.utilityModel ?? state.selectedModel));

  // 按文档位置（首个 segment 块索引）排序
  const sorted = useMemo(
    () =>
      [...annotations].sort((a, b) => {
        const diff = annotationSortKey(a) - annotationSortKey(b);
        return diff !== 0 ? diff : a.createdAt - b.createdAt;
      }),
    [annotations],
  );

  // 星标筛选后的可见列表（全选/计数都按可见范围）
  const visible = useMemo(
    () => (starFilter === "starred" ? sorted.filter((a) => a.starred) : sorted),
    [sorted, starFilter],
  );

  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  }, []);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const allSelected = useMemo(
    () => visible.length > 0 && visible.every((a) => selectedIds.has(a.id)),
    [visible, selectedIds],
  );

  const handleSelectAll = useCallback(() => {
    setSelectedIds(allSelected ? new Set() : new Set(visible.map((a) => a.id)));
  }, [allSelected, visible]);

  // 选中项保持文档顺序导出
  const selectedAnnotations = useMemo(() => sorted.filter((a) => selectedIds.has(a.id)), [sorted, selectedIds]);

  // 同一导出管线：全部导出与多选导出只差条目集与标题后缀
  const exportAnnotationList = (targets: BookNote[], format: AnnotationExportFormat, selection: boolean) => {
    const meta = { title: selection ? `${paperTitle}-节选` : paperTitle };
    switch (format) {
      case "markdown":
        return exportAnnotationsToMarkdown(targets, meta);
      case "html":
        return exportAnnotationsToHtml(targets, meta);
      case "image":
        return exportAnnotationsToImage(targets, meta);
      case "pdf":
        return exportAnnotationsToPdf(targets, meta);
    }
  };

  const handleBatchExport = async (format: AnnotationExportFormat) => {
    if (selectedAnnotations.length === 0) return;
    setIsBatchOperating(true);
    try {
      await exportAnnotationList(selectedAnnotations, format, true);
    } finally {
      setIsBatchOperating(false);
    }
  };

  // 批量删除：ask 确认 → 逐条删（hook 内统一提示）→ 退出多选
  const handleBatchDelete = async () => {
    if (selectedIds.size === 0) return;
    try {
      const confirmed = await ask(`确定要删除选中的 ${selectedIds.size} 条标注吗？\n\n此操作无法撤销。`, {
        title: "确认批量删除",
        kind: "warning",
      });
      if (!confirmed) return;
      setIsBatchOperating(true);
      await onDeleteAnnotations([...selectedIds]);
      exitSelectionMode();
    } catch (error) {
      console.error("批量删除标注失败:", error);
      toast.error("批量删除标注失败");
    } finally {
      setIsBatchOperating(false);
    }
  };

  const aiAnnotations = useMemo(() => annotations.filter((a) => a.source === "ai"), [annotations]);

  // AI 重点分组：组序按跨类型固定类别顺序，组内按文档位置
  const aiGroups = useMemo(() => {
    const byCategory = new Map<string, BookNote[]>();
    for (const annotation of aiAnnotations) {
      const key = annotation.category ?? "";
      byCategory.set(key, [...(byCategory.get(key) ?? []), annotation]);
    }
    const orderOf = (id: string) => {
      const index = PAPER_CATEGORY_ORDER.indexOf(id);
      return index === -1 ? PAPER_CATEGORY_ORDER.length : index;
    };
    return [...byCategory.entries()]
      .sort(([a], [b]) => orderOf(a) - orderOf(b))
      .map(([category, items]) => ({
        category,
        items: items.sort((a, b) => {
          const diff = annotationSortKey(a) - annotationSortKey(b);
          return diff !== 0 ? diff : a.createdAt - b.createdAt;
        }),
      }));
  }, [aiAnnotations]);

  const openEditDialog = (annotation: BookNote) => {
    setEditing(annotation);
    setEditingNote(annotation.note);
  };

  const handleSaveNote = () => {
    if (!editing) return;
    onUpdateNote(editing.id, editingNote.trim());
    setEditing(null);
  };

  // 生成/重新生成：已有 AI 标注时先 ask 确认并清空（仅 source='ai'，人工标注不受影响）
  const handleGenerate = async () => {
    if (!hasAiModel) {
      toast.error("请先在设置中配置辅助模型或聊天模型");
      return;
    }
    if (!markdown) {
      toast.error("论文内容尚未加载完成，请稍后再试");
      return;
    }
    if (aiAnnotations.length > 0) {
      const confirmed = await ask(
        `重新生成会先删除现有的 ${aiAnnotations.length} 条 AI 重点标注（人工标注不受影响），是否继续？`,
        { title: "重新生成 AI 重点", kind: "warning" },
      );
      if (!confirmed) return;
    }

    setGenerating(true);
    try {
      if (aiAnnotations.length > 0) await onClearAiAnnotations();
      const result = await generatePaperHighlights({ markdown, kind: kindSelect, locateQuotes: onLocateQuotes });
      if (kindSelect === "auto") setDetectedKind(result.kind);
      if (result.located.length === 0) {
        toast.warning(
          result.total > 0
            ? `AI 返回了 ${result.total} 条重点，但都无法在正文中定位`
            : "AI 没有返回可用的重点句，请重试",
        );
        return;
      }
      const created = await onCreateAiAnnotations(
        result.located.map((item) => ({
          cfi: item.location.cfi,
          text: item.location.text,
          color: PAPER_CATEGORY_DEFS[item.category]?.color ?? "yellow",
          note: formatAiAnnotationNote(item.category, item.note),
          context: item.location.context,
          category: item.category,
        })),
      );
      const dropped = result.total - result.located.length;
      toast.success(
        `AI 重点标注完成（${PAPER_KIND_LABELS[result.kind]}模板）：命中 ${created}/${result.total} 条${
          dropped > 0 ? `，丢弃 ${dropped} 条无法定位` : ""
        }`,
      );
    } catch (error) {
      console.error("生成 AI 重点标注失败:", error);
      toast.error(error instanceof Error ? error.message : "生成 AI 重点标注失败");
    } finally {
      setGenerating(false);
    }
  };

  // 清除全部 AI 重点：ask 确认（文案明确只删 AI 标注）→ clearAiAnnotations → toast 删除条数
  const handleClearAi = async () => {
    if (aiAnnotations.length === 0) return;
    const confirmed = await ask(
      `确定要清除全部 ${aiAnnotations.length} 条 AI 重点标注吗？\n\n只会删除 AI 生成的标注，人工标注不受影响。此操作无法撤销。`,
      { title: "清除 AI 重点", kind: "warning" },
    );
    if (!confirmed) return;
    try {
      const removed = await onClearAiAnnotations();
      toast.success(`已清除 ${removed} 条 AI 重点标注`);
    } catch (error) {
      console.error("清除 AI 重点标注失败:", error);
      toast.error("清除 AI 重点标注失败");
    }
  };

  const generateButton = (
    <button
      type="button"
      onClick={handleGenerate}
      disabled={generating || !hasAiModel}
      title={hasAiModel ? undefined : "请先在设置中配置辅助模型或聊天模型"}
      className="flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-primary-foreground text-xs hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {generating ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
      {generating ? "生成中…" : aiAnnotations.length > 0 ? "重新生成" : "生成重点标注"}
    </button>
  );

  return (
    <main className="flex h-full flex-col bg-background">
      {/* 头部：标注 / AI 重点 切换（样式同书籍 NotepadHeader） */}
      <div className="h-10 border-neutral-200 bg-background pt-0 pb-10 dark:border-neutral-700">
        <div className="flex select-none items-center justify-between">
          <Tabs
            value={activeTab}
            onValueChange={(value) => setActiveTab(value as PaperNotepadTab)}
            className="mb-1 flex"
          >
            <TabsList className="h-9 rounded-full">
              <TabsTrigger className="h-7 rounded-full" value="annotations">
                <Highlighter className="mr-1 size-4" />
                <span>标注</span>
              </TabsTrigger>
              <TabsTrigger className="h-7 rounded-full" value="ai-highlights">
                <Sparkles className="mr-1 size-4" />
                <span>AI 重点</span>
              </TabsTrigger>
            </TabsList>
          </Tabs>
          {activeTab === "annotations" && sorted.length > 0 && (
            <div className="flex items-center gap-0.5 pr-2">
              {selectionMode ? (
                <button
                  type="button"
                  onClick={handleSelectAll}
                  className="rounded-md px-1.5 py-1 text-neutral-500 text-xs hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
                >
                  {allSelected ? "取消全选" : "全选"}
                </button>
              ) : (
                <>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => setStarFilter((f) => (f === "all" ? "starred" : "all"))}
                        className={`flex size-7 items-center justify-center rounded-full hover:bg-neutral-200 dark:hover:bg-neutral-700 ${
                          starFilter === "starred" ? "bg-neutral-200 dark:bg-neutral-700" : ""
                        }`}
                      >
                        <Star
                          className={`size-4 ${
                            starFilter === "starred"
                              ? "fill-amber-400 text-amber-400"
                              : "text-neutral-500 dark:text-neutral-400"
                          }`}
                        />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">{starFilter === "starred" ? "显示全部" : "仅看星标"}</TooltipContent>
                  </Tooltip>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        title="导出全部标注"
                        className="flex size-7 items-center justify-center rounded-full hover:bg-neutral-200 dark:hover:bg-neutral-700"
                      >
                        <Download className="size-4 text-neutral-500 dark:text-neutral-400" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => void exportAnnotationList(sorted, "markdown", false)}>
                        导出为 Markdown
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => void exportAnnotationList(sorted, "html", false)}>
                        导出为 HTML
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => void exportAnnotationList(sorted, "image", false)}>
                        导出为图片
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => void exportAnnotationList(sorted, "pdf", false)}>
                        导出为 PDF
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => (selectionMode ? exitSelectionMode() : setSelectionMode(true))}
                    className={`flex size-7 items-center justify-center rounded-full hover:bg-neutral-200 dark:hover:bg-neutral-700 ${
                      selectionMode ? "bg-neutral-200 dark:bg-neutral-700" : ""
                    }`}
                  >
                    <ListChecks className="size-4 text-neutral-500 dark:text-neutral-400" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{selectionMode ? "退出管理" : "多选管理"}</TooltipContent>
              </Tooltip>
              <span className="pl-1 text-neutral-400 text-xs dark:text-neutral-500">
                {starFilter === "starred" && !selectionMode
                  ? `${visible.length}/${sorted.length} 条`
                  : `${sorted.length} 条`}
              </span>
            </div>
          )}
          {activeTab === "ai-highlights" && aiAnnotations.length > 0 && (
            <span className="pr-2 text-neutral-400 text-xs dark:text-neutral-500">{aiAnnotations.length} 条</span>
          )}
        </div>
      </div>

      {activeTab === "annotations" ? (
        visible.length === 0 ? (
          <div className="flex flex-1 items-center justify-center p-6">
            <p className="text-center text-neutral-400 text-sm leading-relaxed dark:text-neutral-500">
              {starFilter === "starred" ? "暂无星标标注" : "暂无标注"}
              <br />
              <span className="text-xs">
                {starFilter === "starred"
                  ? "点击标注右下角的星标即可收藏"
                  : "在正文中划词即可标亮，标亮后可在弹窗中写评论"}
              </span>
            </p>
          </div>
        ) : (
          <div className="flex-1 space-y-2 overflow-y-auto p-2">
            {visible.map((annotation) => (
              <PaperAnnotationItem
                key={annotation.id}
                annotation={annotation}
                selectionMode={selectionMode}
                selected={selectedIds.has(annotation.id)}
                onLocate={() => onLocateAnnotation(annotation.id)}
                onToggleSelect={() => toggleSelect(annotation.id)}
                onToggleStar={() => onToggleStar(annotation)}
                onEdit={() => openEditDialog(annotation)}
                onDelete={() => onDeleteAnnotation(annotation.id)}
              />
            ))}
          </div>
        )
      ) : (
        <>
          {/* AI 重点工具栏：类型选择（auto 展示判定结果）+ 生成/重新生成 + 清除（仅 AI 标注） */}
          <div className="flex items-center gap-2 border-neutral-200 border-b px-2 py-1.5 dark:border-neutral-700">
            <Select value={kindSelect} onValueChange={(value) => setKindSelect(value as PaperKindSelect)}>
              <SelectTrigger className="h-7 w-[9.5rem] px-2 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">
                  自动判定{detectedKind ? `（${PAPER_KIND_LABELS[detectedKind]}）` : ""}
                </SelectItem>
                <SelectItem value="research">研究论文</SelectItem>
                <SelectItem value="review">综述</SelectItem>
                <SelectItem value="report">短篇报道</SelectItem>
              </SelectContent>
            </Select>
            {generateButton}
            <button
              type="button"
              onClick={handleClearAi}
              disabled={generating || aiAnnotations.length === 0}
              title="清除全部 AI 重点标注（人工标注不受影响）"
              className="flex items-center gap-1 rounded-md px-2 py-1 text-neutral-500 text-xs hover:bg-neutral-100 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-50 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-red-400"
            >
              <Trash2 className="size-3.5" />
              清除
            </button>
          </div>

          {aiAnnotations.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6">
              <p className="text-center text-neutral-400 text-sm leading-relaxed dark:text-neutral-500">
                {hasAiModel ? "还没有 AI 重点标注" : "请先在设置中配置辅助模型或聊天模型"}
                <br />
                <span className="text-xs">
                  {hasAiModel
                    ? "AI 会按论文类型抽取研究目标/方法/结果等重点句，并按类别着色标亮"
                    : "配置完成后，AI 可按类别自动抽取并标亮论文重点句"}
                </span>
              </p>
              {generateButton}
            </div>
          ) : (
            <div className="flex-1 space-y-3 overflow-y-auto p-2">
              {aiGroups.map((group) => {
                const def = PAPER_CATEGORY_DEFS[group.category];
                const dotColor = def ? HIGHLIGHT_COLOR_HEX[def.color] : HIGHLIGHT_COLOR_HEX.yellow;
                return (
                  <div key={group.category || "unknown"}>
                    <div className="mb-1.5 flex items-center gap-1.5 px-1">
                      <span className="size-2 rounded-full" style={{ backgroundColor: dotColor }} />
                      <span className="font-medium text-neutral-700 text-xs dark:text-neutral-300">
                        {def?.label ?? group.category ?? "未分类"}
                      </span>
                      <span className="text-neutral-400 text-xs dark:text-neutral-500">{group.items.length}</span>
                    </div>
                    <div className="space-y-2">
                      {group.items.map((annotation) => (
                        <PaperAiHighlightItem
                          key={annotation.id}
                          annotation={annotation}
                          onLocate={() => onLocateAnnotation(annotation.id)}
                          onDelete={() => onDeleteAnnotation(annotation.id)}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* 多选管理底栏：导出（四种格式）/ 批量删除 / 退出（样式同历史对话批量操作条） */}
      {activeTab === "annotations" && selectionMode && (
        <div className="flex flex-shrink-0 flex-wrap items-center justify-between gap-2 border-neutral-200 border-t px-2 py-2 dark:border-neutral-700">
          <span className="text-nowrap text-neutral-500 text-xs dark:text-neutral-400">已选 {selectedIds.size} 条</span>
          <div className="flex flex-wrap items-center gap-1">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" disabled={selectedIds.size === 0 || isBatchOperating}>
                  <Download className="h-3.5 w-3.5" />
                  导出
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" side="top">
                <DropdownMenuItem onClick={() => void handleBatchExport("markdown")}>Markdown</DropdownMenuItem>
                <DropdownMenuItem onClick={() => void handleBatchExport("html")}>HTML</DropdownMenuItem>
                <DropdownMenuItem onClick={() => void handleBatchExport("image")}>图片</DropdownMenuItem>
                <DropdownMenuItem onClick={() => void handleBatchExport("pdf")}>PDF</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="outline"
              size="sm"
              disabled={selectedIds.size === 0 || isBatchOperating}
              onClick={() => void handleBatchDelete()}
              className="text-destructive hover:bg-destructive/10"
            >
              <Trash2 className="h-3.5 w-3.5" />
              删除
            </Button>
            <Button variant="ghost" size="sm" onClick={exitSelectionMode} disabled={isBatchOperating}>
              退出
            </Button>
          </div>
        </div>
      )}

      {/* 编辑评论对话框（保存落 book_notes.note；空串 = 纯标亮） */}
      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑评论</DialogTitle>
          </DialogHeader>
          <div className="p-4">
            {editing?.text && (
              <p className="mb-3 line-clamp-2 border-neutral-200 border-l-2 pl-2 text-neutral-500 text-sm dark:border-neutral-700">
                {collapseWs(editing.text)}
              </p>
            )}
            <Textarea
              value={editingNote}
              onChange={(event) => setEditingNote(event.target.value)}
              placeholder="写下你的想法…（留空则为纯标亮）"
              rows={4}
              autoFocus
              className="resize-none text-sm"
            />
          </div>
          <DialogFooter>
            <button
              type="button"
              onClick={() => setEditing(null)}
              className="rounded-md px-3 py-1.5 text-neutral-500 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleSaveNote}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-500"
            >
              保存
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
