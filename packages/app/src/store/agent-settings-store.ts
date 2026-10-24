import { tauriStorageKey } from "@/constants/tauri-storage";
import { tauriStorage } from "@/lib/tauri-storage";
import { isMobile } from "@/utils/mobile";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/**
 * Agent 写操作安全模式（2026-08-05 拍板三档，对三个助手一致生效）：
 * - strict（默认）：工作区内读写静默；界外读/写/命令执行均弹确认卡
 * - relaxed：界外读也静默；界外写/命令执行确认卡
 * - full：常规读写/命令静默（仍有审计日志）；恒确认例外与敏感路径拒绝不取消
 * 网络非 GET、携带密钥引用的外发及破坏性/密钥操作按判定表恒确认；集中在 ai/utils/tool-guard.ts。
 */
export type AgentSafetyMode = "strict" | "relaxed" | "full";

/** 三个 Agent scope（与 registry 的 AgentScope 对齐，此处不 import 避免循环依赖） */
export type AgentWorkspaceScope = "central" | "reader" | "paper";

/** 按助手覆盖的工作区根；缺项/空串 = 跟随共享根（2026-08-05 拍板：共享根 + 按助手覆盖） */
export type PerAgentRoots = Partial<Record<AgentWorkspaceScope, string>>;

/** 文档工具模式：new=通用文档原语（默认）；legacy=旧工具（回退位）。 */
export type DocumentToolMode = "new" | "legacy";

export function normalizeDocumentToolMode(value: unknown): DocumentToolMode {
  return value === "legacy" ? "legacy" : "new";
}

interface AgentSettingsState {
  safetyMode: AgentSafetyMode;
  /** 共享工作区根；null = 默认 {appData}/agent-workspace */
  workspaceRoot: string | null;
  /** 按助手覆盖根；留空跟随共享根。记忆随根走：覆盖了根即独立 memory.md，否则共享 */
  perAgentRoots: PerAgentRoots;
  /** P1-2 文档工具可见性开关 */
  documentToolMode: DocumentToolMode;
  setSafetyMode: (mode: AgentSafetyMode) => void;
  setWorkspaceRoot: (root: string | null) => void;
  setPerAgentRoot: (scope: AgentWorkspaceScope, root: string | null) => void;
  setDocumentToolMode: (mode: DocumentToolMode) => void;
}

export const useAgentSettingsStore = create<AgentSettingsState>()(
  persist(
    (set) => ({
      safetyMode: "strict",
      workspaceRoot: null,
      perAgentRoots: {},
      documentToolMode: "new",
      // 移动端 Agent 权限收敛（M3-g 裁定）：只保留严格模式——无 shell/子进程能力，
      // 完全访问在手机上无意义且风险放大；同步过来的桌面配置可能带 full，写入侧一律拦回 strict
      setSafetyMode: (safetyMode) => set({ safetyMode: isMobile ? "strict" : safetyMode }),
      setWorkspaceRoot: (workspaceRoot) => {
        if (isMobile) return; // 手机工作区恒为 app 私有目录，不开放自选
        set({ workspaceRoot });
      },
      setDocumentToolMode: (documentToolMode) => set({ documentToolMode }),
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
      version: 3,
      // v3：文档工具只保留 new/legacy；历史值与非法值统一回退 new。
      migrate: (persisted) => {
        const state = persisted as Partial<AgentSettingsState> | undefined;
        if (state) state.documentToolMode = normalizeDocumentToolMode(state.documentToolMode);
        return state as AgentSettingsState;
      },
      partialize: (state) => ({
        safetyMode: state.safetyMode,
        workspaceRoot: state.workspaceRoot,
        perAgentRoots: state.perAgentRoots,
        documentToolMode: state.documentToolMode,
      }),
      // 移动端水合兜底：同步/备份恢复过来的 full/relaxed 一律压回 strict（M3-g）
      merge: (persisted, current) => {
        const p = persisted as Partial<AgentSettingsState> | undefined;
        const merged = { ...current, ...p };
        if (isMobile) {
          merged.safetyMode = "strict";
          merged.workspaceRoot = null;
          merged.perAgentRoots = {};
        }
        merged.documentToolMode = normalizeDocumentToolMode(merged.documentToolMode);
        return merged;
      },
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
