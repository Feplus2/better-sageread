import { tauriStorageKey } from "@/constants/tauri-storage";
import { tauriStorage } from "@/lib/tauri-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/**
 * Agent 写操作安全模式（2026-08-05 拍板三档，对三个助手一致生效）：
 * - strict（默认）：工作区内读写静默；界外读/写/命令执行均弹确认卡
 * - relaxed：界外读也静默；界外写/命令执行确认卡
 * - full：全部静默（仍有审计日志）
 * 网络外发（httpRequest 非 GET）任何模式都弹确认卡。判定表集中在 ai/utils/tool-guard.ts。
 */
export type AgentSafetyMode = "strict" | "relaxed" | "full";

/** 三个 Agent scope（与 registry 的 AgentScope 对齐，此处不 import 避免循环依赖） */
export type AgentWorkspaceScope = "central" | "reader" | "paper";

/** 按助手覆盖的工作区根；缺项/空串 = 跟随共享根（2026-08-05 拍板：共享根 + 按助手覆盖） */
export type PerAgentRoots = Partial<Record<AgentWorkspaceScope, string>>;

interface AgentSettingsState {
  safetyMode: AgentSafetyMode;
  /** 共享工作区根；null = 默认 {appData}/agent-workspace */
  workspaceRoot: string | null;
  /** 按助手覆盖根；留空跟随共享根。记忆随根走：覆盖了根即独立 memory.md，否则共享 */
  perAgentRoots: PerAgentRoots;
  setSafetyMode: (mode: AgentSafetyMode) => void;
  setWorkspaceRoot: (root: string | null) => void;
  setPerAgentRoot: (scope: AgentWorkspaceScope, root: string | null) => void;
}

export const useAgentSettingsStore = create<AgentSettingsState>()(
  persist(
    (set) => ({
      safetyMode: "strict",
      workspaceRoot: null,
      perAgentRoots: {},
      setSafetyMode: (safetyMode) => set({ safetyMode }),
      setWorkspaceRoot: (workspaceRoot) => set({ workspaceRoot }),
      setPerAgentRoot: (scope, root) =>
        set((state) => {
          const next = { ...state.perAgentRoots };
          if (root?.trim()) {
            next[scope] = root.trim();
          } else {
            delete next[scope];
          }
          return { perAgentRoots: next };
        }),
    }),
    {
      name: tauriStorageKey.agentSettings,
      storage: createJSONStorage(() => tauriStorage),
      partialize: (state) => ({
        safetyMode: state.safetyMode,
        workspaceRoot: state.workspaceRoot,
        perAgentRoots: state.perAgentRoots,
      }),
    },
  ),
);

/**
 * 解析某 scope 生效的工作区根（仅读 store；null 表示交给 Rust 用默认 {appData}/agent-workspace）。
 * 优先级：按助手覆盖 > 共享根 > null（默认）。
 */
export function resolveWorkspaceRootForScope(scope: AgentWorkspaceScope): string | null {
  const { perAgentRoots, workspaceRoot } = useAgentSettingsStore.getState();
  return perAgentRoots[scope] || workspaceRoot || null;
}
