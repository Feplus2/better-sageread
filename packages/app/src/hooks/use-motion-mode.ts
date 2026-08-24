import { useAppSettingsStore } from "@/store/app-settings-store";
import { useEffect } from "react";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * 动效三档生效链（docs/motion-system-plan.md §五）：
 * settings.motionMode → <html data-motion="full|fade-only|reduced"> → index.css 的 token 变量档位。
 * system 档跟随系统 prefers-reduced-motion（命中等价 reduced，否则 full），监听变化实时切换。
 * 挂载点：ReaderLayout 顶层（全局唯一，HMR 重挂载幂等）。
 */
export function useMotionMode() {
  const motionMode = useAppSettingsStore((s) => s.settings.motionMode ?? "full");

  useEffect(() => {
    const root = document.documentElement;
    if (motionMode === "system") {
      const mediaQuery = window.matchMedia(REDUCED_MOTION_QUERY);
      const applySystem = () => {
        root.dataset.motion = mediaQuery.matches ? "reduced" : "full";
      };
      applySystem();
      mediaQuery.addEventListener("change", applySystem);
      return () => mediaQuery.removeEventListener("change", applySystem);
    }
    root.dataset.motion = motionMode;
  }, [motionMode]);
}
