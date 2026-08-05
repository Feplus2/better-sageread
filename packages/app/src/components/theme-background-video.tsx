import { useThemeStore } from "@/store/theme-store";
import { useEffect, useState } from "react";

/**
 * 主题背景视频层（怜烟主题）：主题 CSS 通过自定义属性 `--bg-video: url(...)` 声明背景视频，
 * 本组件读取计算样式并挂载全屏循环播放层（亮暗模式由 CSS 的 :root / html.dark 分流）。
 * 未声明该属性的主题返回 null，零侵入。
 */
export function ThemeBackgroundVideo() {
  const globalTheme = useThemeStore((s) => s.globalTheme);
  const isDarkMode = useThemeStore((s) => s.isDarkMode);
  const [src, setSrc] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 依赖项仅作主题/亮暗变更的重读信号
  useEffect(() => {
    let cancelled = false;
    // 主题 CSS 注入是异步的：短轮询几次等 --bg-video 出现/消失
    const readVar = () => {
      const raw = getComputedStyle(document.documentElement).getPropertyValue("--bg-video").trim();
      const m = /url\(["']?([^"')]+)["']?\)/.exec(raw);
      return m ? m[1] : null;
    };
    let attempts = 0;
    const tick = () => {
      if (cancelled) return;
      const url = readVar();
      attempts += 1;
      if (url !== null || attempts >= 10) {
        setSrc(url);
        return;
      }
      setTimeout(tick, 60 * attempts);
    };
    tick();
    return () => {
      cancelled = true;
    };
  }, [globalTheme, isDarkMode]);

  if (!src) return null;

  return (
    <video
      key={src}
      src={src}
      autoPlay
      muted
      loop
      playsInline
      aria-hidden
      className="-z-10 pointer-events-none fixed inset-0 h-full w-full object-cover"
    />
  );
}
