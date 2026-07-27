import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/** 搜索 Provider 类型 */
export type SearchProvider = "builtin" | "bocha" | "zhipu" | "tavily" | "serper" | "searxng";

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
  tavilyKey: string;
  serperKey: string;
  /** SearXNG 服务地址 */
  searxngUrl: string;
  /** 已启用的 API provider 列表（配置了 Key 且用户开启的） */
  enabledProviders: SearchProvider[];

  setActiveProvider: (p: SearchProvider) => void;
  setEngine: (engine: SearchEngine) => void;
  setBochaKey: (key: string) => void;
  setZhipuKey: (key: string) => void;
  setTavilyKey: (key: string) => void;
  setSerperKey: (key: string) => void;
  setSearxngUrl: (url: string) => void;
  toggleProvider: (p: SearchProvider) => void;
  /** 获取当前活动 provider 对应的 API Key */
  getActiveApiKey: () => string;
}

export const useWebSearchStore = create<WebSearchState>()(
  persist(
    (set, get) => ({
      activeProvider: "builtin",
      engine: "auto",
      bochaKey: "",
      zhipuKey: "",
      tavilyKey: "",
      serperKey: "",
      searxngUrl: "http://localhost:8080",
      enabledProviders: [],

      setActiveProvider: (activeProvider) => set({ activeProvider }),
      setEngine: (engine) => set({ engine }),
      setBochaKey: (bochaKey) => set({ bochaKey }),
      setZhipuKey: (zhipuKey) => set({ zhipuKey }),
      setTavilyKey: (tavilyKey) => set({ tavilyKey }),
      setSerperKey: (serperKey) => set({ serperKey }),
      setSearxngUrl: (searxngUrl) => set({ searxngUrl }),
      toggleProvider: (p) =>
        set((state) => {
          const enabled = state.enabledProviders.includes(p);
          return {
            enabledProviders: enabled ? state.enabledProviders.filter((x) => x !== p) : [...state.enabledProviders, p],
          };
        }),
      getActiveApiKey: () => {
        const state = get();
        switch (state.activeProvider) {
          case "bocha":
            return state.bochaKey;
          case "zhipu":
            return state.zhipuKey;
          case "tavily":
            return state.tavilyKey;
          case "serper":
            return state.serperKey;
          default:
            return "";
        }
      },
    }),
    {
      name: "web-search-engine",
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
