import { useReaderStore } from "@/store/reader-store";
import { AnnotationItem } from "./annotation-item";
import { useAnnotations } from "./hooks";

interface NotepadContentProps {
  bookId: string;
}

export const NotepadContent = ({ bookId }: NotepadContentProps) => {
  const {
    annotations,
    status: annotationStatus,
    handleDeleteAnnotation,
    handleToggleStar,
  } = useAnnotations({
    bookId,
  });

  const { activeBook } = useReaderStore();

  return (
    <div className="mt-1 h-full overflow-y-auto">
      <div className="space-y-3 p-1">
        {annotationStatus === "pending" ? (
          <div className="flex items-center justify-center py-8">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-700 dark:border-neutral-600 dark:border-t-neutral-400" />
          </div>
        ) : annotationStatus === "error" ? (
          <div className="flex items-center justify-center py-8 text-neutral-500 text-sm">
            <p>加载标注失败</p>
          </div>
        ) : annotations.length === 0 ? (
          <div className="flex items-center justify-center py-8 text-neutral-500 text-sm">
            <p>还没有标注，选中文本并高亮创建第一个标注吧！</p>
          </div>
        ) : (
          <div className="space-y-2">
            {annotations.map((annotation) => (
              <AnnotationItem
                key={annotation.id}
                annotation={annotation}
                bookId={bookId}
                bookTitle={activeBook?.title}
                onDelete={handleDeleteAnnotation}
                onToggleStar={handleToggleStar}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
