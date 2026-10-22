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
type ModelApiStyle =
  | "auto"
  | "openai-chat"
  | "openai-responses"
  | "anthropic-messages"
  | "gemini";

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
  exploreModelsUrl?: string;
  apiKey?: string;
  apiKeyHelpUrl?: string;
  baseUrl?: string;
  baseUrlHelpUrl?: string;
  models: Model[];
};
