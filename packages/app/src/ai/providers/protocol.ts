/**
 * Provider 协议路由（2026-10-22 现代化）：
 * 决定模型走哪一代 API，以及工具结果里的图片能否原生回传。
 *
 * - openai-responses：OpenAI Responses API（官方 OpenAI、以及已知网关的 openai/* 模型）
 * - openai-chat：OpenAI Chat Completions（grok、以及只支持 chat 的自定义代理）
 * - anthropic-messages：Anthropic Messages（官方 Anthropic、以及已知网关的 anthropic/* 模型）
 * - gemini：Google Gemini 原生（Gemini 3 支持多模态工具结果）
 * - chat：OpenAI-compatible chat（OpenRouter、自定义代理、未知端点；工具图片走 fetch 层图片桥）
 *   注：官方 DeepSeek 已走 anthropic-messages（2026-10-22），自定义 DeepSeek 代理仍走 chat。
 *
 * 注意：这是“传输协议”路由，不是“模型能力”判断；未知自定义端点默认 chat（最保守，不会误发新端点 404）。
 */

export type ProviderProtocol = "openai-responses" | "openai-chat" | "anthropic-messages" | "gemini" | "chat";

export type ProviderApiStyle = "auto" | "openai-chat" | "openai-responses" | "anthropic-messages" | "gemini";

export interface ProtocolInput {
  providerId: string;
  baseUrl?: string;
  modelId?: string;
  /** 用户/预置 provider 显式声明的 API 协议；auto/缺省时按 provider 与已知网关推断 */
  apiStyle?: ProviderApiStyle;
}

function hostOf(baseUrl?: string): string {
  if (!baseUrl) return "";
  try {
    return new URL(baseUrl).host.toLowerCase();
  } catch {
    return baseUrl.toLowerCase();
  }
}

/** 是否官方 host（Base URL 未填视为官方默认端点） */
function hostMatches(baseUrl: string | undefined, domain: string): boolean {
  if (!baseUrl) return true;
  const host = hostOf(baseUrl);
  return host === domain || host.endsWith("." + domain);
}

/** 显式协议优先；auto/未填返回 null，继续走推断 */
function explicitProtocol(style?: ProviderApiStyle): ProviderProtocol | null {
  switch (style) {
    case "openai-chat":
      return "openai-chat";
    case "openai-responses":
      return "openai-responses";
    case "anthropic-messages":
      return "anthropic-messages";
    case "gemini":
      return "gemini";
    default:
      return null;
  }
}

/** DeepSeek 官方 Anthropic 兼容入口（2026-10-22 官方文档 + 实网图片工具结果验证） */
function isOfficialDeepSeekHost(baseUrl?: string): boolean {
  if (!baseUrl) return true; // 未自定义 baseURL = 官方默认端点
  const host = hostOf(baseUrl);
  return host === "api.deepseek.com" || host.endsWith(".deepseek.com");
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
  const { providerId, baseUrl, modelId = "", apiStyle } = input;
  const explicit = explicitProtocol(apiStyle);
  if (explicit) return explicit;
  const id = providerId.toLowerCase();
  const model = modelId.toLowerCase();
  const host = hostOf(baseUrl);

  // 预置 provider：只有官方 baseURL 才自动走原生；用户改成代理时保守回落 chat，
  // 除非用户在设置里显式选择 API 格式（由上面的 apiStyle 覆盖）。
  if (id === "openai") return hostMatches(baseUrl, "api.openai.com") ? "openai-responses" : "chat";
  if (id === "anthropic") return hostMatches(baseUrl, "api.anthropic.com") ? "anthropic-messages" : "chat";
  if (id === "gemini" || id === "google") {
    return hostMatches(baseUrl, "generativelanguage.googleapis.com") ? "gemini" : "chat";
  }
  if (id === "grok") return "openai-chat";
  if (id === "deepseek") {
    // 官方 DeepSeek 同时提供 Anthropic Messages 兼容端点（支持 tool_result 图片），官方 baseURL 优先走原生；
    // 自定义 DeepSeek-compatible 代理仍走 chat + 图片桥（避免把只实现 chat 的代理打挂）。
    return isOfficialDeepSeekHost(baseUrl) ? "anthropic-messages" : "chat";
  }
  if (id === "kimi") return hostMatches(baseUrl, "api.moonshot.cn") ? "anthropic-messages" : "chat";
  if (id === "zhipu") return hostMatches(baseUrl, "open.bigmodel.cn") ? "anthropic-messages" : "chat";
  if (id === "minimax")
    return hostMatches(baseUrl, "api.minimaxi.com") || hostMatches(baseUrl, "api.minimax.io")
      ? "anthropic-messages"
      : "chat";
  if (id === "openrouter") return "chat";

  if (
    id.startsWith("custom-") ||
    id === "custom" ||
    !["zhipu", "kimi", "qwen", "doubao", "xiaomi", "ollama", "lmstudio"].includes(id)
  ) {
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
  // 已带版本段（/v1、/v4、/v3、/v1beta、/v1beta/openai 等）不重复追加 /v1；
  // 2026-10-22 修：Gemini 的 /v1beta/openai 之前会被拼成 /v1beta/openai/v1 → 404。
  return /\/v\d+[a-z]*(?:\/|$)/i.test(trimmed) ? trimmed : trimmed + "/v1";
}

/** Gemini 原生 baseURL：Gemini API 用 /v1beta；用户填 /v1 或根地址时规范化。 */
export function normalizeGeminiBaseUrl(baseUrl?: string): string | undefined {
  if (!baseUrl) return undefined;
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (/\/v1beta$/.test(trimmed)) return trimmed;
  if (/\/v1$/.test(trimmed)) return trimmed.replace(/\/v1$/, "/v1beta");
  return trimmed + "/v1beta";
}

/**
 * 已知 Anthropic 兼容 provider 的规范 baseURL。
 *
 * 关键语义（2026-10-22 实网纠偏）：@ai-sdk/anthropic 会在 baseURL 后**追加 /messages**，
 * 而厂商文档写的 base_url 是 Anthropic 官方 SDK 语义（SDK 自己再追加 /v1/messages）。
 * 因此预填给 AI SDK 的地址必须带厂商文档里的 .../v1：
 *   DeepSeek: https://api.deepseek.com/anthropic/v1
 *   Kimi:     https://api.moonshot.cn/anthropic/v1
 *   智谱:     https://open.bigmodel.cn/api/anthropic/v1
 *   MiniMax:  https://api.minimaxi.com/anthropic/v1
 * 实测短路径（无 /v1）：Kimi 404、智谱 HTTP 200 包 404、MiniMax 404；带 /v1 均可达。
 * 用户自定义代理时尊重其 Base URL（normalizeAnthropicBaseUrl 补 /v1，不硬打官方）。
 */
export function resolveAnthropicCompatibleBaseUrl(providerId: string, baseUrl?: string): string | undefined {
  const id = providerId.toLowerCase();
  if (id === "anthropic") {
    return hostMatches(baseUrl, "api.anthropic.com")
      ? "https://api.anthropic.com/v1"
      : normalizeAnthropicBaseUrl(baseUrl);
  }
  if (id === "deepseek") {
    return hostMatches(baseUrl, "api.deepseek.com")
      ? "https://api.deepseek.com/anthropic/v1"
      : normalizeAnthropicBaseUrl(baseUrl);
  }
  if (id === "kimi") {
    return hostMatches(baseUrl, "api.moonshot.cn")
      ? "https://api.moonshot.cn/anthropic/v1"
      : normalizeAnthropicBaseUrl(baseUrl);
  }
  if (id === "zhipu") {
    return hostMatches(baseUrl, "open.bigmodel.cn")
      ? "https://open.bigmodel.cn/api/anthropic/v1"
      : normalizeAnthropicBaseUrl(baseUrl);
  }
  if (id === "minimax") {
    if (hostMatches(baseUrl, "api.minimax.io")) return "https://api.minimax.io/anthropic/v1";
    if (hostMatches(baseUrl, "api.minimaxi.com")) return "https://api.minimaxi.com/anthropic/v1";
    return normalizeAnthropicBaseUrl(baseUrl);
  }
  return normalizeAnthropicBaseUrl(baseUrl);
}

/** Anthropic Messages baseURL：保留 .../v1；用户若只填根地址则补 /v1。 */
export function normalizeAnthropicBaseUrl(baseUrl?: string): string | undefined {
  if (!baseUrl) return undefined;
  const trimmed = baseUrl.replace(/\/+$/, "");
  return /\/v\d+$/.test(trimmed) ? trimmed : trimmed + "/v1";
}
