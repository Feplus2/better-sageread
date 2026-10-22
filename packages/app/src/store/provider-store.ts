import { predefinedProviders } from "@/constants/predefined-providers";
import { tauriStorageKey } from "@/constants/tauri-storage";
import { tauriStorage } from "@/lib/tauri-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/**
 * Anthropic 兼容端点的规范 baseURL（2026-10-22 实网纠偏）。
 * @ai-sdk/anthropic 在 baseURL 后追加 /messages，而厂商文档的 base_url 是 Anthropic 官方
 * SDK 语义（SDK 再补 /v1/messages），所以预填地址必须带 /v1。实测短路径：
 * Kimi 404 / 智谱 HTTP200 包 404 / MiniMax 404；带 /v1 均可达。
 */
const ANTHROPIC_COMPAT_CANONICAL_BASE_URLS: Record<string, string> = {
  deepseek: "https://api.deepseek.com/anthropic/v1",
  kimi: "https://api.moonshot.cn/anthropic/v1",
  zhipu: "https://open.bigmodel.cn/api/anthropic/v1",
  minimax: "https://api.minimaxi.com/anthropic/v1",
};

const ANTHROPIC_COMPAT_OFFICIAL_HOSTS: Record<string, string[]> = {
  deepseek: ["deepseek.com"],
  kimi: ["api.moonshot.cn"],
  zhipu: ["open.bigmodel.cn"],
  minimax: ["api.minimaxi.com", "api.minimax.io"],
};

/** 只对官方 host 做端点规范化；用户自定义代理保持原样 */
function isOfficialProviderHost(providerId: string, baseUrl?: string): boolean {
  if (!baseUrl) return true;
  const allowed = ANTHROPIC_COMPAT_OFFICIAL_HOSTS[providerId];
  if (!allowed) return false;
  try {
    const host = new URL(baseUrl).host.toLowerCase();
    return allowed.some((domain) => host === domain || host.endsWith("." + domain));
  } catch {
    return false;
  }
}

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
        const { modelProviders, selectedModel, utilityModel } = get();
        const updatedProviders = modelProviders.filter((provider) => provider.provider !== providerId);

        let newSelectedModel = selectedModel;
        if (selectedModel && selectedModel.providerId === providerId) {
          newSelectedModel = null;
        }
        // 辅助模型同样不能悬挂：否则 createUtilityModelInstance 会抛 "Provider not found"
        const newUtilityModel = utilityModel && utilityModel.providerId === providerId ? null : utilityModel;

        // 删除提供商时清掉 OS 凭据管理器里的密钥，避免 keyring 孤儿
        void import("@/services/secret-service")
          .then((m) => m.secretDelete("model-provider", providerId))
          .catch(() => {});
        set({ modelProviders: updatedProviders, selectedModel: newSelectedModel, utilityModel: newUtilityModel });
      },
      setSelectedModel: (selectedModel: SelectedModel | null) => set({ selectedModel }),
      setUtilityModel: (utilityModel: SelectedModel | null) => set({ utilityModel }),
    }),
    {
      name: tauriStorageKey.modelProvider,
      storage: createJSONStorage(() => tauriStorage),
      version: 9,
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
            zhipu: "openai-chat",
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
        if (version < 7) {
          // v6→v7：Anthropic 兼容端点补 /v1（Kimi/智谱/MiniMax 短路径会 404；DeepSeek 兼容两种但统一）。
          // 只迁移官方 host；用户自定义代理保持原样，避免覆盖别人的路径约定。
          persistedState.modelProviders = (persistedState.modelProviders ?? []).map((p: ModelProvider) => {
            const target = ANTHROPIC_COMPAT_CANONICAL_BASE_URLS[p.provider];
            if (!target || !isOfficialProviderHost(p.provider, p.baseUrl)) return p;
            // MiniMax 区域域名保持用户选择
            const next =
              p.provider === "minimax" && /minimax\.io/i.test(p.baseUrl ?? "")
                ? "https://api.minimax.io/anthropic/v1"
                : target;
            return p.baseUrl === next ? p : { ...p, baseUrl: next };
          });
        }
        if (version < 8) {
          // v7→v8：合并新增的预置提供商（如 MiniMax；v4 之后新增的预置在旧用户 store 里不存在）。
          // 同 id 不覆盖，保留用户已有配置。
          const current: ModelProvider[] = persistedState.modelProviders ?? [];
          const ids = new Set(current.map((p) => p.provider));
          const missing = predefinedProviders.filter((p) => !ids.has(p.provider));
          if (missing.length > 0) persistedState.modelProviders = [...current, ...missing];
        }
        if (version < 9) {
          // v8→v9：智谱默认协议改 OpenAI 兼容（普通 API key 的 Anthropic 兼容端点会 429 Coding Plan 限制）。
          // 只迁移官方端点形态的预置选择；已订阅 Coding Plan 的用户可在设置里切回 Anthropic 端点。
          persistedState.modelProviders = (persistedState.modelProviders ?? []).map((p: ModelProvider) => {
            if (p.provider !== "zhipu") return p;
            const official = !p.baseUrl || /open\.bigmodel\.cn|api\.z\.ai/i.test(p.baseUrl);
            if (!official) return p;
            if (p.apiStyle !== "anthropic-messages") return p;
            return { ...p, apiStyle: "openai-chat" as const, baseUrl: "https://open.bigmodel.cn/api/paas/v4" };
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
