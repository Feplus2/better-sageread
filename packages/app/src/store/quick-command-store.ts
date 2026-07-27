import { tauriStorageKey } from "@/constants/tauri-storage";
import { tauriStorage } from "@/lib/tauri-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type AgentScope = "reader" | "central" | "both";

export interface QuickCommand {
  id: string;
  label: string;
  prompt: string;
  icon?: string;
  scope: AgentScope;
  visible: boolean;
  sortOrder: number;
}

interface QuickCommandState {
  commands: QuickCommand[];
  addCommand: (cmd: Omit<QuickCommand, "id" | "sortOrder">) => void;
  updateCommand: (id: string, updates: Partial<Omit<QuickCommand, "id">>) => void;
  deleteCommand: (id: string) => void;
  toggleVisible: (id: string) => void;
  reorderCommands: (id: string, direction: "up" | "down") => void;
  getCommandsForScope: (scope: "reader" | "central") => QuickCommand[];
}

/** 默认指令的功能图标（迁移持久化数据时也按此表修正） */
const DEFAULT_ICON_BY_ID: Record<string, string> = {
  "qc-reader-1": "BookOpen",
  "qc-reader-2": "Brain",
  "qc-reader-3": "Waypoints",
  "qc-central-1": "Moon",
  "qc-central-2": "NotebookText",
  "qc-central-3": "Download",
  "qc-central-4": "Database",
};

const DEFAULT_COMMANDS: QuickCommand[] = [
  // 阅读助手
  {
    id: "qc-reader-1",
    label: "总结本章",
    prompt: "请帮我总结本章的核心要点和结论。",
    icon: "BookOpen",
    scope: "reader",
    visible: true,
    sortOrder: 0,
  },
  {
    id: "qc-reader-2",
    label: "分析观点",
    prompt: "请分析作者的观点，指出论据与可能的偏见。",
    icon: "Brain",
    scope: "reader",
    visible: true,
    sortOrder: 1,
  },
  {
    id: "qc-reader-3",
    label: "生成思维导图",
    prompt: "请基于当前内容生成思维导图。",
    icon: "Waypoints",
    scope: "reader",
    visible: true,
    sortOrder: 2,
  },
  // 全局助手
  {
    id: "qc-central-1",
    label: "切换到深色模式",
    prompt: "切换到深色模式",
    icon: "Moon",
    scope: "central",
    visible: true,
    sortOrder: 0,
  },
  {
    id: "qc-central-2",
    label: "总结最近阅读情况",
    prompt: "总结我最近的阅读情况",
    icon: "NotebookText",
    scope: "central",
    visible: true,
    sortOrder: 1,
  },
  {
    id: "qc-central-3",
    label: "导出星标对话",
    prompt: "把星标对话都导出来",
    icon: "Download",
    scope: "central",
    visible: true,
    sortOrder: 2,
  },
  {
    id: "qc-central-4",
    label: "批量向量化",
    prompt: "帮我把未向量化的书全部执行向量化",
    icon: "Database",
    scope: "central",
    visible: true,
    sortOrder: 3,
  },
];

function generateId(): string {
  return `qc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const useQuickCommandStore = create<QuickCommandState>()(
  persist(
    (set, get) => ({
      commands: DEFAULT_COMMANDS,

      addCommand: (cmd) => {
        const { commands } = get();
        const maxOrder = commands.reduce((max, c) => Math.max(max, c.sortOrder), -1);
        const newCmd: QuickCommand = {
          ...cmd,
          id: generateId(),
          sortOrder: maxOrder + 1,
        };
        set({ commands: [...commands, newCmd] });
      },

      updateCommand: (id, updates) => {
        set({
          commands: get().commands.map((c) => (c.id === id ? { ...c, ...updates } : c)),
        });
      },

      deleteCommand: (id) => {
        set({ commands: get().commands.filter((c) => c.id !== id) });
      },

      toggleVisible: (id) => {
        set({
          commands: get().commands.map((c) => (c.id === id ? { ...c, visible: !c.visible } : c)),
        });
      },

      reorderCommands: (id, direction) => {
        const { commands } = get();
        const target = commands.find((c) => c.id === id);
        if (!target) return;
        // 在同 scope 的指令中找相邻项
        const sameScope = commands.filter((c) => c.scope === target.scope).sort((a, b) => a.sortOrder - b.sortOrder);
        const idx = sameScope.findIndex((c) => c.id === id);
        const swapIdx = direction === "up" ? idx - 1 : idx + 1;
        if (swapIdx < 0 || swapIdx >= sameScope.length) return;
        const swapTarget = sameScope[swapIdx];
        if (!swapTarget) return;
        set({
          commands: commands.map((c) => {
            if (c.id === id) return { ...c, sortOrder: swapTarget.sortOrder };
            if (c.id === swapTarget.id) return { ...c, sortOrder: target.sortOrder };
            return c;
          }),
        });
      },

      getCommandsForScope: (scope) => {
        return get()
          .commands.filter((c) => c.visible && (c.scope === scope || c.scope === "both"))
          .sort((a, b) => a.sortOrder - b.sortOrder);
      },
    }),
    {
      name: tauriStorageKey.quickCommands,
      storage: createJSONStorage(() => tauriStorage),
      partialize: (state) => ({ commands: state.commands }),
      // v1：默认指令补上功能图标（旧数据全是 Zap 或缺 icon）
      version: 1,
      migrate: (persistedState: unknown, version: number) => {
        const state = persistedState as { commands?: QuickCommand[] } | undefined;
        if (!state || !Array.isArray(state.commands)) {
          return { commands: DEFAULT_COMMANDS };
        }
        if (version < 1) {
          state.commands = state.commands.map((c) =>
            c.id in DEFAULT_ICON_BY_ID ? { ...c, icon: DEFAULT_ICON_BY_ID[c.id] } : c,
          );
        }
        return state as { commands: QuickCommand[] };
      },
    },
  ),
);
