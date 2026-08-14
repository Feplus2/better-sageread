import { getUtilityModel } from "@/ai/providers/factory";
import { InlineMathText } from "@/components/markdown/inline-math-text";
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
import { type PaperMetadata, normalizeAuthors, parsePaperMarkdown } from "@/pages/paper-reader/paper-metadata";
import { ZoteroImportDialog } from "@/pages/papers/zotero-import-dialog";
import { updateBookStatus } from "@/services/book-service";
import { reparsePapers } from "@/services/paper-reparse-service";
import {
  type Folder,
  type FolderTreeNode,
  type PaperFolderEntry,
  buildFolderTree,
  cancelPaperPdfImport,
  createFolder,
  deleteFolder,
  getPaperFolderMap,
  importPapers,
  listFolders,
  listPapers,
  paperEngineTokenError,
  renameFolder,
  setPaperFolders,
  trashPaper,
  vectorizePaper,
} from "@/services/paper-service";
import { translatePaper } from "@/services/paper-translation-service";
import { syncDownloadBook } from "@/services/sync-service";
import { useAppSettingsStore } from "@/store/app-settings-store";
import { setPaperImportRefresh, startPaperImportBatch, useConvertProgressStore } from "@/store/convert-progress-store";
import { useConverterStore } from "@/store/converter-store";
import { useLayoutStore } from "@/store/layout-store";
import type { PapersSortByType } from "@/types/settings";
import type { BookWithStatus } from "@/types/simple-book";
import { findDegenerateLoop } from "@/utils/degenerate";
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
}

/** 文献库：MARKDOWN 论文的管理页（列表 + 文件夹侧栏，§3.2 文件夹模型）；点击论文行打开阅读标签页 */
export default function PapersPage() {
  const [papers, setPapers] = useState<BookWithStatus[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [members, setMembers] = useState<PaperFolderEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [metaMap, setMetaMap] = useState<Record<string, PaperMetadata>>({});
  const openPaper = useLayoutStore((state) => state.openPaper);
  // 检索关键词（列表工具栏；排序与元数据语言持久化在 app-settings）
  const [searchQuery, setSearchQuery] = useState("");
  const { settings, setSettings } = useAppSettingsStore();
  const sortBy: PapersSortByType = settings.papersSortBy ?? "updated";
  const sortAscending = settings.papersSortAscending ?? false;
  const metaLang = settings.papersMetaLang ?? "original";
  // 向量化进行中：paper_id -> 进度百分比（0-100）
  const [vectorizing, setVectorizing] = useState<Record<string, number>>({});
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
  // 队列与进度卡状态在 convert-progress-store（全局右下角卡，跨页面持续呈现）
  const [pdfPickerOpen, setPdfPickerOpen] = useState(false);
  const [pdfCandidates, setPdfCandidates] = useState<string[]>([]);
  const [pdfDragOver, setPdfDragOver] = useState(false);
  const paperImportRunning = useConvertProgressStore((s) => s.paperImport?.status === "running");
  // Zotero 批量导入对话框（批量运行中禁用其他导入入口）
  const [zoteroOpen, setZoteroOpen] = useState(false);
  const [zoteroRunning, setZoteroRunning] = useState(false);
  // 批量管理：管理模式开关（点「管理」才出现复选框）/ 多选集合 / 批量移动对话框 / 批量任务守卫与进度卡
  const [manageMode, setManageMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchMoveOpen, setBatchMoveOpen] = useState(false);
  const [batchRunning, setBatchRunning] = useState<BatchKind | null>(null);
  const [batchProgress, setBatchProgress] = useState<BatchProgressState | null>(null);
  const [batchCancelling, setBatchCancelling] = useState(false);
  const batchCancelRef = useRef(false);
  const batchTranslateAbortRef = useRef<AbortController | null>(null);
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

  // 批量任务卡同款收尾：干净成功 6 秒自动消失，有失败/取消保留待手动关闭
  useEffect(() => {
    if (batchProgress?.status !== "success") return;
    if (batchProgress.failedCount > 0) return;
    const timer = setTimeout(() => setBatchProgress(null), 6000);
    return () => clearTimeout(timer);
  }, [batchProgress?.status, batchProgress?.failedCount]);

  // metadata.json 缓存：入库后内容不可变，避免每次刷新列表都重读磁盘
  const metaCacheRef = useRef<Map<string, PaperMetadata>>(new Map());

  // 向量化进度事件（payload 形状对齐 epub://index-progress，id 字段为 paper_id）
  useEffect(() => {
    const unlisten = listen<{ paper_id: string; percent: number }>("paper://index-progress", (e) => {
      const p = e.payload;
      if (!p) return;
      setVectorizing((prev) =>
        p.paper_id in prev ? { ...prev, [p.paper_id]: Math.max(0, Math.min(100, Math.round(p.percent))) } : prev,
      );
    });
    return () => {
      unlisten.then((off) => off());
    };
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
    } catch (error) {
      console.error("加载文献库失败:", error);
      toast.error("加载文献库失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // 批量解析结算后的列表刷新回调（注册给全局队列；本页不在场时跳过，重进自会加载）
  // loadAll 经 ref 间接引用：注册一次，刷新函数始终取最新
  const loadAllRef = useRef(loadAll);
  loadAllRef.current = loadAll;
  useEffect(() => {
    setPaperImportRefresh(() => {
      void loadAllRef.current();
    });
    return () => setPaperImportRefresh(null);
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
    // 批量任务守卫（旧 runPdfImportBatch 行为）：重解析与解析共用 Rust 单子进程，并发互踩
    if (batchRunning != null) {
      toast.info("已有批量任务进行中");
      return;
    }
    // 全局队列（convert-progress-store）：进度卡跨页面呈现，folderId 在启动时定格
    void startPaperImportBatch(paths, selectionRef.current.kind === "folder" ? selectionRef.current.id : undefined);
  };

  /** 开始解析：关闭选择弹窗，候选列表转入后台串行队列（全局右下角进度卡），完成时 toast 提醒 */
  const handleStartPdfImport = async () => {
    if (pdfCandidates.length === 0) return;
    if (batchRunning != null) {
      toast.info("已有批量任务进行中");
      return;
    }
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
    setVectorizing((prev) => ({ ...prev, [paper.id]: 0 }));
    try {
      const res = await vectorizePaper({ id: paper.id, title: paper.title, author: paper.author });
      toast.success(`《${paper.title}》向量化完成，分块数：${res.report?.total_chunks ?? "未知"}`);
    } catch (error) {
      console.error("向量化论文失败:", error);
      toast.error(`向量化失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setVectorizing((prev) => {
        const next = { ...prev };
        delete next[paper.id];
        return next;
      });
      // 成功/失败都刷新列表，让向量化徽标落为最新状态
      await loadAll();
    }
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
  const batchLocked = batchRunning != null || importing || paperImportRunning || zoteroRunning;

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
    if (batchRunning || selectedPapers.length === 0) return;
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
  const finishBatch = (summary: string, failedNames: string[], cancelled: boolean) => {
    setBatchProgress((prev) =>
      prev
        ? {
            ...prev,
            status: cancelled || failedNames.length > 0 ? "error" : "success",
            percent: 100,
            summary,
            failedNames,
            failedCount: failedNames.length,
          }
        : prev,
    );
    setBatchCancelling(false);
    setSelectedIds(new Set());
  };

  /** 批量向量化：跳过已成功的，逐篇顺序执行；进度复用 vectorizing map（行内圆环同步展示） */
  const handleBatchVectorize = async () => {
    if (batchLocked || selectedPapers.length === 0) return;
    const { useLlamaStore } = await import("@/store/llama-store");
    if (!useLlamaStore.getState().hasVectorCapability()) {
      toast.error("没有可用的嵌入模型，请先在设置中下载本地嵌入模型或配置外部嵌入服务");
      return;
    }
    const queue = selectedPapers.filter((p) => p.status?.metadata?.vectorization?.status !== "success");
    const skippedCount = selectedPapers.length - queue.length;
    if (queue.length === 0) {
      toast.info("所选论文均已完成向量化");
      return;
    }
    batchCancelRef.current = false;
    setBatchCancelling(false);
    setBatchRunning("vectorize");
    const total = queue.length;
    let done = 0;
    const failedNames: string[] = [];
    setBatchProgress({
      kind: "vectorize",
      status: "running",
      index: 0,
      total,
      title: "",
      detail: "准备向量化…",
      percent: 0,
      doneCount: 0,
      failedCount: 0,
      skippedCount,
      failedNames: [],
    });
    try {
      for (let i = 0; i < total; i++) {
        if (batchCancelRef.current) break;
        const paper = queue[i];
        setBatchProgress((prev) =>
          prev
            ? { ...prev, index: i, title: paper.title, detail: "向量化中…", percent: Math.round((i / total) * 100) }
            : prev,
        );
        setVectorizing((prev) => ({ ...prev, [paper.id]: 0 }));
        try {
          await vectorizePaper({ id: paper.id, title: paper.title, author: paper.author });
          done += 1;
        } catch (error) {
          failedNames.push(paper.title);
          console.error(`向量化论文失败: ${paper.id}`, error);
        } finally {
          setVectorizing((prev) => {
            const next = { ...prev };
            delete next[paper.id];
            return next;
          });
          setBatchProgress((prev) =>
            prev ? { ...prev, doneCount: done, failedCount: failedNames.length, failedNames: [...failedNames] } : prev,
          );
        }
      }
    } finally {
      setBatchRunning(null);
    }
    const cancelled = batchCancelRef.current;
    const remaining = total - done - failedNames.length;
    finishBatch(
      cancelled
        ? `已取消：完成 ${done} · 失败 ${failedNames.length}，剩余 ${remaining} 篇未处理`
        : `完成 ${done} 篇${failedNames.length > 0 ? ` · 失败 ${failedNames.length}` : ""}${skippedCount > 0 ? ` · 跳过已向量化 ${skippedCount}` : ""}`,
      failedNames,
      cancelled,
    );
    await loadAll();
  };

  /** 批量翻译：复用单篇入口 translatePaper（幂等续翻），逐篇顺序执行，AbortController 可取消 */
  const handleBatchTranslate = async (papers?: BookWithStatus[]) => {
    const queue = papers ?? selectedPapers;
    if (batchLocked || queue.length === 0) return;
    if (!getUtilityModel()) {
      toast.error("未配置 AI 模型：请先在设置中配置辅助模型（或聊天模型）后再翻译");
      return;
    }
    batchCancelRef.current = false;
    setBatchCancelling(false);
    const controller = new AbortController();
    batchTranslateAbortRef.current = controller;
    setBatchRunning("translate");
    const total = queue.length;
    let done = 0;
    const failedNames: string[] = [];
    let cancelled = false;
    const base = await appDataDir();
    setBatchProgress({
      kind: "translate",
      status: "running",
      index: 0,
      total,
      title: "",
      detail: "准备翻译…",
      percent: 0,
      doneCount: 0,
      failedCount: 0,
      skippedCount: 0,
      failedNames: [],
    });
    try {
      for (let i = 0; i < total; i++) {
        if (batchCancelRef.current) break;
        const paper = queue[i];
        setBatchProgress((prev) =>
          prev
            ? { ...prev, index: i, title: paper.title, detail: "读取正文…", percent: Math.round((i / total) * 100) }
            : prev,
        );
        try {
          const markdown = await readTextFile(await join(base, "books", paper.id, "paper.md"));
          const result = await translatePaper({
            paperId: paper.id,
            markdown,
            force: false,
            signal: controller.signal,
            onProgress: ({ done: d, total: t }) =>
              setBatchProgress((prev) =>
                prev
                  ? {
                      ...prev,
                      detail: t > 0 ? `翻译块 ${d}/${t}` : prev.detail,
                      percent: Math.round(((i + (t > 0 ? d / t : 0)) / total) * 100),
                    }
                  : prev,
              ),
          });
          if (result.cancelled) {
            cancelled = true;
            break;
          }
          done += 1;
          // 元数据译文（title_zh/abstract_zh）写入 metadata.json，清缓存让列表中文化立即生效
          metaCacheRef.current.delete(paper.id);
        } catch (error) {
          if (controller.signal.aborted || batchCancelRef.current) {
            cancelled = true;
            break;
          }
          failedNames.push(paper.title);
          console.error(`翻译论文失败: ${paper.id}`, error);
        }
        setBatchProgress((prev) =>
          prev ? { ...prev, doneCount: done, failedCount: failedNames.length, failedNames: [...failedNames] } : prev,
        );
      }
    } finally {
      batchTranslateAbortRef.current = null;
      setBatchRunning(null);
    }
    const remaining = total - done - failedNames.length;
    finishBatch(
      cancelled
        ? `已取消：完成 ${done} · 失败 ${failedNames.length}，剩余 ${remaining} 篇未处理（已翻部分已落盘，可续翻）`
        : `完成 ${done} 篇${failedNames.length > 0 ? ` · 失败 ${failedNames.length}` : ""}`,
      failedNames,
      cancelled,
    );
    await loadAll();
  };

  /** 批量重新解析：源 PDF 重走 Papers_Converter 并整体替换产物（保留 id/归属/对话/标注，高亮可能漂移） */
  const handleBatchReparse = async (papers?: BookWithStatus[]) => {
    const queue = papers ?? selectedPapers;
    if (batchLocked || queue.length === 0) return;
    const tokenError = paperEngineTokenError(paperEngine);
    if (tokenError) {
      toast.error(tokenError);
      return;
    }
    let confirmed = false;
    try {
      confirmed = await ask(
        `将用最新解析引擎重新解析选中的 ${queue.length} 篇论文的源 PDF 并替换现有解析产物。\n\n文件夹归属、对话与标注保留，但文内高亮可能因正文变化漂移。`,
        { title: queue.length > 1 ? "批量重新解析" : "重新解析", kind: "warning" },
      );
    } catch (error) {
      console.error("确认对话框失败:", error);
    }
    if (!confirmed) return;
    batchCancelRef.current = false;
    setBatchCancelling(false);
    setBatchRunning("reparse");
    const total = queue.length;
    let filePercent = 0;
    setBatchProgress({
      kind: "reparse",
      status: "running",
      index: 0,
      total,
      title: "",
      detail: "准备解析…",
      percent: 0,
      doneCount: 0,
      failedCount: 0,
      skippedCount: 0,
      failedNames: [],
    });
    let cancelled = false;
    const failedNames: string[] = [];
    let done = 0;
    let suspectCount = 0;
    try {
      const report = await reparsePapers(
        queue.map((p) => ({ id: p.id, title: p.title })),
        metaMap,
        {
          onItemStart: (index, _total, item) => {
            filePercent = 0;
            setBatchProgress((prev) =>
              prev
                ? {
                    ...prev,
                    index,
                    title: item.title,
                    detail: "等待解析…",
                    percent: Math.round((index / prev.total) * 100),
                  }
                : prev,
            );
          },
          onItemProgress: (p) => {
            if (p.percent != null) filePercent = p.percent;
            setBatchProgress((prev) =>
              prev
                ? {
                    ...prev,
                    detail: p.detail ?? p.stage_name ?? prev.detail,
                    percent: Math.min(100, Math.round(((prev.index + filePercent / 100) / prev.total) * 100)),
                  }
                : prev,
            );
          },
          isCancelled: () => batchCancelRef.current,
        },
      );
      cancelled = report.cancelled;
      done = report.done.length;
      failedNames.push(...report.failed.map((f) => f.title));
      suspectCount = report.suspect.length;
      for (const item of report.done) metaCacheRef.current.delete(item.id);
    } catch (error) {
      console.error("批量重新解析失败:", error);
      failedNames.push(...queue.slice(done).map((p) => p.title));
    } finally {
      setBatchRunning(null);
    }
    const remaining = total - done - failedNames.length;
    const suspectNote = suspectCount > 0 ? `；${suspectCount} 篇仍疑似解析异常（建议换引擎再试）` : "";
    finishBatch(
      cancelled
        ? `已取消：完成 ${done} · 失败 ${failedNames.length}，剩余 ${remaining} 篇未处理${suspectNote}`
        : `完成 ${done} 篇${failedNames.length > 0 ? ` · 失败 ${failedNames.length}` : ""}${suspectNote}`,
      failedNames,
      cancelled,
    );
    await loadAll();
  };

  /** 批量任务取消：向量化当前篇跑完即停；翻译 abort；重新解析 kill 当前篇子进程（terminated 事件结算） */
  const handleCancelBatch = () => {
    batchCancelRef.current = true;
    setBatchCancelling(true);
    setBatchProgress((prev) => (prev ? { ...prev, detail: "正在取消…" } : prev));
    if (batchRunning === "translate") batchTranslateAbortRef.current?.abort();
    if (batchRunning === "reparse") cancelPaperPdfImport().catch(() => {});
  };

  /** 关闭批量进度卡（running 时等同取消） */
  const handleDismissBatchProgress = () => {
    if (batchProgress?.status === "running") {
      handleCancelBatch();
      return;
    }
    setBatchProgress(null);
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
          <Button onClick={handleImportPdf} disabled={importing || paperImportRunning || batchRunning != null}>
            <FileDown className="size-4" />
            导入 PDF
          </Button>
          <Button
            variant="outline"
            onClick={() => setZoteroOpen(true)}
            disabled={importing || paperImportRunning || zoteroRunning || batchRunning != null}
          >
            {zoteroRunning ? <Loader2 className="size-4 animate-spin" /> : <Library className="size-4" />}
            Zotero 导入
          </Button>
          {/* 高级导入：面向开发者/转换器用户——期望的是 Papers_Converter 产物目录（含 paper.md 与 images/） */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" disabled={importing || batchRunning != null}>
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
                <>
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
                    disabled={batchRunning != null || selectedIds.size === 0}
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
                    disabled={batchLocked || selectedIds.size === 0}
                    onClick={handleBatchVectorize}
                  >
                    <Sparkles className="size-4" />
                    向量化
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 shrink-0"
                    disabled={batchLocked || selectedIds.size === 0}
                    onClick={handleBatchTranslate}
                  >
                    <Languages className="size-4" />
                    翻译
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 shrink-0"
                    disabled={batchLocked || selectedIds.size === 0}
                    onClick={handleBatchReparse}
                  >
                    <RefreshCw className="size-4" />
                    重新解析
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 shrink-0 text-red-500 hover:text-red-600 dark:hover:text-red-400"
                    disabled={batchRunning != null || selectedIds.size === 0}
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
                </>
              ) : (
                <>
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
                </>
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
              <Button onClick={handleImportPdf} disabled={importing || paperImportRunning || batchRunning != null}>
                <FileDown className="size-4" />
                导入 PDF
              </Button>
              <Button
                variant="outline"
                onClick={() => setZoteroOpen(true)}
                disabled={importing || paperImportRunning || zoteroRunning || batchRunning != null}
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
                              className="mt-0.5 flex h-9 shrink-0 items-center"
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
                        <ContextMenuItem disabled={batchLocked} onClick={() => void handleBatchTranslate([paper])}>
                          <Languages className="mr-2 size-4" />
                          翻译
                        </ContextMenuItem>
                        <ContextMenuItem disabled={batchLocked} onClick={() => void handleBatchReparse([paper])}>
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

      {/* 批量任务进度卡（右下角浮层，样式对齐解析卡/Zotero 卡；running 时关闭即取消） */}
      {batchProgress && (
        <div className="absolute right-4 bottom-4 z-40 w-80 rounded-xl border bg-background p-3.5 shadow-lg">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="min-w-0 flex-1 truncate font-medium text-sm">{BATCH_KIND_LABELS[batchProgress.kind]}</span>
            <span className="shrink-0 text-muted-foreground text-xs">
              {Math.min(batchProgress.index + 1, batchProgress.total)}/{batchProgress.total}
            </span>
            <button
              type="button"
              className="shrink-0 rounded p-0.5 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
              onClick={handleDismissBatchProgress}
            >
              <X className="size-3.5" />
            </button>
          </div>

          {batchProgress.status === "running" ? (
            <>
              <Progress value={batchProgress.percent} className="h-1.5" />
              <div className="mt-2 flex items-center justify-between gap-2 text-muted-foreground text-xs">
                <span className="min-w-0 flex-1 truncate">
                  {batchProgress.title ? `《${batchProgress.title}》 ` : ""}
                  {batchProgress.detail}
                </span>
                <span className="shrink-0">{batchProgress.percent}%</span>
              </div>
              <div className="mt-2.5 flex items-center justify-between gap-2">
                <span className="text-muted-foreground text-xs">
                  完成 {batchProgress.doneCount}
                  {batchProgress.failedCount > 0 ? ` · 失败 ${batchProgress.failedCount}` : ""}
                  {batchProgress.skippedCount > 0 ? ` · 跳过 ${batchProgress.skippedCount}` : ""}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2.5 text-xs"
                  onClick={handleCancelBatch}
                  disabled={batchCancelling}
                >
                  {batchCancelling ? "正在取消…" : "取消"}
                </Button>
              </div>
            </>
          ) : (
            <>
              <p
                className={clsx(
                  "text-xs",
                  batchProgress.status === "success"
                    ? "text-green-600 dark:text-green-400"
                    : "text-red-600 dark:text-red-400",
                )}
              >
                {batchProgress.summary}
              </p>
              {batchProgress.failedNames.length > 0 && (
                <ul className="mt-1 space-y-0.5 text-red-600 text-xs dark:text-red-400">
                  {batchProgress.failedNames.map((name) => (
                    <li key={name} className="truncate" title={name}>
                      {name}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}

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
