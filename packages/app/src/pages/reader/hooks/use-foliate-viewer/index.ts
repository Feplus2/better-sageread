import { useUICSS } from "@/hooks/use-ui-css";
import type { BookDoc } from "@/lib/document";
import { applySyncResult } from "@/services/apply-sync-result";
import { getBookStatus } from "@/services/book-service";
import { syncGetConfig, syncPullNow } from "@/services/sync-service";
import { useAppSettingsStore } from "@/store/app-settings-store";
import { consumeTabWoken } from "@/store/layout-store";
import { useThemeStore } from "@/store/theme-store";
import type { BookConfig } from "@/types/book";
import type { ViewSettings } from "@/types/book";
import type { Insets } from "@/types/misc";
import type { FoliateView } from "@/types/view";
import { applyFixedlayoutStyles, getStyles } from "@/utils/style";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useReaderStoreApi } from "../../components/reader-provider";
import { useMouseEvent } from "../use-iframe-events";
import { usePagination } from "../use-pagination";
import { useProgressAutoSave } from "../use-progress-auto-save";
import { FoliateViewerManager, type ProgressData } from "./foliate-viewer-manager";

export const useFoliateViewer = (bookId: string, bookDoc: BookDoc, config: BookConfig, insets: Insets) => {
  const store = useReaderStoreApi();
  const { themeCode, isDarkMode } = useThemeStore();
  const { settings, setSettings } = useAppSettingsStore();

  const containerRef = useRef<HTMLDivElement>(null);
  const managerRef = useRef<FoliateViewerManager | null>(null);
  const viewRef = useRef<FoliateView | null>(null);
  const isInitialized = useRef(false);
  const [, forceUpdate] = useState({});
  const queryClient = useQueryClient();

  useUICSS(bookId);
  useProgressAutoSave(bookId);

  // biome-ignore lint/correctness/useExhaustiveDependencies: <explanation>
  useEffect(() => {
    if (isInitialized.current || !containerRef.current) {
      console.log(
        "[useFoliateViewer] Skipping init - isInitialized:",
        isInitialized.current,
        "containerRef:",
        !!containerRef.current,
      );
      return;
    }

    console.log("[useFoliateViewer] Starting initialization");
    isInitialized.current = true;

    (async () => {
      // 打开书单点快拉（L2）：~1.5s 超时，超时/失败静默放行本地位置
      // 休眠唤醒的重挂载不算开书：消费唤醒标记走静默快拉（仍拉远端进度，但不弹 toast 扰民）
      const silentPull = consumeTabWoken(`reader-${bookId}`);
      try {
        const syncConfig = await syncGetConfig();
        if (syncConfig?.l2_enabled && syncConfig.endpoint) {
          const pullResult = await Promise.race([
            syncPullNow(),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
          ]);

          if (pullResult?.book_status_ids?.includes(bookId)) {
            // 远端进度更新：以远端位置打开（只写内存 config 供 foliate init 使用；
            // 不落库——config 里的 progress/lastReadAt 是拉取前的旧值，回写会覆盖远端刚应用的行，
            // 由后续正常进度保存落库）
            const status = await getBookStatus(bookId);
            if (status?.location) {
              config.location = status.location;
              const percent =
                status.progressTotal > 0 ? Math.round((status.progressCurrent / status.progressTotal) * 100) : 0;
              // 休眠唤醒的静默快拉不弹 toast；正常开书保留提示
              if (!silentPull) {
                toast.info(`已同步另一台设备的进度（第 ${percent}%）`);
              }
            }
          }

          if (pullResult) {
            // 缓存刷新统一走共享函数（threads/划线/笔记/书架；此处 view 尚未创建，进度跳转由上面开书位置兜底）
            await applySyncResult(pullResult, queryClient);
          }
        }
      } catch (error) {
        console.warn("打开书同步快拉失败（放行本地）:", error);
      }

      const manager = new FoliateViewerManager({
        bookId,
        bookDoc,
        config,
        insets,
        container: containerRef.current!,
        globalViewSettings: settings.globalViewSettings,
        onViewCreated: (view) => {
          store.getState().setView(view);
          viewRef.current = view;
        },
      });

      manager.setProgressCallback((progress: ProgressData) => {
        store.getState().setProgress(progress);
        store.getState().setLocation(progress.location);
      });

      manager.setViewSettingsCallback((updatedSettings: ViewSettings) => {
        // 读最新设置而非挂载时的 settings 快照：挂载后用户改过设置时，旧快照回写会覆盖新值（陈旧闭包）
        const { settings: currentSettings } = useAppSettingsStore.getState();
        setSettings({
          ...currentSettings,
          globalViewSettings: updatedSettings,
        });
      });

      managerRef.current = manager;

      manager
        .initialize()
        .then(() => {
          forceUpdate({});
        })
        .catch((error) => {
          console.error("Failed to initialize foliate viewer:", error);
        });
    })();

    return () => {
      if (managerRef.current) {
        managerRef.current.destroy();
        managerRef.current = null;
      }
      viewRef.current = null;
      isInitialized.current = false;
    };
  }, []);

  // 书籍样式只在"书籍侧相关"字段变化时重注入：
  // 遮罩浓度/场景图片切换只影响应用侧容器背景（reader-viewer.tsx），不触发这里
  const bookBgMode = themeCode.backgroundImage ? "image" : "solid";
  // biome-ignore lint/correctness/useExhaustiveDependencies: <explanation>
  useEffect(() => {
    const view = managerRef.current?.getView();
    if (view?.renderer && isInitialized.current) {
      const styles = getStyles(settings.globalViewSettings, themeCode);
      view.renderer.setStyles?.(styles);

      if (bookDoc.rendition?.layout === "pre-paginated") {
        const docs = view.renderer.getContents();
        docs.forEach(({ doc }) => applyFixedlayoutStyles(doc, settings.globalViewSettings, themeCode));
      }
    }
  }, [
    themeCode.fg,
    themeCode.palette,
    themeCode.texture,
    bookBgMode,
    isDarkMode,
    settings.globalViewSettings,
    bookDoc.rendition?.layout,
  ]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: <explanation>
  useEffect(() => {
    const view = managerRef.current?.getView();
    if (view?.renderer && isInitialized.current) {
      // 双向校正：陈旧链路曾把分页冲回 scrolled，这里以 store 为准强制还原
      view.renderer.setAttribute("flow", settings.globalViewSettings.scrolled ? "scrolled" : "paginated");
    }
  }, [insets.top, insets.right, insets.bottom, insets.left, settings.globalViewSettings]);

  // 设置面板变更时同步 manager 的 config 快照与 StyleManager：
  // 否则章节加载/resize 会用陈旧快照回写 store，把分页选择冲回滚动模式
  useEffect(() => {
    if (isInitialized.current) {
      managerRef.current?.syncGlobalViewSettings(settings.globalViewSettings);
    }
  }, [settings.globalViewSettings]);

  const { handlePageFlip, handleContinuousScroll } = usePagination(
    bookId,
    containerRef as React.RefObject<HTMLDivElement>,
  );

  const mouseHandlers = useMouseEvent(bookId, handlePageFlip, handleContinuousScroll);

  const refresh = async () => {
    if (managerRef.current) {
      await managerRef.current.refresh();
    }
  };

  return {
    containerRef,
    mouseHandlers,
    refresh,
    getView: () => managerRef.current?.getView() || null,
  } as const;
};

export default useFoliateViewer;
