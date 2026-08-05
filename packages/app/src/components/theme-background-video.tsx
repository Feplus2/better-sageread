import { useThemeStore } from "@/store/theme-store";
import { useEffect, useState } from "react";

/**
 * 主题背景视频层（怜烟主题）：主题 CSS 通过自定义属性声明背景视频与磨砂参数：
 *   --bg-video: url(...)   视频地址（:root / html.dark 分流亮暗）
 *   --bg-frost: blur(..) saturate(..)   磨砂强度（可选，默认 blur(16px) saturate(1.25)）
 * 结构：视频层 + 整屏磨砂层（viewport 固定尺寸，不做逐面 backdrop-filter——
 * 逐面 backdrop-filter 在拖拽布局时会产生残留合成块，且性能差）。
 * 未声明 --bg-video 的主题返回 null，零侵入。
 */
export function ThemeBackgroundVideo() {
  const globalTheme = useThemeStore((s) => s.globalTheme);
  const isDarkMode = useThemeStore((s) => s.isDarkMode);
  const [config, setConfig] = useState<{ src: string; frost: string } | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 依赖项仅作主题/亮暗变更的重读信号
  useEffect(() => {
    let cancelled = false;
    const readVars = () => {
      const cs = getComputedStyle(document.documentElement);
      const raw = cs.getPropertyValue("--bg-video").trim();
      const m = /url\(["']?([^"')]+)["']?\)/.exec(raw);
      if (!m) return null;
      const frost = cs.getPropertyValue("--bg-frost").trim() || "blur(16px) saturate(1.25)";
      return { src: m[1], frost };
    };
    let attempts = 0;
    const tick = () => {
      if (cancelled) return;
      const cfg = readVars();
      attempts += 1;
      // 主题注入是异步的：未读到时短轮询；读到（含确认无视频）即停
      if (cfg !== null || attempts >= 10) {
        setConfig(cfg);
        return;
      }
      setTimeout(tick, 60 * attempts);
    };
    tick();
    return () => {
      cancelled = true;
    };
  }, [globalTheme, isDarkMode]);

  if (!config) return null;

  return (
    <>
      <video
        key={config.src}
        src={config.src}
        autoPlay
        muted
        loop
        playsInline
        aria-hidden
        className="-z-20 pointer-events-none fixed inset-0 h-full w-full object-cover"
      />
      <div
        aria-hidden
        className="-z-10 pointer-events-none fixed inset-0"
        style={{ backdropFilter: config.frost, WebkitBackdropFilter: config.frost }}
      />
    </>
  );
}
