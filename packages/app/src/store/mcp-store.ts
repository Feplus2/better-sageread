import { tauriStorageKey } from "@/constants/tauri-storage";
import { tauriStorage } from "@/lib/tauri-storage";
import type { AgentScope } from "@/store/quick-command-store";
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
  scope: AgentScope;
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
    },
  ),
);
