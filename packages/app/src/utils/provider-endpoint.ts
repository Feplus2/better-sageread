/**
 * 预置端点辅助（CherryStudio 式多端点 UX）。
 *
 * 设计：预置提供商在 predefined-providers.ts 里为每个支持的协议预填 baseURL；
 * 用户实际选中的协议/地址仍存在 provider.apiStyle / provider.baseUrl（向后兼容，factory 不用改）。
 * UI 只需要把预填项列出来，用户通常只填 Key；改地址/协议走"自定义"。
 */
import { predefinedProviders } from "@/constants/predefined-providers";

export const CHAT_PROTOCOL_LABELS: Record<ChatProtocol, string> = {
  "openai-responses": "OpenAI Responses",
  "openai-chat": "OpenAI Chat Completions",
  "anthropic-messages": "Anthropic Messages",
  gemini: "Gemini 原生",
};

/** 展示顺序：与协议现代化文档一致，Responses/Anthropic/Gemini 优先（原生工具图片） */
const PROTOCOL_ORDER: ChatProtocol[] = ["openai-responses", "anthropic-messages", "gemini", "openai-chat"];

export interface ProviderEndpointOption {
  protocol: ChatProtocol;
  label: string;
  baseUrl: string;
  /** 是否为该预置提供商的默认端点（apiStyle 匹配） */
  isDefault: boolean;
}

export function getPresetProvider(providerId: string): ModelProvider | undefined {
  return predefinedProviders.find((preset) => preset.provider === providerId);
}

/** 生效端点表：用户覆盖优先，其次预置（与 CherryStudio "registry resolves at read time" 同思路） */
export function resolveProviderEndpoints(provider: ModelProvider): ModelProviderEndpoints {
  return provider.endpoints ?? getPresetProvider(provider.provider)?.endpoints ?? {};
}

function normalizeUrl(url?: string): string {
  return (url ?? "").trim().replace(/\/+$/, "").toLowerCase();
}

/** 当前选中值是否正好命中某个预置端点 */
export function findCurrentEndpoint(provider: ModelProvider): ProviderEndpointOption | null {
  const options = getEndpointOptions(provider);
  const style = provider.apiStyle ?? "auto";
  if (style !== "auto") {
    const matched = options.find(
      (o) => o.protocol === style && normalizeUrl(o.baseUrl) === normalizeUrl(provider.baseUrl),
    );
    if (matched) return matched;
  }
  // apiStyle 是 auto 或缺省时，按地址唯一命中
  const byUrl = options.filter((o) => normalizeUrl(o.baseUrl) === normalizeUrl(provider.baseUrl));
  return byUrl.length === 1 ? byUrl[0] : null;
}

export function getEndpointOptions(provider: ModelProvider): ProviderEndpointOption[] {
  const endpoints = resolveProviderEndpoints(provider);
  const preset = getPresetProvider(provider.provider);
  const defaultStyle = preset?.apiStyle;
  return PROTOCOL_ORDER.filter((protocol) => typeof endpoints[protocol] === "string").map((protocol) => ({
    protocol,
    label: CHAT_PROTOCOL_LABELS[protocol],
    baseUrl: endpoints[protocol] as string,
    isDefault: protocol === defaultStyle,
  }));
}

/** 预置默认端点（"恢复默认"用） */
export function getPresetDefaultEndpoint(provider: ModelProvider): ProviderEndpointOption | null {
  const options = getEndpointOptions(provider);
  return options.find((option) => option.isDefault) ?? options[0] ?? null;
}

/**
 * 请求路径预览（CherryStudio 同款）：把 baseURL 拼成最终会请求的地址，帮用户确认没填错。
 * 只做展示，不参与请求构造。
 */
export function buildRequestPathPreview(
  baseUrl: string | undefined,
  protocol: ModelApiStyle,
  modelId?: string,
): string | null {
  const base = normalizeUrl(baseUrl);
  if (!base) return null;
  switch (protocol) {
    case "openai-chat":
      return `${base}/chat/completions`;
    case "openai-responses":
      return `${base}/responses`;
    case "anthropic-messages":
      return `${base}/messages`;
    case "gemini":
      return `${base}/models/${modelId || "模型ID"}:generateContent`;
    default:
      return null;
  }
}

/** 协议大致按"是否支持原生工具图片"排序的说明（UI 帮助文案） */
export function nativeImageHint(protocol: ModelApiStyle): string | null {
  switch (protocol) {
    case "openai-responses":
      return "支持工具结果图片原生回传";
    case "anthropic-messages":
      return "支持工具结果图片原生回传";
    case "gemini":
      return "Gemini 3 起支持工具结果图片原生回传";
    case "openai-chat":
      return "工具结果图片走兼容桥（较旧的通道）";
    default:
      return null;
  }
}
