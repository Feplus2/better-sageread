import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/** 搜索 Provider 类型 */
export type SearchProvider = "builtin" | "bocha" | "zhipu" | "deepseek" | "tavily" | "serper" | "searxng" | "yuanbao";

/** 内置引擎（仅 builtin 模式下有效） */
export type SearchEngine = "auto" | "bing" | "baidu" | "duckduckgo";

interface WebSearchState {
  /** 当前活动 provider */
  activeProvider: SearchProvider;
  /** 内置引擎选择 */
  engine: SearchEngine;
  /** 各 provider 的 API Key */
  bochaKey: string;
  zhipuKey: string;
  deepseekKey: string;
  tavilyKey: string;
  serperKey: string;
  /** 腾讯元宝搜索（WSA）服务 API KEY */
  yuanbaoKey: string;
  /** SearXNG 服务地址 */
  searxngUrl: string;
  /** 已启用的 API provider 列表（配置了 Key 且用户开启的） */
  enabledProviders: SearchProvider[];

  setActiveProvider: (p: SearchProvider) => void;
  setEngine: (engine: SearchEngine) => void;
  setBochaKey: (key: string) => void;
  setZhipuKey: (key: string) => void;
  setDeepseekKey: (key: string) => void;
  setTavilyKey: (key: string) => void;
  setSerperKey: (key: string) => void;
  setYuanbaoKey: (key: string) => void;
  setSearxngUrl: (url: string) => void;
  toggleProvider: (p: SearchProvider) => void;
}

export const useWebSearchStore = create<WebSearchState>()(
  persist(
    (set) => ({
      activeProvider: "builtin",
      engine: "auto",
      bochaKey: "",
      zhipuKey: "",
      deepseekKey: "",
      tavilyKey: "",
      serperKey: "",
      yuanbaoKey: "",
      searxngUrl: "http://localhost:8080",
      enabledProviders: [],

      setActiveProvider: (activeProvider) => set({ activeProvider }),
      setEngine: (engine) => set({ engine }),
      setBochaKey: (bochaKey) => set({ bochaKey }),
      setZhipuKey: (zhipuKey) => set({ zhipuKey }),
      setDeepseekKey: (deepseekKey) => set({ deepseekKey }),
      setTavilyKey: (tavilyKey) => set({ tavilyKey }),
      setSerperKey: (serperKey) => set({ serperKey }),
      setYuanbaoKey: (yuanbaoKey) => set({ yuanbaoKey }),
      setSearxngUrl: (searxngUrl) => set({ searxngUrl }),
      toggleProvider: (p) =>
        set((state) => {
          const enabled = state.enabledProviders.includes(p);
          return {
            enabledProviders: enabled ? state.enabledProviders.filter((x) => x !== p) : [...state.enabledProviders, p],
          };
        }),
    }),
    {
      name: "web-search-engine",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        // 安全（批次 A）：API Key 由 keyring 保管（启动时载入内存），localStorage 不含密钥
        activeProvider: state.activeProvider,
        engine: state.engine,
        bochaKey: "",
        zhipuKey: "",
        deepseekKey: "",
        tavilyKey: "",
        serperKey: "",
        yuanbaoKey: "",
        searxngUrl: state.searxngUrl,
        enabledProviders: state.enabledProviders,
      }),
    },
  ),
);
