import { type SelectedModel, useProviderStore } from "@/store/provider-store";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { fetch as fetchTauri } from "@tauri-apps/plugin-http";
import { type ReasoningLevel, chatReasoningBodyPatch } from "./reasoning-map";
import { VISION_NAME_RE } from "./vision-map";

export interface ProviderConfig {
  providerId: string;
  apiKey?: string;
  baseUrl?: string;
  /** 轻量任务：注入"关闭思考"请求体参数（DeepSeek V4 默认开思考，轻量任务会慢一个数量级） */
  disableThinking?: boolean;
  /** 模型 ID（关闭思考参数按模型分档时用，如 Kimi K3 用 reasoning_effort、思考专用模型不下发） */
  modelId?: string;
  /** 聊天模型：按请求时刻的用户档位动态打思考强度补丁（P3，分档表见 reasoning-map.ts） */
  reasoningLevelRef?: () => ReasoningLevel;
}

/** 按端点/模型求"关闭思考"请求体补丁；不认识或关不掉的返回 null（不乱发防 400） */
function thinkingOffPatch(
  providerId: string,
  baseUrl?: string,
  modelId?: string,
): ((body: Record<string, unknown>) => void) | null {
  const id = (modelId ?? "").toLowerCase();
  // DeepSeek V4：thinking 默认开启，thinking:{type:"disabled"} 关闭（官方文档）
  if (providerId === "deepseek")
    return (body) => {
      body.thinking = { type: "disabled" };
    };
  const host = (baseUrl ?? "").toLowerCase();
  // GLM（智谱 bigmodel）：thinking:{type:"disabled"}
  if (host.includes("bigmodel.cn"))
    return (body) => {
      body.thinking = { type: "disabled" };
    };
  // Qwen（阿里 dashscope）：enable_thinking:false
  if (host.includes("dashscope"))
    return (body) => {
      body.enable_thinking = false;
    };
  // Kimi（Moonshot）：K3 系列用顶层 reasoning_effort（low/high/max），K2.x 混合模型用 thinking disabled；
  // 思考专用型号（kimi-k2-thinking 等）关不掉，不下发
  if (host.includes("moonshot") || host.includes("kimi.com") || host.includes("kimi.ai")) {
    if (/^(kimi-)?k3/.test(id))
      return (body) => {
        body.reasoning_effort = "low";
      };
    if (id.includes("thinking")) return null;
    return (body) => {
      body.thinking = { type: "disabled" };
    };
  }
  return null;
}

/** 包装 fetch：把补丁写进 JSON 请求体；若端点 400 报思考参数相关错误，去掉补丁重放一次（防未来端点变更击穿轻量任务） */
function wrapThinkingOffFetch(
  base: typeof fetch | undefined,
  patch: (body: Record<string, unknown>) => void,
): typeof fetch {
  const inner = base ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  return async (input, init) => {
    if (!init?.body || typeof init.body !== "string") return inner(input, init);
    let patched: RequestInit;
    try {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      patch(body);
      patched = { ...init, body: JSON.stringify(body) };
    } catch {
      return inner(input, init); // 非 JSON 请求体原样透传
    }
    const res = await inner(input, patched);
    if (res.status === 400) {
      const text = await res
        .clone()
        .text()
        .catch(() => "");
      if (/thinking|reasoning|enable_thinking/i.test(text)) return inner(input, init);
    }
    return res;
  };
}

/**
 * 聊天模型的动态思考强度包装（P3）：每次请求时读取当前档位，按端点分档表打请求体补丁
 * （DeepSeek/GLM/Qwen/Kimi；AI SDK 原生参数族走 transport 的 providerOptions，不经这里）。
 * 端点 400 报思考参数相关错误时去掉补丁重放一次（防端点变更击穿聊天）。
 */
function wrapChatReasoningFetch(
  base: typeof fetch | undefined,
  providerId: string,
  baseUrl: string | undefined,
  modelId: string | undefined,
  levelRef: () => ReasoningLevel,
): typeof fetch {
  const inner = base ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  return async (input, init) => {
    if (!init?.body || typeof init.body !== "string") return inner(input, init);
    let patched: RequestInit;
    let didPatch = false;
    try {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      const patch = chatReasoningBodyPatch(providerId, baseUrl, modelId, levelRef());
      if (patch) {
        patch(body);
        didPatch = true;
      }
      patched = { ...init, body: JSON.stringify(body) };
    } catch {
      return inner(input, init); // 非 JSON 请求体原样透传
    }
    const res = await inner(input, patched);
    if (didPatch && res.status === 400) {
      const text = await res
        .clone()
        .text()
        .catch(() => "");
      if (/thinking|reasoning|enable_thinking/i.test(text)) return inner(input, init);
    }
    return res;
  };
}

/**
 * 动态创建AI提供商实例
 */
export function createProviderInstance(config: ProviderConfig) {
  const { providerId, apiKey, baseUrl, disableThinking, modelId, reasoningLevelRef } = config;
  // 关闭思考补丁：仅轻量任务（disableThinking）且端点认识时生效
  const patch = disableThinking ? thinkingOffPatch(providerId, baseUrl, modelId) : null;
  // 两路 fetch 包装可叠加（实践中互斥：轻量任务走 disableThinking，聊天走 reasoningLevelRef）
  const wrapFetch = (base?: typeof fetch): typeof fetch | undefined => {
    let f = base;
    if (patch) f = wrapThinkingOffFetch(f, patch);
    if (reasoningLevelRef) f = wrapChatReasoningFetch(f, providerId, baseUrl, modelId, reasoningLevelRef);
    return f;
  };
  const wrappedDefault = patch || reasoningLevelRef ? wrapFetch(undefined) : undefined;
  const maybeWrap = (base?: typeof fetch) => wrapFetch(base) ?? base;

  switch (providerId) {
    case "deepseek":
      // D3 修复：视觉型号走 openai-compatible 通道——@ai-sdk/deepseek 为纯文本官方适配器
      // （file part 被静默丢弃，模型只能看到文件名文本）；DeepSeek 视觉 API 本就是 OpenAI
      // 兼容格式（image_url），openai-compatible 适配器可正确转换。命名判定与 vision-map 同源。
      if (modelId && VISION_NAME_RE.test(modelId.toLowerCase())) {
        return createOpenAICompatible({
          name: "deepseek-vision",
          baseURL: baseUrl || "https://api.deepseek.com",
          apiKey: apiKey || "",
          ...(wrappedDefault ? { fetch: wrappedDefault } : {}),
        });
      }
      return createDeepSeek({
        apiKey: apiKey || "",
        baseURL: baseUrl,
        ...(wrappedDefault ? { fetch: wrappedDefault } : {}),
      });

    case "openrouter":
      return createOpenRouter({
        apiKey: apiKey || "",
        baseURL: baseUrl,
      });

    case "openai":
      return createOpenAI({
        apiKey: apiKey || "",
        baseURL: baseUrl,
      });

    case "anthropic":
      return createOpenAICompatible({
        apiKey: apiKey || "",
        baseURL: baseUrl || "https://api.anthropic.com/v1",
        includeUsage: true,
        name: "OpenAI Compatible",
        fetch: fetchTauri,
      });

    case "gemini":
    case "google":
      return createGoogleGenerativeAI({
        apiKey: apiKey || "https://generativelanguage.googleapis.com/v1beta",
        baseURL: baseUrl,
      });

    case "grok":
      // Grok 使用 OpenAI 兼容的 API
      return createOpenAI({
        apiKey: apiKey || "",
        baseURL: baseUrl || "https://api.x.ai/v1",
      });

    default:
      return createOpenAICompatible({
        apiKey: apiKey || "",
        baseURL: baseUrl || "https://api.openai.com/v1",
        includeUsage: true,
        name: "OpenAI Compatible",
        fetch: maybeWrap(fetchTauri) ?? fetchTauri,
      });
  }
}

/**
 * 根据提供商ID和模型ID创建模型实例
 */
export function createModelInstance(
  providerId: string,
  modelId: string,
  opts?: { disableThinking?: boolean; reasoningLevelRef?: () => ReasoningLevel },
) {
  // 从store获取提供商配置
  const { modelProviders } = useProviderStore.getState();
  const provider = modelProviders.find((p) => p.provider === providerId);

  if (!provider) {
    throw new Error(`Provider not found: ${providerId}`);
  }

  if (!provider.active) {
    throw new Error(`Provider is not active: ${providerId}`);
  }

  const model = provider.models.find((m) => m.id === modelId);
  if (!model || !model.active) {
    throw new Error(`Model not found or not active: ${modelId}`);
  }

  // 创建提供商实例
  const providerInstance = createProviderInstance({
    providerId,
    apiKey: provider.apiKey,
    baseUrl: provider.baseUrl,
    disableThinking: opts?.disableThinking,
    modelId,
    reasoningLevelRef: opts?.reasoningLevelRef,
  });

  // 返回模型实例
  return providerInstance(modelId);
}

/**
 * 轻量任务（翻译/标题/标签等）的模型实例：对支持的端点注入"关闭思考"请求体参数。
 * 与 utilityTaskProviderOptions（AI SDK 原生支持的 provider）互补，二合一使用。
 */
export function createUtilityModelInstance(providerId: string, modelId: string) {
  return createModelInstance(providerId, modelId, { disableThinking: true });
}

/**
 * 获取用于轻量任务（生成对话标题、AI 标签、前情摘要压缩等）的辅助模型
 * 未配置辅助模型时回落到当前聊天选中模型
 * _task 为将来按任务类型分配模型预留，当前忽略
 */
export function getUtilityModel(_task?: string): SelectedModel | null {
  const { utilityModel, selectedModel } = useProviderStore.getState();
  return utilityModel ?? selectedModel;
}

/**
 * 轻量任务（翻译/标题/标签等辅助模型调用）的思考强度控制：混合推理模型在简单任务上
 * 先思考数十秒再输出，是辅助任务慢的主因。按 provider+model 返回"低档/关闭思考"的 providerOptions。
 * 只下发对端明确兼容的参数（OpenAI 对不支持的模型会 400，故按模型前缀门控）；不支持的一律不下发。
 * DeepSeek：deepseek-chat 默认非思考、deepseek-reasoner 恒思考（建议辅助模型选 chat 版），无可下开关；
 * anthropic 走 OpenAI 兼容通道无思考开关；GLM/Qwen 自定义端点参数不统一，不下发防 400。
 */
export function utilityTaskProviderOptions(
  providerId: string,
  modelId: string,
): Record<string, Record<string, any>> | undefined {
  const id = modelId.toLowerCase();
  switch (providerId) {
    case "openai":
      // reasoning_effort 仅 o 系列 / gpt-5 系列支持
      if (/^(o\d|gpt-5)/.test(id)) return { openai: { reasoningEffort: "low" } };
      return undefined;
    case "google":
    case "gemini":
      // thinkingConfig 仅 Gemini 2.5+ 支持
      if (/gemini-(2\.5|3)/.test(id)) return { google: { thinkingConfig: { thinkingBudget: 0 } } };
      return undefined;
    case "openrouter":
      // OpenRouter 对不支持推理的模型自动忽略 reasoning 参数，可安全下发
      return { openrouter: { reasoning: { effort: "low" } } };
    case "grok":
      // 仅 grok-3-mini 系列支持 reasoning_effort（grok-4 恒思考）
      if (id.includes("grok-3-mini")) return { openai: { reasoningEffort: "low" } };
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Hook: 获取可用的模型列表
 */
export function useAvailableModels() {
  const { modelProviders } = useProviderStore();

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
        })),
    );
}
