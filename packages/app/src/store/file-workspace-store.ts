import { create } from "zustand";
import { persist } from "zustand/middleware";

export type AgentWorkspaceScope = "central" | "reader" | "paper";
export type FileWorkspaceMode = "chat" | "files";
export type FileWorkspaceTabType = "file" | "explorer";

export interface FileTabDescriptor {
  id: string;
  path: string;
  title: string;
  scope: AgentWorkspaceScope;
  rootResolved: string;
  type?: FileWorkspaceTabType;
}

interface FileWorkspaceHostState {
  mode: FileWorkspaceMode;
  scope: AgentWorkspaceScope;
  rootResolved: string;
  explorerPath: string;
  tabs: FileTabDescriptor[];
  activeTabId: string | null;
}

interface FileWorkspaceState {
  hosts: Record<string, FileWorkspaceHostState>;
  recentRoots: Partial<Record<AgentWorkspaceScope, string[]>>;
  openWorkspace: (hostId: string, scope: AgentWorkspaceScope, rootResolved: string) => void;
  openExplorer: (hostId: string, scope: AgentWorkspaceScope, rootResolved: string) => void;
  closeWorkspace: (hostId: string) => void;
  openFile: (
    hostId: string,
    scope: AgentWorkspaceScope,
    rootResolved: string,
    file: { path: string; title?: string },
  ) => void;
  setActiveTab: (hostId: string, tabId: string) => void;
  closeTab: (hostId: string, tabId: string) => void;
  closeAllTabs: (hostId: string) => void;
  setPreviewRoot: (hostId: string, scope: AgentWorkspaceScope, rootResolved: string) => void;
  setExplorerPath: (hostId: string, path: string) => void;
}

function normalizeDirectory(path: string): string {
  if (!path.trim()) throw new Error("预览目录不能为空");
  const value = path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (/^[A-Za-z]:$/.test(value)) return `${value}/`;
  if (!value) return "/";
  return value;
}

function rootKey(path: string): string {
  const normalized = normalizeDirectory(path);
  return /^(?:[a-z]:|\/\/)/i.test(normalized) ? normalized.toLowerCase() : normalized;
}

function emptyHost(scope: AgentWorkspaceScope, rootResolved: string): FileWorkspaceHostState {
  return { mode: "chat", scope, rootResolved, explorerPath: rootResolved, tabs: [], activeTabId: null };
}

function explorerTab(rootResolved: string): FileTabDescriptor {
  return {
    id: "explorer",
    path: rootResolved,
    title: "文件资源管理器",
    scope: "central",
    rootResolved,
    type: "explorer",
  };
}

function hostFor(
  state: FileWorkspaceState,
  hostId: string,
  scope: AgentWorkspaceScope,
  rootResolved: string,
  replaceRoot: boolean,
): FileWorkspaceHostState {
  const current = state.hosts[hostId] ?? emptyHost(scope, rootResolved);
  if (current.scope !== scope) return emptyHost(scope, rootResolved);
  if (!replaceRoot || current.rootResolved === rootResolved) return current;
  return {
    ...current,
    rootResolved,
    explorerPath: rootResolved,
    tabs: current.tabs.map((tab) => (tab.type === "explorer" ? { ...tab, path: rootResolved, rootResolved } : tab)),
  };
}

function withRecentRoots(
  state: FileWorkspaceState,
  scope: AgentWorkspaceScope,
  root: string,
): FileWorkspaceState["recentRoots"] {
  const key = rootKey(root);
  const previous = state.recentRoots[scope] ?? [];
  return {
    ...state.recentRoots,
    [scope]: [root, ...previous.filter((item) => rootKey(item) !== key)].slice(0, 6),
  };
}

export const useFileWorkspaceStore = create<FileWorkspaceState>()(
  persist(
    (set) => ({
      hosts: {},
      recentRoots: {},
      openWorkspace: (hostId, scope, rootResolved) =>
        set((state) => {
          const host = hostFor(state, hostId, scope, rootResolved, true);
          const needsExplorer = host.tabs.length === 0;
          const explorer = needsExplorer ? [{ ...explorerTab(host.rootResolved), scope }] : [];
          return {
            hosts: {
              ...state.hosts,
              [hostId]: {
                ...host,
                mode: "files",
                tabs: needsExplorer ? explorer : host.tabs,
                activeTabId: needsExplorer ? "explorer" : host.activeTabId,
              },
            },
          };
        }),
      openExplorer: (hostId, scope, rootResolved) =>
        set((state) => {
          const host = hostFor(state, hostId, scope, rootResolved, true);
          const exists = host.tabs.some((tab) => tab.type === "explorer");
          const explorer = { ...explorerTab(host.rootResolved), scope, path: host.explorerPath };
          return {
            hosts: {
              ...state.hosts,
              [hostId]: {
                ...host,
                mode: "files",
                tabs: exists ? host.tabs : [explorer, ...host.tabs],
                activeTabId: "explorer",
              },
            },
          };
        }),
      closeWorkspace: (hostId) =>
        set((state) => {
          const host = state.hosts[hostId];
          if (!host) return state;
          return { hosts: { ...state.hosts, [hostId]: { ...host, mode: "chat" } } };
        }),
      openFile: (hostId, scope, rootResolved, file) =>
        set((state) => {
          const host = hostFor(state, hostId, scope, rootResolved, false);
          const existing = host.tabs.find((tab) => tab.path === file.path);
          const tab: FileTabDescriptor = existing ?? {
            id: file.path,
            path: file.path,
            title:
              file.title?.trim() ||
              file.path
                .replace(/[\\/]+$/, "")
                .split(/[\\/]/)
                .pop() ||
              file.path,
            scope,
            rootResolved,
            type: "file",
          };
          return {
            hosts: {
              ...state.hosts,
              [hostId]: {
                ...host,
                mode: "files",
                tabs: existing ? host.tabs : [...host.tabs, tab],
                activeTabId: tab.id,
              },
            },
          };
        }),
      setActiveTab: (hostId, tabId) =>
        set((state) => {
          const host = state.hosts[hostId];
          if (!host?.tabs.some((tab) => tab.id === tabId)) return state;
          return { hosts: { ...state.hosts, [hostId]: { ...host, mode: "files", activeTabId: tabId } } };
        }),
      closeTab: (hostId, tabId) =>
        set((state) => {
          const host = state.hosts[hostId];
          if (!host) return state;
          const index = host.tabs.findIndex((tab) => tab.id === tabId);
          if (index < 0) return state;
          const tabs = host.tabs.filter((tab) => tab.id !== tabId);
          const activeTabId =
            host.activeTabId === tabId ? (tabs[index]?.id ?? tabs[index - 1]?.id ?? null) : host.activeTabId;
          return { hosts: { ...state.hosts, [hostId]: { ...host, tabs, activeTabId } } };
        }),
      closeAllTabs: (hostId) =>
        set((state) => {
          const host = state.hosts[hostId];
          if (!host) return state;
          return { hosts: { ...state.hosts, [hostId]: { ...host, mode: "files", tabs: [], activeTabId: null } } };
        }),
      setPreviewRoot: (hostId, scope, rootResolved) =>
        set((state) => {
          const root = normalizeDirectory(rootResolved);
          const host = hostFor(state, hostId, scope, root, true);
          return {
            hosts: { ...state.hosts, [hostId]: { ...host, mode: "files" } },
            recentRoots: withRecentRoots(state, scope, root),
          };
        }),
      setExplorerPath: (hostId, path) =>
        set((state) => {
          const host = state.hosts[hostId];
          if (!host) return state;
          const candidate = normalizeDirectory(path);
          const root = rootKey(host.rootResolved);
          const candidateKey = rootKey(candidate);
          const prefix = root.endsWith("/") ? root : `${root}/`;
          if (candidateKey !== root && !candidateKey.startsWith(prefix)) {
            throw new Error("不能越过当前预览根");
          }
          return {
            hosts: {
              ...state.hosts,
              [hostId]: {
                ...host,
                explorerPath: candidate,
                tabs: host.tabs.map((tab) => (tab.type === "explorer" ? { ...tab, path: candidate } : tab)),
              },
            },
          };
        }),
    }),
    {
      name: "sageread-file-workspace-preview-v1",
      partialize: (state) => ({ recentRoots: state.recentRoots }),
    },
  ),
);
