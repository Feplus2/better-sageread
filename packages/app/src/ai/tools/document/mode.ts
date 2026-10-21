import { useAgentSettingsStore } from "@/store/agent-settings-store";

/** P1-2 文档工具可见性模式：both=新旧并存；new=只暴露通用文档原语；legacy=旧工具（回退位）。 */
export type DocumentToolMode = "both" | "new" | "legacy";

declare global {
  interface Window {
    /** 评测/调试钩子：在消息发送前覆盖文档工具模式（避免模块实例不一致） */
    __SAGEREAD_DOC_TOOL_MODE__?: DocumentToolMode;
  }
}

export function getDocumentToolMode(): DocumentToolMode {
  if (typeof window !== "undefined") {
    const override = window.__SAGEREAD_DOC_TOOL_MODE__;
    if (override === "new" || override === "legacy" || override === "both") return override;
  }
  return useAgentSettingsStore.getState().documentToolMode ?? "both";
}
