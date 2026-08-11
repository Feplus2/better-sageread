import { Markdown } from "@/components/prompt-kit/markdown";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { exportNoteToMarkdown, exportNotesToMarkdownFiles } from "@/lib/export-notes-markdown";
import { applyCompositionPairing, applyPairedPunctuation } from "@/lib/pair-punctuation";
import { NOTES_CHANGED_EVENT, createNote, deleteNote, getNotes, updateNote } from "@/services/note-service";
import type { Note, NoteLocation, NoteTocItem } from "@/types/note";
import { ask } from "@tauri-apps/plugin-dialog";
import dayjs from "dayjs";
import { Check, ChevronLeft, Download, ListChecks, ListTree, Loader2, MapPin, Plus, Star, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

/** 展示用文本折叠（Markdown 原文含换行/语法标记，只作预览） */
const collapseWs = (text: string) => text.replace(/\s+/g, " ").trim();

const AUTOSAVE_DELAY = 800;

interface NoteCardProps {
  note: Note;
  selectionMode: boolean;
  selected: boolean;
  onOpen: () => void;
  onToggleSelect: () => void;
  onToggleStar: () => void;
  onDelete: () => void;
  onExport: () => void;
  onLocate: () => void;
}

/** 笔记卡片：标题 + 正文摘要 + 位置 chip + 更新时间 + 星标；点卡片进编辑态，点 chip 跳正文，右键导出/删除 */
function NoteCard({
  note,
  selectionMode,
  selected,
  onOpen,
  onToggleSelect,
  onToggleStar,
  onDelete,
  onExport,
  onLocate,
}: NoteCardProps) {
  const handleDelete = async () => {
    try {
      const confirmed = await ask(
        `确定要删除这条笔记吗？\n\n"${note.title || collapseWs(note.content).slice(0, 50) || "无标题"}"\n\n此操作无法撤销。`,
        { title: "确认删除", kind: "warning" },
      );
      if (confirmed) onDelete();
    } catch (error) {
      console.error("删除笔记失败:", error);
    }
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className="group cursor-pointer rounded-lg bg-muted p-2 transition-colors hover:bg-neutral-200/60 dark:bg-neutral-900 dark:hover:bg-neutral-800"
          onClick={selectionMode ? onToggleSelect : onOpen}
        >
          <div className="flex items-start gap-2">
            {/* 多选模式：整行点击切换勾选（样式同标注多选） */}
            {selectionMode && (
              <span
                className={`flex size-4 flex-shrink-0 items-center justify-center self-center rounded border transition-colors ${
                  selected ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/50"
                }`}
              >
                {selected && <Check size={12} />}
              </span>
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-sm">{note.title || "无标题笔记"}</div>
              {note.content.trim() && (
                <div className="mt-0.5 line-clamp-2 text-neutral-500 text-xs leading-relaxed dark:text-neutral-400">
                  {collapseWs(note.content).slice(0, 120)}
                </div>
              )}
              <div className="mt-1.5 flex items-center gap-2 text-neutral-500 text-xs dark:text-neutral-500">
                {note.locationTag && !selectionMode && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        role="button"
                        tabIndex={-1}
                        className="flex max-w-[10rem] cursor-pointer items-center gap-0.5 truncate rounded bg-primary/10 px-1 py-0.5 text-primary hover:bg-primary/20"
                        onClick={(e) => {
                          e.stopPropagation();
                          onLocate();
                        }}
                      >
                        <MapPin className="size-3 shrink-0" />
                        <span className="truncate">{note.locationTag}</span>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">跳转到：{note.locationTag}</TooltipContent>
                  </Tooltip>
                )}
                {note.locationTag && selectionMode && (
                  <span className="flex max-w-[10rem] items-center gap-0.5 truncate rounded bg-primary/10 px-1 py-0.5 text-primary">
                    <MapPin className="size-3 shrink-0" />
                    <span className="truncate">{note.locationTag}</span>
                  </span>
                )}
                <span className="shrink-0">{dayjs(note.updatedAt).format("MM-DD HH:mm")}</span>
                {/* 星标切换（样式同标注列表；stopPropagation 不进编辑态/勾选） */}
                <span
                  role="button"
                  tabIndex={-1}
                  className={`ml-auto flex-shrink-0 cursor-pointer opacity-40 transition-opacity hover:opacity-100 group-hover:opacity-70 ${
                    note.starred ? "opacity-100" : ""
                  }`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleStar();
                  }}
                >
                  <Star
                    className={`size-3.5 ${note.starred ? "fill-amber-400 text-amber-400" : "text-muted-foreground"}`}
                  />
                </span>
              </div>
            </div>
          </div>
        </div>
      </ContextMenuTrigger>
      {!selectionMode && (
        <ContextMenuContent>
          <ContextMenuItem onClick={onExport}>导出为 Markdown</ContextMenuItem>
          <ContextMenuItem variant="destructive" onClick={() => handleDelete()}>
            删除
          </ContextMenuItem>
        </ContextMenuContent>
      )}
    </ContextMenu>
  );
}

/** 编辑器草稿（位置三件套：TOC 选择器同时写 cfi/block 保持锚点精确；手改 tag 不动锚点） */
interface NoteDraft {
  title: string;
  content: string;
  locationTag: string;
  locationCfi: string | null;
  locationBlock: number | null;
}

interface NoteEditorProps {
  note: Note;
  /** 章节清单（位置选择器数据源；空数组时隐藏选择器按钮，仅手输） */
  tocItems: NoteTocItem[];
  /** 自动保存（debounce 在外层实现）：落库并回写最新行 */
  onSave: (id: string, draft: NoteDraft) => Promise<void>;
  onBack: () => void;
}

/**
 * 编辑态（侧栏内子视图，不扩宽）：返回 + 标题 + 位置 tag（可手输/可从 TOC 选）+
 * 编辑|预览 切换（同一板块互换，Typora 式源码/预览二态，非上下堆叠）。
 * 改动 800ms debounce 自动保存，卸载兜底 flush；textarea 挂了标点自动配对。
 */
function NoteEditor({ note, tocItems, onSave, onBack }: NoteEditorProps) {
  const [title, setTitle] = useState(note.title);
  const [content, setContent] = useState(note.content);
  const [locationTag, setLocationTag] = useState(note.locationTag ?? "");
  const [locationCfi, setLocationCfi] = useState<string | null>(note.locationCfi);
  const [locationBlock, setLocationBlock] = useState<number | null>(note.locationBlock);
  const [saving, setSaving] = useState<"idle" | "pending" | "saving">("idle");
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  // TOC 位置选择器
  const [tocOpen, setTocOpen] = useState(false);
  const [tocFilter, setTocFilter] = useState("");
  const filteredTocItems = useMemo(() => {
    const q = tocFilter.trim().toLowerCase();
    return q ? tocItems.filter((t) => t.tag.toLowerCase().includes(q)) : tocItems;
  }, [tocItems, tocFilter]);
  const timerRef = useRef<number | null>(null);
  // 最新草稿 ref：卸载/返回时兜底 flush，避免防抖窗口内丢字
  const draftRef = useRef<NoteDraft>({ title, content, locationTag, locationCfi, locationBlock });
  draftRef.current = { title, content, locationTag, locationCfi, locationBlock };
  const dirtyRef = useRef(false);

  // 标点自动配对（原生 beforeinput；IME 提交的全角符号也覆盖，见 pair-punctuation.ts）
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const contentRef = useRef(content);
  contentRef.current = content;
  useEffect(() => {
    if (mode !== "edit") return; // 预览态 textarea 未挂载
    const ta = textareaRef.current;
    if (!ta) return;
    const handler = (e: Event) => {
      applyPairedPunctuation(e as InputEvent, ta, contentRef.current, setContent);
    };
    const compHandler = () => {
      applyCompositionPairing(ta, setContent);
    };
    ta.addEventListener("beforeinput", handler);
    ta.addEventListener("compositionend", compHandler);
    return () => {
      ta.removeEventListener("beforeinput", handler);
      ta.removeEventListener("compositionend", compHandler);
    };
  }, [mode]);

  const flush = useCallback(async () => {
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    setSaving("saving");
    try {
      await onSave(note.id, draftRef.current);
    } finally {
      setSaving("idle");
    }
  }, [note.id, onSave]);

  // 内容变化 → debounce 自动保存
  // biome-ignore lint/correctness/useExhaustiveDependencies: 各草稿字段是变化侦测信号（正文只走 ref 草稿），必须列全
  useEffect(() => {
    dirtyRef.current = true;
    setSaving("pending");
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void flush();
    }, AUTOSAVE_DELAY);
  }, [title, content, locationTag, locationCfi, locationBlock, flush]);

  // 卸载兜底（返回列表/切 tab/关面板）：有未保存改动立即 flush
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在卸载时跑一次（onSave/note.id 经 ref 化草稿兜底，不依赖最新值）
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      if (dirtyRef.current) void onSave(note.id, draftRef.current);
    };
  }, []);

  const modePill = (active: boolean) =>
    `rounded-full px-2.5 py-0.5 text-xs transition-colors ${
      active
        ? "bg-background font-medium text-foreground shadow-sm dark:bg-neutral-700"
        : "text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
    }`;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-1 border-neutral-200 border-b px-2 py-1.5 dark:border-neutral-700">
        <button
          type="button"
          onClick={onBack}
          className="flex size-7 items-center justify-center rounded-full hover:bg-accent dark:hover:bg-accent"
          title="返回列表"
        >
          <ChevronLeft className="size-4 text-neutral-500 dark:text-neutral-400" />
        </button>
        <span className="text-neutral-400 text-xs dark:text-neutral-500">
          {saving === "idle" ? "已自动保存" : saving === "pending" ? "编辑中…" : "保存中…"}
        </span>
        {/* 编辑|预览 切换（同一板块互换） */}
        <div className="ml-auto flex items-center rounded-full bg-muted p-0.5 dark:bg-neutral-800">
          <button type="button" onClick={() => setMode("edit")} className={modePill(mode === "edit")}>
            编辑
          </button>
          <button type="button" onClick={() => setMode("preview")} className={modePill(mode === "preview")}>
            预览
          </button>
        </div>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto p-2">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="笔记标题（可选）"
          className="w-full rounded-md bg-muted px-2 py-1.5 font-medium text-sm outline-none placeholder:text-neutral-400 focus:ring-1 focus:ring-primary/50 dark:bg-neutral-900"
        />
        <div className="flex items-center gap-1 text-neutral-500 text-xs dark:text-neutral-400">
          <MapPin className="size-3 shrink-0" />
          <input
            value={locationTag}
            onChange={(e) => setLocationTag(e.target.value)}
            placeholder="位置标签（创建时自动捕获，可修改）"
            className="w-full rounded bg-muted px-1.5 py-1 outline-none placeholder:text-neutral-400 focus:ring-1 focus:ring-primary/50 dark:bg-neutral-900"
          />
          {/* 从目录选择位置：同时写入精确锚点（cfi/block），比手输文本更可靠。
              Popover + 轻量 div 列表（Radix MenuItem 数百条时打开卡顿）；层级按 depth 缩进，顶部可过滤 */}
          {tocItems.length > 0 && (
            <Popover open={tocOpen} onOpenChange={setTocOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  title="从目录选择章节位置"
                  className="flex size-6 shrink-0 items-center justify-center rounded hover:bg-accent dark:hover:bg-accent"
                >
                  <ListTree className="size-3.5" />
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-72 p-1.5">
                <input
                  value={tocFilter}
                  onChange={(e) => setTocFilter(e.target.value)}
                  placeholder="过滤章节…"
                  autoFocus
                  className="mb-1 w-full rounded bg-muted px-2 py-1 text-xs outline-none placeholder:text-neutral-400 focus:ring-1 focus:ring-primary/50 dark:bg-neutral-900"
                />
                <div className="max-h-64 overflow-y-auto">
                  {filteredTocItems.length === 0 ? (
                    <p className="px-2 py-3 text-center text-neutral-400 text-xs">无匹配章节</p>
                  ) : (
                    filteredTocItems.map((item, index) => (
                      <button
                        type="button"
                        key={`${item.cfi ?? item.tag}-${index}`}
                        onClick={() => {
                          setLocationTag(item.tag);
                          setLocationCfi(item.cfi);
                          setLocationBlock(item.block);
                          setTocOpen(false);
                          setTocFilter("");
                        }}
                        className="block w-full truncate rounded px-2 py-1 text-left text-neutral-700 text-xs hover:bg-accent dark:text-neutral-300"
                        style={{ paddingLeft: `${item.depth * 12 + 8}px` }}
                        title={item.tag}
                      >
                        {item.tag}
                      </button>
                    ))
                  )}
                </div>
              </PopoverContent>
            </Popover>
          )}
        </div>

        {/* 编辑/预览同一板块：编辑 = 等宽 textarea（标点配对已挂）；预览 = react-markdown + KaTeX 渲染 */}
        {mode === "edit" ? (
          <Textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="用 Markdown 写笔记…"
            className="min-h-[45vh] flex-1 resize-none bg-muted font-mono text-sm leading-relaxed dark:bg-neutral-900"
            autoFocus
          />
        ) : (
          <div className="min-h-[45vh] rounded-lg bg-muted px-3 py-2 dark:bg-neutral-900">
            {content.trim() ? (
              <Markdown className="prose prose-neutral dark:prose-invert prose-headings:my-2 prose-p:my-1.5 max-w-none prose-table:text-xs text-sm leading-relaxed">
                {content}
              </Markdown>
            ) : (
              <p className="text-neutral-400 text-xs dark:text-neutral-500">暂无内容</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export interface NotesTabProps {
  bookId: string;
  /** 书籍/论文标题（导出 frontmatter 用） */
  bookTitle: string;
  /** 新建时捕获的当前阅读位置（论文 = heading；书籍 = 章节，父组件装配；阅读位置未知为 null） */
  currentLocation: NoteLocation | null;
  /** 章节清单（位置选择器数据源；论文 = TOC headings，书籍 = book.toc 拍平） */
  tocItems: NoteTocItem[];
  /** 点击位置 chip → 正文跳转（父组件实现 精确锚点 → 文本兜底 → 顶部+toast 的降级链） */
  onLocate: (note: Note) => void;
}

/**
 * 「笔记」tab（论文/书籍共用）：列表态（卡片 + 新建 + 星标 + 右键导出/删除）
 * ↔ 编辑态（编辑|预览切换 + 自动保存 + TOC 位置选择器）↔ 管理态（多选/全选 → 批量逐篇导出/删除）。
 */
export function NotesTab({ bookId, bookTitle, currentLocation, tocItems, onLocate }: NotesTabProps) {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  // 管理态（多选批量操作）
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isBatchOperating, setIsBatchOperating] = useState(false);

  const reload = useCallback(async () => {
    try {
      setNotes(await getNotes(bookId));
    } catch (error) {
      console.error("加载笔记失败:", error);
      toast.error("加载笔记失败");
      setNotes([]);
    }
  }, [bookId]);

  useEffect(() => {
    setEditingId(null);
    setSelectionMode(false);
    setSelectedIds(new Set());
    void reload();
  }, [reload]);

  // 外部写入实时刷新（聊天区「存为笔记」/ manageNotes 工具）：监听变更广播，按 bookId 过滤
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ bookId?: string }>).detail;
      if (detail?.bookId === bookId) void reload();
    };
    window.addEventListener(NOTES_CHANGED_EVENT, handler);
    return () => window.removeEventListener(NOTES_CHANGED_EVENT, handler);
  }, [bookId, reload]);

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

  const allSelected = (notes?.length ?? 0) > 0 && (notes ?? []).every((n) => selectedIds.has(n.id));

  const handleSelectAll = useCallback(() => {
    setSelectedIds(allSelected ? new Set() : new Set((notes ?? []).map((n) => n.id)));
  }, [allSelected, notes]);

  const handleCreate = async () => {
    try {
      const note = await createNote({
        bookId,
        locationTag: currentLocation?.tag ?? null,
        locationBlock: currentLocation?.block ?? null,
        locationCfi: currentLocation?.cfi ?? null,
      });
      await reload();
      setEditingId(note.id);
    } catch (error) {
      console.error("创建笔记失败:", error);
      toast.error("创建笔记失败");
    }
  };

  const handleSave = useCallback(async (id: string, draft: NoteDraft) => {
    try {
      await updateNote(id, {
        title: draft.title.trim(),
        content: draft.content,
        locationTag: draft.locationTag.trim() || null,
        locationCfi: draft.locationCfi,
        locationBlock: draft.locationBlock,
      });
      // 位置/星标不参与排序重排前的轻更新：只回写该行，避免编辑中列表跳动
      setNotes((prev) =>
        prev
          ? prev.map((n) =>
              n.id === id
                ? {
                    ...n,
                    title: draft.title.trim(),
                    content: draft.content,
                    locationTag: draft.locationTag.trim() || null,
                    locationCfi: draft.locationCfi,
                    locationBlock: draft.locationBlock,
                    updatedAt: Date.now(),
                  }
                : n,
            )
          : prev,
      );
    } catch (error) {
      console.error("保存笔记失败:", error);
      toast.error("保存笔记失败");
    }
  }, []);

  const handleToggleStar = async (note: Note) => {
    // 乐观更新，失败回滚
    setNotes((prev) => (prev ? prev.map((n) => (n.id === note.id ? { ...n, starred: !n.starred } : n)) : prev));
    try {
      await updateNote(note.id, { starred: !note.starred });
      await reload(); // 星标影响排序（置顶），重拉保持序一致
    } catch (error) {
      console.error("切换星标失败:", error);
      toast.error("切换星标失败");
      await reload();
    }
  };

  const handleDelete = async (note: Note) => {
    try {
      await deleteNote(note.id);
      setNotes((prev) => (prev ? prev.filter((n) => n.id !== note.id) : prev));
      toast.success("已删除笔记");
    } catch (error) {
      console.error("删除笔记失败:", error);
      toast.error("删除笔记失败");
    }
  };

  // 批量导出：逐篇各存一个 .md（无合集形态），选目录后批量写
  const handleBatchExport = async () => {
    const targets = (notes ?? []).filter((n) => selectedIds.has(n.id));
    if (targets.length === 0) return;
    setIsBatchOperating(true);
    try {
      const succeeded = await exportNotesToMarkdownFiles(targets, bookTitle);
      if (succeeded > 0) exitSelectionMode();
    } finally {
      setIsBatchOperating(false);
    }
  };

  // 批量删除：ask 确认 → 逐条删 → 退出管理态
  const handleBatchDelete = async () => {
    if (selectedIds.size === 0) return;
    try {
      const confirmed = await ask(`确定要删除选中的 ${selectedIds.size} 篇笔记吗？\n\n此操作无法撤销。`, {
        title: "确认批量删除",
        kind: "warning",
      });
      if (!confirmed) return;
      setIsBatchOperating(true);
      for (const id of selectedIds) {
        await deleteNote(id);
      }
      toast.success(`已删除 ${selectedIds.size} 篇笔记`);
      exitSelectionMode();
      await reload();
    } catch (error) {
      console.error("批量删除笔记失败:", error);
      toast.error("批量删除笔记失败");
    } finally {
      setIsBatchOperating(false);
    }
  };

  const editing = editingId ? (notes?.find((n) => n.id === editingId) ?? null) : null;

  if (editing) {
    return <NoteEditor note={editing} tocItems={tocItems} onSave={handleSave} onBack={() => setEditingId(null)} />;
  }

  return (
    <>
      {/* 工具栏：新建 / 管理（多选）+ 计数 */}
      <div className="flex items-center justify-between border-neutral-200 border-b px-2 py-1.5 dark:border-neutral-700">
        {selectionMode ? (
          <button
            type="button"
            onClick={handleSelectAll}
            className="rounded-md px-1.5 py-1 text-neutral-500 text-xs hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
          >
            {allSelected ? "取消全选" : "全选"}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void handleCreate()}
            className="flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-primary-foreground text-xs hover:bg-primary/90"
          >
            <Plus className="size-3.5" />
            新建笔记
          </button>
        )}
        <div className="flex items-center gap-0.5">
          {notes && notes.length > 0 && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => (selectionMode ? exitSelectionMode() : setSelectionMode(true))}
                    className={`flex size-7 items-center justify-center rounded-full hover:bg-accent dark:hover:bg-accent ${
                      selectionMode ? "bg-accent dark:bg-accent" : ""
                    }`}
                  >
                    <ListChecks className="size-4 text-neutral-500 dark:text-neutral-400" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{selectionMode ? "退出管理" : "管理"}</TooltipContent>
              </Tooltip>
              <span className="text-neutral-400 text-xs dark:text-neutral-500">{notes.length} 条</span>
            </>
          )}
        </div>
      </div>

      {notes === null ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <Loader2 className="size-5 animate-spin text-neutral-400" />
        </div>
      ) : notes.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <p className="text-center text-neutral-400 text-sm leading-relaxed dark:text-neutral-500">
            暂无笔记
            <br />
            <span className="text-xs">读到有想法的地方，点「新建笔记」——会自动记录当前章节位置</span>
          </p>
        </div>
      ) : (
        <div className="flex-1 space-y-2 overflow-y-auto p-2">
          {notes.map((note) => (
            <NoteCard
              key={note.id}
              note={note}
              selectionMode={selectionMode}
              selected={selectedIds.has(note.id)}
              onOpen={() => setEditingId(note.id)}
              onToggleSelect={() => toggleSelect(note.id)}
              onToggleStar={() => void handleToggleStar(note)}
              onDelete={() => void handleDelete(note)}
              onExport={() => void exportNoteToMarkdown(note, bookTitle)}
              onLocate={() => onLocate(note)}
            />
          ))}
        </div>
      )}

      {/* 管理态底栏：批量导出（逐篇 .md）/ 批量删除 / 退出（样式同标注多选底栏） */}
      {selectionMode && (
        <div className="flex flex-shrink-0 flex-wrap items-center justify-between gap-2 border-neutral-200 border-t px-2 py-2 dark:border-neutral-700">
          <span className="text-nowrap text-neutral-500 text-xs dark:text-neutral-400">已选 {selectedIds.size} 条</span>
          <div className="flex flex-wrap items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              disabled={selectedIds.size === 0 || isBatchOperating}
              onClick={() => void handleBatchExport()}
            >
              <Download className="h-3.5 w-3.5" />
              导出
            </Button>
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
    </>
  );
}
