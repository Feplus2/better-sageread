import { useAppSettingsStore } from "@/store/app-settings-store";
import { useLayoutStore } from "@/store/layout-store";
import { invoke } from "@tauri-apps/api/core";
import { isMobile } from "./mobile";

/**
 * 安卓硬件返回键/返回手势的统一裁决（MainActivity.onKeyDown 全量转发到这里）。
 * 消费顺序（命中即停）：
 *  1. 阅读页抽屉/弹层（MobileReaderBars 等订阅 "android-back" 事件，detail.handled 置位即消费）
 *  2. 设置对话框 → 关闭
 *  3. 阅读页（书/论文） → 回主页区
 *  4. 二级页（hash ≠ "/"） → 回首页
 *  5. 首页根 → 无事可退，退出应用
 */
export function installAndroidBackHandler() {
  if (!isMobile) return;
  window.__androidBack = () => {
    const ev = new CustomEvent("android-back", { detail: { handled: false } });
    window.dispatchEvent(ev);
    if (ev.detail.handled) return;

    const appSettings = useAppSettingsStore.getState();
    if (appSettings.isSettingsDialogOpen) {
      appSettings.toggleSettingsDialog();
      return;
    }

    const layout = useLayoutStore.getState();
    if (!layout.isHomeActive) {
      layout.navigateToHome();
      return;
    }

    if (window.location.hash && window.location.hash !== "#/") {
      window.location.hash = "#/";
      return;
    }

    invoke("mobile_exit_app").catch(() => {});
  };
}

declare global {
  interface Window {
    __androidBack?: () => void;
  }
}
