import { create } from "zustand";

interface TaskWorkspaceState {
  pendingRoots: Record<string, string | undefined>;
  threadRoots: Record<string, string | undefined>;
  setTaskWorkspaceRoot: (hostId: string, threadId: string | null, root: string) => void;
  bindPendingWorkspaceRoot: (hostId: string | undefined, threadId: string, rootSnapshot?: string | null) => void;
  clearPendingWorkspaceRoot: (hostId: string | undefined) => void;
  clearTaskWorkspaceRoot: (hostId: string | undefined, threadId?: string) => void;
}

function threadKey(hostId: string, threadId: string): string {
  return `${hostId}\0${threadId}`;
}

function checkedRoot(root: string): string {
  const value = root.trim();
  if (!value) throw new Error("任务工作区路径不能为空");
  return value;
}

export const useTaskWorkspaceStore = create<TaskWorkspaceState>()((set) => ({
  pendingRoots: {},
  threadRoots: {},
  setTaskWorkspaceRoot: (hostId, threadId, root) =>
    set((state) => {
      const value = checkedRoot(root);
      const pendingRoots = { ...state.pendingRoots };
      const threadRoots = { ...state.threadRoots };
      if (threadId) {
        threadRoots[threadKey(hostId, threadId)] = value;
        delete pendingRoots[hostId];
      } else {
        pendingRoots[hostId] = value;
      }
      return { pendingRoots, threadRoots };
    }),
  bindPendingWorkspaceRoot: (hostId, threadId, rootSnapshot) =>
    set((state) => {
      if (!hostId) return state;
      if (rootSnapshot === null) return state;
      const root = rootSnapshot === undefined ? state.pendingRoots[hostId] : rootSnapshot;
      if (!root) return state;
      const pendingRoots = { ...state.pendingRoots };
      if (root === state.pendingRoots[hostId]) delete pendingRoots[hostId];
      return { pendingRoots, threadRoots: { ...state.threadRoots, [threadKey(hostId, threadId)]: root } };
    }),
  clearPendingWorkspaceRoot: (hostId) =>
    set((state) => {
      if (!hostId) return state;
      const pendingRoots = { ...state.pendingRoots };
      delete pendingRoots[hostId];
      return { pendingRoots };
    }),
  clearTaskWorkspaceRoot: (hostId, threadId) =>
    set((state) => {
      if (!hostId) return state;
      const pendingRoots = { ...state.pendingRoots };
      const threadRoots = { ...state.threadRoots };
      delete pendingRoots[hostId];
      if (threadId) delete threadRoots[threadKey(hostId, threadId)];
      return { pendingRoots, threadRoots };
    }),
}));

export function selectTaskWorkspaceRoot(
  state: Pick<TaskWorkspaceState, "pendingRoots" | "threadRoots">,
  hostId: string,
  threadId?: string,
): string | undefined {
  return threadId ? state.threadRoots[threadKey(hostId, threadId)] : state.pendingRoots[hostId];
}

export function resolveRequestTaskWorkspaceRoot(
  hostId: string | undefined,
  threadId: string | undefined,
  hasRequestContext: boolean,
  rootSnapshot?: string | null,
): string | undefined {
  if (!hasRequestContext || !hostId) return undefined;
  if (rootSnapshot !== undefined) return rootSnapshot ?? undefined;
  return selectTaskWorkspaceRoot(useTaskWorkspaceStore.getState(), hostId, threadId);
}
