import { resolveProviderProtocol } from "@/ai/providers/protocol";
import { getPresetProvider } from "@/utils/provider-endpoint";
import { fetch as fetchTauri } from "@tauri-apps/plugin-http";

/** 模型列表条目：id + 可选上下文窗口（部分厂商 /models 会带 context_length 等字段） */
export interface ProviderModelInfo {
  id: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

const CONTEXT_WINDOW_FIELDS = [
  "context_length",
  "context_window",
  "max_context_length",
  "max_input_tokens",
  "max_model_len",
  "inputTokenLimit",
];

function pickContextWindow(record: any): number | undefined {
  for (const key of CONTEXT_WINDOW_FIELDS) {
    const value = record?.[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
    if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  }
  return undefined;
}

function pickMaxOutputTokens(record: any): number | undefined {
  for (const key of ["max_output_tokens", "maxOutputTokens", "max_tokens", "outputTokenLimit"]) {
    const value = record?.[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
    if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  }
  return undefined;
}

function toModelInfo(record: any, id: string): ProviderModelInfo {
  const contextWindow = pickContextWindow(record);
  const maxOutputTokens = pickMaxOutputTokens(record);
  return {
    id,
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
  };
}

/**
 * 拉取模型列表（含窗口等元数据，供上下文预算使用）。
 * Always uses Tauri's HTTP client to bypass CORS issues.
 */
export const fetchModelCatalog = async (provider: ModelProvider, modelId?: string): Promise<ProviderModelInfo[]> => {
  if (!provider.baseUrl) {
    throw new Error("Provider must have baseUrl configured");
  }

  const catalogModelId = modelId?.trim() || provider.models.find((model) => model.active)?.id || provider.models[0]?.id;
  const protocol = resolveProviderProtocol({
    providerId: provider.provider,
    baseUrl: provider.baseUrl,
    modelId: catalogModelId,
    apiStyle: provider.apiStyle,
  });
  const isGemini = protocol === "gemini";
  // Anthropic 兼容端点未必暴露 /models；回退到该提供商的 OpenAI Chat 根再试一次
  // （预置端点表里就有，DeepSeek/Kimi/智谱/MiniMax 用户刷新模型列表时更不容易卡住）
  const candidates = modelListBaseUrls(provider, isGemini);
  let lastError: unknown = null;

  for (const baseUrl of candidates) {
    try {
      return await fetchModelsAt(provider, baseUrl, isGemini);
    } catch (error) {
      lastError = error;
    }
  }

  console.error("Error fetching models from provider:", lastError);
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  if (message.includes("fetch")) {
    throw new Error(
      `Cannot connect to ${provider.provider} at ${provider.baseUrl}. Please check that the service is running and accessible.`,
    );
  }
  throw lastError instanceof Error ? lastError : new Error(message);
};

/** 兼容旧调用：只返回模型 ID */
export const fetchModelsFromProvider = async (provider: ModelProvider): Promise<string[]> =>
  (await fetchModelCatalog(provider)).map((entry) => entry.id);

/** 模型列表候选地址：当前 baseUrl 优先，其后是预置的 OpenAI 兼容根 */
function modelListBaseUrls(provider: ModelProvider, isGemini: boolean): string[] {
  const urls = [provider.baseUrl?.replace(/\/+$/, "") ?? ""].filter(Boolean);
  if (!isGemini) {
    const endpoints = provider.endpoints ?? getPresetProvider(provider.provider)?.endpoints ?? {};
    for (const key of ["openai-chat", "openai-responses"] as const) {
      const url = endpoints[key];
      if (url) urls.push(url.replace(/\/+$/, ""));
    }
  }
  return [...new Set(urls)];
}

async function fetchModelsAt(
  provider: ModelProvider,
  baseUrl: string,
  isGemini: boolean,
): Promise<ProviderModelInfo[]> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (provider.apiKey) {
    if (isGemini) {
      headers["x-goog-api-key"] = provider.apiKey;
    } else {
      headers["x-api-key"] = provider.apiKey;
      headers.Authorization = `Bearer ${provider.apiKey}`;
    }
  } else if (isGemini) {
    throw new Error("Gemini provider requires an API key");
  }

  const modelsUrl = isGemini
    ? `${/(\/v1(beta)?)$/.test(baseUrl) ? baseUrl : `${baseUrl}/v1beta`}/models?key=${encodeURIComponent(provider.apiKey!)}`
    : `${baseUrl}/models`;

  const response = await fetchWithTimeout(modelsUrl, { method: "GET", headers }, MODEL_LIST_TIMEOUT_MS);
  if (!response.ok) {
    throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();

  // Handle different response formats that providers might use
  if (data.data && Array.isArray(data.data)) {
    // OpenAI format: { data: [{ id: "model-id", context_length?: 128000 }, ...] }
    return data.data
      .filter((model: any) => typeof model?.id === "string" && model.id)
      .map((model: any) => toModelInfo(model, model.id));
  }

  if (Array.isArray(data)) {
    // Direct array format: ["model-id", { id, context_length }]
    return data
      .map((model: any) => {
        if (typeof model === "string") return { id: model } as ProviderModelInfo;
        if (typeof model?.id === "string") return toModelInfo(model, model.id);
        return undefined;
      })
      .filter((entry: ProviderModelInfo | undefined): entry is ProviderModelInfo => !!entry?.id);
  }

  if (data.models && Array.isArray(data.models)) {
    // Alternative format: { models: [{ name: "models/gemini-2.5-pro", inputTokenLimit }, ...] }
    return data.models
      .map((model: any) => {
        if (typeof model === "string") return { id: model } as ProviderModelInfo;
        if (typeof model?.id === "string") return toModelInfo(model, model.id);
        if (typeof model?.name === "string") return toModelInfo(model, model.name.replace(/^models\//, ""));
        return undefined;
      })
      .filter((entry: ProviderModelInfo | undefined): entry is ProviderModelInfo => !!entry?.id);
  }

  console.warn("Unexpected response format from provider API:", data);
  return [];
}

/** 模型列表请求超时：防止坏 provider/代理让设置页刷新永远转圈 */
const MODEL_LIST_TIMEOUT_MS = 15_000;

function fetchWithTimeout(
  url: string,
  init: Parameters<typeof fetchTauri>[1],
  timeoutMs: number,
): ReturnType<typeof fetchTauri> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`fetch timeout (${timeoutMs}ms)`)), timeoutMs);
  });
  return Promise.race([fetchTauri(url, init), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as ReturnType<typeof fetchTauri>;
}

/** 本地服务的原生管理 API 根地址（去掉 /v1 后缀） */
function nativeRoot(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
}

/**
 * 聊天模型列表过滤（模型列表只留对话模型）：
 * - Ollama：/v1/models 会把嵌入/多模态模型一并列出；用原生 /api/show 的
 *   capabilities（completion / tools）判定是否为对话模型；
 * - LM Studio：用 /api/v0/models 的 type 过滤掉 "embeddings"；
 * - 过滤失败或结果为空时回退原列表，避免误杀。
 */
export async function filterChatModels(modelIds: string[], provider: ModelProvider): Promise<string[]> {
  const baseUrl = (provider.baseUrl ?? "").trim();
  if (!baseUrl) return modelIds;

  const isOllama = /:11434(?:\/|$)/.test(baseUrl) || /ollama/i.test(provider.name ?? "");
  if (isOllama) {
    const root = nativeRoot(baseUrl);
    const checked = await Promise.all(
      modelIds.map(async (id) => {
        try {
          const res = await fetchTauri(`${root}/api/show`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: id }),
          });
          if (!res.ok) return id;
          const json = (await res.json()) as { capabilities?: string[] };
          const caps = Array.isArray(json.capabilities) ? json.capabilities : [];
          if (!caps.length) return id;
          return caps.includes("completion") || caps.includes("tools") ? id : null;
        } catch {
          return id;
        }
      }),
    );
    const chatModels = checked.filter((id): id is string => !!id);
    return chatModels.length > 0 ? chatModels : modelIds;
  }

  const isLmStudio = /:1234(?:\/|$)/.test(baseUrl) || /lm\s*studio/i.test(provider.name ?? "");
  if (isLmStudio) {
    try {
      const res = await fetchTauri(`${nativeRoot(baseUrl)}/api/v0/models`);
      if (!res.ok) return modelIds;
      const json = (await res.json()) as { data?: Array<{ id?: string; type?: string }> };
      const typeMap = new Map((json.data ?? []).map((m) => [m.id, m.type]));
      const chatModels = modelIds.filter((id) => typeMap.get(id) !== "embeddings");
      return chatModels.length > 0 ? chatModels : modelIds;
    } catch {
      return modelIds;
    }
  }

  return modelIds;
}
