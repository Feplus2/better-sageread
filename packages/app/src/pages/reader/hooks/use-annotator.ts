import { createBookNote, deleteBookNote, updateBookNote } from "@/services/book-note-service";
import { iframeService } from "@/services/iframe-service";
import { useAppSettingsStore } from "@/store/app-settings-store";
import { useLayoutStore } from "@/store/layout-store";
import type { HighlightColor, HighlightStyle } from "@/types/book";
import { type Position, type TextSelection, getPopupPosition, getPosition } from "@/utils/sel";
import { useQueryClient } from "@tanstack/react-query";
import * as CFI from "foliate-js/epubcfi.js";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useReaderStore, useReaderStoreApi } from "../components/reader-provider";

function getContextByRange(range: Range, win = 30) {
  const container = range.commonAncestorContainer;
  const el =
    (container.nodeType === Node.ELEMENT_NODE ? (container as Element) : (container.parentElement as Element)).closest(
      "p,li,div,section,article,blockquote,td",
    ) || document.body;

  const blockText = el.textContent || "";
  const highlight = range.toString();
  const i = blockText.indexOf(highlight);
  if (i < 0) return { before: "", highlight, after: "" };

  const s = Math.max(0, i - win);
  const e = Math.min(blockText.length, i + highlight.length + win);
  const squash = (s: string) => s.replace(/\s+/g, " ");
  return {
    before: squash(blockText.slice(s, i)),
    highlight,
    after: squash(blockText.slice(i + highlight.length, e)),
  };
}

interface UseAnnotatorProps {
  bookId: string;
}

export const useAnnotator = ({ bookId }: UseAnnotatorProps) => {
  const { settings } = useAppSettingsStore();
  const config = useReaderStore((state) => state.config)!;
  const progress = useReaderStore((state) => state.progress)!;
  const view = useReaderStore((state) => state.view);
  const store = useReaderStoreApi();
  const queryClient = useQueryClient();
  const globalViewSettings = settings.globalViewSettings;

  // 状态管理
  const [selection, setSelection] = useState<TextSelection | null>(null);
  const [showAnnotPopup, setShowAnnotPopup] = useState(false);
  const [trianglePosition, setTrianglePosition] = useState<Position>();
  const [annotPopupPosition, setAnnotPopupPosition] = useState<Position>();
  const [highlightOptionsVisible, setHighlightOptionsVisible] = useState(false);
  // 评论（标注-笔记二合一，落 book_notes.note；仅"已有标注"回显态可写，与独立 notes 系统无关）
  const [commentOpen, setCommentOpen] = useState(false);
  const [commentDraft, setCommentDraft] = useState("");

  const [selectedStyle, setSelectedStyle] = useState<HighlightStyle>(settings.globalReadSettings.highlightStyle);
  const [selectedColor, setSelectedColor] = useState<HighlightColor>(
    settings.globalReadSettings.highlightStyles[selectedStyle],
  );

  const popupPadding = 10;
  // 横向弹窗容纳"复制 / Ask AI / 高亮(/删除/评论)"，竖排为窄列；宽度需同时容纳笔触/颜色选项面板（约 236px）
  const annotPopupWidth = Math.min(globalViewSettings?.vertical ? 250 : 240, window.innerWidth - 2 * popupPadding);
  const annotPopupHeight = 36;

  // Popup 相关函数
  const handleDismissPopup = useCallback(() => {
    setSelection(null);
    setShowAnnotPopup(false);
    setCommentOpen(false);
    setCommentDraft("");
  }, []);

  const handleDismissPopupAndSelection = useCallback(() => {
    handleDismissPopup();
    view?.deselect();
  }, [handleDismissPopup, view]);

  // 业务逻辑函数
  const handleCopy = useCallback(() => {
    if (!selection || !selection.text) return;
    if (selection) navigator.clipboard?.writeText(selection.text);
    toast.success("Copy success!");
    handleDismissPopupAndSelection();
  }, [selection, handleDismissPopupAndSelection]);

  const handleHighlight = useCallback(
    async (update = false) => {
      if (!selection || !selection.text) return;
      setHighlightOptionsVisible(true);
      const { booknotes: annotations = [] } = config;
      const cfi = view?.getCFI(selection.index, selection.range);
      if (!cfi) return;

      const style = settings.globalReadSettings.highlightStyle;
      const color = settings.globalReadSettings.highlightStyles[style];

      const existingAnnotation = annotations.find(
        (annotation) => annotation.cfi === cfi && annotation.type === "annotation" && !annotation.deletedAt,
      );

      try {
        if (existingAnnotation) {
          if (update) {
            const updatedAnnotation = await updateBookNote(existingAnnotation.id, {
              style,
              color,
              text: selection.text,
              note: existingAnnotation.note,
            });

            const updatedAnnotations = annotations.map((ann) =>
              ann.id === existingAnnotation.id ? updatedAnnotation : ann,
            );
            const updatedConfig = store.getState().updateBooknotes(updatedAnnotations);
            view?.addAnnotation(updatedAnnotation, true);
            view?.addAnnotation(updatedAnnotation);

            if (updatedConfig) {
              await store.getState().saveConfig(updatedConfig);
            }
            queryClient.invalidateQueries({ queryKey: ["annotations", bookId] });
          } else {
            await deleteBookNote(existingAnnotation.id);
            const updatedAnnotations = annotations.filter((ann) => ann.id !== existingAnnotation.id);
            const updatedConfig = store.getState().updateBooknotes(updatedAnnotations);

            view?.addAnnotation(existingAnnotation, true);

            setShowAnnotPopup(false);

            if (updatedConfig) {
              await store.getState().saveConfig(updatedConfig);
            }

            queryClient.invalidateQueries({ queryKey: ["annotations", bookId] });
          }
        } else {
          const ctx = getContextByRange(selection.range, 50);
          const newAnnotation = await createBookNote({
            bookId,
            type: "annotation",
            cfi,
            style,
            color,
            text: selection.text,
            note: "",
            context: {
              before: ctx.before,
              after: ctx.after,
            },
          });

          const updatedAnnotations = [...annotations, newAnnotation];
          const updatedConfig = store.getState().updateBooknotes(updatedAnnotations);

          view?.addAnnotation(newAnnotation);
          setSelection({ ...selection, annotated: true });

          if (updatedConfig) {
            await store.getState().saveConfig(updatedConfig);
          }

          queryClient.invalidateQueries({ queryKey: ["annotations", bookId] });
        }
      } catch (error) {
        console.error("Failed to handle highlight:", error);
        toast.error("Failed to save annotation");
      }
    },
    [selection, config, view, settings, bookId, store, queryClient],
  );

  // Ask AI：选中文本作为 quote 注入当前书籍 AI 会话输入框（不自动发送）
  const handleQuoteToChat = useCallback(() => {
    if (!selection || !selection.text) return;
    // AI 面板折叠时先展开（等 SideChat 挂载后再派发，否则同一 tick 内事件无人接收）
    if (!useLayoutStore.getState().isChatVisible) {
      useLayoutStore.getState().toggleChatSidebar();
    }
    const text = selection.text;
    setTimeout(() => iframeService.sendQuoteReferenceRequest(text, bookId), 50);
    handleDismissPopupAndSelection();
  }, [selection, bookId, handleDismissPopupAndSelection]);

  // 评论按钮：展开/收起内嵌评论输入框（展开时预填已有评论）
  const handleToggleComment = useCallback(() => {
    if (!selection || !selection.text) return;
    if (!commentOpen) {
      const { booknotes: annotations = [] } = config;
      const cfi = view?.getCFI(selection.index, selection.range);
      const existingAnnotation = cfi
        ? annotations.find(
            (annotation) => annotation.cfi === cfi && annotation.type === "annotation" && !annotation.deletedAt,
          )
        : undefined;
      setCommentDraft(existingAnnotation?.note ?? "");
    }
    setCommentOpen((open) => !open);
  }, [selection, commentOpen, config, view]);

  // 保存评论：仅在"已有标注"回显态开放，更新 book_notes.note
  const handleSaveComment = useCallback(async () => {
    if (!selection || !selection.text) return;
    const note = commentDraft.trim();
    const { booknotes: annotations = [] } = config;
    const cfi = view?.getCFI(selection.index, selection.range);
    if (!cfi) return;

    const existingAnnotation = annotations.find(
      (annotation) => annotation.cfi === cfi && annotation.type === "annotation" && !annotation.deletedAt,
    );
    if (!existingAnnotation) return;

    try {
      const updatedAnnotation = await updateBookNote(existingAnnotation.id, { note });
      const updatedAnnotations = annotations.map((ann) => (ann.id === existingAnnotation.id ? updatedAnnotation : ann));
      const updatedConfig = store.getState().updateBooknotes(updatedAnnotations);
      if (updatedConfig) {
        await store.getState().saveConfig(updatedConfig);
      }
      queryClient.invalidateQueries({ queryKey: ["annotations", bookId] });
      toast.success("评论已保存");
      handleDismissPopupAndSelection();
    } catch (error) {
      console.error("Failed to save comment:", error);
      toast.error("保存评论失败");
    }
  }, [selection, commentDraft, config, view, bookId, store, queryClient, handleDismissPopupAndSelection]);

  // Popup 位置计算
  // biome-ignore lint/correctness/useExhaustiveDependencies: <explanation>
  useEffect(() => {
    setHighlightOptionsVisible(!!selection?.annotated);
    if (selection && selection.text.trim().length > 0) {
      const gridFrame = document.querySelector(`#gridcell-${bookId}`);

      if (!gridFrame) {
        return;
      }

      const rect = gridFrame.getBoundingClientRect();
      const triangPos = getPosition(selection.range, rect, popupPadding, globalViewSettings?.vertical);
      const annotPopupPos = getPopupPosition(
        triangPos,
        rect,
        globalViewSettings?.vertical ? annotPopupHeight : annotPopupWidth,
        globalViewSettings?.vertical ? annotPopupWidth : annotPopupHeight,
        popupPadding,
      );

      if (triangPos.point.x === 0 || triangPos.point.y === 0) {
        return;
      }

      setAnnotPopupPosition(annotPopupPos);
      setTrianglePosition(triangPos);
      setShowAnnotPopup(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, bookId]);

  // 加载当前页面的标注
  // biome-ignore lint/correctness/useExhaustiveDependencies: <explanation>
  useEffect(() => {
    if (!progress) return;
    const { location } = progress;
    const start = CFI.collapse(location);
    const end = CFI.collapse(location, true);
    const { booknotes = [] } = config;
    const annotations = booknotes.filter(
      (item) =>
        !item.deletedAt &&
        item.type === "annotation" &&
        item.style &&
        CFI.compare(item.cfi, start) >= 0 &&
        CFI.compare(item.cfi, end) <= 0,
    );
    try {
      Promise.all(annotations.map((annotation) => view?.addAnnotation(annotation)));
    } catch (e) {
      console.warn(e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress]);

  return {
    // 状态
    selection,
    setSelection,
    showAnnotPopup,
    trianglePosition,
    annotPopupPosition,
    highlightOptionsVisible,
    selectedStyle,
    setSelectedStyle,
    selectedColor,
    setSelectedColor,
    annotPopupWidth,
    annotPopupHeight,
    commentOpen,
    commentDraft,
    setCommentDraft,

    // 函数
    handleDismissPopup,
    handleDismissPopupAndSelection,
    handleCopy,
    handleHighlight,
    handleQuoteToChat,
    handleToggleComment,
    handleSaveComment,
  };
};
