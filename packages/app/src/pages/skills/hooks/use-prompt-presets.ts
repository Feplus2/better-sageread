import * as promptPresetService from "@/services/prompt-preset-service";
import type { PromptPreset, PromptPresetScope } from "@/services/prompt-preset-service";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

const PROMPT_PRESETS_QUERY_KEY = ["prompt-presets"];

export function usePromptPresets() {
  return useQuery({
    queryKey: PROMPT_PRESETS_QUERY_KEY,
    queryFn: () => promptPresetService.listPromptPresets(),
  });
}

export function useCreatePromptPreset() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ scope, name, content }: { scope: PromptPresetScope; name: string; content: string }) =>
      promptPresetService.createPromptPreset(scope, name, content),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PROMPT_PRESETS_QUERY_KEY });
    },
  });
}

export function useUpdatePromptPreset() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, name, content }: { id: string; name: string; content: string }) =>
      promptPresetService.updatePromptPreset(id, name, content),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PROMPT_PRESETS_QUERY_KEY });
    },
  });
}

export function useDeletePromptPreset() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => promptPresetService.deletePromptPreset(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PROMPT_PRESETS_QUERY_KEY });
    },
  });
}

export function useSetActivePromptPreset() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => promptPresetService.setActivePromptPreset(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PROMPT_PRESETS_QUERY_KEY });
    },
  });
}

export function useClearActivePromptPreset() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (scope: PromptPresetScope) => promptPresetService.clearActivePromptPreset(scope),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PROMPT_PRESETS_QUERY_KEY });
    },
  });
}

export type { PromptPreset };
