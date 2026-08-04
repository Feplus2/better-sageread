import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Grid3X3, List } from "lucide-react";

interface StatusBarProps {
  totalBooks: number;
  viewMode: "grid" | "list";
  onViewModeChange: (mode: "grid" | "list") => void;
}

export default function StatusBar({ totalBooks, viewMode, onViewModeChange }: StatusBarProps) {
  return (
    <div className="fixed right-6 bottom-6 z-40">
      <div className="flex items-center space-x-3 rounded-full border border-base-300 bg-base-100 px-4 py-2 shadow-lg">
        <div className="flex items-center space-x-2 text-base-content text-sm">
          <span className="text-xs opacity-70">总计</span>
          <span className="font-medium">{totalBooks}</span>
        </div>

        <div className="h-4 w-px bg-base-300" />

        <div className="flex items-center space-x-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => onViewModeChange("grid")}
                className={`rounded-lg p-2 transition-colors ${
                  viewMode === "grid" ? "bg-primary text-primary-content" : "text-base-content hover:bg-base-200"
                }`}
              >
                <Grid3X3 className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">网格视图</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => onViewModeChange("list")}
                className={`rounded-lg p-2 transition-colors ${
                  viewMode === "list" ? "bg-primary text-primary-content" : "text-base-content hover:bg-base-200"
                }`}
              >
                <List className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">列表视图</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
