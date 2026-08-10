import { useNotificationStore } from "@/store/notification-store";
import { toast } from "sonner";

/**
 * 值得留档的提示：弹 toast 的同时写进通知中心（用户错过 toast 可去铃铛里找回）。
 * 仅用于"错过会可惜"的信息——失败、异步任务完成、重要结果；
 * 鸡毛蒜皮的即时反馈（如"已复制"）仍用裸 toast，避免通知中心变噪音。
 */
export const notify = {
  success: (message: string) => {
    toast.success(message);
    useNotificationStore.getState().addNotification(message);
  },
  error: (message: string, description?: string) => {
    toast.error(message, description ? { description } : undefined);
    useNotificationStore.getState().addNotification(description ? `${message}：${description}` : message);
  },
  info: (message: string) => {
    toast.info(message);
    useNotificationStore.getState().addNotification(message);
  },
  warning: (message: string) => {
    toast.warning(message);
    useNotificationStore.getState().addNotification(message);
  },
};
