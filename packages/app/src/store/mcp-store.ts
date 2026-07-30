import { tauriStorageKey } from "@/constants/tauri-storage";
import { tauriStorage } from "@/lib/tauri-storage";
import { type AgentScope, parseCommandScopes } from "@/store/quick-command-store";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export interface McpServer {
  id: string;
  name: string;
  transport: "stdio" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  /** 生效的 Agent 集合（子集即可多选）；旧数据单值模型在迁移时转换 */
  scope: AgentScope[];
  enabled: boolean;
}

interface McpState {
  servers: McpServer[];
  addServer: (server: Omit<McpServer, "id">) => void;
  updateServer: (id: string, updates: Partial<Omit<McpServer, "id">>) => void;
  removeServer: (id: string) => void;
  toggleEnabled: (id: string) => void;
}

function generateId(): string {
  return `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const useMcpStore = create<McpState>()(
  persist(
    (set, get) => ({
      servers: [],

      addServer: (server) => {
        const newServer: McpServer = { ...server, id: generateId() };
        set({ servers: [...get().servers, newServer] });
      },

      updateServer: (id, updates) => {
        set({
          servers: get().servers.map((s) => (s.id === id ? { ...s, ...updates } : s)),
        });
      },

      removeServer: (id) => {
        set({ servers: get().servers.filter((s) => s.id !== id) });
      },

      toggleEnabled: (id) => {
        set({
          servers: get().servers.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)),
        });
      },
    }),
    {
      name: tauriStorageKey.mcpServers,
      storage: createJSONStorage(() => tauriStorage),
      partialize: (state) => ({ servers: state.servers }),
      // v1：scope 单值模型 → 集合模型（"both"→["reader","central"]）
      version: 1,
      migrate: (persistedState: unknown, version: number) => {
        const state = persistedState as { servers?: Array<Omit<McpServer, "scope"> & { scope: unknown }> } | undefined;
        if (!state || !Array.isArray(state.servers)) {
          return { servers: [] };
        }
        if (version < 1) {
          return { servers: state.servers.map((s) => ({ ...s, scope: parseCommandScopes(s.scope) })) };
        }
        return state as { servers: McpServer[] };
      },
    },
  ),
);
