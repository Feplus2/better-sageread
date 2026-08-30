import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useLayoutStore } from "@/store/layout-store";
import { useThemeStore } from "@/store/theme-store";
import { TableOfContents } from "lucide-react";
import { useRef } from "react";
import {
  TbLayoutSidebarLeftCollapse,
  TbLayoutSidebarLeftCollapseFilled,
  TbLayoutSidebarRightCollapse,
  TbLayoutSidebarRightCollapseFilled,
} from "react-icons/tb";
import { useAutoHideControls } from "../hooks/use-auto-hide-controls";
import { useReaderStore } from "./reader-provider";
import SearchDropdown from "./search-dropdown";
import SettingsDropdown from "./settings-dropdown";
import TOCView from "./toc-view";
import TranslateDropdown from "./translate-dropdown";

const HeaderBar = () => {
  const headerRef = useRef<HTMLDivElement>(null);

  const bookId = useReaderStore((state) => state.bookId);
  const bookDoc = useReaderStore((state) => state.bookData?.bookDoc);
  const progress = useReaderStore((state) => state.progress);
  const openDropdown = useReaderStore((state) => state.openDropdown);
  const setOpenDropdown = useReaderStore((state) => state.setOpenDropdown);
  const section = progress?.sectionLabel || "";

  // selector 订阅（切 tab 墙治理 2026-08-26）：整店订阅会被 activateTab 翻动拖出每次切换的重渲
  const isChatVisible = useLayoutStore((s) => s.isChatVisible);
  const isNotepadVisible = useLayoutStore((s) => s.isNotepadVisible);
  const toggleChatSidebar = useLayoutStore((s) => s.toggleChatSidebar);
  const toggleNotepadSidebar = useLayoutStore((s) => s.toggleNotepadSidebar);
  const { swapSidebars } = useThemeStore();

  const isTocDropdownOpen = openDropdown === "toc";

  const {
    isVisible: showControls,
    handleMouseEnter,
    handleMouseLeave,
  } = useAutoHideControls({
    keepVisible: Boolean(openDropdown),
  });

  const handleToggleTocDropdown = (isOpen: boolean) => {
    setOpenDropdown?.(isOpen ? "toc" : null);
  };

  const handleTocItemSelect = () => {
    setOpenDropdown?.(null);
  };

  return (
    <div className="w-full">
      <div
        ref={headerRef}
        className="header-bar pointer-events-auto flex h-10 w-full items-center px-2 pl-4 transition-all duration-300"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <div
          className={`flex h-full items-center justify-start gap-x-2 transition-opacity duration-300 ${
            showControls ? "opacity-100" : "opacity-0"
          }`}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="cursor-pointer" onClick={swapSidebars ? toggleChatSidebar : toggleNotepadSidebar}>
                {(swapSidebars ? isChatVisible : isNotepadVisible) ? (
                  <TbLayoutSidebarLeftCollapseFilled className="size-5 text-neutral-700 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200" />
                ) : (
                  <TbLayoutSidebarLeftCollapse className="size-5 text-neutral-700 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200" />
                )}
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {(swapSidebars ? isChatVisible : isNotepadVisible) ? "收起" : "展开"}
              {swapSidebars ? "AI 面板" : "笔记面板"}
            </TooltipContent>
          </Tooltip>

          <DropdownMenu open={isTocDropdownOpen} onOpenChange={handleToggleTocDropdown}>
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
              className="max-h-[calc(100vh-8rem)] w-80 overflow-y-auto p-0"
              align="start"
              side="bottom"
              sideOffset={4}
            >
              {bookDoc?.toc ? (
                <div className="h-full">
                  <TOCView
                    toc={bookDoc.toc}
                    bookId={bookId!}
                    autoExpand={true}
                    onItemSelect={handleTocItemSelect}
                    isVisible={isTocDropdownOpen}
                  />
                </div>
              ) : (
                <div className="p-4 text-center text-muted-foreground">没有可用的目录</div>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="flex min-w-0 flex-1 items-center justify-center gap-x-4 px-4">
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className={`max-w-100 flex-shrink-0 overflow-hidden truncate whitespace-nowrap font-medium text-sm transition-colors duration-300 ${
                  showControls ? "text-neutral-800 dark:text-neutral-300" : "text-neutral-500 dark:text-neutral-600"
                }`}
              >
                {section}
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">{section}</TooltipContent>
          </Tooltip>
        </div>

        <div
          className={`flex h-full items-center justify-end space-x-2 ps-2 transition-opacity duration-300 ${
            showControls ? "opacity-100" : "opacity-0"
          }`}
        >
          <SearchDropdown />
          <TranslateDropdown />
          <SettingsDropdown />
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="cursor-pointer" onClick={swapSidebars ? toggleNotepadSidebar : toggleChatSidebar}>
                {(swapSidebars ? isNotepadVisible : isChatVisible) ? (
                  <TbLayoutSidebarRightCollapseFilled className="size-5 text-neutral-700 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200" />
                ) : (
                  <TbLayoutSidebarRightCollapse className="size-5 text-neutral-700 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200" />
                )}
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {(swapSidebars ? isNotepadVisible : isChatVisible) ? "收起" : "展开"}
              {swapSidebars ? "笔记面板" : "AI 面板"}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
};

export default HeaderBar;
