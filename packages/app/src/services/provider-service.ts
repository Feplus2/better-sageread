import { getPresetProvider } from "@/utils/provider-endpoint";
import { fetch as fetchTauri } from "@tauri-apps/plugin-http";

/**
 * Fetches models from a provider's API endpoint
 * Always uses Tauri's HTTP client to bypass CORS issues
 * @param provider The provider object containing baseUrl and apiKey
 * @returns Promise<string[]> Array of model IDs
 */
export const fetchModelsFromProvider = async (provider: ModelProvider): Promise<string[]> => {
  if (!provider.baseUrl) {
    throw new Error("Provider must have baseUrl configured");
  }

  const isGemini = provider.provider === "gemini";
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

async function fetchModelsAt(provider: ModelProvider, baseUrl: string, isGemini: boolean): Promise<string[]> {
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

  const response = await fetchTauri(modelsUrl, { method: "GET", headers });
  if (!response.ok) {
    throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();

  // Handle different response formats that providers might use
  if (data.data && Array.isArray(data.data)) {
    // OpenAI format: { data: [{ id: "model-id" }, ...] }
    return data.data.map((model: { id: string }) => model.id).filter(Boolean);
  }

  if (Array.isArray(data)) {
    // Direct array format: ["model-id1", "model-id2", ...]
    return data.filter(Boolean).map((model) => (typeof model === "object" && "id" in model ? model.id : model));
  }

  if (data.models && Array.isArray(data.models)) {
    // Alternative format: { models: [...] }
    return data.models
      .map((model: any) => {
        if (typeof model === "string") return model;
        if (typeof model.id === "string") return model.id;
        if (typeof model.name === "string") {
          return model.name.replace(/^models\//, "");
        }
        return undefined;
      })
      .filter(Boolean);
  }

  console.warn("Unexpected response format from provider API:", data);
  return [];
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
