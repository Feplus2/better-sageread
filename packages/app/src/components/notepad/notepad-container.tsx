import { useReaderStore } from "@/pages/reader/components/reader-provider";
import { useReaderStore as useGlobalReaderStore } from "@/store/reader-store";
import type { Note, NoteLocation } from "@/types/note";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { NotepadContent } from "./notepad-content";
import { type BookNotepadTab, NotepadHeader } from "./notepad-header";
import { NotesTab } from "./notes-tab";

/** 空白折叠（TOC label 与 progress.sectionLabel 的匹配口径） */
const collapseWs = (text: string) => text.replace(/\s+/g, " ").trim();

/** TOC 递归按章节标题找条目（文本兜底：CFI 漂移后的降级匹配） */
function findTocByLabel(
  items: { label: string; href: string; subitems?: unknown[] }[],
  tag: string,
): { href: string } | null {
  for (const item of items) {
    if (collapseWs(item.label) === tag) return item;
    const hit = item.subitems ? findTocByLabel(item.subitems as typeof items, tag) : null;
    if (hit) return hit;
  }
  return null;
}

/** 书籍侧笔记 tab：从 reader store 装配当前位置（CFI + 章节标题 + sectionId），跳转走 goTo 降级链 */
const BookNotes = ({ bookId }: { bookId: string }) => {
  const view = useReaderStore((state) => state.view);
  const location = useReaderStore((state) => state.location);
  const progress = useReaderStore((state) => state.progress);
  const activeBook = useGlobalReaderStore((state) => state.activeBook);

  const currentLocation: NoteLocation | null = progress?.sectionLabel
    ? { tag: progress.sectionLabel, cfi: location ?? null, block: progress.sectionId ?? null }
    : null;

  const handleLocate = useCallback(
    (note: Note) => {
      if (!view) return;
      // 精确锚点：CFI
      if (note.locationCfi) {
        try {
          view.goTo(note.locationCfi);
          return;
        } catch {
          // CFI 漂移（重导入等），退化文本匹配
        }
      }
      // 文本兜底：TOC 章节标题匹配
      const tag = note.locationTag?.trim();
      if (tag) {
        const hit = findTocByLabel(view.book?.toc ?? [], collapseWs(tag));
        if (hit) {
          view.goTo(hit.href);
          return;
        }
      }
      toast.info("未能定位到笔记位置（内容可能已变更）");
    },
    [view],
  );

  return (
    <NotesTab
      bookId={bookId}
      bookTitle={activeBook?.title ?? ""}
      currentLocation={currentLocation}
      onLocate={handleLocate}
    />
  );
};

interface NotepadContainerProps {
  bookId: string;
}

export const NotepadContainer = ({ bookId }: NotepadContainerProps) => {
  const [tab, setTab] = useState<BookNotepadTab>("annotations");

  return (
    <div className="flex h-full flex-col bg-background">
      <NotepadHeader tab={tab} onTabChange={setTab} />
      <div className="flex-1 overflow-hidden">
        {tab === "annotations" ? <NotepadContent bookId={bookId} /> : <BookNotes bookId={bookId} />}
      </div>
    </div>
  );
};
