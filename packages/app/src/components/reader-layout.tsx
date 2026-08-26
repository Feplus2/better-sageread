import GlobalConvertProgress from "@/components/global-convert-progress";
import HomeLayout from "@/components/home-layout";
import { renderInlineMathHtml } from "@/components/markdown/inline-math-text";
import { MotionSidebar, SidebarMotionPin, SidebarMotionProvider } from "@/components/motion/sidebar-motion";
import { NotepadContainer } from "@/components/notepad";
import NotificationDropdown from "@/components/notification-dropdown";
import { PreviewPanel } from "@/components/preview/preview-panel";
import SettingsDialog from "@/components/settings/settings-dialog";
import SideChat from "@/components/side-chat";
import SyncRefreshButton from "@/components/sync-refresh-button";
import { BottomRightStackHost } from "@/components/ui/bottom-right-stack";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { UpdateConfirmDialog } from "@/components/update-confirm-dialog";
import VerticalTabBar from "@/components/vertical-tab-bar";
import WindowControls from "@/components/window-controls";
import { useFontEvents } from "@/hooks/use-font-events";
import { useMotionMode } from "@/hooks/use-motion-mode";
import { useSyncEvents } from "@/hooks/use-sync-events";
import PaperReaderView from "@/pages/paper-reader/paper-reader-view";
import ReaderViewer from "@/pages/reader";
import { ReaderProvider } from "@/pages/reader/components/reader-provider";
import type { ReaderStore } from "@/pages/reader/store/create-reader-store";
import { applySyncResult } from "@/services/apply-sync-result";
import {
  type SyncRunResult,
  syncBackupNow,
  syncGetConfig,
  syncHasUnpushed,
  syncPullNow,
  syncRunNow,
} from "@/services/sync-service";
import { syncUiConfigNow } from "@/services/ui-config-sync";
import { useAppSettingsStore } from "@/store/app-settings-store";
import { markTabWoken, useLayoutStore } from "@/store/layout-store";
import { useThemeStore } from "@/store/theme-store";
import { useUpdateStore } from "@/store/update-store";
import { getOSPlatform } from "@/utils/misc";
import { useQueryClient } from "@tanstack/react-query";
import { Tabs } from "app-tabs";
import { HomeIcon, PanelLeft, PanelTop, Settings } from "lucide-react";
import { Resizable } from "re-resizable";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import appIconUrl from "../../src-tauri/icons/32x32.png";

/** 全局设置入口（窗口顶栏右侧，横向/纵向两种顶栏模式共用，全页面可点） */
function TopbarSettingsButton() {
  const { toggleSettingsDialog } = useAppSettingsStore();
  // 「有新版本」小红点（启动静默检查只置标志位，绝不弹框/下载——用户拍板的不打扰口径）
  const availableUpdate = useUpdateStore((s) => s.availableUpdate);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={toggleSettingsDialog}
          className="relative flex h-6 w-6 items-center justify-center rounded-full outline-none hover:bg-accent focus:outline-none focus-visible:ring-0 dark:hover:bg-accent"
        >
          <Settings size={18} />
          {availableUpdate && <span className="-top-0.5 -right-0.5 absolute h-2 w-2 rounded-full bg-red-500" />}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {availableUpdate ? `设置（有新版本 v${availableUpdate.version}）` : "设置"}
      </TooltipContent>
    </Tooltip>
  );
}

/** 书籍 tab 层内容（React.memo，2026-08-26 切 tab 墙治理）：
 * 层壳 data-active/inert 翻转留在 ReaderLayout 侧（廉价 div 属性）；
 * 本组件 props 全为原始值/稳定引用（store 来自 getReaderStore 的 Map 常驻）——
 * 切 tab 时未被涉及的层整树跳过 reconcile（治理前书籍层每次切换全量重渲 ~350ms，
 * 含 SideChat/ReaderViewer/foliate 壳与两个 Resizable 侧栏）。isActive 不入 props 是关键：
 * 涉及切换的两个 tab 也只翻层壳属性，子树不动。 */
const BookTabLayer = memo(function BookTabLayer({
  bookId,
  store,
  isSlept,
  isChatVisible,
  isNotepadVisible,
  swapSidebars,
  sidebarHeightClass,
  showOverlay = false,
}: {
  bookId: string;
  store: ReaderStore;
  isSlept: boolean;
  isChatVisible: boolean;
  isNotepadVisible: boolean;
  swapSidebars: boolean;
  sidebarHeightClass: string;
  /** 窗口 resize 遮罩（ReaderLayout 下发；翻转即重渲属预期——遮罩本就要此时显示） */
  showOverlay?: boolean;
}) {
  // 拖拽遮罩：窗口 resize 由 ReaderLayout 经 showOverlay prop 下发（每窗一次重渲属预期）；
  // 侧栏拖拽由层内 dragOverlay 自治（原共享态的可见行为逐像素等价）
  const [dragOverlay, setDragOverlay] = useState(false);
  // 批次 4 结束帧拆钉一次性 reflow（detail 同拖拽处现有用法）；useCallback 钉死保 memo
  const handleMotionReflow = useCallback(() => {
    window.dispatchEvent(new CustomEvent("foliate-resize-update", { detail: { bookId, source: "sidebar-motion" } }));
  }, [bookId]);
  const handleResizeStart = useCallback(() => setDragOverlay(true), []);
  const handleResizeStop = useCallback(() => {
    setDragOverlay(false);
    window.dispatchEvent(new CustomEvent("foliate-resize-update", { detail: { bookId, source: "resize-drag" } }));
  }, [bookId]);

  // 批次 4：侧栏经 MotionSidebar 滑入滑出（冻结式，裁定三口径 2）——触发语义不变，
  // 壳只加一层 h-full 包裹 div，终态布局/宽度/间距与硬切时代逐像素一致
  const notepadSidebar = (
    <MotionSidebar open={isNotepadVisible} side={swapSidebars ? "right" : "left"}>
      <Resizable
        defaultSize={{
          width: 360,
          height: "100%",
        }}
        minWidth={260}
        maxWidth={800}
        enable={{
          top: false,
          right: !swapSidebars,
          bottom: false,
          left: swapSidebars,
          topRight: false,
          bottomRight: false,
          bottomLeft: false,
          topLeft: false,
        }}
        handleComponent={
          swapSidebars
            ? { left: <div className="custom-resize-handle" /> }
            : { right: <div className="custom-resize-handle custom-resize-handle-left" /> }
        }
        // 手柄感应区收回面板内（默认跨界 10px 会盖住邻居阅读区右缘的滚动条）
        handleStyles={{ left: { left: "0px" }, right: { right: "0px" } }}
        className="h-full"
        onResize={handleResizeStart}
        onResizeStop={handleResizeStop}
      >
        <div
          data-region="notepad-panel"
          className={swapSidebars ? `ml-1 ${sidebarHeightClass}` : `mr-1 ${sidebarHeightClass}`}
        >
          <NotepadContainer bookId={bookId} />
        </div>
      </Resizable>
    </MotionSidebar>
  );

  const chatSidebar = (
    <MotionSidebar open={isChatVisible} side={swapSidebars ? "left" : "right"}>
      <Resizable
        defaultSize={{
          width: 370,
          height: "100%",
        }}
        minWidth={320}
        maxWidth={800}
        enable={{
          top: false,
          right: swapSidebars,
          bottom: false,
          left: !swapSidebars,
          topRight: false,
          bottomRight: false,
          bottomLeft: false,
          topLeft: false,
        }}
        handleComponent={
          swapSidebars
            ? { right: <div className="custom-resize-handle custom-resize-handle-left" /> }
            : { left: <div className="custom-resize-handle" /> }
        }
        // 手柄感应区收回面板内（默认跨界 10px 会盖住邻居阅读区右缘的滚动条）
        handleStyles={{ left: { left: "0px" }, right: { right: "0px" } }}
        className="h-full"
        onResize={handleResizeStart}
        onResizeStop={handleResizeStop}
      >
        <div
          className={
            swapSidebars ? `mr-1 ${sidebarHeightClass} rounded-md` : `m-1 mt-0 ${sidebarHeightClass} rounded-md`
          }
        >
          <SideChat key={`chat-${bookId}`} bookId={bookId} />
        </div>
      </Resizable>
    </MotionSidebar>
  );

  return (
    <ReaderProvider store={store}>
      {/* 批次 4：侧栏开合冻结编排——动画期间内容钉层宽度钉死（EPUB 不逐帧重分页），
          结束帧拆钉一次性 reflow，此时才发一次 foliate-resize-update（detail 同拖拽处现有用法） */}
      <SidebarMotionProvider onReflow={handleMotionReflow}>
        {swapSidebars && <PreviewPanel />}
        {swapSidebars ? chatSidebar : notepadSidebar}

        <div className="relative min-w-0 flex-1 rounded-md border shadow-around">
          {/* 内容钉层：正常态纯透传（h-full 无样式差异）；冻结态钉宽+裁剪由编排器内联控制 */}
          <SidebarMotionPin className="h-full">
            {/* P2 休眠态：卸载 foliate 视图（阅读位置由 reader store 恢复），侧栏/聊天保活 */}
            {!isSlept && <ReaderViewer />}
          </SidebarMotionPin>

          {showOverlay || dragOverlay ? (
            <div className="absolute inset-0 z-50 flex items-center justify-center rounded-md bg-background/80 backdrop-blur-sm dark:bg-neutral-900/60" />
          ) : null}
        </div>

        {swapSidebars ? notepadSidebar : chatSidebar}
        {!swapSidebars && <PreviewPanel />}
      </SidebarMotionProvider>
    </ReaderProvider>
  );
});

export default function ReaderLayout() {
  useFontEvents();
  useSyncEvents();
  useMotionMode();
  const {
    tabs,
    activeTabId,
    isHomeActive,

    removeTab,
    activateTab,
    navigateToHome,
    reorderTab,
    getReaderStore,
    isChatVisible,
    isNotepadVisible,
    tabOrientation,
    toggleTabOrientation,
  } = useLayoutStore();
  const { isDarkMode, swapSidebars } = useThemeStore();
  const { isSettingsDialogOpen, toggleSettingsDialog } = useAppSettingsStore();
  const queryClient = useQueryClient();

  const resizeTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [showOverlay, setShowOverlay] = useState(false);

  const isWindows = getOSPlatform() === "windows";
  const isVertical = tabOrientation === "vertical";
  // 侧边栏高度：横向模式标签栏 36px，纵向模式窄顶条 32px，另加 main 的 p-1 和余量
  const sidebarHeightClass = isVertical ? "h-[calc(100dvh-44px)]" : "h-[calc(100dvh-48px)]";

  // ─── P2 标签页休眠（性能优化，2026-08-08）───
  // 只卸重型阅读视图（论文 PaperReader / 书籍 ReaderViewer），侧栏与聊天保活（护流式任务）；
  // 阅读状态在 zustand store 中独立于视图，切回重挂载自动恢复。
  // 双条件：宽限期内切回零成本；挂载数超上限时 LRU 立即休眠（防多开堆积）。
  const TAB_SLEEP_GRACE_MS = 10 * 60 * 1000;
  const TAB_MOUNT_LIMIT = 6;
  // 休眠清单存 layout-store：横排/竖排标签栏据此降透明度提示（不持久化）
  const sleptTabIds = useLayoutStore((s) => s.sleptTabIds);
  const sleptTabs = useMemo(() => new Set(sleptTabIds), [sleptTabIds]);
  const lastActiveRef = useRef(new Map<string, number>());

  // 激活即唤醒 + 刷新活跃时间；顺手清理已关闭 tab 的残留 id
  useEffect(() => {
    if (activeTabId) lastActiveRef.current.set(activeTabId, Date.now());
    const { sleptTabIds: prev, setSleptTabIds } = useLayoutStore.getState();
    if (prev.length === 0) return;
    const tabIds = new Set(useLayoutStore.getState().tabs.map((t) => t.id));
    // 唤醒的 tab 先打一次性标记：重挂载的开书快拉据此静默（不弹进度同步 toast）
    if (activeTabId && prev.includes(activeTabId)) markTabWoken(activeTabId);
    setSleptTabIds(prev.filter((id) => id !== activeTabId && tabIds.has(id)));
  }, [activeTabId]);

  // 启动静默检查更新（每启动一次）：只置 availableUpdate 标志位喂小红点，
  // 绝不弹框/下载（不打扰口径，2026-08-25 用户拍板）
  useEffect(() => {
    void useUpdateStore.getState().silentCheck();
  }, []);

  // 新增 tab 时写入基准时间：避免"开新 tab 放置超宽限期→下个巡检立即休眠"的突然行为
  useEffect(() => {
    const now = Date.now();
    for (const t of tabs) {
      if (!lastActiveRef.current.has(t.id)) lastActiveRef.current.set(t.id, now);
    }
  }, [tabs]);

  // 定时巡检：宽限期到期或 LRU 超限则休眠
  useEffect(() => {
    const timer = setInterval(() => {
      const {
        tabs,
        activeTabId: activeId,
        sleptTabIds: prev,
        setSleptTabIds,
        getReaderStore,
      } = useLayoutStore.getState();
      const now = Date.now();
      const next = new Set(prev);
      if (activeId) next.delete(activeId);
      // PDF 标签页永不休眠：原生 iframe 渲染没有阅读位置恢复通道，休眠重挂载后用户会丢阅读位置
      const isPdfTab = (tabId: string) => getReaderStore(tabId)?.getState().bookData?.book?.format === "PDF";
      // LRU 硬上限：挂载数超限时从最久未活跃的开始休眠
      let mounted = tabs.filter((t) => !next.has(t.id));
      if (mounted.length > TAB_MOUNT_LIMIT) {
        const oldestFirst = mounted
          .filter((t) => t.id !== activeId && !isPdfTab(t.id))
          .sort((a, b) => (lastActiveRef.current.get(a.id) ?? 0) - (lastActiveRef.current.get(b.id) ?? 0));
        for (const t of oldestFirst) {
          if (mounted.length <= TAB_MOUNT_LIMIT) break;
          next.add(t.id);
          mounted = mounted.filter((m) => m.id !== t.id);
        }
      }
      // 宽限期：非活动超阈值 → 休眠（新增 tab 已由上方 effect 写入基准时间）
      for (const t of tabs) {
        if (t.id === activeId || next.has(t.id) || isPdfTab(t.id)) continue;
        const last = lastActiveRef.current.get(t.id) ?? now;
        if (now - last > TAB_SLEEP_GRACE_MS) next.add(t.id);
      }
      setSleptTabIds([...next]);
    }, 30_000);
    return () => clearInterval(timer);
  }, []);

  // 启动时应用持久化的全局主题（值来自 localStorage 同步读取，无异步恢复闪烁）
  useEffect(() => {
    const { refreshGlobalThemes, setGlobalTheme, globalTheme } = useThemeStore.getState();
    refreshGlobalThemes().then(() => {
      if (globalTheme) {
        setGlobalTheme(globalTheme);
      }
    });
  }, []);

  // WebDAV 自动备份（运行期配置自检，与 L2 调度同款）：60 秒基础 tick 重读配置，
  // off/hourly/daily 改动即时生效（原版只在挂载时读一次，改了配置要刷新才生效）。
  // 备份自身有整包哈希门控——数据无变化零流量，到点空转代价可忽略。
  useEffect(() => {
    let cancelled = false;
    let backingUp = false;
    let lastBackupAt = 0;

    const tick = async () => {
      if (cancelled || backingUp) return;
      let config: Awaited<ReturnType<typeof syncGetConfig>>;
      try {
        config = await syncGetConfig();
      } catch {
        return;
      }
      if (cancelled || !config || config.auto_backup === "off" || !config.endpoint) return;
      const intervalMs = config.auto_backup === "hourly" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
      if (Date.now() - lastBackupAt < intervalMs) return;
      backingUp = true;
      lastBackupAt = Date.now();
      try {
        await syncBackupNow();
      } catch (error) {
        console.warn("自动备份失败:", error);
      } finally {
        backingUp = false;
      }
    };

    const timer = setInterval(() => {
      void tick();
    }, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // L2 增量同步调度（P1 修复 + 运行期配置自检）：
  // 固定 25 秒基础 tick——每轮重读配置（l2_enabled/频率改动即时生效，无需重启或刷新）；
  // dirty 立即完整同步（推+拉，不受频率下拉影响）；clean 时按 sync_frequency 兜底轻量拉取
  // （syncPullNow：远端无新意时只有一个小 GET，无变更零下载）。启动时自动一轮照旧。
  // 空闲调度：用户活跃交互时跳过同步，放下书 10 秒后自动同步。
  // biome-ignore lint/correctness/useExhaustiveDependencies: queryClient 实例稳定，定时器只需注册一次
  useEffect(() => {
    let cancelled = false;
    let syncing = false;
    let lastPullAt = 0;
    let lastInteraction = Date.now();

    // 空闲检测：监听用户交互事件
    const markActive = () => {
      lastInteraction = Date.now();
    };
    const interactionEvents = ["click", "keydown", "wheel", "touchstart"] as const;
    for (const evt of interactionEvents) {
      window.addEventListener(evt, markActive, { passive: true });
    }
    const isIdle = () => Date.now() - lastInteraction >= 10_000;

    const handleResult = (result: SyncRunResult) => {
      void applySyncResult(result, queryClient);
      // 每轮 Rust 同步后附带一轮 UI 配置同步（背景选择/辅助模型，前端 LWW）
      void syncUiConfigNow();
      // 自动同步完全静默：不弹 toast、不写通知中心（仅手动同步才有反馈）
    };

    const runWith = (fn: () => Promise<SyncRunResult>) => {
      if (syncing) return;
      syncing = true;
      fn()
        .then(handleResult)
        .catch((error) => console.warn("L2 同步失败:", error))
        .finally(() => {
          syncing = false;
        });
    };

    const pullFallbackMsOf = (frequency: string) =>
      frequency === "30min"
        ? 30 * 60_000
        : frequency === "5min"
          ? 5 * 60_000
          : frequency === "off"
            ? Number.POSITIVE_INFINITY
            : 30_000;

    // 每轮自检配置：未启用/未配置端点则空转（25s 一次轻量读，代价可忽略）
    const tick = async () => {
      if (cancelled || syncing || !isIdle()) return;
      let config: Awaited<ReturnType<typeof syncGetConfig>>;
      try {
        config = await syncGetConfig();
      } catch {
        return;
      }
      if (cancelled || !config || !config.l2_enabled || !config.endpoint) return;
      try {
        const dirty = await syncHasUnpushed();
        if (dirty) {
          runWith(syncRunNow); // 有变更：立即推+拉
          lastPullAt = Date.now();
        } else if (Date.now() - lastPullAt >= pullFallbackMsOf(config.sync_frequency)) {
          runWith(syncPullNow); // 无变更：按兜底频率轻量拉取
          lastPullAt = Date.now();
        }
      } catch (error) {
        console.warn("L2 水位检查失败:", error);
      }
    };

    // 启动时自动一轮完整同步（仅当已启用）
    void (async () => {
      try {
        const config = await syncGetConfig();
        if (cancelled || !config || !config.l2_enabled || !config.endpoint) return;
        runWith(syncRunNow);
        lastPullAt = Date.now();
      } catch (error) {
        console.warn("L2 同步调度初始化失败:", error);
      }
    })();

    const timer = setInterval(() => {
      void tick();
    }, 25_000);

    // 网络恢复时立即一轮同步（dirty 推+拉，clean 轻量拉取）
    const onOnline = () => {
      void (async () => {
        try {
          const config = await syncGetConfig();
          if (cancelled || !config || !config.l2_enabled || !config.endpoint) return;
          const dirty = await syncHasUnpushed();
          runWith(dirty ? syncRunNow : syncPullNow);
          lastPullAt = Date.now();
        } catch (error) {
          console.warn("L2 水位检查失败:", error);
        }
      })();
    };
    window.addEventListener("online", onOnline);

    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener("online", onOnline);
      for (const evt of interactionEvents) {
        window.removeEventListener(evt, markActive);
      }
    };
  }, []);

  useEffect(() => {
    const handleResize = () => {
      setShowOverlay(true);

      if (resizeTimeoutRef.current) {
        clearTimeout(resizeTimeoutRef.current);
      }

      resizeTimeoutRef.current = setTimeout(() => {
        setShowOverlay(false);
      }, 200);
    };

    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      if (resizeTimeoutRef.current) {
        clearTimeout(resizeTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const isCloseShortcut =
        (event.metaKey && event.key === "w" && event.code === "KeyW") ||
        (event.ctrlKey && event.key === "w" && event.code === "KeyW");

      if (isCloseShortcut) {
        event.preventDefault();
        if (activeTabId && activeTabId !== "home") {
          removeTab(activeTabId);
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [activeTabId, removeTab]);

  return (
    <div className="flex h-screen flex-col bg-muted">
      {isVertical ? (
        <div
          data-tauri-drag-region
          data-region="reader-tabs"
          className="relative flex h-8 shrink-0 select-none items-center bg-tab-background pr-1"
          style={isWindows ? undefined : { paddingLeft: 70 }}
        >
          {/* 左侧顶格：主页 / 切换横向标签。
              控件尺寸与颜色与横向 pinnedLeft 完全一致；容器带 drag region，按钮本身不触发拖动 */}
          <div data-tauri-drag-region className="mx-2 flex items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="cursor-pointer" onClick={navigateToHome}>
                  <HomeIcon className="size-5 text-neutral-700 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200" />
                </div>
              </TooltipTrigger>
              <TooltipContent side="bottom">主页</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="cursor-pointer" onClick={toggleTabOrientation}>
                  <PanelTop className="size-5 text-neutral-700 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200" />
                </div>
              </TooltipTrigger>
              <TooltipContent side="bottom">切换到横向标签</TooltipContent>
            </Tooltip>
          </div>

          {/* 居中：应用图标 + 名称（垂直模式顶栏无 tab 条，品牌居中；横向模式在 tab 栏 pinnedLeft，不重复）。
              pointer-events-none：鼠标落到下层 drag region，品牌区也能拖窗 */}
          <div className="-translate-x-1/2 pointer-events-none absolute left-1/2 flex items-center gap-1.5">
            <img src={appIconUrl} alt="" className="size-4" />
            <span className="font-medium text-neutral-600 text-xs dark:text-neutral-400">Better SageRead</span>
          </div>

          <div data-tauri-drag-region className="flex flex-1 items-center justify-end gap-1">
            <SyncRefreshButton />
            <NotificationDropdown />
            <TopbarSettingsButton />
            <WindowControls />
          </div>
        </div>
      ) : (
        <div
          data-region="reader-tabs"
          className="select-none border-neutral-200 bg-tab-background dark:border-neutral-700"
        >
          <Tabs
            tabs={tabs.map((t) => ({ ...t, dimmed: sleptTabs.has(t.id) }))}
            onTabActive={activateTab}
            onTabClose={removeTab}
            onTabReorder={reorderTab}
            draggable={true}
            darkMode={isDarkMode}
            className="h-7"
            enableDragRegion={true}
            marginLeft={isWindows ? 0 : 60}
            renderTabTitleHtml={renderInlineMathHtml}
            pinnedLeft={
              <div className="mx-2 flex items-center gap-2">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="cursor-pointer" onClick={navigateToHome}>
                      <HomeIcon className="size-5 text-neutral-700 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200" />
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">主页</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="cursor-pointer" onClick={toggleTabOrientation}>
                      <PanelLeft className="size-5 text-neutral-700 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200" />
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">切换到垂直标签</TooltipContent>
                </Tooltip>
              </div>
            }
            pinnedRight={
              <div className="flex items-center gap-1">
                <SyncRefreshButton />
                <NotificationDropdown />
                <TopbarSettingsButton />
                <WindowControls />
              </div>
            }
          />
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {isVertical && <VerticalTabBar />}

        {/* overflow-clip 而非 overflow-hidden：hidden 仍是编程式滚动容器，任何 scrollIntoView
            （书籍 TOC/聊天工具卡等）都会把 main 滚出 20px 左右，整版面上移没入顶栏（2026-08-13 复发根因）；
            clip 不是滚动容器，scrollTop 恒 0，从机制上免疫 */}
        <main className="relative flex-1 overflow-clip rounded-md">
          {/* 保活层可见性改走 .tab-layer + data-active（index.css 批次 3）：
              硬切 → 交叉淡入 + 位移归位；zIndex 语义不变（active=1 否则 0），休眠/保活逻辑不动。
              非活跃层 inert + aria-hidden：opacity 隐藏模型下无 visibility 遮挡，
              焦点/键盘/无障碍树隔离由这两个属性兜底（visibility 模型下同属 belt+braces） */}
          <div
            className="tab-layer absolute inset-0"
            data-active={isHomeActive}
            inert={!isHomeActive}
            aria-hidden={!isHomeActive || undefined}
          >
            <HomeLayout />
          </div>

          {tabs.map((tab) => {
            // 论文 tab：三段式阅读视图（左笔记占位 | 中 PaperHeaderBar+PaperReader | 右论文助手），无 foliate reader store
            if ((tab.type ?? "book") === "paper") {
              const isActiveTab = tab.id === activeTabId;
              return (
                <div
                  key={tab.id}
                  className="tab-layer absolute inset-0 flex bg-background p-1"
                  data-active={isActiveTab}
                  inert={!isActiveTab}
                  aria-hidden={!isActiveTab || undefined}
                >
                  <PaperReaderView paperId={tab.bookId} title={tab.title} viewSleeping={sleptTabs.has(tab.id)} />
                </div>
              );
            }

            // 书籍 tab：层壳（data-active/inert 翻转）留在本层，内容树抽成 memo 的 BookTabLayer——
            // 切 tab 只翻层壳属性，子树（侧栏/聊天/foliate 壳）整树跳过 reconcile（2026-08-26 切 tab 墙治理）
            const store = getReaderStore(tab.id);
            if (!store) return null;

            return (
              <div
                key={tab.id}
                className="tab-layer absolute inset-0 flex bg-background p-1"
                data-active={tab.id === activeTabId}
                inert={tab.id !== activeTabId}
                aria-hidden={tab.id !== activeTabId || undefined}
              >
                <BookTabLayer
                  bookId={tab.bookId}
                  store={store}
                  isSlept={sleptTabs.has(tab.id)}
                  isChatVisible={isChatVisible}
                  isNotepadVisible={isNotepadVisible}
                  swapSidebars={swapSidebars}
                  sidebarHeightClass={sidebarHeightClass}
                  showOverlay={showOverlay}
                />
              </div>
            );
          })}
        </main>
      </div>

      {/* 全局转换进度层（论文解析卡 + 图书转换小卡；阅读器/聊天页豁免，见组件注释） */}
      <GlobalConvertProgress />
      <BottomRightStackHost />
      {/* 更新确认框全局挂载（update-store 驱动；仅设置页手动「检查更新」触发，启动不自动检查） */}
      <UpdateConfirmDialog />

      <SettingsDialog open={isSettingsDialogOpen} onOpenChange={toggleSettingsDialog} />
    </div>
  );
}
