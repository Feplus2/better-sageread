import { type Update, check } from "@tauri-apps/plugin-updater";
import { toast } from "sonner";
import { create } from "zustand";

/**
 * 更新状态中心（2026-08-25）：设置页手动「检查更新」驱动。
 * 纪律：发现新版本只挂 pendingUpdate（确认框展示版本号+更新说明），用户确认才下载——
 * 任何路径都不得绕过确认直接 downloadAndInstall（v0.2.1 启动静默强更事故的根修）。
 * 用户拍板（2026-08-25）：启动不做自动检查，仅手动触发——不打扰优先。
 */

interface UpdateState {
  pendingUpdate: Update | null;
  isChecking: boolean;
  isUpdating: boolean;
  /** 检查更新（仅设置页手动触发）：发现新版本挂 pendingUpdate 弹确认框；已最新/失败如实 toast */
  checkForUpdates: () => Promise<void>;
  /** 确认更新：下载安装（完成后提示重启） */
  confirmUpdate: () => Promise<void>;
  /** 「以后再说」（下载中禁止关闭防误触） */
  dismissUpdate: () => void;
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  pendingUpdate: null,
  isChecking: false,
  isUpdating: false,

  checkForUpdates: async () => {
    if (get().isChecking || get().isUpdating || get().pendingUpdate) return;
    set({ isChecking: true });
    try {
      const update = await check();
      if (update) {
        set({ pendingUpdate: update });
      } else {
        toast.info("当前已是最新版本");
      }
    } catch (error) {
      console.error("检查更新失败:", error);
      // Tauri 插件错误多为纯字符串（非 Error 实例），直接 String 兜底展示真实原因
      const detail = error instanceof Error ? error.message : String(error ?? "");
      toast.error("检查更新失败", {
        description: detail && detail !== "undefined" ? detail : "未知错误",
      });
    } finally {
      set({ isChecking: false });
    }
  },

  confirmUpdate: async () => {
    const { pendingUpdate } = get();
    if (!pendingUpdate || get().isUpdating) return;
    set({ isUpdating: true });
    try {
      await pendingUpdate.downloadAndInstall();
      set({ pendingUpdate: null });
      toast.success("更新已下载", {
        description: "请重启应用以完成更新",
        duration: 10000,
      });
    } catch (error) {
      console.error("更新失败:", error);
      const detail = error instanceof Error ? error.message : String(error ?? "");
      toast.error("更新失败", {
        description: detail && detail !== "undefined" ? detail : "未知错误",
      });
    } finally {
      set({ isUpdating: false });
    }
  },

  dismissUpdate: () => {
    if (get().isUpdating) return;
    set({ pendingUpdate: null });
  },
}));
