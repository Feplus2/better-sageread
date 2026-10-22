/**
 * Provider 协议路由（2026-10-22 现代化）：
 * 决定模型走哪一代 API，以及工具结果里的图片能否原生回传。
 *
 * - openai-responses：OpenAI Responses API（官方 OpenAI、以及已知网关的 openai/* 模型）
 * - openai-chat：OpenAI Chat Completions（grok、以及只支持 chat 的自定义代理）
 * - anthropic-messages：Anthropic Messages（官方 Anthropic、以及已知网关的 anthropic/* 模型）
 * - gemini：Google Gemini 原生（Gemini 3 支持多模态工具结果）
 * - chat：OpenAI-compatible chat（DeepSeek 视觉、OpenRouter、未知自定义端点；工具图片走 fetch 层图片桥）
 *
 * 注意：这是“传输协议”路由，不是“模型能力”判断；未知自定义端点默认 chat（最保守，不会误发新端点 404）。
 */

export type ProviderProtocol =
  | "openai-responses"
  | "openai-chat"
  | "anthropic-messages"
  | "gemini"
  | "chat";

export interface ProtocolInput {
  providerId: string;
  baseUrl?: string;
  modelId?: string;
}

function hostOf(baseUrl?: string): string {
  if (!baseUrl) return "";
  try {
    return new URL(baseUrl).host.toLowerCase();
  } catch {
    return baseUrl.toLowerCase();
  }
}

/** DeepSeek 官方 Anthropic 兼容入口（2026-10-22 官方文档 + 实网图片工具结果验证） */
function isOfficialDeepSeekHost(baseUrl?: string): boolean {
  if (!baseUrl) return true; // 未自定义 baseURL = 官方默认端点
  const host = hostOf(baseUrl);
  return host === "api.deepseek.com" || host.endsWith(".deepseek.com");
}

export function normalizeDeepSeekAnthropicBaseUrl(baseUrl?: string): string {
  if (!baseUrl) return "https://api.deepseek.com/anthropic";
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (/\/anthropic$/.test(trimmed)) return trimmed;
  if (/\/v\d+$/.test(trimmed)) return trimmed.replace(/\/v\d+$/, "/anthropic");
  return trimmed + "/anthropic";
}

/** 已知网关（按域名 + 模型前缀）的协议映射；未知端点不猜，走 chat。 */
function gatewayProtocol(host: string, modelId: string): ProviderProtocol | null {
  // CherryIN：官方文档支持 /v1/chat/completions、/v1/responses，以及 Anthropic Messages（Claude Code 配置）
  if (host.endsWith("cherryin.net") || host.endsWith("cherryin.ai")) {
    if (modelId.startsWith("openai/")) return "openai-responses";
    if (modelId.startsWith("anthropic/")) return "anthropic-messages";
    // 2026-10-22 实测：CherryIN 的 google/* 模型对外暴露 gemini 端点（/v1beta），可走原生 Gemini 协议
    if (modelId.startsWith("google/") || modelId.startsWith("gemini/")) return "gemini";
    return "chat";
  }
  return null;
}

export function resolveProviderProtocol(input: ProtocolInput): ProviderProtocol {
  const { providerId, baseUrl, modelId = "" } = input;
  const id = providerId.toLowerCase();
  const model = modelId.toLowerCase();
  const host = hostOf(baseUrl);

  if (id === "openai") return "openai-responses";
  if (id === "anthropic") return "anthropic-messages";
  if (id === "gemini" || id === "google") return "gemini";
  if (id === "grok") return "openai-chat";
  if (id === "deepseek") {
    // 官方 DeepSeek 同时提供 Anthropic Messages 兼容端点（支持 tool_result 图片），官方 baseURL 优先走原生；
    // 自定义 DeepSeek-compatible 代理仍走 chat + 图片桥（避免把只实现 chat 的代理打挂）。
    return isOfficialDeepSeekHost(baseUrl) ? "anthropic-messages" : "chat";
  }
  if (id === "openrouter") return "chat";

  if (id.startsWith("custom-") || id === "custom" || !["zhipu", "kimi", "qwen", "doubao", "xiaomi", "ollama", "lmstudio"].includes(id)) {
    const gateway = gatewayProtocol(host, model);
    if (gateway) return gateway;
  }
  return "chat";
}

/** 原生通道：工具结果可以按 AI SDK 的 toModelOutput 直接回传图片/文件。 */
export function supportsNativeToolImages(protocol: ProviderProtocol): boolean {
  return protocol === "openai-responses" || protocol === "anthropic-messages" || protocol === "gemini";
}

/** 把用户填的 OpenAI 兼容 baseURL 规范成 SDK 需要的 .../v1（已有 /v1 则不动）。 */
export function normalizeOpenAIBaseUrl(baseUrl?: string): string | undefined {
  if (!baseUrl) return undefined;
  const trimmed = baseUrl.replace(/\/+$/, "");
  return /\/v\d+$/.test(trimmed) ? trimmed : trimmed + "/v1";
}

/** Gemini 原生 baseURL：Gemini API 用 /v1beta；用户填 /v1 或根地址时规范化。 */
export function normalizeGeminiBaseUrl(baseUrl?: string): string | undefined {
  if (!baseUrl) return undefined;
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (/\/v1beta$/.test(trimmed)) return trimmed;
  if (/\/v1$/.test(trimmed)) return trimmed.replace(/\/v1$/, "/v1beta");
  return trimmed + "/v1beta";
}

/** Anthropic Messages baseURL：保留 .../v1；用户若只填根地址则补 /v1。 */
export function normalizeAnthropicBaseUrl(baseUrl?: string): string | undefined {
  if (!baseUrl) return undefined;
  const trimmed = baseUrl.replace(/\/+$/, "");
  return /\/v\d+$/.test(trimmed) ? trimmed : trimmed + "/v1";
}
