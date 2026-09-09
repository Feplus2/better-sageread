import { getOSPlatform } from "./misc";

/** 移动端平台判定（Tauri 按平台出包，应用生命周期内为常量；UA 探测与 iframeEventHandlers 同源）。
 *  布局分叉一律走它：桌面 UI 一行不动，移动端在 ReaderLayout 顶层换 MobileLayout。 */
export const isMobile = ["android", "ios"].includes(getOSPlatform());
