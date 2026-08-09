import { tauriStorageKey } from "@/constants/tauri-storage";
import { tauriStorage } from "@/lib/tauri-storage";
import { type AgentScope, parseCommandScopes } from "@/store/quick-command-store";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export interface McpServer {
  id: string;
  name: string;
  /** stdio 批次 D 才可用；sse 已弃用（兼容保留，建议 http） */
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  /** 远程传输请求头（值支持 {{secret:NAME}} 引用，批次 A3） */
  headers?: Record<string, string>;
  /** 生效的 Agent 集合（子集即可多选）；旧数据单值模型在迁移时转换 */
  scope: AgentScope[];
  enabled: boolean;
  /** 来源：手动配置 / 市场安装（批次 C） */
  source?: "manual" | "registry";
  /** 官方 registry 的 name，供将来检查更新 */
  registryName?: string;
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
      // v2（批次 B2）：新增 http 传输 + headers/source/registryName 字段
      version: 2,
      migrate: (persistedState: unknown, version: number) => {
        const state = persistedState as { servers?: Array<Omit<McpServer, "scope"> & { scope: unknown }> } | undefined;
        if (!state || !Array.isArray(state.servers)) {
          return { servers: [] };
        }
        let servers = state.servers.map((s) => ({ ...s, scope: s.scope }));
        if (version < 1) {
          servers = servers.map((s) => ({ ...s, scope: parseCommandScopes(s.scope) }));
        }
        if (version < 2) {
          servers = servers.map((s) => ({
            ...s,
            headers: s.headers ?? {},
            source: s.source ?? "manual",
          })) as unknown as typeof servers;
        }
        return { servers } as { servers: McpServer[] };
      },
    },
  ),
);
