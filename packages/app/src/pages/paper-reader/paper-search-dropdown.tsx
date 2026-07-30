import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ChevronDown, ChevronUp, Search } from "lucide-react";
import { useEffect, useRef } from "react";

interface PaperSearchDropdownProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 检索关键词（受控；大小写不敏感，空串清除高亮） */
  query: string;
  onQueryChange: (query: string) => void;
  /** 匹配总数（PaperReader 上报） */
  matchCount: number;
  /** 当前匹配序号（0 起） */
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
}

/**
 * 本文内搜索下拉（论文正文 DOM 搜索，非对话内搜索）：
 * UI 参照书籍 SearchDropdown 的触发按钮，内容精简为 输入框 + 匹配计数 + 上一个/下一个；
 * 高亮/滚动定位由 PaperReader 用 CSS Custom Highlight API 完成。
 */
export default function PaperSearchDropdown({
  open,
  onOpenChange,
  query,
  onQueryChange,
  matchCount,
  activeIndex,
  onActiveIndexChange,
}: PaperSearchDropdownProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  // 打开后聚焦输入框（DropdownMenu 会接管初始焦点，延迟一拍）
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, [open]);

  const hasQuery = query.trim().length > 0;
  const gotoPrev = () => {
    if (matchCount > 0) onActiveIndexChange((activeIndex - 1 + matchCount) % matchCount);
  };
  const gotoNext = () => {
    if (matchCount > 0) onActiveIndexChange((activeIndex + 1) % matchCount);
  };

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button className="btn btn-ghost flex items-center justify-center rounded-full p-0 outline-none focus:outline-none focus-visible:ring-0">
              <Search size={18} />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">本文内搜索</TooltipContent>
      </Tooltip>
      <DropdownMenuContent className="w-80 p-3" align="end" side="bottom" sideOffset={4}>
        <div className="flex items-center gap-2">
          <Search className="size-4 shrink-0 text-neutral-400" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                if (event.shiftKey) {
                  gotoPrev();
                } else {
                  gotoNext();
                }
              }
            }}
            placeholder="在本文内搜索"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-neutral-400 dark:placeholder:text-neutral-500"
          />
          {hasQuery && (
            <span className="shrink-0 text-neutral-500 text-xs tabular-nums dark:text-neutral-400">
              {matchCount > 0 ? `${activeIndex + 1}/${matchCount}` : "无匹配"}
            </span>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                disabled={matchCount === 0}
                onClick={gotoPrev}
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700 disabled:opacity-40 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
              >
                <ChevronUp className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">上一个</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                disabled={matchCount === 0}
                onClick={gotoNext}
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700 disabled:opacity-40 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
              >
                <ChevronDown className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">下一个</TooltipContent>
          </Tooltip>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
