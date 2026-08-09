import { createModelInstance } from "@/ai/providers/factory";
import { useChatSettingsStore } from "@/store/chat-settings-store";
import { type SelectedModel, useProviderStore } from "@/store/provider-store";
import { useCallback, useEffect, useMemo } from "react";

export function useModelSelector(defaultProviderId?: string, defaultModelId?: string) {
  const { modelProviders, selectedModel, setSelectedModel } = useProviderStore();

  // 当前选中 provider 的 apiKey（响应式）：keyring 异步载入 key 后 updateProvider 会变更 modelProviders，
  // 需据此重建模型实例，否则实例会攥住创建时捕获的空 key（401）不放
  const currentApiKey = selectedModel
    ? (modelProviders.find((p) => p.provider === selectedModel.providerId)?.apiKey ?? "")
    : "";

  useEffect(() => {
    if (!selectedModel) {
      let initialModel: SelectedModel | null = null;

      if (defaultProviderId && defaultModelId) {
        const provider = modelProviders.find((p) => p.provider === defaultProviderId && p.active);
        if (provider) {
          const model = provider.models.find((m) => m.id === defaultModelId && m.active);
          if (model) {
            initialModel = {
              modelId: model.id,
              providerId: provider.provider,
              providerName: provider.name,
              modelName: model.name || model.id,
            };
          }
        }
      }

      if (!initialModel) {
        for (const provider of modelProviders) {
          if (!provider.active) continue;

          const activeModel = provider.models.find((m) => m.active);
          if (activeModel) {
            initialModel = {
              modelId: activeModel.id,
              providerId: provider.provider,
              providerName: provider.name,
              modelName: activeModel.name || activeModel.id,
            };
            break;
          }
        }
      }

      if (initialModel) {
        setSelectedModel(initialModel);
      }
    }
  }, [selectedModel, modelProviders, defaultProviderId, defaultModelId, setSelectedModel]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: currentApiKey 是刻意依赖——keyring 异步载入 key 后触发实例重建，修复启动竞态导致的 401
  const currentModelInstance = useMemo(() => {
    if (!selectedModel) return null;

    try {
      // 聊天模型：挂动态思考强度包装（P3；按请求时刻档位打补丁，映射表不认的端透传）
      return createModelInstance(selectedModel.providerId, selectedModel.modelId, {
        reasoningLevelRef: () => useChatSettingsStore.getState().reasoningLevel,
      });
    } catch (error) {
      console.error("Failed to create model instance:", error);
      return null;
    }
  }, [selectedModel, currentApiKey]);

  const handleModelSelect = useCallback(
    (model: SelectedModel) => {
      setSelectedModel(model);
    },
    [setSelectedModel],
  );

  const availableModels = useMemo(() => {
    return modelProviders
      .filter((provider) => provider.active)
      .flatMap((provider) =>
        provider.models
          .filter((model) => model.active)
          .map((model) => ({
            modelId: model.id,
            providerId: provider.provider,
            providerName: provider.name,
            modelName: model.name || model.id,
            providerIcon: provider.icon,
          })),
      );
  }, [modelProviders]);

  return {
    selectedModel,
    setSelectedModel: handleModelSelect,
    currentModelInstance,
    availableModels,
  };
}
