import {
  DEFAULT_RETRIEVAL_SCOPE,
  type RetrievalScope,
  type RetrievalScopeRole,
  isRetrievalScope,
} from "@/constants/retrieval-scope";
import { tauriStorageKey } from "@/constants/tauri-storage";
import { tauriStorage } from "@/lib/tauri-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/** 按「每本书 / 每篇论文」记住上次选择：reader:<bookId> / paper:<paperId>。
 *  不给全局单值——不同书/论文可以有不同的圈定范围；默认 current。 */
export function retrievalScopeKey(role: RetrievalScopeRole, docId: string): string {
  return `${role}:${docId}`;
}

interface RetrievalScopeState {
  scopes: Record<string, RetrievalScope>;
  setScope: (role: RetrievalScopeRole, docId: string, scope: RetrievalScope) => void;
}

function sanitizeScopes(value: unknown): Record<string, RetrievalScope> {
  if (!value || typeof value !== "object") return {};
  const next: Record<string, RetrievalScope> = {};
  for (const [key, scope] of Object.entries(value as Record<string, unknown>)) {
    if (typeof key === "string" && isRetrievalScope(scope)) next[key] = scope;
  }
  return next;
}

export const useRetrievalScopeStore = create<RetrievalScopeState>()(
  persist(
    (set) => ({
      scopes: {},
      setScope: (role, docId, scope) =>
        set((state) => ({
          scopes: { ...state.scopes, [retrievalScopeKey(role, docId)]: scope },
        })),
    }),
    {
      name: tauriStorageKey.retrievalScope,
      storage: createJSONStorage(() => tauriStorage),
      version: 1,
      partialize: (state) => ({ scopes: state.scopes }),
      merge: (persisted, current) => {
        const persistedScopes = sanitizeScopes((persisted as { scopes?: unknown } | undefined)?.scopes);
        return { ...current, scopes: persistedScopes };
      },
    },
  ),
);

/** 读取某本书/某篇论文上次选择的范围；无记录时 current。 */
export function useRetrievalScopeFor(role: RetrievalScopeRole, docId: string | undefined): RetrievalScope {
  return useRetrievalScopeStore((state) =>
    docId ? (state.scopes[retrievalScopeKey(role, docId)] ?? DEFAULT_RETRIEVAL_SCOPE) : DEFAULT_RETRIEVAL_SCOPE,
  );
}
