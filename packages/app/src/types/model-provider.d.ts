/**
 * The model object structure
 */
type Model = {
  id: string;
  name?: string;
  active?: boolean;
  description?: string;
  capabilities?: string[];
  manual?: boolean;
};

/** 模型 API 协议（Base URL 只决定端点，协议必须显式声明或按 provider 推断） */
type ModelApiStyle = "auto" | "openai-chat" | "openai-responses" | "anthropic-messages" | "gemini";

/** 可路由的聊天协议（去掉 auto） */
type ChatProtocol = Exclude<ModelApiStyle, "auto">;

/**
 * 预置端点表：协议 → 传给 AI SDK 的 baseURL（必须含 /v1、/v1beta 等版本段）。
 * 一个提供商可同时预填多个协议的地址（CherryStudio 式），当前选中值仍存于 apiStyle/baseUrl。
 */
type ModelProviderEndpoints = Partial<Record<ChatProtocol, string>>;

/**
 * The provider object structure
 */
type ModelProvider = {
  name: string;
  active: boolean;
  provider: string;
  /** 图标标识（lucide 名等，展示用；预置提供商配置） */
  icon?: string;
  /** API 协议；未填/auto 时按 provider/网关推断（预置 provider 应填默认值） */
  apiStyle?: ModelApiStyle;
  /** 预置端点表（多协议地址一次性预填；用户通常只需填 Key，不用手动选协议） */
  endpoints?: ModelProviderEndpoints;
  exploreModelsUrl?: string;
  apiKey?: string;
  apiKeyHelpUrl?: string;
  baseUrl?: string;
  baseUrlHelpUrl?: string;
  models: Model[];
};
