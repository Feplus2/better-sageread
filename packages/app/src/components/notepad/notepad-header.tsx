import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Highlighter, NotebookPen } from "lucide-react";

export type BookNotepadTab = "annotations" | "notes";

interface NotepadHeaderProps {
  tab: BookNotepadTab;
  onTabChange: (tab: BookNotepadTab) => void;
}

/** 书籍笔记面板头部：标注 / 笔记 切换（样式同论文 PaperNotepadPanel 头部） */
export const NotepadHeader = ({ tab, onTabChange }: NotepadHeaderProps) => {
  return (
    <div className="h-10 border-neutral-200 bg-background pt-0 pb-10 dark:border-neutral-700">
      <div className="flex select-none items-center justify-between">
        <Tabs value={tab} onValueChange={(value) => onTabChange(value as BookNotepadTab)} className="mb-1 flex">
          <TabsList className="h-9 rounded-full">
            <TabsTrigger className="h-7 rounded-full" value="annotations">
              <Highlighter className="mr-1 size-4" />
              <span>标注</span>
            </TabsTrigger>
            <TabsTrigger className="h-7 rounded-full" value="notes">
              <NotebookPen className="mr-1 size-4" />
              <span>笔记</span>
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
    </div>
  );
};
