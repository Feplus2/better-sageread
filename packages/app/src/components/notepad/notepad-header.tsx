import { Highlighter } from "lucide-react";

export const NotepadHeader = () => {
  return (
    <div className="h-10 border-neutral-200 bg-background pt-0 pb-10 dark:border-neutral-700">
      <div className="flex select-none items-center justify-between">
        <div className="mb-1 flex h-9 items-center rounded-full px-3">
          <Highlighter className="mr-1 size-4" />
          <span className="text-sm">标注</span>
        </div>
      </div>
    </div>
  );
};
