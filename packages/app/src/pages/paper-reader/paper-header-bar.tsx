import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { TocItem } from "@/pages/paper-reader/paper-reader";
import PaperSearchDropdown from "@/pages/paper-reader/paper-search-dropdown";
import PaperSettingsDropdown from "@/pages/paper-reader/paper-settings-dropdown";
import PaperTranslationDropdown from "@/pages/paper-reader/paper-translation-dropdown";
import { useAutoHideControls } from "@/pages/reader/hooks/use-auto-hide-controls";
import type { PaperAlignmentInfo } from "@/services/paper-alignment-service";
import type { TranslateProgress } from "@/services/paper-translation-service";
import { useThemeStore } from "@/store/theme-store";
import type { PaperViewModeType } from "@/types/settings";
import { TableOfContents } from "lucide-react";
import { useState } from "react";
import {
  TbLayoutSidebarLeftCollapse,
  TbLayoutSidebarLeftCollapseFilled,
  TbLayoutSidebarRightCollapse,
  TbLayoutSidebarRightCollapseFilled,
} from "react-icons/tb";

type PaperDropdown = "toc" | "search" | "settings" | "translate";

interface PaperHeaderBarProps {
  /** 笔记/标注面板开关（swapSidebars 时左按钮改为控制 AI 面板，与书籍 HeaderBar 一致） */
  notesOpen: boolean;
  onToggleNotes: () => void;
  /** AI 面板开关 */
  chatOpen: boolean;
  onToggleChat: () => void;
  /** PaperReader 上报的 TOC 与当前阅读位置 */
  toc: TocItem[];
  activeHeadingId: string | null;
  onTocSelect: (id: string) => void;
  /** 中部显示的当前小节名称 */
  currentSection: string;
  /** 本文内搜索（受控，状态在 PaperReaderView） */
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  searchMatchCount: number;
  activeMatchIndex: number;
  onActiveMatchIndexChange: (index: number) => void;
  /** 翻译：显示模式（持久化）/译本存在性/进度/操作 */
  viewMode: PaperViewModeType;
  onViewModeChange: (mode: PaperViewModeType) => void;
  hasTranslation: boolean;
  translating: TranslateProgress | null;
  onTranslate: (force: boolean) => void;
  onCancelTranslate: () => void;
  /** T2/T3 对齐：覆盖情况（句/词已对齐块数，状态行展示）/计算中标志/手动重建（句词两级） */
  alignInfo: PaperAlignmentInfo | null;
  aligning: boolean;
  onRebuildAlign: () => void;
}

/**
 * 论文阅读区顶栏：复刻书籍 HeaderBar 的结构与交互
 * （悬停浮现左右 UI 组、中部当前小节名、TOC/搜索/设置下拉、两侧面板折叠开关）。
 */
export default function PaperHeaderBar({
  notesOpen,
  onToggleNotes,
  chatOpen,
  onToggleChat,
  toc,
  activeHeadingId,
  onTocSelect,
  currentSection,
  searchQuery,
  onSearchQueryChange,
  searchMatchCount,
  activeMatchIndex,
  onActiveMatchIndexChange,
  viewMode,
  onViewModeChange,
  hasTranslation,
  translating,
  onTranslate,
  onCancelTranslate,
  alignInfo,
  aligning,
  onRebuildAlign,
}: PaperHeaderBarProps) {
  const [openDropdown, setOpenDropdown] = useState<PaperDropdown | null>(null);
  // swapSidebars 时左右开关互换控制对象（与书籍 HeaderBar 同一语义）
  const { swapSidebars } = useThemeStore();

  const {
    isVisible: showControls,
    handleMouseEnter,
    handleMouseLeave,
  } = useAutoHideControls({
    keepVisible: Boolean(openDropdown),
  });

  const minTocLevel = toc.length > 0 ? Math.min(...toc.map((item) => item.level)) : 1;

  const handleSearchOpenChange = (open: boolean) => {
    setOpenDropdown(open ? "search" : null);
    // 关闭时清空关键词、清除正文高亮（书籍同款行为）
    if (!open) onSearchQueryChange("");
  };

  return (
    <div className="w-full shrink-0">
      <div
        className="header-bar pointer-events-auto visible flex h-10 w-full items-center px-2 pl-4 transition-all duration-300"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {/* 左：笔记/标注面板开关 + TOC 下拉（悬停浮现） */}
        <div
          className={`flex h-full items-center justify-start gap-x-2 transition-opacity duration-300 ${
            showControls ? "opacity-100" : "opacity-0"
          }`}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="cursor-pointer" onClick={swapSidebars ? onToggleChat : onToggleNotes}>
                {(swapSidebars ? chatOpen : notesOpen) ? (
                  <TbLayoutSidebarLeftCollapseFilled className="size-5 text-neutral-700 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200" />
                ) : (
                  <TbLayoutSidebarLeftCollapse className="size-5 text-neutral-700 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200" />
                )}
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {(swapSidebars ? chatOpen : notesOpen) ? "收起" : "展开"}
              {swapSidebars ? "AI 面板" : "笔记面板"}
            </TooltipContent>
          </Tooltip>

          <DropdownMenu open={openDropdown === "toc"} onOpenChange={(open) => setOpenDropdown(open ? "toc" : null)}>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <button className="btn btn-ghost flex h-6 w-6 items-center justify-center rounded-full p-0 outline-none focus:outline-none focus-visible:ring-0">
                    <TableOfContents size={18} className="text-base-content" />
                  </button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom">目录</TooltipContent>
            </Tooltip>
            <DropdownMenuContent
              className="max-h-[calc(100vh-8rem)] w-80 overflow-y-auto p-2"
              align="start"
              side="bottom"
              sideOffset={4}
            >
              {toc.length === 0 ? (
                <div className="p-4 text-center text-muted-foreground text-sm">没有可用的目录</div>
              ) : (
                toc.map((item) => (
                  <Tooltip key={item.id}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className={cn(
                          "block w-full truncate rounded-md px-2 py-1.5 text-left text-sm",
                          item.id === activeHeadingId
                            ? "bg-neutral-100 font-medium text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100"
                            : "text-neutral-500 hover:bg-neutral-50 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800/60 dark:hover:text-neutral-300",
                        )}
                        style={{ paddingLeft: `${(item.level - minTocLevel) * 12 + 8}px` }}
                        onClick={() => {
                          onTocSelect(item.id);
                          setOpenDropdown(null);
                        }}
                      >
                        {item.text}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="right">{item.text}</TooltipContent>
                  </Tooltip>
                ))
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* 中：当前小节名称 */}
        <div className="flex min-w-0 flex-1 items-center justify-center px-4">
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className={`max-w-100 flex-shrink-0 overflow-hidden truncate whitespace-nowrap font-medium text-sm transition-colors duration-300 ${
                  showControls ? "text-neutral-800 dark:text-neutral-300" : "text-neutral-500 dark:text-neutral-600"
                }`}
              >
                {currentSection}
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">{currentSection}</TooltipContent>
          </Tooltip>
        </div>

        {/* 右：本文内搜索 + 设置 + AI 面板开关（悬停浮现） */}
        <div
          className={`flex h-full items-center justify-end space-x-2 ps-2 transition-opacity duration-300 ${
            showControls ? "opacity-100" : "opacity-0"
          }`}
        >
          <PaperSearchDropdown
            open={openDropdown === "search"}
            onOpenChange={handleSearchOpenChange}
            query={searchQuery}
            onQueryChange={onSearchQueryChange}
            matchCount={searchMatchCount}
            activeIndex={activeMatchIndex}
            onActiveIndexChange={onActiveMatchIndexChange}
          />
          <PaperTranslationDropdown
            open={openDropdown === "translate"}
            onOpenChange={(open) => setOpenDropdown(open ? "translate" : null)}
            viewMode={viewMode}
            onViewModeChange={onViewModeChange}
            hasTranslation={hasTranslation}
            translating={translating}
            onTranslate={onTranslate}
            onCancelTranslate={onCancelTranslate}
            alignInfo={alignInfo}
            aligning={aligning}
            onRebuildAlign={onRebuildAlign}
          />
          <PaperSettingsDropdown
            open={openDropdown === "settings"}
            onOpenChange={(open) => setOpenDropdown(open ? "settings" : null)}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="cursor-pointer" onClick={swapSidebars ? onToggleNotes : onToggleChat}>
                {(swapSidebars ? notesOpen : chatOpen) ? (
                  <TbLayoutSidebarRightCollapseFilled className="size-5 text-neutral-700 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200" />
                ) : (
                  <TbLayoutSidebarRightCollapse className="size-5 text-neutral-700 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200" />
                )}
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {(swapSidebars ? notesOpen : chatOpen) ? "收起" : "展开"}
              {swapSidebars ? "笔记面板" : "AI 面板"}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
