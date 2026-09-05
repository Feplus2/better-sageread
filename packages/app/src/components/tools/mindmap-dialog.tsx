import { TOOL_NAME_MAP } from "@/components/side-chat/chat-messages";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { X } from "lucide-react";
import { MindmapViewer } from "./mindmap-viewer";
import { SciverseViewer } from "./sciverse-viewer";
import { WebSearchViewer } from "./web-search-viewer";

interface MindmapDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  toolPart: any;
}

export function MindmapDialog({ open, onOpenChange, toolPart }: MindmapDialogProps) {
  // D8 目录牌模式：useTool 转发卡的真实工具名在 input.tool（output 即原工具结果结构）
  const rawType = toolPart?.type;
  const forwarded =
    rawType === "useTool" && typeof toolPart?.input?.tool === "string" ? String(toolPart.input.tool) : null;
  const effectiveType = forwarded ? (TOOL_NAME_MAP[forwarded] ?? forwarded) : rawType;
  const isMindmap = effectiveType === TOOL_NAME_MAP.mindmap;
  const isWebSearch = effectiveType === TOOL_NAME_MAP.webSearch;
  const isSciverse = effectiveType === TOOL_NAME_MAP.sciverseSearch;
  const markdown = toolPart?.output?.results?.markdown;

  if ((!isMindmap || !markdown) && !isWebSearch && !isSciverse) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[90vh] min-w-[90%] max-w-[90%] flex-col gap-0 overflow-y-auto p-0">
        <div className="flex items-center justify-between border-neutral-200 border-b p-4 py-2 dark:border-neutral-700">
          <h2 className="font-semibold text-lg text-neutral-900 dark:text-neutral-50">{effectiveType || "工具详情"}</h2>
          <Button variant="ghost" size="icon" className="size-8 rounded-full" onClick={() => onOpenChange(false)}>
            <X className="h-5 w-5" />
          </Button>
        </div>
        <div className="flex-1 overflow-hidden">
          {isWebSearch ? (
            <WebSearchViewer results={toolPart?.output?.results} />
          ) : isSciverse ? (
            <SciverseViewer results={toolPart?.output?.results} />
          ) : (
            <MindmapViewer markdown={markdown} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
