import { getUtilityModel } from "@/ai/providers/factory";
import { InlineMathText } from "@/components/markdown/inline-math-text";
import { MotionStackCard } from "@/components/ui/bottom-right-stack";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type PaperMetadata, normalizeAuthors } from "@/pages/paper-reader/paper-metadata";
import { ZoteroImportDialog } from "@/pages/papers/zotero-import-dialog";
import { getBookStatus, updateBookStatus, updateBookVectorizationMeta } from "@/services/book-service";
import { onPaperListChanged, onPaperStatusChanged } from "@/services/paper-events";
import {
  type Folder,
  type FolderTreeNode,
  type PaperFolderEntry,
  buildFolderTree,
  createFolder,
  deleteFolder,
  getPaperFolderMap,
  getPaperSourceStatus,
  importPapers,
  listFolders,
  listPapers,
  paperEngineTokenError,
  renameFolder,
  setPaperFolders,
  trashPaper,
} from "@/services/paper-service";
import { PAPER_TRANSLATION_LANG } from "@/services/paper-translation-service";
import { syncDownloadBook } from "@/services/sync-service";
import { useAppSettingsStore } from "@/store/app-settings-store";
import { setPaperImportRefresh, startPaperImportBatch, startPaperReparse } from "@/store/convert-progress-store";
import { useConverterStore } from "@/store/converter-store";
import { useLayoutStore } from "@/store/layout-store";
import { usePaperTaskRegistry } from "@/store/paper-task-registry";
import { type ChannelProgress, usePaperTaskStore } from "@/store/paper-task-store";
import {
  type ChannelAggregate,
  type TaskChannel,
  selectChannelAggregate,
  useTaskCenterStore,
} from "@/store/task-center-store";
import type { PapersSortByType } from "@/types/settings";
import type { BookWithStatus } from "@/types/simple-book";
import { conflictReasonText, paperConflicts } from "@/utils/paper-conflict";
import { listen } from "@tauri-apps/api/event";
import { appDataDir, join } from "@tauri-apps/api/path";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { exists, readTextFile } from "@tauri-apps/plugin-fs";
import { openPath } from "@tauri-apps/plugin-opener";
import clsx from "clsx";
import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  BookOpenText,
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  FileDown,
  FileText,
  Folder as FolderIcon,
  FolderInput,
  FolderOpen,
  FolderPen,
  FolderPlus,
  Inbox,
  Languages,
  Library,
  ListChecks,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

/** 侧栏选中项：全部论文 / 未归档 / 某个文件夹 */
type Selection = { kind: "all" } | { kind: "unfiled" } | { kind: "folder"; id: string };

/** 文件夹名称对话框：新建（可带父节点）或重命名 */
type NameDialogState = { mode: "create"; parentId: string | null } | { mode: "rename"; id: string };

/** 向量化状态指示：与图书馆 book-item 同款圆环（绿=已向量化/红=失败/灰=未向量化；进行中为扇形环+百分比） */
/** L2 仅云端徽标：论文文件（paper.md 捆）不在本地时显示；点击打开时会自动下载（handleOpen 门） */
function PaperCloudBadge({ paper }: { paper: BookWithStatus }) {
  const [isCloudOnly, setIsCloudOnly] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (paper.filePath) {
      appDataDir()
        .then((base) => exists(`${base}/${paper.filePath}`))
        .then((fileExists) => {
          if (!cancelled) setIsCloudOnly(!fileExists);
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [paper.filePath]);
  if (!isCloudOnly) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Cloud className="size-4 text-neutral-400 dark:text-neutral-500" />
      </TooltipTrigger>
      <TooltipContent side="bottom">仅在云端，点击打开时自动下载</TooltipContent>
    </Tooltip>
  );
}

function VectorizationRing({ paper, vectorizePercent }: { paper: BookWithStatus; vectorizePercent?: number }) {
  const statusFromMeta = paper.status?.metadata?.vectorization?.status ?? "idle";
  if (vectorizePercent != null) {
    const pct = Math.max(0, Math.min(100, vectorizePercent));
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-1">
            <div className="relative h-4 w-4">
              <div
                className="absolute inset-0 rounded-full"
                style={{ background: `conic-gradient(#eab308 ${pct}%, rgba(229,231,235,0.6) 0)` }}
              />
              <div className="absolute inset-[2px] rounded-full bg-white dark:bg-neutral-900" />
            </div>
            <span className="text-[10px] text-neutral-500 leading-none dark:text-neutral-400">{pct}%</span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom">向量化中 {pct}%</TooltipContent>
      </Tooltip>
    );
  }
  const colorClass =
    statusFromMeta === "success"
      ? "border-green-500"
      : statusFromMeta === "failed"
        ? "border-red-500"
        : "border-neutral-400 dark:border-neutral-500";
  const label = statusFromMeta === "success" ? "已向量化" : statusFromMeta === "failed" ? "向量化失败" : "未向量化";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-1">
          <div className={`h-3.5 w-3.5 rounded-full border-2 ${colorClass}`} />
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

/** 已翻译徽标：译本文件（translation-zh.json）在库时显示；与向量化绿环同排，未翻译不占位。
 *  绿色=完整且新鲜；黄色=陈旧（重解析后旧译文不再显示）或不完整（中断/批次失败），tooltip 区分原因 */
function PaperTranslatedBadge({ state }: { state: { stale: boolean; partial: boolean } }) {
  const degraded = state.stale || state.partial;
  const tip = state.stale
    ? "译本已陈旧：论文重新解析后旧译文不再显示，重新翻译后恢复"
    : state.partial
      ? "译本不完整：上次翻译中断或部分批次失败，重新翻译可补齐"
      : "已翻译（含中文译文）";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Languages
          className={
            degraded ? "size-3.5 text-amber-500 dark:text-amber-400" : "size-3.5 text-green-600 dark:text-green-500"
          }
        />
      </TooltipTrigger>
      <TooltipContent side="bottom">{tip}</TooltipContent>
    </Tooltip>
  );
}

/** 重要度打星（0-3）：点击第 n 颗设 n 星，再点当前档取消；整行一个 Tooltip */
function PaperStars({ rating, onRate }: { rating: number; onRate: (rating: number) => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-0.5">
          {[1, 2, 3].map((n) => (
            <button
              key={n}
              type="button"
              className="rounded p-0.5 text-neutral-300 transition-colors hover:text-amber-400 dark:text-neutral-600"
              onClick={(event) => {
                event.stopPropagation();
                onRate(rating === n ? 0 : n);
              }}
            >
              <Star className={clsx("size-3.5", n <= rating && "fill-amber-400 text-amber-400")} />
            </button>
          ))}
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {rating > 0 ? `重要度 ${rating}/3 星（点击调整）` : "打星标记重要度（最多 3 星）"}
      </TooltipContent>
    </Tooltip>
  );
}

/** 阅读状态徽标（New 主题色 / 进度琥珀 / 已读完绿） */
function PaperStatusBadge({ status }: { status: BookWithStatus["status"] }) {
  if (!status || status.status === "unread") {
    return <span className="rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary text-xs">New</span>;
  }
  if (status.status === "completed") {
    return (
      <span className="rounded-full bg-green-50 px-2 py-0.5 font-medium text-green-600 text-xs dark:bg-green-950/50 dark:text-green-400">
        已读完
      </span>
    );
  }
  const percent = status.progressTotal > 0 ? Math.round((status.progressCurrent / status.progressTotal) * 100) : 0;
  return (
    <span className="rounded-full bg-amber-50 px-2 py-0.5 font-medium text-amber-600 text-xs dark:bg-amber-950/50 dark:text-amber-400">
      {percent > 0 ? `${percent}%` : "阅读中"}
    </span>
  );
}

const sidebarItemClass = (active: boolean) =>
  clsx(
    "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
    active
      ? "bg-neutral-200/70 font-medium text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100"
      : "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800/60",
  );

/** 树形铺平（移动到对话框用，全部展开，带缩进深度） */
const flattenTree = (nodes: FolderTreeNode[], depth = 0): { node: FolderTreeNode; depth: number }[] =>
  nodes.flatMap((node) => [{ node, depth }, ...flattenTree(node.children, depth + 1)]);

interface FolderTreeItemProps {
  node: FolderTreeNode;
  depth: number;
  selection: Selection;
  expanded: Set<string>;
  counts: Map<string, number>;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  onCreateChild: (parentId: string) => void;
  onRename: (folder: Folder) => void;
  onDelete: (folder: Folder) => void;
}

/** 侧栏文件夹树节点：缩进 + 展开/折叠 + 直接成员计数 + hover 操作（新建子文件夹/重命名/删除） */
function FolderTreeItem({
  node,
  depth,
  selection,
  expanded,
  counts,
  onSelect,
  onToggle,
  onCreateChild,
  onRename,
  onDelete,
}: FolderTreeItemProps) {
  const isSelected = selection.kind === "folder" && selection.id === node.id;
  const isExpanded = expanded.has(node.id);
  const hasChildren = node.children.length > 0;
  const hoverButtonClass =
    "rounded p-0.5 text-neutral-400 hover:bg-neutral-300/60 hover:text-neutral-600 dark:hover:bg-neutral-600 dark:hover:text-neutral-300";

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        className={clsx(
          "group flex w-full cursor-pointer items-center gap-1 rounded-md py-1.5 pr-1 text-sm",
          isSelected
            ? "bg-neutral-200/70 font-medium text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100"
            : "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800/60",
        )}
        style={{ paddingInlineStart: `${depth * 14 + 4}px` }}
        onClick={() => onSelect(node.id)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelect(node.id);
          }
        }}
      >
        {hasChildren ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="flex size-4 shrink-0 items-center justify-center rounded text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
                onClick={(event) => {
                  event.stopPropagation();
                  onToggle(node.id);
                }}
              >
                <ChevronRight className={clsx("size-3.5 transition-transform", isExpanded && "rotate-90")} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{isExpanded ? "折叠" : "展开"}</TooltipContent>
          </Tooltip>
        ) : (
          <span className="size-4 shrink-0" />
        )}
        <FolderIcon className="size-3.5 shrink-0 text-neutral-400" />
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="min-w-0 flex-1 truncate">{node.name}</span>
          </TooltipTrigger>
          <TooltipContent side="right">{node.name}</TooltipContent>
        </Tooltip>
        <span className="shrink-0 text-neutral-400 text-xs group-hover:hidden">{counts.get(node.id) ?? 0}</span>
        <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={hoverButtonClass}
                onClick={(event) => {
                  event.stopPropagation();
                  onCreateChild(node.id);
                }}
              >
                <Plus className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">新建子文件夹</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={hoverButtonClass}
                onClick={(event) => {
                  event.stopPropagation();
                  onRename(node);
                }}
              >
                <Pencil className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">重命名</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={hoverButtonClass}
                onClick={(event) => {
                  event.stopPropagation();
                  onDelete(node);
                }}
              >
                <Trash2 className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">删除</TooltipContent>
          </Tooltip>
        </span>
      </div>
      {isExpanded &&
        node.children.map((child) => (
          <FolderTreeItem
            key={child.id}
            node={child}
            depth={depth + 1}
            selection={selection}
            expanded={expanded}
            counts={counts}
            onSelect={onSelect}
            onToggle={onToggle}
            onCreateChild={onCreateChild}
            onRename={onRename}
            onDelete={onDelete}
          />
        ))}
    </div>
  );
}

/** 候选列表去重追加（点选/拖拽可多次累加） */
function mergePdfCandidates(prev: string[], incoming: string[]): string[] {
  const seen = new Set(prev);
  return [...prev, ...incoming.filter((p) => !seen.has(p))];
}

/** 批量任务种类：向量化 / 翻译 / 重新解析（共用 LLM 或转换资源，同一时刻只跑一种） */
type BatchKind = "vectorize" | "translate" | "reparse";

const BATCH_KIND_LABELS: Record<BatchKind, string> = {
  vectorize: "批量向量化",
  translate: "批量翻译",
  reparse: "批量重新解析",
};

/** 批量任务右下角进度卡状态（样式对齐 pdfImport 卡与 Zotero 卡） */
interface BatchProgressState {
  kind: BatchKind;
  status: "running" | "success" | "error";
  /** 当前篇序号（0 基） */
  index: number;
  total: number;
  /** 当前篇标题 */
  title: string;
  /** 当前篇细节（阶段/块进度） */
  detail: string;
  /** 总进度百分比 */
  percent: number;
  doneCount: number;
  failedCount: number;
  skippedCount: number;
  failedNames: string[];
  /** 收尾汇总（status 非 running 时展示） */
  summary?: string;
  /** 取消中（cancel 已触发、当前篇收尾中）——取消按钮置灰文案用 */
  cancelling?: boolean;
}

/**
 * 通道聚合 → 批量进度卡视图模型（P2-3：卡片数据源切到 task-center 通道聚合）。
 * 口径对齐旧队列卡：index/total 动态含排队；percent 按篇数加权（含当前篇内进度）；
 * summary/状态文案同旧 drain 收尾（取消汇总=已取消：完成 X · 失败 Y，剩余 Z 篇未处理）。
 * 返回 null = 通道无任何任务（不渲染卡）。
 */
function channelCardOf(
  kind: "vectorize" | "translate",
  agg: ChannelAggregate,
  cancelling: boolean,
): (BatchProgressState & { kind: "vectorize" | "translate" }) | null {
  const { current, queuedCount, settled } = agg;
  if (!current && queuedCount === 0 && settled.length === 0) return null;
  const doneCount = settled.filter((t) => t.status === "success").length;
  const failed = settled.filter((t) => t.status === "error");
  const cancelledCount = settled.filter((t) => t.status === "cancelled").length;
  const running = current !== null || queuedCount > 0;
  const total = settled.length + queuedCount + (current ? 1 : 0);
  const percent =
    running && total > 0
      ? Math.min(100, Math.round(((settled.length + (current ? current.percent / 100 : 0)) / total) * 100))
      : 100;
  return {
    kind,
    status: running ? "running" : failed.length > 0 ? "error" : "success",
    index: settled.length,
    total,
    title: current?.title ?? "",
    detail: current?.detail ?? (queuedCount > 0 ? "排队中…" : ""),
    percent,
    doneCount,
    failedCount: failed.length,
    skippedCount: 0,
    failedNames: failed.map((t) => t.title),
    summary: running
      ? undefined
      : cancelledCount > 0
        ? `已取消：完成 ${doneCount} · 失败 ${failed.length}，剩余 ${cancelledCount} 篇未处理${kind === "translate" ? "（已翻部分已落盘，可续翻）" : ""}`
        : `完成 ${doneCount} 篇${failed.length > 0 ? ` · 失败 ${failed.length}` : ""}`,
    cancelling,
  };
}

/** 批量任务进度卡本体（markup 自 batchCards.map 内联段提取，供 MotionStackCard 离场编排复用） */
function BatchProgressCard({
  card,
  onCancel,
  onDismiss,
}: {
  card: BatchProgressState & { kind: "vectorize" | "translate" };
  onCancel: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="w-80 rounded-xl border bg-background p-3.5 shadow-lg">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="min-w-0 flex-1 truncate font-medium text-sm">{BATCH_KIND_LABELS[card.kind]}</span>
        <span className="shrink-0 text-muted-foreground text-xs">
          {Math.min(card.index + 1, card.total)}/{card.total}
        </span>
        <button
          type="button"
          className="shrink-0 rounded p-0.5 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
          onClick={onDismiss}
        >
          <X className="size-3.5" />
        </button>
      </div>

      {card.status === "running" ? (
        <>
          <Progress value={card.percent} className="h-1.5" />
          <div className="mt-2 flex items-center justify-between gap-2 text-muted-foreground text-xs">
            <span className="min-w-0 flex-1 truncate">
              {card.title ? `《${card.title}》 ` : ""}
              {card.detail}
            </span>
            <span className="shrink-0">{card.percent}%</span>
          </div>
          <div className="mt-2.5 flex items-center justify-between gap-2">
            <span className="text-muted-foreground text-xs">
              完成 {card.doneCount}
              {card.failedCount > 0 ? ` · 失败 ${card.failedCount}` : ""}
              {card.skippedCount > 0 ? ` · 跳过 ${card.skippedCount}` : ""}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2.5 text-xs"
              onClick={onCancel}
              disabled={card.cancelling === true}
            >
              {card.cancelling ? "正在取消…" : "取消"}
            </Button>
          </div>
        </>
      ) : (
        <>
          <p
            className={clsx(
              "text-xs",
              card.status === "success" ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400",
            )}
          >
            {card.summary}
          </p>
          {card.failedNames.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-red-600 text-xs dark:text-red-400">
              {card.failedNames.map((name) => (
                <li key={name} className="truncate" title={name}>
                  {name}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

/** 文献库：MARKDOWN 论文的管理页（列表 + 文件夹侧栏，§3.2 文件夹模型）；点击论文行打开阅读标签页 */
export default function PapersPage() {
  const [papers, setPapers] = useState<BookWithStatus[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [members, setMembers] = useState<PaperFolderEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [metaMap, setMetaMap] = useState<Record<string, PaperMetadata>>({});
  /** 已翻译标记（paperId → 译本状态）：卡片「已翻译」徽标与右键「重新翻译」入口用。
   *  stale=陈旧（重解析后锚不匹配，阅读器不再显示旧译文）；partial=不完整（中断/批次失败戳记） */
  const [translatedMap, setTranslatedMap] = useState<Record<string, { stale: boolean; partial: boolean }>>({});
  const openPaper = useLayoutStore((state) => state.openPaper);
  // 检索关键词（列表工具栏；排序与元数据语言持久化在 app-settings）
  const [searchQuery, setSearchQuery] = useState("");
  const { settings, setSettings } = useAppSettingsStore();
  const sortBy: PapersSortByType = settings.papersSortBy ?? "updated";
  const sortAscending = settings.papersSortAscending ?? false;
  const metaLang = settings.papersMetaLang ?? "original";
  // 向量化进行中：paper_id -> 进度百分比（0-100）
  // 向量化百分比圆环：改订阅任务队列 store（队列 drain 写入；原本地 state 在批量循环里，已随 H4 迁移）
  const vectorizing = usePaperTaskStore((st) => st.vectorizePercent);
  // 文件夹侧栏状态
  const [selection, setSelection] = useState<Selection>({ kind: "all" });
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [nameDialog, setNameDialog] = useState<NameDialogState | null>(null);
  const [nameInput, setNameInput] = useState("");
  const [nameSubmitting, setNameSubmitting] = useState(false);
  // "移动到…"对话框状态
  const [movePaper, setMovePaper] = useState<BookWithStatus | null>(null);
  const [moveChecked, setMoveChecked] = useState<Set<string>>(new Set());
  const [moveSubmitting, setMoveSubmitting] = useState(false);
  // PDF 解析导入：选择弹窗（点选/拖拽，可多选累加候选）+ 后台串行队列
  // 队列在 task-center 的 paper-parse 通道（P2-4；全局右下角卡，跨页面持续呈现）
  const [pdfPickerOpen, setPdfPickerOpen] = useState(false);
  const [pdfCandidates, setPdfCandidates] = useState<string[]>([]);
  const [pdfDragOver, setPdfDragOver] = useState(false);
  // Zotero 批量导入对话框（批量运行中禁用其他导入入口）
  const [zoteroOpen, setZoteroOpen] = useState(false);
  const [zoteroRunning, setZoteroRunning] = useState(false);
  // 批量管理：管理模式开关（点「管理」才出现复选框）/ 多选集合 / 批量移动对话框 / 批量任务守卫与进度卡
  const [manageMode, setManageMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchMoveOpen, setBatchMoveOpen] = useState(false);
  // 进度卡数据源（P2-3 切换）：task-center 双通道聚合（向量化/翻译），reparse 卡在全局解析浮层；
  // 通道无任务时向量化卡回落「恢复监控」切片（刷新后 Rust 侧 index_paper 仍在跑的挂载扫描恢复卡）
  const storeProgress = usePaperTaskStore((st) => st.progress);
  const taskCenterTasks = useTaskCenterStore((st) => st.tasks);
  const taskCenterOrder = useTaskCenterStore((st) => st.order);
  const taskCenterCancelling = useTaskCenterStore((st) => st.cancelling);
  // 注意：selectChannelAggregate 每次返回新对象，不能直接作 zustand 选择器（getSnapshot 须缓存）——
  // 订阅稳定的 tasks/order 引用再 useMemo 聚合（同 global-convert-progress 的既有写法）
  const vectorizeAgg = useMemo(
    () => selectChannelAggregate({ tasks: taskCenterTasks, order: taskCenterOrder }, "paper-vectorize"),
    [taskCenterTasks, taskCenterOrder],
  );
  const translateAgg = useMemo(
    () => selectChannelAggregate({ tasks: taskCenterTasks, order: taskCenterOrder }, "paper-translate"),
    [taskCenterTasks, taskCenterOrder],
  );
  // 解析通道在跑/有排队（P2-4 起读 task-center 聚合；含刷新恢复占用任务，Zotero 镜像任务不计）
  const paperParseAgg = useMemo(
    () => selectChannelAggregate({ tasks: taskCenterTasks, order: taskCenterOrder }, "paper-parse"),
    [taskCenterTasks, taskCenterOrder],
  );
  const paperImportRunning = paperParseAgg.current !== null || paperParseAgg.queuedCount > 0;
  // 双通道可并行（向量化×翻译读写不相干）：各出一张卡，经 BottomRightStack 纵向堆叠
  const batchCards: (BatchProgressState & { kind: "vectorize" | "translate" })[] = (
    ["vectorize", "translate"] as const
  ).flatMap((kind) => {
    const channelCard = channelCardOf(
      kind,
      kind === "vectorize" ? vectorizeAgg : translateAgg,
      taskCenterCancelling[kind === "vectorize" ? "paper-vectorize" : "paper-translate"] === true,
    );
    if (channelCard) return [channelCard];
    const recovery = kind === "vectorize" ? storeProgress.vectorize : undefined;
    return recovery ? [{ kind, ...recovery }] : [];
  });
  const { paperEngine } = useConverterStore();
  // 事件回调里读取最新 selection（拖放监听挂载一次，闭包不能捕获渲染期状态）
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const pdfPickerOpenRef = useRef(pdfPickerOpen);
  pdfPickerOpenRef.current = pdfPickerOpen;
  const runPdfImportRef = useRef<(paths: string[]) => void>(() => {});

  // 页面级拖放导入：拖 PDF 到文献库页任意位置直接开始解析（弹窗开启时落入候选区）。
  // 用 Tauri onDragDropEvent（HTML5 drop 拿不到文件路径，sidecar 需要路径）；
  // 书籍拖入已由 home-layout 限定在图书馆页，本页无冲突。
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    getCurrentWebviewWindow()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "enter" || payload.type === "over") {
          setPdfDragOver(true);
        } else if (payload.type === "leave") {
          setPdfDragOver(false);
        } else if (payload.type === "drop") {
          setPdfDragOver(false);
          const pdfs = payload.paths.filter((p) => p.toLowerCase().endsWith(".pdf"));
          if (pdfs.length === 0) {
            if (payload.paths.length > 0) {
              toast.error("文献库只支持导入 PDF（书籍请去图书馆页拖入）");
            }
            return;
          }
          const ignored = payload.paths.length - pdfs.length;
          if (ignored > 0) {
            toast.info(`已忽略 ${ignored} 个非 PDF 文件`);
          }
          if (pdfPickerOpenRef.current) {
            setPdfCandidates((prev) => mergePdfCandidates(prev, pdfs));
            return;
          }
          runPdfImportRef.current(pdfs);
        }
      })
      .then((off) => {
        if (cancelled) off();
        else unlisten = off;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 监听只挂一次，状态经 ref 读取
  }, []);

  // 批量任务卡同款收尾：干净成功 6 秒自动消失，有失败/取消保留待手动关闭（双通道各自适用）
  const cleanSuccessKinds = batchCards
    .filter((c) => c.status === "success" && c.failedCount === 0)
    .map((c) => c.kind)
    .join(",");
  useEffect(() => {
    if (!cleanSuccessKinds) return;
    const kinds = cleanSuccessKinds.split(",") as ("vectorize" | "translate")[];
    const timer = setTimeout(() => {
      for (const k of kinds) {
        // 通道卡：6 秒内该通道状态又变了（重新开跑/出现失败）则不自动消失——
        // dismiss 前复查聚合仍是干净收尾态（对齐旧口径，队列化后接续间隔可能超过 6s）
        const channel: TaskChannel = k === "vectorize" ? "paper-vectorize" : "paper-translate";
        const agg = selectChannelAggregate(useTaskCenterStore.getState(), channel);
        if (
          !agg.current &&
          agg.queuedCount === 0 &&
          agg.settled.length > 0 &&
          agg.settled.every((t) => t.status !== "error")
        ) {
          useTaskCenterStore.getState().dismissSettled(channel);
        }
        // 恢复监控卡（无通道任务的刷新恢复）：同样 6s 自动清
        const recovery = usePaperTaskStore.getState().progress[k];
        if (recovery?.status === "success" && recovery.failedCount === 0) {
          usePaperTaskStore.setState((prev) => ({ progress: { ...prev.progress, [k]: undefined } }));
        }
      }
    }, 6000);
    return () => clearTimeout(timer);
  }, [cleanSuccessKinds]);

  // metadata.json 缓存：入库后内容不可变，避免每次刷新列表都重读磁盘
  const metaCacheRef = useRef<Map<string, PaperMetadata>>(new Map());

  // 向量化进度事件（payload 形状对齐 epub://index-progress，id 字段为 paper_id）
  useEffect(() => {
    const unlisten = listen<{ paper_id: string; percent: number }>("paper://index-progress", (e) => {
      const p = e.payload;
      if (!p) return;
      usePaperTaskStore.setState((prev) => ({
        vectorizePercent: { ...prev.vectorizePercent, [p.paper_id]: Math.max(0, Math.min(100, Math.round(p.percent))) },
      }));
    });
    return () => {
      unlisten.then((off) => off());
    };
  }, []);

  /** 已翻译标记实查：逐篇探测 translation-zh.json 存在性（一次 stat/篇）；有译本的再逐篇查陈旧锚
   * （invoke 量小，fail-open 按不陈旧）；不完整戳记（translationRunState）读 metaCacheRef——
   * 调用前须先跑 loadMeta（loadAll 与任务收尾回调均保证此顺序）。 */
  const checkTranslated = useCallback(async (list: BookWithStatus[]) => {
    const base = await appDataDir();
    const existsPairs = await Promise.all(
      list.map(async (paper): Promise<[string, boolean]> => {
        try {
          return [
            paper.id,
            await exists(await join(base, "books", paper.id, `translation-${PAPER_TRANSLATION_LANG}.json`)),
          ];
        } catch {
          return [paper.id, false];
        }
      }),
    );
    const entries = await Promise.all(
      existsPairs.map(async ([id, has]) => {
        if (!has) return [id, undefined] as const;
        let stale = false;
        try {
          stale = (await getPaperSourceStatus(id)).translationStale;
        } catch {
          // 状态查询失败按不陈旧处理（宁可绿不可误黄）
        }
        const partial = metaCacheRef.current.get(id)?.translationRunState === "partial";
        return [id, { stale, partial }] as const;
      }),
    );
    const map: Record<string, { stale: boolean; partial: boolean }> = {};
    for (const [id, state] of entries) if (state) map[id] = state;
    setTranslatedMap(map);
  }, []);

  /** 元数据读取：metaCacheRef 缓存，已缓存的跳过；任务收尾/删除等场景先失效对应条目再调用即重读 */
  const loadMeta = useCallback(async (list: BookWithStatus[]) => {
    const base = await appDataDir();
    const cache = metaCacheRef.current;
    await Promise.all(
      list.map(async (paper) => {
        if (cache.has(paper.id)) return;
        try {
          const raw = await readTextFile(await join(base, "books", paper.id, "metadata.json"));
          cache.set(paper.id, JSON.parse(raw) as PaperMetadata);
        } catch (error) {
          console.warn(`读取论文元数据失败: ${paper.id}`, error);
          cache.set(paper.id, {});
        }
      }),
    );
    setMetaMap(Object.fromEntries(cache));
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      // 列表数据、文件夹树、成员关系一次加载，操作后统一 reload
      const [list, folderList, memberList] = await Promise.all([listPapers(), listFolders(), getPaperFolderMap()]);
      setPapers(list);
      setFolders(folderList);
      setMembers(memberList);
      // 多选集合剔除已不在库的论文（删除/外部变更后不留幽灵选中）
      const aliveIds = new Set(list.map((p) => p.id));
      setSelectedIds((prev) => {
        const next = new Set([...prev].filter((id) => aliveIds.has(id)));
        return next.size === prev.size ? prev : next;
      });

      await loadMeta(list);
      await checkTranslated(list);
    } catch (error) {
      console.error("加载文献库失败:", error);
      toast.error("加载文献库失败");
    } finally {
      setLoading(false);
    }
  }, [loadMeta, checkTranslated]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // 刷新恢复（2026-08-23）：向量化进行中刷新页面 → 内存队列丢失但 Rust 侧仍在跑。
  // 扫描 metadata 中 status=processing 的论文回写注册表，防重复入队争抢；进度卡重建为简化态。
  // 2026-08-24 加固：①轮询定时器/进度监听随卸载清理（原每次挂载泄漏一个 30s interval）；
  // ②死标兜底——processing 标超过 2 小时未更新视为崩溃残留，不注册且回写 failed 解锁该篇；
  // ③本通道有实时任务在跑（drain/队列/进度卡任一存在）时不恢复，避免覆盖实时进度卡；
  // ④注册表对账——已标记但 metadata 不再是 processing 的（离场期间完成）即时解除；
  // ⑤恢复卡订阅 paper://index-progress 实时喂 percent（圆环同喂），不再恒 0%。
  useEffect(() => {
    /** processing 标超过此时长未更新视为死标（单篇向量化正常为分钟级） */
    const STALE_PROCESSING_MS = 2 * 60 * 60 * 1000;
    let timer: ReturnType<typeof setInterval> | undefined;
    let unlistenProgress: (() => void) | undefined;
    let disposed = false;
    void (async () => {
      try {
        const papers = await listPapers();
        const now = Date.now();
        const fresh: BookWithStatus[] = [];
        const stale: BookWithStatus[] = [];
        for (const p of papers) {
          const vec = p.status?.metadata?.vectorization;
          if (vec?.status !== "processing") continue;
          const ts = vec.updatedAt ?? vec.startedAt ?? 0;
          (now - ts > STALE_PROCESSING_MS ? stale : fresh).push(p);
        }
        // 死标清理解锁（不注册、不出恢复卡；回写 failed 供用户重试）
        for (const p of stale) {
          updateBookVectorizationMeta(p.id, { status: "failed", finishedAt: now }).catch(() => {});
        }
        // 实时通道在跑（P2-3 读 task-center 通道聚合）：注册表已被执行器打点、进度卡是实时的，恢复逻辑整体跳过
        const liveAgg = selectChannelAggregate(useTaskCenterStore.getState(), "paper-vectorize");
        if (liveAgg.current || liveAgg.queuedCount > 0 || usePaperTaskStore.getState().progress.vectorize) return;
        const reg = await import("@/store/paper-task-registry");
        if (disposed) return;
        const regState = reg.usePaperTaskRegistry.getState();
        // 对账：注册表里有标记但 metadata 已不是 processing 的（页面离场期间完成/失败、
        // 上轮轮询随卸载被清理没来得及解除）→ 解除，防永久残留误挡该篇的向量化/重解析
        for (const id of Object.keys(regState.activeVectorize)) {
          const still = papers.find((p) => p.id === id)?.status?.metadata?.vectorization?.status === "processing";
          if (!still) regState.mark(id, "vectorize", false);
        }
        if (fresh.length === 0) return;
        const mark = regState.mark;
        for (const p of fresh) mark(p.id, "vectorize", true);
        // 进度卡恢复（简化：无法知道百分比初值，显示 N 篇进行中）
        usePaperTaskStore.setState({
          progress: {
            vectorize: {
              status: "running",
              index: 0,
              total: fresh.length,
              title: fresh[0]?.title ?? "",
              detail: "向量化进行中（页面刷新后恢复监控）…",
              percent: 0,
              doneCount: 0,
              failedCount: 0,
              skippedCount: 0,
              failedNames: [],
            },
          },
        });
        // 恢复卡也吃真实进度事件（Rust 侧 index_paper 仍在跑仍会发）：圆环 + 卡片 percent 不再恒 0
        const freshIds = new Set(fresh.map((p) => p.id));
        const pctById = new Map<string, number>();
        unlistenProgress = await listen<{ paper_id: string; percent: number }>("paper://index-progress", (e) => {
          const p = e.payload;
          if (!freshIds.has(p.paper_id)) return;
          const pct = Math.max(0, Math.min(100, Math.round(p.percent)));
          pctById.set(p.paper_id, pct);
          const avg = Math.round([...pctById.values()].reduce((a, b) => a + b, 0) / Math.max(1, pctById.size));
          usePaperTaskStore.setState((s) => ({
            vectorizePercent: { ...s.vectorizePercent, [p.paper_id]: pct },
            progress: s.progress.vectorize?.detail?.includes("恢复监控")
              ? { ...s.progress, vectorize: { ...s.progress.vectorize, percent: avg } }
              : s.progress,
          }));
        });
        if (disposed) {
          unlistenProgress();
          unlistenProgress = undefined;
          return;
        }
        // 监听完成事件：metadata 变为 success/failed 时解除注册表标记（loadAll 后自然刷新）
        // 简化：30 秒轮询检查一次
        timer = setInterval(async () => {
          try {
            const recheck = await listPapers();
            const stillProcessing = recheck.filter((p) => p.status?.metadata?.vectorization?.status === "processing");
            const regS = reg.usePaperTaskRegistry.getState();
            // 解除已完成的
            for (const p of fresh) {
              if (!stillProcessing.find((sp) => sp.id === p.id)) {
                regS.mark(p.id, "vectorize", false);
              }
            }
            if (stillProcessing.length === 0) {
              clearInterval(timer);
              timer = undefined;
              unlistenProgress?.();
              unlistenProgress = undefined;
              // 清恢复态进度卡（实时卡由 drain 自己收尾，不动）
              usePaperTaskStore.setState((prev) => ({
                progress: prev.progress.vectorize?.detail?.includes("恢复监控")
                  ? { ...prev.progress, vectorize: undefined }
                  : prev.progress,
              }));
            }
          } catch {
            /* 轮询失败静默 */
          }
        }, 30000);
      } catch {
        /* 恢复失败不阻断 */
      }
    })();
    return () => {
      // 卸载清理定时器与事件监听（堵漏）；注册表标记有意保留——任务真在跑，标记是真相；
      // 若任务在页面离场期间完成，标记由下次挂载的恢复扫描（processing 已消失则不回写）自然解除
      disposed = true;
      if (timer !== undefined) clearInterval(timer);
      unlistenProgress?.();
    };
  }, []);

  // 批量解析结算后的列表刷新回调（注册给全局队列；本页不在场时跳过，重进自会加载）
  // loadAll 经 ref 间接引用：注册一次，刷新函数始终取最新
  const loadAllRef = useRef(loadAll);
  loadAllRef.current = loadAll;
  const papersRef = useRef(papers);
  papersRef.current = papers;
  useEffect(() => {
    setPaperImportRefresh(() => {
      void loadAllRef.current();
    });
    // 向量化/翻译通道收尾回调（paper-task-store 预留的 PapersPage 注册口）：静默重查译本存在性 +
    // 失效重读元数据（翻译落盘的 title_zh/abstract_zh 即时上列表，metaCacheRef 不再挡新值）——
    // 不走 loadAll（setLoading 会整表闪屏）；向量化收尾触发同样的重查，无害
    usePaperTaskStore.getState().setOnSettled(() => {
      const current = papersRef.current;
      const cache = metaCacheRef.current;
      for (const p of current) cache.delete(p.id);
      // 先重读元数据再重查译本标记：checkTranslated 的不完整戳记读 metaCacheRef，乱序会短暂误绿
      void (async () => {
        await loadMeta(current);
        await checkTranslated(current);
      })();
    });
    return () => {
      setPaperImportRefresh(null);
      usePaperTaskStore.getState().setOnSettled(null);
    };
  }, [loadMeta, checkTranslated]);

  // 论文变更总线（2026-08-24）：状态变化按 id 局部刷新该篇（向量化完成圆环即转绿，不靠重挂载）；
  // 列表变化（新条目入库）去抖 400ms 增量重载——AI 工具 importPaper 等不过队列收尾的入口也覆盖。
  // 全程响应式局部更新，不做整页刷新（阅读视图不受影响：本页未挂载时通知落空，重进 loadAll 兜底）。
  useEffect(() => {
    let listTimer: ReturnType<typeof setTimeout> | null = null;
    const offStatus = onPaperStatusChanged((paperId) => {
      void (async () => {
        try {
          const st = await getBookStatus(paperId);
          if (!st) return;
          setPapers((prev) => prev.map((p) => (p.id === paperId ? { ...p, status: st } : p)));
        } catch {
          /* 单篇状态刷新失败不阻断 */
        }
      })();
    });
    const offList = onPaperListChanged(() => {
      if (listTimer) clearTimeout(listTimer);
      listTimer = setTimeout(() => void loadAllRef.current(), 400);
    });
    return () => {
      offStatus();
      offList();
      if (listTimer) clearTimeout(listTimer);
    };
  }, []);

  // ---- 文件夹派生数据 ----
  const folderTree = useMemo(() => buildFolderTree(folders), [folders]);

  /** paperId -> 所属 folderId 集合 */
  const memberMap = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const { paperId, folderId } of members) {
      let set = map.get(paperId);
      if (!set) {
        set = new Set();
        map.set(paperId, set);
      }
      set.add(folderId);
    }
    return map;
  }, [members]);

  /** folderId -> 直接成员数（只计在库论文；回收站中的论文保留归属行但不应计入——2026-08-13 修复） */
  const folderCounts = useMemo(() => {
    const liveIds = new Set(papers.map((p) => p.id));
    const map = new Map<string, number>();
    for (const { paperId, folderId } of members) {
      if (!liveIds.has(paperId)) continue;
      map.set(folderId, (map.get(folderId) ?? 0) + 1);
    }
    return map;
  }, [members, papers]);

  /** 当前文件夹的直接子文件夹（主列表顶部的文件夹行；folders 按创建时间升序，filter 保持顺序） */
  const currentSubfolders = useMemo(() => {
    if (selection.kind !== "folder") return [];
    return folders.filter((f) => f.parentId === selection.id);
  }, [folders, selection]);

  /** 当前文件夹的面包屑路径（从根到当前，含当前；点任一段跳转） */
  const breadcrumbPath = useMemo(() => {
    if (selection.kind !== "folder") return [];
    const byId = new Map(folders.map((f) => [f.id, f]));
    const path: Folder[] = [];
    let cursor = byId.get(selection.id);
    // path.length 上限防御脏数据父链成环
    while (cursor && path.length <= folders.length) {
      path.unshift(cursor);
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
    return path;
  }, [folders, selection]);

  const unfiledCount = useMemo(() => papers.filter((p) => !memberMap.get(p.id)?.size).length, [papers, memberMap]);

  /** 选中文件夹被删除（或随祖先级联删除）后，回退到"全部论文" */
  useEffect(() => {
    if (!loading && selection.kind === "folder" && !folders.some((f) => f.id === selection.id)) {
      setSelection({ kind: "all" });
    }
  }, [loading, folders, selection]);

  /** 列表过滤：全部 = 不过滤；未归档 = 无成员关系；文件夹 = 仅直接挂在该文件夹的论文（子文件夹以文件夹行呈现） */
  const filteredPapers = useMemo(() => {
    if (selection.kind === "all") return papers;
    if (selection.kind === "unfiled") return papers.filter((p) => !memberMap.get(p.id)?.size);
    return papers.filter((p) => memberMap.get(p.id)?.has(selection.id));
  }, [papers, selection, memberMap]);

  const renderAuthorLine = (paper: BookWithStatus) => {
    const authors = normalizeAuthors(metaMap[paper.id]?.author);
    if (authors.length > 0) {
      return authors.slice(0, 3).join(", ") + (authors.length > 3 ? " et al." : "");
    }
    return paper.author;
  };

  const renderVenueLine = (paper: BookWithStatus) => {
    const meta = metaMap[paper.id];
    return [meta?.date, meta?.["container-title"]].filter(Boolean).join(" · ");
  };

  /** 检索 + 排序后的可见列表：关键词（空白分词 AND）匹配标题/作者/期刊/摘要/中英文/关键词；排序持久化在 app-settings */
  const visiblePapers = useMemo(() => {
    let list = filteredPapers;
    const query = searchQuery.trim().toLowerCase();
    if (query) {
      const terms = query.split(/\s+/);
      list = list.filter((paper) => {
        const meta = metaMap[paper.id];
        const haystack = [
          paper.title,
          renderAuthorLine(paper),
          renderVenueLine(paper),
          meta?.abstract,
          meta?.title_zh,
          meta?.abstract_zh,
          ...(meta?.keywords ?? []),
        ]
          .filter(Boolean)
          .join("\n")
          .toLowerCase();
        return terms.every((term) => haystack.includes(term));
      });
    }
    const dir = sortAscending ? 1 : -1;
    const sorted = [...list];
    switch (sortBy) {
      case "title":
        sorted.sort((a, b) => dir * a.title.localeCompare(b.title));
        break;
      case "rating":
        // 重要度恒按星数降序为主键，方向键只作用于次序的时间次键
        sorted.sort((a, b) => (b.status?.rating ?? 0) - (a.status?.rating ?? 0) || dir * (b.updatedAt - a.updatedAt));
        break;
      case "created":
        sorted.sort((a, b) => dir * (b.createdAt - a.createdAt));
        break;
      default:
        sorted.sort((a, b) => dir * (b.updatedAt - a.updatedAt));
    }
    return sorted;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- renderAuthorLine/renderVenueLine 只读 metaMap
  }, [filteredPapers, searchQuery, metaMap, sortBy, sortAscending]);

  /** 打星（0-3）：乐观更新本地状态，失败提示并整体重载回滚 */
  const handleRate = async (paper: BookWithStatus, rating: number) => {
    setPapers((prev) =>
      prev.map((p) => (p.id === paper.id ? { ...p, status: p.status ? { ...p.status, rating } : p.status } : p)),
    );
    try {
      await updateBookStatus(paper.id, { rating });
    } catch (error) {
      console.error("更新重要度失败:", error);
      toast.error("更新重要度失败");
      loadAll();
    }
  };

  const handleSortByChange = (value: string) => {
    const next = value as PapersSortByType;
    // 标题默认升序，其余默认降序
    setSettings({ ...settings, papersSortBy: next, papersSortAscending: next === "title" });
  };
  const handleSortDirectionToggle = () => {
    setSettings({ ...settings, papersSortAscending: !sortAscending });
  };
  const handleMetaLangToggle = () => {
    setSettings({ ...settings, papersMetaLang: metaLang === "zh" ? "original" : "zh" });
  };

  // ---- 文件夹操作 ----
  const handleSelect = (next: Selection) => {
    setSelection(next);
    if (next.kind === "folder") {
      // 展开全部祖先节点，保证侧栏中该文件夹可见（主区导航与侧栏选中保持同步）
      setExpandedFolders((prev) => {
        const byId = new Map(folders.map((f) => [f.id, f]));
        const expanded = new Set(prev);
        let cursor = byId.get(next.id)?.parentId;
        let guard = 0;
        while (cursor && guard < folders.length) {
          expanded.add(cursor);
          cursor = byId.get(cursor)?.parentId;
          guard += 1;
        }
        return expanded;
      });
    }
  };

  const handleToggleFolder = (id: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const openCreateDialog = (parentId: string | null) => {
    setNameInput("");
    setNameDialog({ mode: "create", parentId });
  };

  const openRenameDialog = (folder: Folder) => {
    setNameInput(folder.name);
    setNameDialog({ mode: "rename", id: folder.id });
  };

  const handleNameSubmit = async () => {
    const name = nameInput.trim();
    if (!name || !nameDialog || nameSubmitting) return;

    setNameSubmitting(true);
    try {
      if (nameDialog.mode === "create") {
        await createFolder(name, nameDialog.parentId);
        const parentId = nameDialog.parentId;
        if (parentId) {
          // 新建子文件夹后自动展开父节点，让新节点可见
          setExpandedFolders((prev) => new Set(prev).add(parentId));
        }
        toast.success(`已创建文件夹「${name}」`);
      } else {
        await renameFolder(nameDialog.id, name);
        toast.success("已重命名");
      }
      setNameDialog(null);
      await loadAll();
    } catch (error) {
      console.error("保存文件夹失败:", error);
      toast.error(`保存文件夹失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setNameSubmitting(false);
    }
  };

  const handleDeleteFolder = async (folder: Folder) => {
    try {
      const confirmed = await ask(
        `确定删除文件夹「${folder.name}」吗？其中的子文件夹会一并移入回收站。\n\n论文不会被删除，归属关系保留，恢复后原样回来。`,
        { title: "删除文件夹", kind: "warning" },
      );
      if (!confirmed) return;

      await deleteFolder(folder.id);
      toast.success("文件夹已移到回收站");
      await loadAll();
    } catch (error) {
      console.error("删除文件夹失败:", error);
      toast.error(`删除文件夹失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // ---- "移动到…"对话框 ----
  const openMoveDialog = (paper: BookWithStatus) => {
    setMovePaper(paper);
    setMoveChecked(new Set(memberMap.get(paper.id) ?? []));
  };

  const handleMoveConfirm = async () => {
    if (!movePaper || moveSubmitting) return;

    setMoveSubmitting(true);
    try {
      await setPaperFolders(movePaper.id, [...moveChecked]);
      toast.success("已更新所属文件夹");
      setMovePaper(null);
      await loadAll();
    } catch (error) {
      console.error("移动论文失败:", error);
      toast.error(`移动失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setMoveSubmitting(false);
    }
  };

  /** 两个导入入口共用：dialogTitle 不同，扫描逻辑相同（单篇目录或其父目录都支持）。
   *  选中某个文件夹时导入，新入库的论文自动挂载到该文件夹（跳过的重复篇不动）。 */
  const handleImport = async (dialogTitle: string) => {
    try {
      const selected = await open({ directory: true, multiple: false, title: dialogTitle });
      if (typeof selected !== "string" || !selected) return;

      setImporting(true);
      const folderId = selection.kind === "folder" ? selection.id : undefined;
      const result = await importPapers(selected, folderId);

      if (result.imported === 0 && result.skipped === 0 && result.failed.length === 0) {
        toast.info("未发现可导入的论文", { description: "所选目录（或其一级子目录）中需要存在 paper.md" });
      } else {
        const parts = [`导入 ${result.imported} 篇`];
        if (result.skipped > 0) parts.push(`跳过 ${result.skipped} 篇重复`);
        if (result.failed.length > 0) parts.push(`失败 ${result.failed.length} 篇`);
        const summary = parts.join("，");
        if (result.failed.length > 0) {
          toast.error(summary, {
            description: result.failed
              .slice(0, 3)
              .map((f) => f.error)
              .join("\n"),
          });
        } else {
          toast.success(summary);
        }
      }

      await loadAll();
    } catch (error) {
      console.error("导入论文失败:", error);
      toast.error(`导入失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setImporting(false);
    }
  };

  /** 点「导入 PDF」：先做引擎 Token 检查，再开选择弹窗（点选/拖拽可多选累加，确认后开始解析） */
  const handleImportPdf = () => {
    const tokenError = paperEngineTokenError(paperEngine);
    if (tokenError) {
      toast.error(tokenError);
      return;
    }
    setPdfCandidates([]);
    setPdfPickerOpen(true);
  };

  /** 弹窗内"点击选择文件"（多选，去重追加进候选列表） */
  const handlePickPdfFile = async () => {
    try {
      const selected = await open({
        multiple: true,
        directory: false,
        title: "选择论文 PDF（可多选）",
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
      if (paths.length > 0) setPdfCandidates((prev) => mergePdfCandidates(prev, paths));
    } catch (error) {
      console.error("选择 PDF 失败:", error);
    }
  };

  runPdfImportRef.current = (paths) => {
    // 解析导入走全局队列（convert-progress-store 自身串行），与向量化/翻译通道并行不互斥
    // 全局队列（convert-progress-store）：进度卡跨页面呈现，folderId 在启动时定格
    void startPaperImportBatch(paths, selectionRef.current.kind === "folder" ? selectionRef.current.id : undefined);
  };

  /** 开始解析：关闭选择弹窗，候选列表转入后台串行队列（全局右下角进度卡），完成时 toast 提醒 */
  const handleStartPdfImport = async () => {
    if (pdfCandidates.length === 0) return;
    const paths = pdfCandidates;
    setPdfPickerOpen(false);
    setPdfCandidates([]);
    await startPaperImportBatch(paths, selection.kind === "folder" ? selection.id : undefined);
  };

  /** 列表行点击 = 打开论文标签页（阅读视图在标签页三段布局中，正文由 PaperReaderView 自行加载）。
   *  L2 仅云端（元数据已同步、文件未下载）时先经文件通道下载再打开（与书籍卡片同款懒加载语义） */
  const handleOpen = async (paper: BookWithStatus) => {
    try {
      const base = await appDataDir();
      if (paper.filePath && !(await exists(`${base}/${paper.filePath}`))) {
        toast.info(`正在下载《${paper.title}》...`);
        // 论文走 zip 捆下载（整目录时点替换解包），失败不打开避免读取落空
        await syncDownloadBook(paper.id);
      }
    } catch (error) {
      console.error("下载论文失败:", error);
      toast.error("下载失败", { description: String(error) });
      return;
    }
    openPaper(paper.id, paper.title);
  };

  const handleTrash = async (paper: BookWithStatus) => {
    try {
      const confirmed = await ask(`确定把《${paper.title}》移到回收站吗？\n\n回收站中的论文可以随时恢复。`, {
        title: "删除论文",
        kind: "warning",
      });
      if (!confirmed) return;

      await trashPaper(paper.id);
      metaCacheRef.current.delete(paper.id);
      toast.success("已移到回收站");
      await loadAll();
    } catch (error) {
      console.error("删除论文失败:", error);
      toast.error(`删除论文失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const handleVectorize = async (paper: BookWithStatus) => {
    const { useLlamaStore } = await import("@/store/llama-store");
    if (!useLlamaStore.getState().hasVectorCapability()) {
      toast.error("没有可用的嵌入模型，请先在设置中下载本地嵌入模型或配置外部嵌入服务");
      return;
    }
    const conflicts = paperConflicts(paper.id, "vectorize");
    if (conflicts.length > 0) {
      toast.info(`《${paper.title}》${conflictReasonText(conflicts)}，完成后再向量化`);
      return;
    }
    const { enqueuePaperVectorizeBatch } = await import("@/services/task-executors/paper-vectorize");
    enqueuePaperVectorizeBatch([{ id: paper.id, title: paper.title, author: paper.author ?? "", solo: true }]);
  };

  /** 打开论文数据目录（{appData}/books/{id}——paper.md/源 PDF/图片都在这里），与图书卡片同款 */
  const handleOpenPaperFolder = async (paper: BookWithStatus) => {
    try {
      const dir = await join(await appDataDir(), "books", paper.id);
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

  // ---- 批量管理 ----
  /** 选中集合对应的论文（按列表顺序；过滤掉已不在库的幽灵 id） */
  const selectedPapers = useMemo(() => papers.filter((p) => selectedIds.has(p.id)), [papers, selectedIds]);
  /** 批量任务或导入进行中：占用转换/LLM 资源的批量操作（向量化/翻译/重新解析）禁用 */
  // 响应式订阅任务注册表：任一篇任务状态变化 → 按钮禁用态实时重算（冲突解除自动恢复可点）
  const activeVectorizeMap = usePaperTaskRegistry((st) => st.activeVectorize);
  const activeTranslateMap = usePaperTaskRegistry((st) => st.activeTranslate);
  // 排队/运行中集合读 task-center 通道（P2-3 队列已迁入；注册表打点仅覆盖运行中，排队项在此补）
  const busyVectorize = useMemo(() => {
    const set = new Set(Object.keys(activeVectorizeMap));
    for (const t of Object.values(taskCenterTasks)) {
      if (t.channel === "paper-vectorize" && (t.status === "queued" || t.status === "running")) set.add(t.targetId);
    }
    return set;
  }, [activeVectorizeMap, taskCenterTasks]);
  const busyTranslate = useMemo(() => {
    const set = new Set(Object.keys(activeTranslateMap));
    for (const t of Object.values(taskCenterTasks)) {
      if (t.channel === "paper-translate" && (t.status === "queued" || t.status === "running")) set.add(t.targetId);
    }
    return set;
  }, [activeTranslateMap, taskCenterTasks]);
  const taskVectorizeBlockers = selectedPapers.filter(
    (p) => paperConflicts(p.id, "vectorize").length > 0 || busyVectorize.has(p.id),
  );
  const taskTranslateBlockers = selectedPapers.filter(
    (p) => paperConflicts(p.id, "translate").length > 0 || busyTranslate.has(p.id),
  );
  const taskReparseBlockers = selectedPapers.filter((p) => paperConflicts(p.id, "parse").length > 0);
  const blockerHint = (list: BookWithStatus[], verb: string) =>
    list.length > 0
      ? `${list.length} 篇无法${verb}：${list
          .slice(0, 3)
          .map((p) => `${p.title}`)
          .join("、")}${list.length > 3 ? " 等" : ""}（任务进行中或已排队，取消勾选后可执行）`
      : undefined;
  const batchLocked = importing || paperImportRunning || zoteroRunning;

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  /** 全选三态：当前可见（文件夹过滤 + 检索过滤后）全部选中→全选；部分→indeterminate；点击在全选可见/清空可见间切换 */
  const visibleCheckState: boolean | "indeterminate" = useMemo(() => {
    if (visiblePapers.length === 0) return false;
    const hit = visiblePapers.filter((p) => selectedIds.has(p.id)).length;
    if (hit === 0) return false;
    return hit === visiblePapers.length ? true : "indeterminate";
  }, [visiblePapers, selectedIds]);

  const handleToggleSelectAll = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (visiblePapers.length > 0 && visiblePapers.every((p) => next.has(p.id))) {
        for (const p of visiblePapers) next.delete(p.id);
      } else {
        for (const p of visiblePapers) next.add(p.id);
      }
      return next;
    });
  };

  /** 批量移动确认：对每篇整体替换文件夹归属（初始为空 = 默认全部移出文件夹） */
  const handleBatchMoveConfirm = async () => {
    if (moveSubmitting || selectedPapers.length === 0) return;
    setMoveSubmitting(true);
    try {
      for (const paper of selectedPapers) {
        await setPaperFolders(paper.id, [...moveChecked]);
      }
      toast.success(`已替换 ${selectedPapers.length} 篇论文的文件夹归属`);
      setBatchMoveOpen(false);
      setSelectedIds(new Set());
      await loadAll();
    } catch (error) {
      console.error("批量移动论文失败:", error);
      toast.error(`批量移动失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setMoveSubmitting(false);
    }
  };

  const handleBatchDelete = async () => {
    const anyChannelBusy =
      Object.keys(usePaperTaskStore.getState().vectorizePercent).length > 0 ||
      (["paper-vectorize", "paper-translate"] as const).some((channel) => {
        const agg = selectChannelAggregate(useTaskCenterStore.getState(), channel);
        return agg.current !== null || agg.queuedCount > 0;
      });
    if (anyChannelBusy) {
      toast.info("向量化/翻译进行中，完成后删除（避免删到正在处理的论文）");
      return;
    }
    if (selectedPapers.length === 0) return;
    try {
      const confirmed = await ask(
        `确定把选中的 ${selectedPapers.length} 篇论文移到回收站吗？\n\n回收站中的论文可以随时恢复。`,
        { title: "批量删除论文", kind: "warning" },
      );
      if (!confirmed) return;
      let failed = 0;
      for (const paper of selectedPapers) {
        try {
          await trashPaper(paper.id);
          metaCacheRef.current.delete(paper.id);
        } catch (error) {
          failed += 1;
          console.error(`删除论文失败: ${paper.id}`, error);
        }
      }
      setSelectedIds(new Set());
      if (failed > 0) toast.error(`完成 ${selectedPapers.length - failed} 篇 · 失败 ${failed} 篇`);
      else toast.success(`已把 ${selectedPapers.length} 篇论文移到回收站`);
      await loadAll();
    } catch (error) {
      console.error("批量删除论文失败:", error);
      toast.error(`批量删除失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };
  /** 批量任务通用收尾：写收尾卡 + 清选择 + 刷新列表 */

  /** 批量向量化：入 task-center 的 paper-vectorize 通道（单篇=批量=入队；按钮禁用态实时推导冲突，此处仅竞态兜底） */
  const handleBatchVectorize = async () => {
    if (selectedPapers.length === 0) return;
    const { useLlamaStore } = await import("@/store/llama-store");
    if (!useLlamaStore.getState().hasVectorCapability()) {
      toast.error("没有可用的嵌入模型，请先在设置中下载本地嵌入模型或配置外部嵌入服务");
      return;
    }
    const { enqueuePaperVectorizeBatch } = await import("@/services/task-executors/paper-vectorize");
    enqueuePaperVectorizeBatch(selectedPapers.map((p) => ({ id: p.id, title: p.title, author: p.author ?? "" })));
    if (manageMode && selectedIds.size > 0) setManageMode(false);
  };

  /** 翻译入队（幂等续翻；P2-3 起走 task-center 的 paper-translate 通道）。
   *  paper 直发 = 右键菜单单篇（solo 独立完成 toast），缺省走选择集批量；
   *  force=true 全量重翻（「重新翻译」入口，确认后入队——已有译文作废，耗时/额度与首翻相当） */
  const handleBatchTranslate = async (paper?: BookWithStatus, force = false) => {
    const targets = paper ? [paper] : selectedPapers;
    if (targets.length === 0) return;
    if (!getUtilityModel()) {
      toast.error("未配置 AI 模型：请先在设置中配置辅助模型（或聊天模型）后再翻译");
      return;
    }
    if (force) {
      let confirmed = false;
      try {
        confirmed = await ask(
          paper
            ? `将全量重新翻译《${paper.title}》：已有译文作废重翻，耗时与额度消耗与首次翻译相当。`
            : `将全量重新翻译选中的 ${targets.length} 篇论文：已有译文作废重翻，耗时与额度消耗与首次翻译相当。`,
          { title: "重新翻译", kind: "warning" },
        );
      } catch (error) {
        console.error("确认对话框失败:", error);
      }
      if (!confirmed) return;
    }
    const { enqueuePaperTranslateBatch } = await import("@/services/task-executors/paper-translate");
    enqueuePaperTranslateBatch(
      targets.map((p) => ({
        id: p.id,
        title: p.title,
        ...(paper ? { solo: true } : {}),
        ...(force ? { force: true } : {}),
      })),
    );
    if (!paper && manageMode && selectedIds.size > 0) setManageMode(false);
  };

  /** 重新解析：确认后逐篇入全局解析队列（silent 聚合拒绝，单条 toast）。
   *  paper 直发 = 右键菜单单篇，缺省走选择集批量 */
  const handleBatchReparse = async (paper?: BookWithStatus) => {
    const targets = paper ? [paper] : selectedPapers;
    if (targets.length === 0) return;
    const tokenError = paperEngineTokenError(paperEngine);
    if (tokenError) {
      toast.error(tokenError);
      return;
    }
    let confirmed = false;
    try {
      confirmed = await ask(
        paper
          ? `将用最新解析引擎重新解析《${paper.title}》的源 PDF 并替换现有解析产物。\n\n文件夹归属、对话与标注保留，但文内高亮可能因正文变化漂移。`
          : `将用最新解析引擎重新解析选中的 ${targets.length} 篇论文的源 PDF 并替换现有解析产物。\n\n文件夹归属、对话与标注保留，但文内高亮可能因正文变化漂移。`,
        { title: !paper && targets.length > 1 ? `重新解析（${targets.length} 篇）` : "重新解析", kind: "warning" },
      );
    } catch (error) {
      console.error("确认对话框失败:", error);
    }
    if (!confirmed) return;
    let queued = 0;
    const rejected: string[] = [];
    for (const p of targets) {
      const res = startPaperReparse({ id: p.id, title: p.title }, { silent: true });
      if (res.ok) queued += 1;
      else rejected.push(res.message);
    }
    if (rejected.length > 0) {
      toast.info(`跳过 ${rejected.length} 篇：${rejected.slice(0, 3).join("；")}${rejected.length > 3 ? " 等" : ""}`, {
        duration: 6000,
      });
    }
    if (queued > 0) {
      toast.success(paper ? `《${paper.title}》已加入解析队列` : `已加入解析队列：${queued} 篇`);
      if (!paper && manageMode && selectedIds.size > 0) setManageMode(false);
    }
  };
  /** 批量任务取消（按通道，P2-3 走 task-center）：向量化当前篇跑完即停；翻译 abort 当前篇+撤排队。
   *  取消中态由 task-center 的通道 cancelling 标志承载（cancelChannel 置位、泵收尾清除）；
   *  恢复监控卡（无通道任务）保持旧口径：标取消中，由恢复轮询收尾清卡 */
  const handleCancelBatch = (kind: "vectorize" | "translate") => {
    const channel: TaskChannel = kind === "vectorize" ? "paper-vectorize" : "paper-translate";
    const agg = selectChannelAggregate(useTaskCenterStore.getState(), channel);
    if (agg.current || agg.queuedCount > 0) {
      useTaskCenterStore.getState().cancelChannel(channel);
      return;
    }
    usePaperTaskStore.setState((s) => ({
      progress: s.progress[kind]
        ? { ...s.progress, [kind]: { ...(s.progress[kind] as ChannelProgress), cancelling: true, detail: "正在取消…" } }
        : s.progress,
    }));
  };

  /** 关闭批量进度卡（running 时等同取消） */
  const handleDismissBatchProgress = (card: (typeof batchCards)[number]) => {
    if (card.status === "running") {
      handleCancelBatch(card.kind);
      return;
    }
    // 通道卡清已结算；恢复监控卡清切片（两者互斥，双写无害）
    useTaskCenterStore.getState().dismissSettled(card.kind === "vectorize" ? "paper-vectorize" : "paper-translate");
    usePaperTaskStore.setState((prev) => ({ progress: { ...prev.progress, [card.kind]: undefined } }));
  };

  // ---- 列表视图 ----
  return (
    <div className="relative flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between gap-4 px-4 pt-4 pb-3">
        <div className="flex items-baseline gap-3">
          <h1 className="font-bold text-2xl text-neutral-900 dark:text-neutral-100">文献库</h1>
          <span className="text-neutral-500 text-sm dark:text-neutral-400">共 {visiblePapers.length} 篇</span>
        </div>
        <div className="flex items-center gap-2">
          {/* 解析运行中不禁用：提交进全局队列排队（convert-progress-store 串行接续） */}
          <Button onClick={handleImportPdf} disabled={importing}>
            <FileDown className="size-4" />
            导入 PDF
          </Button>
          <Button
            variant="outline"
            onClick={() => setZoteroOpen(true)}
            disabled={importing || paperImportRunning || zoteroRunning}
          >
            {zoteroRunning ? <Loader2 className="size-4 animate-spin" /> : <Library className="size-4" />}
            Zotero 导入
          </Button>
          {/* 高级导入：面向开发者/转换器用户——期望的是 Papers_Converter 产物目录（含 paper.md 与 images/） */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" disabled={importing}>
                {importing ? <Loader2 className="size-4 animate-spin" /> : <FolderInput className="size-4" />}
                高级
                <ChevronDown className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72 p-2">
              <div className="px-2 py-1.5 text-muted-foreground text-xs leading-relaxed">
                适用于已用 Papers_Converter 转换好的目录（含 paper.md 与 images/）。普通用户请直接用「导入
                PDF」，无需关心此处。
              </div>
              <DropdownMenuItem onSelect={() => handleImport("选择论文目录（含 paper.md）")}>
                <FolderOpen className="size-4" />
                导入论文目录（单篇）
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => handleImport("选择包含多篇论文的父目录")}>
                <FolderInput className="size-4" />
                批量导入（父目录，一级子目录逐篇）
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* 文件夹侧栏 */}
        <aside className="flex w-56 shrink-0 flex-col gap-0.5 overflow-y-auto border-neutral-200 border-r px-2 py-3 dark:border-neutral-800">
          <button
            type="button"
            className={sidebarItemClass(selection.kind === "all")}
            onClick={() => handleSelect({ kind: "all" })}
          >
            <Library className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">全部论文</span>
            <span className="shrink-0 text-neutral-400 text-xs">{papers.length}</span>
          </button>
          <button
            type="button"
            className={sidebarItemClass(selection.kind === "unfiled")}
            onClick={() => handleSelect({ kind: "unfiled" })}
          >
            <Inbox className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">未归档</span>
            <span className="shrink-0 text-neutral-400 text-xs">{unfiledCount}</span>
          </button>

          <div className="mt-3 mb-1 flex items-center justify-between px-2">
            <span className="text-neutral-400 text-xs">文件夹</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="rounded p-0.5 text-neutral-400 hover:bg-neutral-200 hover:text-neutral-600 dark:hover:bg-neutral-700 dark:hover:text-neutral-300"
                  onClick={() => openCreateDialog(null)}
                >
                  <FolderPlus className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">新建文件夹</TooltipContent>
            </Tooltip>
          </div>
          {folderTree.map((node) => (
            <FolderTreeItem
              key={node.id}
              node={node}
              depth={0}
              selection={selection}
              expanded={expandedFolders}
              counts={folderCounts}
              onSelect={(id) => handleSelect({ kind: "folder", id })}
              onToggle={handleToggleFolder}
              onCreateChild={openCreateDialog}
              onRename={openRenameDialog}
              onDelete={handleDeleteFolder}
            />
          ))}
        </aside>

        {/* 主区：工具栏（检索/排序/中文化）+ 面包屑（文件夹语境）+ 内容列表 */}
        <div className="flex min-w-0 flex-1 flex-col">
          {!loading && papers.length > 0 && (
            <div className="flex shrink-0 items-center gap-2 border-neutral-200 border-b px-4 py-2 dark:border-neutral-800">
              {manageMode ? (
                <div className="motion-enter-slide-up flex w-full items-center gap-2">
                  {/* 批量操作条：全选三态 + 已选计数 + 操作组 + 取消选择/完成 */}
                  <Checkbox
                    checked={visibleCheckState}
                    onCheckedChange={handleToggleSelectAll}
                    aria-label="全选当前列表"
                    className="ml-1"
                  />
                  <span className="shrink-0 text-neutral-600 text-sm dark:text-neutral-400">
                    已选 {selectedIds.size} 篇
                  </span>
                  <div className="min-w-0 flex-1" />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 shrink-0"
                    disabled={selectedIds.size === 0}
                    onClick={() => {
                      // 批量移动初始为空：确认即整体替换所选论文的文件夹归属
                      setMoveChecked(new Set());
                      setBatchMoveOpen(true);
                    }}
                  >
                    <FolderPen className="size-4" />
                    移动到…
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 shrink-0"
                    disabled={batchLocked || selectedIds.size === 0 || taskVectorizeBlockers.length > 0}
                    title={blockerHint(taskVectorizeBlockers, "向量化") ?? ""}
                    onClick={handleBatchVectorize}
                  >
                    <Sparkles className="size-4" />
                    向量化
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 shrink-0"
                    disabled={batchLocked || selectedIds.size === 0 || taskTranslateBlockers.length > 0}
                    title={blockerHint(taskTranslateBlockers, "翻译") ?? ""}
                    onClick={() => void handleBatchTranslate()}
                  >
                    <Languages className="size-4" />
                    翻译
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 shrink-0"
                    disabled={batchLocked || selectedIds.size === 0 || taskTranslateBlockers.length > 0}
                    title={blockerHint(taskTranslateBlockers, "重新翻译") ?? "已有译文作废，全量重翻"}
                    onClick={() => void handleBatchTranslate(undefined, true)}
                  >
                    <Languages className="size-4" />
                    重新翻译
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 shrink-0"
                    disabled={batchLocked || selectedIds.size === 0 || taskReparseBlockers.length > 0}
                    title={blockerHint(taskReparseBlockers, "重新解析") ?? ""}
                    onClick={() => void handleBatchReparse()}
                  >
                    <RefreshCw className="size-4" />
                    重新解析
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 shrink-0 text-red-500 hover:text-red-600 dark:hover:text-red-400"
                    disabled={selectedIds.size === 0}
                    onClick={handleBatchDelete}
                  >
                    <Trash2 className="size-4" />
                    删除
                  </Button>
                  <Button variant="ghost" size="sm" className="h-8 shrink-0" onClick={() => setSelectedIds(new Set())}>
                    <X className="size-4" />
                    取消选择
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 shrink-0"
                    onClick={() => {
                      setManageMode(false);
                      setSelectedIds(new Set());
                    }}
                  >
                    <Check className="size-4" />
                    完成
                  </Button>
                </div>
              ) : (
                <div className="motion-enter-fade flex w-full items-center gap-2">
                  <div className="relative min-w-0 flex-1">
                    <Search className="-translate-y-1/2 absolute top-1/2 left-2.5 size-3.5 text-neutral-400" />
                    <Input
                      value={searchQuery}
                      onChange={(event) => setSearchQuery(event.target.value)}
                      placeholder="检索标题 / 作者 / 期刊 / 摘要（空格分隔多词）"
                      className="h-8 pl-8 text-sm"
                    />
                  </div>
                  <Select value={sortBy} onValueChange={handleSortByChange}>
                    <SelectTrigger className="h-8 w-28 shrink-0">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="updated">更新时间</SelectItem>
                      <SelectItem value="created">导入时间</SelectItem>
                      <SelectItem value="rating">重要度</SelectItem>
                      <SelectItem value="title">标题</SelectItem>
                    </SelectContent>
                  </Select>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 shrink-0"
                        onClick={handleSortDirectionToggle}
                      >
                        {sortAscending ? (
                          <ArrowUpNarrowWide className="size-4" />
                        ) : (
                          <ArrowDownWideNarrow className="size-4" />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      {sortAscending ? "升序（点击切换）" : "降序（点击切换）"}
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className={clsx("size-8 shrink-0", metaLang === "zh" && "bg-primary/10 text-primary")}
                        onClick={handleMetaLangToggle}
                      >
                        <Languages className="size-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      {metaLang === "zh" ? "标题/摘要显示中文（点击切回原文）" : "标题/摘要中文化显示（用已有翻译）"}
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="sm" className="h-8 shrink-0" onClick={() => setManageMode(true)}>
                        <ListChecks className="size-4" />
                        管理
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">批量管理（多选后移动/删除/向量化/翻译/重新解析）</TooltipContent>
                  </Tooltip>
                </div>
              )}
            </div>
          )}
          {selection.kind === "folder" && !loading && papers.length > 0 && (
            <nav className="flex shrink-0 items-center gap-1 overflow-x-auto border-neutral-200 border-b px-4 py-2 text-sm dark:border-neutral-800">
              <button
                type="button"
                className="shrink-0 text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
                onClick={() => handleSelect({ kind: "all" })}
              >
                全部论文
              </button>
              {breadcrumbPath.map((folder, index) => {
                const isLast = index === breadcrumbPath.length - 1;
                return (
                  <Fragment key={folder.id}>
                    <ChevronRight className="size-3.5 shrink-0 text-neutral-400" />
                    {isLast ? (
                      <span className="shrink-0 font-medium text-neutral-900 dark:text-neutral-100">{folder.name}</span>
                    ) : (
                      <button
                        type="button"
                        className="shrink-0 text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
                        onClick={() => handleSelect({ kind: "folder", id: folder.id })}
                      >
                        {folder.name}
                      </button>
                    )}
                  </Fragment>
                );
              })}
            </nav>
          )}

          {loading ? (
            <div className="flex flex-1 items-center justify-center">
              <div className="text-neutral-600 dark:text-neutral-400">加载中...</div>
            </div>
          ) : papers.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-6 p-8">
              <div className="flex h-20 w-20 items-center justify-center rounded-3xl bg-primary/10">
                <BookOpenText className="h-10 w-10 text-primary" />
              </div>
              <div className="max-w-lg space-y-3 text-center">
                <h2 className="font-bold text-neutral-900 text-xl dark:text-neutral-100">文献库还是空的</h2>
                <p className="text-muted-foreground text-sm leading-relaxed">
                  把论文 PDF 拖进本页，或点下方按钮选择文件，即可自动解析、入库管理并阅读。 已有 Papers_Converter
                  转换产物（含 paper.md 与 images/ 的目录）可走右上角「高级」导入。
                </p>
              </div>
              <Button onClick={handleImportPdf} disabled={importing || paperImportRunning}>
                <FileDown className="size-4" />
                导入 PDF
              </Button>
              <Button
                variant="outline"
                onClick={() => setZoteroOpen(true)}
                disabled={importing || paperImportRunning || zoteroRunning}
              >
                <Library className="size-4" />
                Zotero 导入
              </Button>
            </div>
          ) : visiblePapers.length === 0 && currentSubfolders.length === 0 ? (
            <div className="flex flex-1 items-center justify-center">
              <p className="text-neutral-400 text-sm">
                {searchQuery.trim()
                  ? "没有匹配的论文"
                  : selection.kind === "folder"
                    ? "该文件夹还是空的"
                    : "当前范围内暂无论文"}
              </p>
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8">
              <div className="space-y-2">
                {/* 子文件夹行：文件夹图标 + 名称 + 直接成员论文数，点击进入（侧栏选中同步） */}
                {currentSubfolders.map((folder) => (
                  <div
                    key={folder.id}
                    role="button"
                    tabIndex={0}
                    className="flex cursor-pointer items-center gap-3 rounded-xl border border-neutral-200 bg-white p-4 transition-colors hover:border-neutral-300 hover:bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-neutral-700 dark:hover:bg-neutral-800/60"
                    onClick={() => handleSelect({ kind: "folder", id: folder.id })}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        handleSelect({ kind: "folder", id: folder.id });
                      }
                    }}
                  >
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-neutral-100 dark:bg-neutral-800">
                      <FolderIcon className="size-4 text-neutral-500 dark:text-neutral-400" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <h3 className="truncate font-semibold text-neutral-900 leading-snug dark:text-neutral-100">
                        {folder.name}
                      </h3>
                      <p className="mt-0.5 text-neutral-500 text-xs dark:text-neutral-500">
                        {folderCounts.get(folder.id) ?? 0} 篇论文
                      </p>
                    </div>
                    <ChevronRight className="size-4 shrink-0 text-neutral-400" />
                  </div>
                ))}
                {visiblePapers.map((paper) => {
                  const meta = metaMap[paper.id];
                  const venueLine = renderVenueLine(paper);
                  const vectorizePercent = vectorizing[paper.id];
                  const isVectorized = paper.status?.metadata?.vectorization?.status === "success";
                  // 右键菜单单篇操作的禁用口径：同篇任务撞车（进行中或已排队）才禁，无任务时可用
                  const translateBlocked =
                    busyTranslate.has(paper.id) || paperConflicts(paper.id, "translate").length > 0;
                  const reparseBlockers = paperConflicts(paper.id, "parse");
                  const translationState = translatedMap[paper.id];
                  const isTranslated = translationState !== undefined;
                  // 元数据中文化：用翻译服务已落盘的 title_zh/abstract_zh，缺省回退原文
                  const displayTitle = metaLang === "zh" ? meta?.title_zh || paper.title : paper.title;
                  const displayAbstract = metaLang === "zh" ? meta?.abstract_zh || meta?.abstract : meta?.abstract;
                  return (
                    <ContextMenu key={paper.id}>
                      <ContextMenuTrigger asChild>
                        <div
                          role="button"
                          tabIndex={0}
                          className="group flex cursor-pointer items-start gap-3 rounded-xl border border-neutral-200 bg-white p-4 transition-colors hover:border-neutral-300 hover:bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-neutral-700 dark:hover:bg-neutral-800/60"
                          onClick={() => handleOpen(paper)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              handleOpen(paper);
                            }
                          }}
                        >
                          {/* 多选 checkbox：仅管理模式出现；点击不触发行打开 */}
                          {manageMode && (
                            <div
                              className="motion-enter-pop mt-0.5 flex h-9 shrink-0 items-center"
                              onClick={(event) => event.stopPropagation()}
                              onKeyDown={(event) => event.stopPropagation()}
                            >
                              <Checkbox
                                checked={selectedIds.has(paper.id)}
                                onCheckedChange={() => toggleSelected(paper.id)}
                                aria-label={`选择《${paper.title}》`}
                              />
                            </div>
                          )}
                          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-neutral-100 dark:bg-neutral-800">
                            <FileText className="size-4 text-neutral-500 dark:text-neutral-400" />
                          </div>

                          <div className="min-w-0 flex-1">
                            <h3 className="line-clamp-2 font-semibold text-neutral-900 leading-snug dark:text-neutral-100">
                              <InlineMathText text={displayTitle} />
                            </h3>
                            {renderAuthorLine(paper) && (
                              <p className="mt-1 line-clamp-1 text-neutral-600 text-sm dark:text-neutral-400">
                                {renderAuthorLine(paper)}
                              </p>
                            )}
                            {venueLine && (
                              <p className="mt-0.5 line-clamp-1 text-neutral-500 text-xs dark:text-neutral-500">
                                {venueLine}
                              </p>
                            )}
                            {displayAbstract && (
                              <p className="mt-2 line-clamp-2 text-neutral-600 text-sm leading-relaxed dark:text-neutral-400">
                                <InlineMathText text={displayAbstract} />
                              </p>
                            )}
                          </div>

                          {/* 右侧两行纵向：上行仅打星（重要度），下行状态徽标（向量化圆环/云端/阅读状态）；
                          动作（向量化/翻译/重新解析/移动/打开文件夹/删除）全部收进卡片右键菜单 */}
                          <div className="flex shrink-0 flex-col items-end gap-1.5">
                            <div className="flex items-center gap-1.5">
                              <PaperStars
                                rating={paper.status?.rating ?? 0}
                                onRate={(rating) => handleRate(paper, rating)}
                              />
                            </div>
                            <div className="flex items-center gap-1.5">
                              <VectorizationRing paper={paper} vectorizePercent={vectorizePercent} />
                              {translationState && <PaperTranslatedBadge state={translationState} />}
                              <PaperCloudBadge paper={paper} />
                              <PaperStatusBadge status={paper.status} />
                            </div>
                          </div>
                        </div>
                      </ContextMenuTrigger>
                      <ContextMenuContent>
                        <ContextMenuItem
                          disabled={vectorizePercent != null}
                          onClick={() => void handleVectorize(paper)}
                        >
                          {vectorizePercent != null ? (
                            <Loader2 className="mr-2 size-4 animate-spin" />
                          ) : (
                            <Sparkles className="mr-2 size-4" />
                          )}
                          {isVectorized ? "重新向量化" : "向量化"}
                        </ContextMenuItem>
                        {/* 右键单篇只给一个翻译入口：未翻译→翻译（幂等首翻/续翻走阅读页），已翻译→重新翻译（force 全量） */}
                        <ContextMenuItem
                          disabled={translateBlocked}
                          title={translateBlocked ? "该篇翻译进行中或已排队，完成后再试" : undefined}
                          onClick={() => void handleBatchTranslate(paper, isTranslated)}
                        >
                          <Languages className="mr-2 size-4" />
                          {isTranslated ? "重新翻译" : "翻译"}
                        </ContextMenuItem>
                        <ContextMenuItem
                          disabled={batchLocked || reparseBlockers.length > 0}
                          title={
                            reparseBlockers.length > 0
                              ? `该篇${conflictReasonText(reparseBlockers)}，完成后再重新解析`
                              : undefined
                          }
                          onClick={() => void handleBatchReparse(paper)}
                        >
                          <RefreshCw className="mr-2 size-4" />
                          重新解析
                        </ContextMenuItem>
                        <ContextMenuItem onClick={() => openMoveDialog(paper)}>
                          <FolderPen className="mr-2 size-4" />
                          移动到…
                        </ContextMenuItem>
                        <ContextMenuItem onClick={() => void handleOpenPaperFolder(paper)}>
                          <FolderOpen className="mr-2 size-4" />
                          打开文件夹
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem variant="destructive" onClick={() => void handleTrash(paper)}>
                          <Trash2 className="mr-2 size-4" />
                          移到回收站
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 导入 PDF 选择弹窗：点击选择 / 拖入文件（可多选累加候选），确认后任务转后台串行队列 */}
      <Dialog open={pdfPickerOpen} onOpenChange={setPdfPickerOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader className="px-5">
            <DialogTitle>导入 PDF 论文</DialogTitle>
            <DialogDescription className="px-0">
              解析为 Markdown 论文并入库（后台串行运行，完成时提醒）
            </DialogDescription>
          </DialogHeader>
          <div className="min-w-0 space-y-4 px-5 py-4">
            <button
              type="button"
              onClick={handlePickPdfFile}
              className={clsx(
                "flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors",
                pdfDragOver
                  ? "border-primary bg-primary/5"
                  : "border-neutral-300 hover:border-primary/50 hover:bg-muted/40 dark:border-neutral-700",
              )}
            >
              <FileDown className={clsx("size-8", pdfDragOver ? "text-primary" : "text-neutral-400")} />
              <span className="font-medium text-sm">
                {pdfDragOver ? "松开以添加 PDF" : "点击选择或拖入 PDF（可多选）"}
              </span>
              <span className="text-muted-foreground text-xs">多篇将逐篇串行解析，每篇约需十几秒到几分钟</span>
            </button>
            {pdfCandidates.length > 0 && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground text-xs">待解析 {pdfCandidates.length} 篇</span>
                  <button
                    type="button"
                    className="text-muted-foreground text-xs hover:text-foreground"
                    onClick={() => setPdfCandidates([])}
                  >
                    清空
                  </button>
                </div>
                <div className="max-h-44 space-y-1 overflow-y-auto">
                  {pdfCandidates.map((path) => (
                    <div key={path} className="flex items-center gap-2 rounded-md border px-2 py-1.5">
                      <span className="min-w-0 flex-1 truncate text-sm" title={path}>
                        {path.split(/[\\/]/).pop()}
                      </span>
                      <button
                        type="button"
                        className="shrink-0 rounded p-0.5 text-neutral-400 hover:text-red-500"
                        onClick={() => setPdfCandidates((prev) => prev.filter((p) => p !== path))}
                      >
                        <X className="size-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          <DialogFooter className="px-5 pt-0 pb-4">
            <Button variant="outline" onClick={() => setPdfPickerOpen(false)}>
              取消
            </Button>
            <Button disabled={pdfCandidates.length === 0} onClick={handleStartPdfImport}>
              {pdfCandidates.length > 0 ? `开始解析（${pdfCandidates.length} 篇）` : "开始解析"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Zotero 批量导入对话框（选择 → 进行 → 报告三态，完成后刷新列表与文件夹树） */}
      <ZoteroImportDialog
        open={zoteroOpen}
        onOpenChange={setZoteroOpen}
        onCompleted={loadAll}
        onRunningChange={setZoteroRunning}
      />

      {/* 后台解析进度卡已上移为全局浮层（components/global-convert-progress）——跨页面持续呈现 */}

      {/* 批量任务进度卡（共享右下角栈，与解析/Zotero 卡纵向堆叠不覆盖；向量化/翻译双通道可并行各出一张；running 时关闭即取消）。
          出入场走 MotionStackCard 延迟卸载编排：通道进度清空后先播离场动画（定格收尾快照）再卸载。 */}
      {(["vectorize", "translate"] as const).map((kind) => {
        const progress = storeProgress[kind];
        return (
          <MotionStackCard key={kind} show={!!progress}>
            {progress && (
              <BatchProgressCard
                card={{ kind, ...progress }}
                onCancel={() => handleCancelBatch(kind)}
                onDismiss={() => handleDismissBatchProgress({ kind, ...progress })}
              />
            )}
          </MotionStackCard>
        );
      })}

      {/* 页面级拖入感应遮罩（拖 PDF 到文献库页任意位置直接解析） */}
      {pdfDragOver && !pdfPickerOpen && (
        <div className="pointer-events-none absolute inset-2 z-50 flex items-center justify-center rounded-2xl border-2 border-primary border-dashed bg-primary/5">
          <div className="flex flex-col items-center gap-2 text-primary">
            <FileDown className="size-10" />
            <span className="font-medium text-sm">松开导入 PDF 并解析</span>
          </div>
        </div>
      )}

      {/* 新建/重命名文件夹对话框 */}
      <Dialog
        open={nameDialog != null}
        onOpenChange={(openState) => {
          if (!openState) setNameDialog(null);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{nameDialog?.mode === "rename" ? "重命名文件夹" : "新建文件夹"}</DialogTitle>
          </DialogHeader>
          <div className="px-4 py-3">
            <Input
              autoFocus
              value={nameInput}
              placeholder="文件夹名称"
              onChange={(event) => setNameInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  handleNameSubmit();
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNameDialog(null)}>
              取消
            </Button>
            <Button onClick={handleNameSubmit} disabled={!nameInput.trim() || nameSubmitting}>
              确定
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 移动到文件夹对话框（单篇：回显当前成员关系；批量：初始为空、整体替换归属。可多选——一篇论文可属多个文件夹） */}
      <Dialog
        open={movePaper != null || batchMoveOpen}
        onOpenChange={(openState) => {
          if (!openState) {
            setMovePaper(null);
            setBatchMoveOpen(false);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{batchMoveOpen ? "批量移动到文件夹" : "移动到文件夹"}</DialogTitle>
          </DialogHeader>
          <p className="px-4 pt-2 text-neutral-500 text-xs dark:text-neutral-400">
            {batchMoveOpen
              ? `将替换 ${selectedIds.size} 篇论文的现有文件夹归属；全部取消勾选则移出所有文件夹（进入"未归档"）`
              : `《${movePaper?.title}》可同时属于多个文件夹；全部取消勾选则移出所有文件夹（进入"未归档"）`}
          </p>
          <div className="max-h-72 overflow-y-auto px-2 py-2">
            {folderTree.length === 0 ? (
              <p className="py-6 text-center text-neutral-400 text-sm">还没有文件夹，请先在左侧创建</p>
            ) : (
              flattenTree(folderTree).map(({ node, depth }) => (
                <label
                  key={node.id}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800/60"
                  style={{ marginInlineStart: `${depth * 16}px` }}
                >
                  <Checkbox
                    checked={moveChecked.has(node.id)}
                    onCheckedChange={(checked) => {
                      setMoveChecked((prev) => {
                        const next = new Set(prev);
                        if (checked === true) {
                          next.add(node.id);
                        } else {
                          next.delete(node.id);
                        }
                        return next;
                      });
                    }}
                  />
                  <FolderIcon className="size-3.5 shrink-0 text-neutral-400" />
                  <span className="truncate">{node.name}</span>
                </label>
              ))
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setMovePaper(null);
                setBatchMoveOpen(false);
              }}
            >
              取消
            </Button>
            <Button onClick={batchMoveOpen ? handleBatchMoveConfirm : handleMoveConfirm} disabled={moveSubmitting}>
              确定
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
