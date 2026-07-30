import { Button } from "@/components/ui/button";

interface SelectionExportBarProps {
  selectedCount: number;
  onExportMarkdown: () => void;
  onExportHtml: () => void;
  onExportImage: () => void;
  onCancel: () => void;
}

/** 多选导出浮动条：已选计数 + Markdown/HTML/图片导出 + 取消 */
export function SelectionExportBar({
  selectedCount,
  onExportMarkdown,
  onExportHtml,
  onExportImage,
  onCancel,
}: SelectionExportBarProps) {
  return (
    <div className="-translate-x-1/2 absolute bottom-20 left-1/2 z-40 flex items-center gap-2 rounded-xl border bg-background px-3 py-2 shadow-lg dark:border-neutral-700 dark:bg-neutral-800">
      <span className="flex-shrink-0 text-nowrap text-neutral-600 text-xs dark:text-neutral-400">
        已选 {selectedCount} 条
      </span>
      <Button variant="outline" size="sm" disabled={selectedCount === 0} onClick={onExportMarkdown}>
        Markdown
      </Button>
      <Button variant="outline" size="sm" disabled={selectedCount === 0} onClick={onExportHtml}>
        HTML
      </Button>
      <Button variant="outline" size="sm" disabled={selectedCount === 0} onClick={onExportImage}>
        图片
      </Button>
      <Button variant="ghost" size="sm" onClick={onCancel}>
        取消
      </Button>
    </div>
  );
}
