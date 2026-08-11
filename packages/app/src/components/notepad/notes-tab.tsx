import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { createNote, deleteNote, getNotes, updateNote } from "@/services/note-service";
import type { Note, NoteLocation } from "@/types/note";
import { ask } from "@tauri-apps/plugin-dialog";
import dayjs from "dayjs";
import { ChevronLeft, Loader2, MapPin, Plus, Star } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

/** 展示用文本折叠（Markdown 原文含换行/语法标记，只作预览） */
const collapseWs = (text: string) => text.replace(/\s+/g, " ").trim();

const AUTOSAVE_DELAY = 800;

interface NoteCardProps {
  note: Note;
  onOpen: () => void;
  onToggleStar: () => void;
  onDelete: () => void;
  onLocate: () => void;
}

/** 笔记卡片：标题 + 正文摘要 + 位置 chip + 更新时间 + 星标；点卡片进编辑态，点 chip 跳正文，右键删除 */
function NoteCard({ note, onOpen, onToggleStar, onDelete, onLocate }: NoteCardProps) {
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
          onClick={onOpen}
        >
          <div className="flex items-start gap-1.5">
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-sm">{note.title || "无标题笔记"}</div>
              {note.content.trim() && (
                <div className="mt-0.5 line-clamp-2 text-neutral-500 text-xs leading-relaxed dark:text-neutral-400">
                  {collapseWs(note.content).slice(0, 120)}
                </div>
              )}
              <div className="mt-1.5 flex items-center gap-2 text-neutral-500 text-xs dark:text-neutral-500">
                {note.locationTag && (
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
                <span className="shrink-0">{dayjs(note.updatedAt).format("MM-DD HH:mm")}</span>
                {/* 星标切换（样式同标注列表；stopPropagation 不进编辑态） */}
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
      <ContextMenuContent>
        <ContextMenuItem variant="destructive" onClick={() => handleDelete()}>
          删除
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

interface NoteEditorProps {
  note: Note;
  /** 自动保存（debounce 在外层实现）：落库并回写最新行 */
  onSave: (id: string, draft: { title: string; content: string; locationTag: string }) => Promise<void>;
  onBack: () => void;
}

/** 编辑态（侧栏内子视图，不扩宽）：返回 + 标题 + 位置 tag + 等宽 textarea；改动 800ms debounce 自动保存 */
function NoteEditor({ note, onSave, onBack }: NoteEditorProps) {
  const [title, setTitle] = useState(note.title);
  const [content, setContent] = useState(note.content);
  const [locationTag, setLocationTag] = useState(note.locationTag ?? "");
  const [saving, setSaving] = useState<"idle" | "pending" | "saving">("idle");
  const timerRef = useRef<number | null>(null);
  // 最新草稿 ref：卸载/返回时兜底 flush，避免防抖窗口内丢字
  const draftRef = useRef({ title, content, locationTag });
  draftRef.current = { title, content, locationTag };
  const dirtyRef = useRef(false);

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
  // biome-ignore lint/correctness/useExhaustiveDependencies: title/content/locationTag 是变化侦测信号（正文只走 ref 草稿），必须列全
  useEffect(() => {
    dirtyRef.current = true;
    setSaving("pending");
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void flush();
    }, AUTOSAVE_DELAY);
  }, [title, content, locationTag, flush]);

  // 卸载兜底（返回列表/切 tab/关面板）：有未保存改动立即 flush
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在卸载时跑一次（onSave/note.id 经 ref 化草稿兜底，不依赖最新值）
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      if (dirtyRef.current) void onSave(note.id, draftRef.current);
    };
  }, []);

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
        </div>
        <Textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="用 Markdown 写笔记…"
          className="min-h-[50vh] flex-1 resize-none font-mono text-sm leading-relaxed"
          autoFocus
        />
      </div>
    </div>
  );
}

export interface NotesTabProps {
  bookId: string;
  /** 新建时捕获的当前阅读位置（论文 = heading；书籍 = 章节，父组件装配；阅读位置未知为 null） */
  currentLocation: NoteLocation | null;
  /** 点击位置 chip → 正文跳转（父组件实现 精确锚点 → 文本兜底 → 顶部+toast 的降级链） */
  onLocate: (note: Note) => void;
}

/**
 * 「笔记」tab（论文/书籍共用骨架）：列表态（卡片 + 新建 + 星标 + 右键删除）↔ 编辑态（自动保存）。
 * B2 增量：Markdown 预览/折叠、管理态（多选导出/删除）、导出。
 */
export function NotesTab({ bookId, currentLocation, onLocate }: NotesTabProps) {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

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
    void reload();
  }, [reload]);

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

  const handleSave = useCallback(async (id: string, draft: { title: string; content: string; locationTag: string }) => {
    try {
      await updateNote(id, {
        title: draft.title.trim(),
        content: draft.content,
        locationTag: draft.locationTag.trim() || null,
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

  const editing = editingId ? (notes?.find((n) => n.id === editingId) ?? null) : null;

  if (editing) {
    return <NoteEditor note={editing} onSave={handleSave} onBack={() => setEditingId(null)} />;
  }

  return (
    <>
      {/* 工具栏：新建 + 计数 */}
      <div className="flex items-center justify-between border-neutral-200 border-b px-2 py-1.5 dark:border-neutral-700">
        <button
          type="button"
          onClick={() => void handleCreate()}
          className="flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-primary-foreground text-xs hover:bg-primary/90"
        >
          <Plus className="size-3.5" />
          新建笔记
        </button>
        {notes && notes.length > 0 && (
          <span className="text-neutral-400 text-xs dark:text-neutral-500">{notes.length} 条</span>
        )}
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
              onOpen={() => setEditingId(note.id)}
              onToggleStar={() => void handleToggleStar(note)}
              onDelete={() => void handleDelete(note)}
              onLocate={() => onLocate(note)}
            />
          ))}
        </div>
      )}
    </>
  );
}
