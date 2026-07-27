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
      version: 2,
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
        return persistedState;
      },
      partialize: (state) => ({
        modelProviders: state.modelProviders,
        selectedModel: state.selectedModel,
        utilityModel: state.utilityModel,
      }),
    },
  ),
);
