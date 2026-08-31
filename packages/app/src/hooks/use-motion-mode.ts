import { useAppSettingsStore } from "@/store/app-settings-store";
import { useEffect, useState } from "react";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

export type EffectiveMotionMode = "full" | "fade-only" | "reduced";

/**
 * 解析后的生效档位："system" 已按 prefers-reduced-motion 折算成 full/reduced，其余原样。
 * data-motion 写入（useMotionMode）与运行期消费者（动态壁纸冻结等 JS 侧判断）共用此口径，
 * 避免 system 档折算逻辑散落多处。
 */
export function useEffectiveMotionMode(): EffectiveMotionMode {
  const motionMode = useAppSettingsStore((s) => s.settings.motionMode ?? "full");
  const [systemReduced, setSystemReduced] = useState(
    () => typeof window !== "undefined" && window.matchMedia(REDUCED_MOTION_QUERY).matches,
  );

  useEffect(() => {
    const mediaQuery = window.matchMedia(REDUCED_MOTION_QUERY);
    const onChange = () => setSystemReduced(mediaQuery.matches);
    mediaQuery.addEventListener("change", onChange);
    return () => mediaQuery.removeEventListener("change", onChange);
  }, []);

  if (motionMode === "system") return systemReduced ? "reduced" : "full";
  return motionMode;
}

/**
 * 动效三档生效链（docs/archive/motion-system-plan.md §五）：
 * settings.motionMode → <html data-motion="full|fade-only|reduced"> → index.css 的 token 变量档位。
 * system 档跟随系统 prefers-reduced-motion（命中等价 reduced，否则 full），监听变化实时切换。
 * 挂载点：ReaderLayout 顶层（全局唯一，HMR 重挂载幂等）。
 */
export function useMotionMode() {
  const effectiveMode = useEffectiveMotionMode();

  useEffect(() => {
    document.documentElement.dataset.motion = effectiveMode;
  }, [effectiveMode]);
}
