import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type PaperMetadata, normalizeAuthors } from "@/pages/paper-reader/paper-metadata";
import { updateBookStatus } from "@/services/book-service";
import { useAppSettingsStore } from "@/store/app-settings-store";
import type { PapersSortByType } from "@/types/settings";
import {
  type Folder,
  type FolderTreeNode,
  type PaperFolderEntry,
  buildFolderTree,
  createFolder,
  deleteFolder,
  getPaperFolderMap,
  importPapers,
  listFolders,
  listPapers,
  renameFolder,
  setPaperFolders,
  trashPaper,
  vectorizePaper,
} from "@/services/paper-service";
import { useLayoutStore } from "@/store/layout-store";
import type { BookWithStatus } from "@/types/simple-book";
import { listen } from "@tauri-apps/api/event";
import { appDataDir, join } from "@tauri-apps/api/path";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import clsx from "clsx";
import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  BookOpenText,
  ChevronRight,
  FileText,
  Folder as FolderIcon,
  FolderInput,
  FolderOpen,
  FolderPen,
  FolderPlus,
  Inbox,
  Languages,
  Library,
  Loader2,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Star,
  Trash2,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

/** 侧栏选中项：全部论文 / 未归档 / 某个文件夹 */
type Selection = { kind: "all" } | { kind: "unfiled" } | { kind: "folder"; id: string };

/** 文件夹名称对话框：新建（可带父节点）或重命名 */
type NameDialogState = { mode: "create"; parentId: string | null } | { mode: "rename"; id: string };

/** 向量化状态指示：与图书馆 book-item 同款圆环（绿=已向量化/红=失败/灰=未向量化；进行中为扇形环+百分比） */
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
  const label =
    statusFromMeta === "success" ? "已向量化" : statusFromMeta === "failed" ? "向量化失败" : "未向量化";
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
      <TooltipContent side="bottom">{rating > 0 ? `重要度 ${rating}/3 星（点击调整）` : "打星标记重要度（最多 3 星）"}</TooltipContent>
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

  /** folderId -> 直接成员数 */
  const folderCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const { folderId } of members) {
      map.set(folderId, (map.get(folderId) ?? 0) + 1);
    }
    return map;
  }, [members]);

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

  /** 列表行点击 = 打开论文标签页（阅读视图在标签页三段布局中，正文由 PaperReaderView 自行加载） */
  const handleOpen = (paper: BookWithStatus) => {
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

  // ---- 列表视图 ----
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between gap-4 px-4 pt-4 pb-3">
        <div className="flex items-baseline gap-3">
          <h1 className="font-bold text-2xl text-neutral-900 dark:text-neutral-100">文献库</h1>
          <span className="text-neutral-500 text-sm dark:text-neutral-400">共 {visiblePapers.length} 篇</span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => handleImport("选择包含多篇论文的父目录")} disabled={importing}>
            {importing ? <Loader2 className="size-4 animate-spin" /> : <FolderInput className="size-4" />}
            批量导入
          </Button>
          <Button onClick={() => handleImport("选择论文目录（含 paper.md）")} disabled={importing}>
            {importing ? <Loader2 className="size-4 animate-spin" /> : <FolderOpen className="size-4" />}
            {importing ? "正在导入..." : "导入论文目录"}
          </Button>
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
              <div className="relative min-w-0 flex-1">
                <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-neutral-400" />
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
                  <Button variant="ghost" size="icon" className="size-8 shrink-0" onClick={handleSortDirectionToggle}>
                    {sortAscending ? (
                      <ArrowUpNarrowWide className="size-4" />
                    ) : (
                      <ArrowDownWideNarrow className="size-4" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{sortAscending ? "升序（点击切换）" : "降序（点击切换）"}</TooltipContent>
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
              <div className="flex h-20 w-20 items-center justify-center rounded-3xl bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-blue-950/40 dark:to-indigo-900/30">
                <BookOpenText className="h-10 w-10 text-blue-500 dark:text-blue-400" />
              </div>
              <div className="max-w-lg space-y-3 text-center">
                <h2 className="font-bold text-neutral-900 text-xl dark:text-neutral-100">文献库还是空的</h2>
                <p className="text-muted-foreground text-sm leading-relaxed">
                  导入 Pandoc Markdown 论文目录（包含 paper.md 与
                  images/），即可入库管理并阅读。选择单个论文目录导入一篇，或选择其父目录批量导入。
                </p>
              </div>
              <Button onClick={() => handleImport("选择论文目录（含 paper.md）")} disabled={importing}>
                <FolderOpen className="size-4" />
                导入论文目录
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
                    <div
                      key={paper.id}
                      role="button"
                      tabIndex={0}
                      className="flex cursor-pointer items-start gap-3 rounded-xl border border-neutral-200 bg-white p-4 transition-colors hover:border-neutral-300 hover:bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-neutral-700 dark:hover:bg-neutral-800/60"
                      onClick={() => handleOpen(paper)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          handleOpen(paper);
                        }
                      }}
                    >
                      <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-neutral-100 dark:bg-neutral-800">
                        <FileText className="size-4 text-neutral-500 dark:text-neutral-400" />
                      </div>

                      <div className="min-w-0 flex-1">
                        <h3 className="line-clamp-2 font-semibold text-neutral-900 leading-snug dark:text-neutral-100">
                          {displayTitle}
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
                            {displayAbstract}
                          </p>
                        )}
                      </div>

                      {/* 右侧统一一行：打星 / 状态徽标 / 向量化圆环 ｜ 动作（向量化/移动/删除） */}
                      <div className="flex shrink-0 items-center gap-1">
                        <PaperStars rating={paper.status?.rating ?? 0} onRate={(rating) => handleRate(paper, rating)} />
                        <PaperStatusBadge status={paper.status} />
                        <VectorizationRing paper={paper} vectorizePercent={vectorizePercent} />
                        <div className="mx-1 h-4 w-px bg-neutral-200 dark:bg-neutral-700" />

                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              disabled={vectorizePercent != null}
                              className="size-8 text-neutral-400 hover:text-primary dark:text-neutral-500"
                              onClick={(event) => {
                                event.stopPropagation();
                                handleVectorize(paper);
                              }}
                            >
                              {vectorizePercent != null ? (
                                <Loader2 className="size-4 animate-spin" />
                              ) : (
                                <Sparkles className="size-4" />
                              )}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom">{isVectorized ? "重新向量化" : "向量化"}</TooltipContent>
                        </Tooltip>

                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8 text-neutral-400 hover:text-primary dark:text-neutral-500"
                              onClick={(event) => {
                                event.stopPropagation();
                                openMoveDialog(paper);
                              }}
                            >
                              <FolderPen className="size-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom">移动到…</TooltipContent>
                        </Tooltip>

                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8 text-neutral-400 hover:text-red-500 dark:text-neutral-500 dark:hover:text-red-400"
                              onClick={(event) => {
                                event.stopPropagation();
                                handleTrash(paper);
                              }}
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom">移到回收站</TooltipContent>
                        </Tooltip>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

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

      {/* 移动到文件夹对话框（回显当前成员关系，可多选——一篇论文可属多个文件夹） */}
      <Dialog
        open={movePaper != null}
        onOpenChange={(openState) => {
          if (!openState) setMovePaper(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>移动到文件夹</DialogTitle>
          </DialogHeader>
          <p className="px-4 pt-2 text-neutral-500 text-xs dark:text-neutral-400">
            《{movePaper?.title}》可同时属于多个文件夹；全部取消勾选则移出所有文件夹（进入"未归档"）
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
            <Button variant="outline" onClick={() => setMovePaper(null)}>
              取消
            </Button>
            <Button onClick={handleMoveConfirm} disabled={moveSubmitting}>
              确定
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
