import { useNotificationStore } from "@/store/notification-store";
import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";

/**
 * 同步域全局事件：
 * - sync-backup-done：备份完成/失败写进通知中心（静默，不弹 toast——
 *   手动备份的即时反馈仍由设置页 toast 负责；设置页关闭后结果在此可回看）
 */
export function useSyncEvents() {
  const { addNotification } = useNotificationStore();

  useEffect(() => {
    const unlisten = listen<{ ok: boolean; message: string }>("sync-backup-done", (event) => {
      const { ok, message } = event.payload;
      addNotification(ok ? `备份完成：${message}` : `备份失败：${message}`);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [addNotification]);
}
