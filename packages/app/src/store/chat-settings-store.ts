import type { ReasoningLevel } from "@/ai/providers/reasoning-map";
import { tauriStorageKey } from "@/constants/tauri-storage";
import { tauriStorage } from "@/lib/tauri-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/**
 * 聊天偏好（P3）：思考强度档位等对话级用户偏好。
 * reasoningLevel 经两条链路生效：AI SDK 原生 providerOptions（transport streamText）
 * + 自定义端点请求体补丁（factory 动态 fetch 包装，见 ai/providers/reasoning-map.ts 映射表）。
 * 映射表不认的端不下发参数，此时档位静默无效果。
 */
interface ChatSettingsState {
  reasoningLevel: ReasoningLevel;
  setReasoningLevel: (level: ReasoningLevel) => void;
  /** H3：宽版聊天布局（放宽消息列/输入区 max-w 约束，全局/书籍/论文三 scope 同生效） */
  wideChatLayout: boolean;
  setWideChatLayout: (wide: boolean) => void;
  /** H3：输入区 textarea 最小高度（px，顶边拖拽手柄可调） */
  inputHeight: number;
  setInputHeight: (height: number) => void;
}

export const useChatSettingsStore = create<ChatSettingsState>()(
  persist(
    (set) => ({
      reasoningLevel: "medium",
      setReasoningLevel: (reasoningLevel) => set({ reasoningLevel }),
      wideChatLayout: false,
      setWideChatLayout: (wideChatLayout) => set({ wideChatLayout }),
      inputHeight: 60,
      setInputHeight: (inputHeight) => set({ inputHeight }),
    }),
    {
      name: tauriStorageKey.chatSettings,
      storage: createJSONStorage(() => tauriStorage),
      partialize: (state) => ({
        reasoningLevel: state.reasoningLevel,
        wideChatLayout: state.wideChatLayout,
        inputHeight: state.inputHeight,
      }),
    },
  ),
);
