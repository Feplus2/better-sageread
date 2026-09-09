import { create } from "zustand";

/** 聊天输入草稿（M3-d 裁定：抽屉收起不清未发送内容，重拉原样复原）。
 *  按 `${agentScope}:${bookId}` 分键；不持久化到磁盘（会话级草稿），但活在整个运行期。
 *  桌面侧连带收益：侧栏/页面卸载重挂后草稿也在。 */
interface ChatDraftState {
  drafts: Record<string, string>;
  setDraft: (key: string, value: string | ((prev: string) => string)) => void;
}

export const useChatDraftStore = create<ChatDraftState>()((set, get) => ({
  drafts: {},
  setDraft: (key, value) => {
    const prev = get().drafts[key] ?? "";
    const next = typeof value === "function" ? value(prev) : value;
    set((s) => ({ drafts: { ...s.drafts, [key]: next } }));
  },
}));
