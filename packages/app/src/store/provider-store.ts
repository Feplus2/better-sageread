import { predefinedProviders } from "@/constants/predefined-providers";
import { tauriStorageKey } from "@/constants/tauri-storage";
import { tauriStorage } from "@/lib/tauri-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export interface SelectedModel {
  modelId: string;
  providerId: string;
  providerName: string;
  modelName: string;
}

interface ProviderState {
  modelProviders: ModelProvider[];
  selectedModel: SelectedModel | null;
  utilityModel: SelectedModel | null;
  setModelProviders: (modelProviders: ModelProvider[]) => void;
  updateProvider: (providerId: string, updates: Partial<ModelProvider>) => void;
  addProvider: () => string;
  removeProvider: (providerId: string) => void;
  setSelectedModel: (model: SelectedModel | null) => void;
  setUtilityModel: (model: SelectedModel | null) => void;
}

export const useProviderStore = create<ProviderState>()(
  persist(
    (set, get) => ({
      modelProviders: predefinedProviders,
      selectedModel: null,
      utilityModel: null,
      setModelProviders: (modelProviders: ModelProvider[]) => set({ modelProviders }),
      updateProvider: (providerId: string, updates: Partial<ModelProvider>) => {
        const { modelProviders } = get();
        const updatedProviders = modelProviders.map((provider) =>
          provider.provider === providerId ? { ...provider, ...updates } : provider,
        );
        set({ modelProviders: updatedProviders });
      },
      addProvider: () => {
        const { modelProviders } = get();
        const newProviderId = `custom-${Date.now()}`;
        const newProvider: ModelProvider = {
          name: "untitled",
          active: true,
          provider: newProviderId,
          apiStyle: "auto",
          apiKey: "",
          baseUrl: "",
          models: [],
        };
        set({ modelProviders: [...modelProviders, newProvider] });
        return newProviderId;
      },
      removeProvider: (providerId: string) => {
        const { modelProviders, selectedModel } = get();
        const updatedProviders = modelProviders.filter((provider) => provider.provider !== providerId);

        let newSelectedModel = selectedModel;
        if (selectedModel && selectedModel.providerId === providerId) {
          newSelectedModel = null;
        }

        set({ modelProviders: updatedProviders, selectedModel: newSelectedModel });
      },
      setSelectedModel: (selectedModel: SelectedModel | null) => set({ selectedModel }),
      setUtilityModel: (utilityModel: SelectedModel | null) => set({ utilityModel }),
    }),
    {
      name: tauriStorageKey.modelProvider,
      storage: createJSONStorage(() => tauriStorage),
      version: 6,
      migrate: (persistedState: any, version: number) => {
        if (version < 1) {
          // v0→v1: 合并新增的预定义提供商（保留用户已有配置不动）
          const existing: ModelProvider[] = persistedState.modelProviders ?? [];
          const existingIds = new Set(existing.map((p) => p.provider));
          const missing = predefinedProviders.filter((p) => !existingIds.has(p.provider));
          if (missing.length > 0) {
            persistedState.modelProviders = [...existing, ...missing];
          }
        }
        if (version < 2) {
          // v1→v2: 无 API Key 的提供商强制 active=false
          const domesticIds = new Set(["zhipu", "kimi", "xiaomi", "qwen", "doubao"]);
          persistedState.modelProviders = (persistedState.modelProviders ?? []).map((p: ModelProvider) =>
            domesticIds.has(p.provider) && !p.apiKey?.trim() ? { ...p, active: false } : p,
          );
        }
        if (version < 3) {
          // v2→v3: 阿里百炼(Qwen) 正名为「阿里云百炼」，旧名迁移（provider id 仍为 qwen，避免拆配置）
          persistedState.modelProviders = (persistedState.modelProviders ?? []).map((p: ModelProvider) =>
            p.provider === "qwen" && /^阿里百炼/.test(p.name ?? "") ? { ...p, name: "阿里云百炼" } : p,
          );
        }
        if (version < 4) {
          // v3→v4: 合并新增的预定义提供商（如 LM Studio 本地服务）；用户已有同 id 配置不覆盖
          const existing: ModelProvider[] = persistedState.modelProviders ?? [];
          const existingIds = new Set(existing.map((p) => p.provider));
          const missing = predefinedProviders.filter((p) => !existingIds.has(p.provider));
          if (missing.length > 0) {
            persistedState.modelProviders = [...existing, ...missing];
          }
        }
        if (version < 5) {
          // v4→v5: 本地 Ollama 从「自定义提供商」正名为预定义提供商：
          // 迁移旧 custom-*（名称含 ollama 或 11434 端点）的模型/启用状态到 provider=ollama，
          // 删除旧条目，并重映射 selectedModel/utilityModel 里的 providerId（保留用户当前选择）。
          const providers: ModelProvider[] = [...(persistedState.modelProviders ?? [])];
          const ollamaPredef = predefinedProviders.find((p) => p.provider === "ollama");
          const legacyOllama = providers.filter(
            (p) =>
              p.provider.startsWith("custom-") &&
              (/ollama/i.test(p.name ?? "") || /:11434(?:\/|$)/.test(p.baseUrl ?? "")),
          );
          let ollamaIds = new Map<string, string>();
          if (ollamaPredef && legacyOllama.length > 0) {
            const existingIdx = providers.findIndex((p) => p.provider === "ollama");
            const existingOllama = existingIdx >= 0 ? providers[existingIdx] : null;
            const mergedModels: ModelProvider["models"] = [...(existingOllama?.models ?? [])];
            let mergedActive = existingOllama?.active ?? false;
            let mergedApiKey = existingOllama?.apiKey ?? "";
            ollamaIds = new Map(legacyOllama.map((p) => [p.provider, "ollama"]));
            for (const legacy of legacyOllama) {
              mergedActive = mergedActive || legacy.active;
              mergedApiKey = mergedApiKey || legacy.apiKey || "";
              for (const model of legacy.models ?? []) {
                if (!mergedModels.some((m) => m.id === model.id)) mergedModels.push(model);
              }
            }
            const normalized: ModelProvider = {
              ...ollamaPredef,
              active: mergedActive,
              apiKey: mergedApiKey,
              models: mergedModels,
            };
            const legacyIds = new Set(legacyOllama.map((p) => p.provider));
            persistedState.modelProviders = providers
              .filter((p) => !legacyIds.has(p.provider))
              .map((p) => (p.provider === "ollama" ? normalized : p));
            if (!persistedState.modelProviders.some((p: ModelProvider) => p.provider === "ollama")) {
              persistedState.modelProviders.push(normalized);
            }
            const remap = (sel: SelectedModel | null) =>
              sel && ollamaIds.has(sel.providerId) ? { ...sel, providerId: "ollama", providerName: "Ollama" } : sel;
            persistedState.selectedModel = remap(persistedState.selectedModel ?? null);
            persistedState.utilityModel = remap(persistedState.utilityModel ?? null);
          }
          // 顺带合并其它新增的预定义提供商（如 LM Studio）；同 id 不覆盖
          const current: ModelProvider[] = persistedState.modelProviders ?? providers;
          const currentIds = new Set(current.map((p) => p.provider));
          const missing = predefinedProviders.filter((p) => !currentIds.has(p.provider));
          if (missing.length > 0) persistedState.modelProviders = [...current, ...missing];
        }
        if (version < 6) {
          // v5→v6: API 协议现代化。预置 provider 写默认 apiStyle；
          // 已有用户若把官方 provider 改成自定义代理，不强行覆盖为原生（按 auto 处理）。
          const nativeDefaults: Record<string, string> = {
            openai: "openai-responses",
            anthropic: "anthropic-messages",
            gemini: "gemini",
            deepseek: "anthropic-messages",
            kimi: "anthropic-messages",
            zhipu: "anthropic-messages",
            minimax: "anthropic-messages",
          };
          const officialHosts: Record<string, string[]> = {
            openai: ["api.openai.com"],
            anthropic: ["api.anthropic.com"],
            gemini: ["generativelanguage.googleapis.com"],
            deepseek: ["deepseek.com"],
            kimi: ["api.moonshot.cn"],
            zhipu: ["open.bigmodel.cn"],
            minimax: ["api.minimaxi.com", "api.minimax.io"],
          };
          const isOfficialHost = (providerId: string, baseUrl?: string) => {
            if (!baseUrl) return true;
            const hosts = officialHosts[providerId];
            if (!hosts) return false;
            try {
              const host = new URL(baseUrl).host.toLowerCase();
              return hosts.some((allowed) => host === allowed || host.endsWith("." + allowed));
            } catch {
              return false;
            }
          };
          const chatDefaults: Record<string, string> = {
            openrouter: "openai-chat",
            grok: "openai-chat",
            xiaomi: "openai-chat",
            qwen: "openai-chat",
            doubao: "openai-chat",
            ollama: "openai-chat",
            lmstudio: "openai-chat",
          };
          persistedState.modelProviders = (persistedState.modelProviders ?? []).map((p: ModelProvider) => {
            if (p.apiStyle) return p;
            const native = nativeDefaults[p.provider];
            if (native && isOfficialHost(p.provider, p.baseUrl)) return { ...p, apiStyle: native };
            const chat = chatDefaults[p.provider];
            if (chat) return { ...p, apiStyle: chat };
            return { ...p, apiStyle: "auto" as const };
          });
        }
        return persistedState;
      },
      partialize: (state) => ({
        // 安全（批次 A）：apiKey 仅存内存（启动时自 keyring 载入），落盘/备份不含密钥
        modelProviders: state.modelProviders.map(({ apiKey: _apiKey, ...rest }) => ({ ...rest, apiKey: "" })),
        selectedModel: state.selectedModel,
        utilityModel: state.utilityModel,
      }),
    },
  ),
);
