import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useReaderStore } from "@/pages/reader/components/reader-provider";
import { HIGHLIGHT_COLOR_HEX, HIGHLIGHT_COLOR_RGBA } from "@/services/constants";
import type { BookNote } from "@/types/book";
import { ask } from "@tauri-apps/plugin-dialog";
import dayjs from "dayjs";
import { NotebookPen, Star } from "lucide-react";
import { useCallback } from "react";

interface AnnotationItemProps {
  annotation: BookNote;
  bookId: string;
  bookTitle?: string;
  onDelete?: (id: string) => void;
  onToggleStar?: (annotation: BookNote) => void;
}

export const AnnotationItem = ({ annotation, onDelete, onToggleStar }: AnnotationItemProps) => {
  const view = useReaderStore((state) => state.view);
  const bgColor = annotation.color ? HIGHLIGHT_COLOR_RGBA[annotation.color] : HIGHLIGHT_COLOR_RGBA.yellow;
  const lineColor = annotation.color ? HIGHLIGHT_COLOR_HEX[annotation.color] : HIGHLIGHT_COLOR_HEX.yellow;
  const style = annotation.style || "highlight";

  const handleClick = useCallback(() => {
    if (view) {
      view.goTo(annotation.cfi);
    }
  }, [annotation.cfi, view]);

  const handleNativeDelete = useCallback(async () => {
    try {
      const confirmed = await ask(`确定要删除这条标注吗？\n\n"${annotation.text || ""}"\n\n此操作无法撤销。`, {
        title: "确认删除",
        kind: "warning",
      });

      if (confirmed && onDelete) {
        await onDelete(annotation.id);
      }
    } catch (error) {
      console.error("删除标注失败:", error);
    }
  }, [annotation, onDelete]);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className="group cursor-pointer rounded-lg bg-muted p-2 transition-colors dark:bg-neutral-900"
          onClick={handleClick}
        >
          <div className="flex items-stretch gap-2">
            {/* 左侧 4px 色条（颜色 = 标注色），比整底色更清爽 */}
            <div className="w-1 shrink-0 rounded-full" style={{ backgroundColor: lineColor }} />
            <div className="min-w-0 flex-1">
              {annotation.context && (
                <div className="mb-1 text-sm leading-relaxed">
                  <span className="text-neutral-600 dark:text-neutral-200">...{annotation.context.before}</span>
                  <span
                    className="font-medium text-sm"
                    style={{
                      backgroundColor: style === "highlight" ? bgColor : "transparent",
                      textDecoration: style === "underline" || style === "squiggly" ? "underline" : "none",
                      textDecorationColor: style !== "highlight" ? lineColor : undefined,
                      textDecorationThickness: "2px",
                      textDecorationStyle: style === "squiggly" ? "wavy" : "solid",
                    }}
                  >
                    {annotation.text}
                  </span>
                  <span className="text-neutral-600 dark:text-neutral-200">{annotation.context.after}...</span>
                </div>
              )}

              {!annotation.context && (
                <div className="mb-2">
                  <span
                    className="font-medium text-sm"
                    style={{
                      backgroundColor: style === "highlight" ? bgColor : "transparent",
                      textDecoration: style === "underline" || style === "squiggly" ? "underline" : "none",
                      textDecorationColor: style !== "highlight" ? lineColor : undefined,
                      textDecorationThickness: "2px",
                      textDecorationStyle: style === "squiggly" ? "wavy" : "solid",
                    }}
                  >
                    {annotation.text}
                  </span>
                </div>
              )}

              {/* 评论预览（标注-笔记二合一，book_notes.note） */}
              {annotation.note && (
                <div className="mt-1 flex items-start gap-1 text-neutral-500 text-xs dark:text-neutral-400">
                  <NotebookPen className="mt-0.5 size-3 shrink-0" />
                  <span className="line-clamp-2">{annotation.note}</span>
                </div>
              )}

              <div className="mt-2 flex items-center gap-2 text-neutral-500 text-xs dark:text-neutral-500">
                <span>{dayjs(annotation.createdAt).format("YYYY-MM-DD HH:mm:ss")}</span>
                {/* 星标切换（同一 update_book_note starred 路径；stopPropagation 不触发跳转） */}
                {onToggleStar && (
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
                          onToggleStar(annotation);
                        }}
                      >
                        <Star
                          className={`size-3.5 ${annotation.starred ? "fill-amber-400 text-amber-400" : "text-muted-foreground"}`}
                        />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">{annotation.starred ? "取消星标" : "星标"}</TooltipContent>
                  </Tooltip>
                )}
              </div>
            </div>
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem variant="destructive" onClick={() => handleNativeDelete()}>
          删除
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
};
