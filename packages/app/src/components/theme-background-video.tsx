import { useEffectiveMotionMode } from "@/hooks/use-motion-mode";
import { useThemeStore } from "@/store/theme-store";
import { useEffect, useRef, useState } from "react";

/**
 * 主题背景视频层（怜烟主题）：主题 CSS 通过自定义属性声明背景视频与磨砂参数：
 *   --bg-video: url(...)   视频地址（:root / html.dark 分流亮暗）
 *   --bg-frost: blur(..) saturate(..)   磨砂强度（可选，默认 blur(16px) saturate(1.25)）
 * 结构：视频层 + 整屏磨砂层（viewport 固定尺寸，不做逐面 backdrop-filter——
 * 逐面 backdrop-filter 在拖拽布局时会产生残留合成块，且性能差）。
 * 未声明 --bg-video 的主题返回 null，零侵入。
 *
 * 性能门控（motion-system-plan.md §5.4）：生效动效档位非 full 时冻结为静态帧
 * （pause 停在当前画面），解码与逐帧合成归零；对任何 --bg-video 视频壁纸普适。
 */
export function ThemeBackgroundVideo() {
  const globalTheme = useThemeStore((s) => s.globalTheme);
  const isDarkMode = useThemeStore((s) => s.isDarkMode);
  const effectiveMotionMode = useEffectiveMotionMode();
  const [config, setConfig] = useState<{ src: string; frost: string } | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

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

  // 播放控制走命令式（不依赖 autoPlay 属性）：full 档播放，其余冻结。
  // 冻结而非卸载：全局画布 --background 是半透明遮罩，卸掉视频层会透出 html 白底。
  // biome-ignore lint/correctness/useExhaustiveDependencies: config.src 变更会经 key 重建 video 元素，重挂后须重放播放/冻结控制
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (effectiveMotionMode === "full") {
      video.play().catch(() => {}); // autoplay 策略拦截时保持静态帧，不致命
      return;
    }
    // 首帧未解码时 pause 会渲染成透明，须等 loadeddata 再停
    const freeze = () => video.pause();
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      freeze();
    } else {
      video.addEventListener("loadeddata", freeze, { once: true });
    }
    return () => video.removeEventListener("loadeddata", freeze);
  }, [effectiveMotionMode, config?.src]);

  if (!config) return null;

  return (
    <>
      <video
        key={config.src}
        ref={videoRef}
        src={config.src}
        preload="auto"
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
