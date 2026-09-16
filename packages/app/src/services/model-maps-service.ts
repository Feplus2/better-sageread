import { adoptRemoteReasoningMap } from "@/ai/providers/reasoning-map";
import { adoptRemoteVisionMap } from "@/ai/providers/vision-map";
/**
 * 模型映射表远程热更新（2026-09-14）：site/maps 托管 JSON + 远程优先、本地兜底。
 *
 * 启动后异步拉取 site/maps 下的两张表（视觉/思考），校验形状与版本后整表热替换
 * （生效机制见 ai/providers/maps/map-runtime.ts）；采纳的表写 localStorage 缓存，
 * 下次启动先用缓存、后台再拉远程刷新。
 * 纪律：拉取失败/超时/非法一律静默回退（打包表+缓存表照常工作），不阻塞启动、不弹错。
 * 请求走 @tauri-apps/plugin-http 的 fetch（Rust 侧出网，绕 CORS）。
 */
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { REMOTE_REASONING_MAP_URL, REMOTE_VISION_MAP_URL } from "./constants";

const FETCH_TIMEOUT_MS = 5000;

/** 启动调用一次即可（main.tsx）；两表并行，永不 reject */
export async function refreshModelMaps(): Promise<void> {
  await Promise.all([
    pullMap(REMOTE_VISION_MAP_URL, adoptRemoteVisionMap),
    pullMap(REMOTE_REASONING_MAP_URL, adoptRemoteReasoningMap),
  ]);
}

async function pullMap(url: string, adopt: (raw: unknown) => boolean): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // 时间戳参数防 CDN/中间缓存发陈旧表（latest.json 陈旧事故同款教训，见 site/DEPLOY.md 第 6 节）
    const res = await tauriFetch(`${url}?_ts=${Date.now()}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) return;
    adopt(await res.json());
  } catch (error) {
    // 静默：离线/超时/非法 JSON 都走本地兜底，仅留控制台痕迹
    console.warn("模型映射表远程拉取失败（已回退本地表）:", error);
  } finally {
    clearTimeout(timer);
  }
}
