import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/**
 * Sciverse 科研搜索配置（独立于 web-search-store 的"网络搜索"）：
 * - 二者是叠加关系——webSearch 管通用网页/实时资讯，sciverseSearch 管学术证据检索；
 * - token 由 keyring 保管（account: sciverse:token），启动时载入内存，不落盘。
 */
interface SciverseState {
  /** 是否启用科研搜索工具（填了 token 才能开） */
  enabled: boolean;
  /** API Token（仅内存态；partialize 置空，持久化层不含密钥） */
  token: string;

  setEnabled: (enabled: boolean) => void;
  setToken: (token: string) => void;
}

export const useSciverseStore = create<SciverseState>()(
  persist(
    (set) => ({
      enabled: false,
      token: "",

      setEnabled: (enabled) => set({ enabled }),
      setToken: (token) => set({ token }),
    }),
    {
      name: "sciverse-search",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        enabled: state.enabled,
        // 安全（与 web-search 同款约定）：API Token 由 keyring 保管，localStorage 不含密钥
        token: "",
      }),
    },
  ),
);
