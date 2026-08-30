import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type Tab, useLayoutStore } from "@/store/layout-store";
import { BookOpen, FileText, SquareX, X } from "lucide-react";
import { Fragment, useState } from "react";

/** 标签类型图标：论文 FileText、书籍 BookOpen */
function TabTypeIcon({ tab, className }: { tab: Tab; className: string }) {
  return (tab.type ?? "book") === "paper" ? <FileText className={className} /> : <BookOpen className={className} />;
}

/**
 * 垂直标签栏（仿 Edge 悬停浮现）：
 * - 常态为 48px 窄条（仅图标，作为浮层触发热区）；主页 / 切换横向两个控件在窗口顶栏左侧（reader-layout）
 * - 鼠标挪入窄条 → 详细信息面板以浮层形式向右浮现（absolute 定位，不推挤布局，带过渡动画）；
 *   鼠标移出窄条与浮层 → 自动缩回
 * - 标签列表可滚动、可拖拽排序、中键关闭，按类型分组（书籍在前、论文在后）
 */
export default function VerticalTabBar() {
  const { tabs, activeTabId, activateTab, removeTab, reorderTab, sleptTabIds, closeAllTabs } = useLayoutStore();

  const [dragTabId, setDragTabId] = useState<string | null>(null);
  const [hovered, setHovered] = useState(false);
  const [closeAllOpen, setCloseAllOpen] = useState(false);

  // 分组（携带原始索引，拖拽排序直接作用于 store 的 tabs 数组）
  const indexed = tabs.map((tab, index) => ({ tab, index }));
  const bookItems = indexed.filter(({ tab }) => (tab.type ?? "book") === "book");
  const paperItems = indexed.filter(({ tab }) => (tab.type ?? "paper") === "paper");
  const showGroupHeaders = bookItems.length > 0 && paperItems.length > 0;

  const handleDragOver = (e: React.DragEvent, targetIndex: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (!dragTabId) return;
    // 按 id 取最新位置：分组钳制后拖拽中的 tab 索引可能与上次记录漂移
    const currentTabs = useLayoutStore.getState().tabs;
    const fromIndex = currentTabs.findIndex((t) => t.id === dragTabId);
    if (fromIndex === -1 || fromIndex === targetIndex) return;
    reorderTab(dragTabId, fromIndex, targetIndex);
  };

  // ─── 窄条（常驻）：仅图标 ───
  // 窄条是浮层的触发热区，不再单独挂 Tooltip：悬停即展开浮层显示完整标题，
  // 若同时弹 Tooltip 会与浮层重叠（门户 z-50 在浮层之上）
  const collapsedGroup = (items: { tab: Tab; index: number }[], label: string) => {
    if (items.length === 0) return null;
    return (
      <Fragment key={label}>
        {showGroupHeaders && (
          <div className="mt-1.5 mb-0.5 w-full text-center text-[10px] text-neutral-400 leading-tight dark:text-neutral-500">
            {label}
          </div>
        )}
        {items.map(({ tab, index }) => (
          <div
            key={tab.id}
            draggable
            onDragStart={(e) => {
              setDragTabId(tab.id);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => handleDragOver(e, index)}
            onDragEnd={() => setDragTabId(null)}
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                removeTab(tab.id);
              }
            }}
            className={`group flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors ${
              tab.id === activeTabId
                ? "bg-neutral-200 text-neutral-900 dark:bg-neutral-700 dark:text-neutral-100"
                : "text-neutral-500 hover:bg-neutral-200 dark:text-neutral-400 dark:hover:bg-neutral-700"
            } ${dragTabId === tab.id ? "opacity-50" : sleptTabIds.includes(tab.id) ? "opacity-40" : ""}`}
            onClick={() => activateTab(tab.id)}
          >
            <TabTypeIcon tab={tab} className="size-4" />
          </div>
        ))}
      </Fragment>
    );
  };

  // ─── 悬停浮层：分组头 + 完整标签行 ───
  const expandedGroup = (items: { tab: Tab; index: number }[], label: string) => {
    if (items.length === 0) return null;
    return (
      <Fragment key={label}>
        {showGroupHeaders && (
          <div className="mt-2 mb-0.5 px-2 text-neutral-400 text-xs dark:text-neutral-500">{label}</div>
        )}
        {items.map(({ tab, index }) => (
          <Tooltip key={tab.id}>
            <TooltipTrigger asChild>
              <div
                draggable
                onDragStart={(e) => {
                  setDragTabId(tab.id);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(e) => handleDragOver(e, index)}
                onDragEnd={() => setDragTabId(null)}
                onAuxClick={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    removeTab(tab.id);
                  }
                }}
                className={`group flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-md px-2 text-[13px] transition-colors ${
                  tab.id === activeTabId
                    ? "bg-neutral-200 font-medium text-neutral-900 dark:bg-neutral-700 dark:text-neutral-100"
                    : "text-neutral-600 hover:bg-neutral-200/70 dark:text-neutral-400 dark:hover:bg-neutral-700/60"
                } ${dragTabId === tab.id ? "opacity-50" : sleptTabIds.includes(tab.id) ? "opacity-40" : ""}`}
                onClick={() => activateTab(tab.id)}
              >
                <TabTypeIcon tab={tab} className="size-4 shrink-0" />
                <span className="flex-1 truncate">{tab.title}</span>
                <button
                  type="button"
                  className={`flex size-5 shrink-0 items-center justify-center rounded transition-opacity hover:bg-neutral-300 dark:hover:bg-neutral-600 ${
                    tab.id === activeTabId ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                  }`}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeTab(tab.id);
                  }}
                  aria-label="关闭标签"
                >
                  <X className="size-3" />
                </button>
              </div>
            </TooltipTrigger>
            <TooltipContent side="right">{tab.title}</TooltipContent>
          </Tooltip>
        ))}
      </Fragment>
    );
  };

  return (
    <div
      data-region="vertical-tabs"
      className="relative w-12 shrink-0 select-none"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* 窄条（常驻，占位 48px） */}
      <div
        className="flex h-full w-12 flex-col items-center border-neutral-200 bg-tab-background py-2 dark:border-neutral-700"
        style={{ borderRightWidth: 1 }}
      >
        <div className="flex w-full flex-1 flex-col items-center gap-1 overflow-y-auto px-1.5">
          {collapsedGroup(bookItems, "书籍")}
          {collapsedGroup(paperItems, "论文")}
        </div>
        {/* 栏末：关闭所有标签页（窄条为视觉锚——悬停展开浮层后由浮层页脚承接点击，两处同一入口） */}
        {tabs.length > 0 && (
          <div className="flex w-full shrink-0 flex-col items-center gap-1 pt-1">
            <div className="h-px w-6 bg-neutral-200 dark:bg-neutral-700" />
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="关闭所有标签页"
                  onClick={() => setCloseAllOpen(true)}
                  className="flex size-8 shrink-0 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-200 hover:text-red-600 dark:text-neutral-400 dark:hover:bg-neutral-700 dark:hover:text-red-400"
                >
                  <SquareX className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">关闭所有标签页</TooltipContent>
            </Tooltip>
          </div>
        )}
      </div>

      {/* 详细信息浮层（absolute，不推挤布局；隐藏时 pointer-events-none 不挡交互） */}
      <div
        className={`absolute top-0 left-0 z-40 h-full w-[220px] border-neutral-200 bg-tab-background shadow-around transition-all duration-150 dark:border-neutral-700 ${
          hovered ? "pointer-events-auto translate-x-0 opacity-100" : "-translate-x-1 pointer-events-none opacity-0"
        }`}
        style={{ borderRightWidth: 1 }}
      >
        <div className="flex h-full flex-col">
          <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2 py-1">
            {expandedGroup(bookItems, "书籍")}
            {expandedGroup(paperItems, "论文")}
          </div>
          {/* 页脚：关闭所有标签页（浮层覆盖窄条，此处是可点入口；行样式沿用标签行视觉语言） */}
          {tabs.length > 0 && (
            <div className="shrink-0 border-neutral-200 border-t px-2 py-1 dark:border-neutral-700">
              <button
                type="button"
                onClick={() => setCloseAllOpen(true)}
                className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-[13px] text-neutral-600 transition-colors hover:bg-neutral-200/70 hover:text-red-600 dark:text-neutral-400 dark:hover:bg-neutral-700/60 dark:hover:text-red-400"
              >
                <SquareX className="size-4 shrink-0" />
                <span className="flex-1 truncate text-left">关闭所有标签页</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* 轻确认（阅读进度已持久化，无数据损失；确认只为防误点） */}
      <AlertDialog open={closeAllOpen} onOpenChange={setCloseAllOpen}>
        <AlertDialogContent className="sm:max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>关闭所有标签页</AlertDialogTitle>
            <AlertDialogDescription>
              将关闭全部 {tabs.length} 个阅读标签页（书籍与论文）并回到主页。阅读进度已自动保存，不会丢失。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={closeAllTabs}>全部关闭</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
