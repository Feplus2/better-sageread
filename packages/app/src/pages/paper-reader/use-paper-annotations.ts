import type { PaperAnnotationDraft } from "@/pages/paper-reader/paper-reader";
import {
  createBookNote,
  deleteAiBookNotes,
  deleteBookNote,
  getBookNotes,
  updateBookNote,
} from "@/services/book-note-service";
import type { BookNote, HighlightColor, HighlightStyle } from "@/types/book";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { toast } from "sonner";

/** AI 重点标注落库条目（category/source 由本模块补齐，调用方只给定位产物与类别色/评论） */
export interface AiAnnotationCreateItem {
  cfi: string;
  text: string;
  color: HighlightColor;
  /** 已按【类别中文名】可选说明 格式拼好的 note */
  note: string;
  context: { before: string; after: string };
  category: string;
}

/**
 * 论文标注（复用 book_notes 表：论文即 books 表 format='MARKDOWN' 的行，paperId 即 bookId）。
 * 仿写书籍 use-annotations，补齐 create/update/delete 全套 CRUD；
 * queryKey 与书籍标注一致（["annotations", id]），invalidate 后 PaperReader 与侧栏同时刷新。
 */
export function usePaperAnnotations(paperId: string) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["annotations", paperId],
    queryFn: async () => {
      const bookNotes = await getBookNotes(paperId);
      return bookNotes.filter((note) => note.type === "annotation" && !note.deletedAt);
    },
    enabled: !!paperId,
  });

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["annotations", paperId] });
  }, [queryClient, paperId]);

  // 返回新建的标注（失败返回 undefined）：弹窗创建后要切换到"已有标注"模式继续改笔触/颜色
  const createAnnotation = useCallback(
    async (draft: PaperAnnotationDraft): Promise<BookNote | undefined> => {
      try {
        const created = await createBookNote({
          bookId: paperId,
          type: "annotation",
          style: draft.style,
          cfi: draft.cfi,
          text: draft.text,
          color: draft.color,
          note: draft.note,
          context: draft.context,
        });
        toast.success(draft.note ? "标注已保存" : "已标亮");
        invalidate();
        return created;
      } catch (error) {
        console.error("保存标注失败:", error);
        toast.error("保存标注失败");
        return undefined;
      }
    },
    [paperId, invalidate],
  );

  const updateAnnotation = useCallback(
    async (id: string, update: { color?: HighlightColor; style?: HighlightStyle; note?: string }) => {
      try {
        await updateBookNote(id, update);
        invalidate();
      } catch (error) {
        console.error("更新标注失败:", error);
        toast.error("更新标注失败");
      }
    },
    [invalidate],
  );

  const deleteAnnotation = useCallback(
    async (id: string) => {
      try {
        await deleteBookNote(id);
        toast.success("标注删除成功");
        invalidate();
      } catch (error) {
        console.error("删除标注失败:", error);
        toast.error("删除标注失败");
      }
    },
    [invalidate],
  );

  // 切换星标：先落库后 invalidate（参照 use-threads handleToggleStar）
  const toggleStar = useCallback(
    async (annotation: BookNote) => {
      try {
        await updateBookNote(annotation.id, { starred: !annotation.starred });
        invalidate();
      } catch (error) {
        console.error("更新星标失败:", error);
        toast.error("更新星标失败");
      }
    },
    [invalidate],
  );

  // 批量删除（多选管理模式）：逐条删除，统一提示一次
  const deleteAnnotations = useCallback(
    async (ids: string[]) => {
      let removed = 0;
      for (const id of ids) {
        try {
          await deleteBookNote(id);
          removed += 1;
        } catch (error) {
          console.error("删除标注失败:", error);
        }
      }
      invalidate();
      if (removed > 0) toast.success(`已删除 ${removed} 条标注`);
      if (removed < ids.length) toast.error(`${ids.length - removed} 条标注删除失败`);
    },
    [invalidate],
  );

  // C2：批量落库 AI 重点标注（source='ai' + category；逐条创建，失败跳过继续）。返回成功条数
  const createAiAnnotations = useCallback(
    async (items: AiAnnotationCreateItem[]): Promise<number> => {
      let created = 0;
      for (const item of items) {
        try {
          await createBookNote({
            bookId: paperId,
            type: "annotation",
            style: "highlight",
            cfi: item.cfi,
            text: item.text,
            color: item.color,
            note: item.note,
            context: item.context,
            category: item.category,
            source: "ai",
          });
          created += 1;
        } catch (error) {
          console.error("保存 AI 标注失败:", error);
        }
      }
      invalidate();
      return created;
    },
    [paperId, invalidate],
  );

  // C2：清空本篇论文的全部 AI 标注（SQL 侧显式 source='ai'，人工标注不受影响）。返回删除条数
  const clearAiAnnotations = useCallback(async (): Promise<number> => {
    const removed = await deleteAiBookNotes(paperId);
    invalidate();
    return removed;
  }, [paperId, invalidate]);

  return {
    annotations: data ?? [],
    isLoading,
    createAnnotation,
    updateAnnotation,
    deleteAnnotation,
    toggleStar,
    deleteAnnotations,
    createAiAnnotations,
    clearAiAnnotations,
  };
}
