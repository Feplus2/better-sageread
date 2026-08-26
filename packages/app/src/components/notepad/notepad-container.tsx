import { useReaderStore } from "@/pages/reader/components/reader-provider";
import { useReaderStore as useGlobalReaderStore } from "@/store/reader-store";
import type { Note, NoteLocation, NoteTocItem } from "@/types/note";
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

/** book.toc 递归拍平为位置选择器清单（cfi 优先，退化 href；block = foliate section id；depth 层级缩进） */
function flattenToc(
  items: { label: string; href: string; cfi?: string; id?: number; subitems?: unknown[] }[],
  depth = 0,
): NoteTocItem[] {
  const out: NoteTocItem[] = [];
  for (const item of items) {
    const tag = collapseWs(item.label);
    if (tag) out.push({ tag, cfi: item.cfi ?? item.href ?? null, block: item.id ?? null, depth });
    if (item.subitems) out.push(...flattenToc(item.subitems as typeof items, depth + 1));
  }
  return out;
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

  // 位置选择器清单：book.toc 拍平（view 未就绪为空数组，选择器按钮自动隐藏）
  const tocItems = view?.book?.toc ? flattenToc(view.book.toc) : [];

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
      tocItems={tocItems}
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
      {/* 批次 5：key={tab} 让切 tab 时容器重挂载 → 进场动画重播（motion-enter-slide-up，token 驱动） */}
      <div key={tab} className="motion-enter-slide-up flex-1 overflow-hidden">
        {tab === "annotations" ? <NotepadContent bookId={bookId} /> : <BookNotes bookId={bookId} />}
      </div>
    </div>
  );
};
