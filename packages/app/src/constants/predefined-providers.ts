/**
 * 预置提供商（CherryStudio 式多端点预置）。
 *
 * 2026-10-22 改版：每个预置提供商同时预填多个协议的 Base URL（endpoints），
 * 默认协议由 apiStyle 决定——用户通常只填 API Key 即可，不需要手动选协议。
 * endpoints 里的地址是**给 AI SDK 的 baseURL 语义**（含 /v1 等版本段，SDK 会再追加
 * /chat/completions、/responses、/messages、/models/{id}:generateContent）。
 *
 * 2026-10-27 更新：MiniMax 默认国内 api.minimax.cn 的 Anthropic Messages，另备 OpenAI Chat/Responses；
 * Step、百炼和豆包默认普通开放平台的 OpenAI Responses，另备 Chat 等已核实的协议，不预置订阅专用路径。
 * Kimi/智谱/MiniMax 的 Anthropic 短路径兼容问题已有迁移处理；DeepSeek 统一用 /v1。
 */
export const predefinedProviders: ModelProvider[] = [
  {
    active: true,
    apiKey: "",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiKeyHelpUrl: "https://platform.openai.com/account/api-keys",
    baseUrlHelpUrl: "https://platform.openai.com/docs/api-reference/chat/create",
    provider: "openai",
    apiStyle: "openai-responses",
    endpoints: {
      "openai-responses": "https://api.openai.com/v1",
      "openai-chat": "https://api.openai.com/v1",
    },
    models: [],
  },
  {
    active: true,
    apiKey: "",
    name: "Anthropic",
    apiKeyHelpUrl: "https://console.anthropic.com/settings/keys",
    baseUrl: "https://api.anthropic.com/v1",
    provider: "anthropic",
    apiStyle: "anthropic-messages",
    endpoints: {
      "anthropic-messages": "https://api.anthropic.com/v1",
    },
    baseUrlHelpUrl: "https://docs.anthropic.com/en/api/messages",
    models: [],
  },
  {
    active: true,
    apiKey: "",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyHelpUrl: "https://openrouter.ai/settings/keys",
    baseUrlHelpUrl: "https://openrouter.ai/docs/api-reference/overview",
    provider: "openrouter",
    apiStyle: "openai-chat",
    endpoints: {
      "openai-chat": "https://openrouter.ai/api/v1",
    },
    models: [],
  },
  {
    active: true,
    apiKey: "",
    name: "Grok",
    baseUrl: "https://api.x.ai/v1",
    apiKeyHelpUrl: "https://console.x.ai/team/default/api-keys",
    baseUrlHelpUrl: "https://docs.x.ai/docs/models",
    provider: "grok",
    apiStyle: "openai-chat",
    endpoints: {
      "openai-chat": "https://api.x.ai/v1",
    },
    models: [],
  },
  {
    active: true,
    apiKey: "",
    name: "Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKeyHelpUrl: "https://aistudio.google.com/apikey",
    baseUrlHelpUrl: "https://ai.google.dev/gemini-api/docs/openai",
    provider: "gemini",
    apiStyle: "gemini",
    endpoints: {
      gemini: "https://generativelanguage.googleapis.com/v1beta",
      "openai-chat": "https://generativelanguage.googleapis.com/v1beta/openai",
    },
    models: [],
  },
  {
    active: true,
    apiKey: "",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/anthropic/v1",
    apiKeyHelpUrl: "https://platform.deepseek.com/api_keys",
    baseUrlHelpUrl: "https://api-docs.deepseek.com",
    provider: "deepseek",
    apiStyle: "anthropic-messages",
    endpoints: {
      "anthropic-messages": "https://api.deepseek.com/anthropic/v1",
      "openai-chat": "https://api.deepseek.com/v1",
    },
    models: [],
  },
  // ==================== 国内提供商 ====================
  {
    active: false,
    apiKey: "",
    name: "智谱 GLM",
    // 2026-10-22 实网：普通 API key 的 OpenAI 兼容端点可用；Anthropic 兼容端点绑定 GLM Coding Plan
    // （未订阅时报 429 "套餐已到期"）。故默认改走 OpenAI 兼容，Anthropic 端点仅作 Coding Plan 用户的备选。
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    apiKeyHelpUrl: "https://open.bigmodel.cn/usercenter/apikeys",
    baseUrlHelpUrl: "https://open.bigmodel.cn/dev/api/normal-model/glm-4",
    provider: "zhipu",
    apiStyle: "openai-chat",
    endpoints: {
      "openai-chat": "https://open.bigmodel.cn/api/paas/v4",
      "anthropic-messages": "https://open.bigmodel.cn/api/anthropic/v1",
    },
    models: [],
  },
  {
    active: false,
    apiKey: "",
    name: "KIMI (Moonshot)",
    baseUrl: "https://api.moonshot.cn/anthropic/v1",
    apiKeyHelpUrl: "https://platform.moonshot.cn/console/api-keys",
    baseUrlHelpUrl: "https://platform.moonshot.cn/docs/api/chat",
    provider: "kimi",
    apiStyle: "anthropic-messages",
    endpoints: {
      "anthropic-messages": "https://api.moonshot.cn/anthropic/v1",
      "openai-chat": "https://api.moonshot.cn/v1",
      "openai-responses": "https://api.moonshot.cn/v1",
    },
    models: [],
  },
  {
    active: false,
    apiKey: "",
    name: "小米 MiMo",
    baseUrl: "https://api.xiaomimimo.com/v1",
    apiKeyHelpUrl: "https://platform.xiaomimimo.com",
    baseUrlHelpUrl: "https://platform.xiaomimimo.com",
    provider: "xiaomi",
    apiStyle: "openai-chat",
    endpoints: {
      "openai-chat": "https://api.xiaomimimo.com/v1",
      "anthropic-messages": "https://api.xiaomimimo.com/anthropic/v1",
    },
    models: [],
  },
  {
    active: false,
    apiKey: "",
    name: "阿里云百炼",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKeyHelpUrl: "https://bailian.console.aliyun.com/#/api-key",
    baseUrlHelpUrl: "https://help.aliyun.com/zh/model-studio/compatibility-with-openai",
    provider: "qwen",
    apiStyle: "openai-responses",
    endpoints: {
      "openai-chat": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "openai-responses": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "anthropic-messages": "https://dashscope.aliyuncs.com/api/v2/apps/claude-code-proxy/v1",
    },
    models: [],
  },
  {
    active: false,
    apiKey: "",
    name: "豆包 (火山方舟)",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    apiKeyHelpUrl: "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey",
    baseUrlHelpUrl: "https://www.volcengine.com/docs/82379/1263512",
    provider: "doubao",
    apiStyle: "openai-responses",
    endpoints: {
      "openai-chat": "https://ark.cn-beijing.volces.com/api/v3",
      "openai-responses": "https://ark.cn-beijing.volces.com/api/v3",
    },
    models: [],
  },
  {
    active: false,
    apiKey: "",
    name: "MiniMax",
    baseUrl: "https://api.minimax.cn/anthropic/v1",
    apiKeyHelpUrl: "https://platform.minimaxi.com/user-center/basic-information/interface-key",
    baseUrlHelpUrl: "https://platform.minimaxi.com/docs/guides/text-generation",
    provider: "minimax",
    apiStyle: "anthropic-messages",
    endpoints: {
      "anthropic-messages": "https://api.minimax.cn/anthropic/v1",
      "openai-chat": "https://api.minimax.cn/v1",
      "openai-responses": "https://api.minimax.cn/v1",
    },
    models: [],
  },
  {
    active: false,
    apiKey: "",
    name: "阶跃星辰 StepFun",
    baseUrl: "https://api.stepfun.com/v1",
    apiKeyHelpUrl: "https://platform.stepfun.com/interface-key",
    baseUrlHelpUrl: "https://platform.stepfun.com/docs/zh/api-reference/responses/responses-create",
    provider: "stepfun",
    apiStyle: "openai-responses",
    endpoints: {
      "openai-responses": "https://api.stepfun.com/v1",
      "openai-chat": "https://api.stepfun.com/v1",
      "anthropic-messages": "https://api.stepfun.com/v1",
    },
    models: [],
  },
  {
    active: false,
    apiKey: "",
    name: "腾讯混元",
    baseUrl: "https://tokenhub.tencentmaas.com/v1",
    baseUrlHelpUrl: "https://cloud.tencent.com/document/product/1823/132252",
    provider: "tencent",
    apiStyle: "openai-chat",
    endpoints: {
      "openai-chat": "https://tokenhub.tencentmaas.com/v1",
    },
    models: [
      {
        id: "hy4",
        name: "Hy4",
        active: true,
        contextWindow: 1_024_000,
        maxOutputTokens: 64_000,
      },
    ],
  },
  // ==================== 本地服务（OpenAI 兼容，免 Key） ====================
  {
    // 本地 Ollama：装好并保持服务运行（默认 11434），OpenAI 兼容端点
    active: false,
    apiKey: "",
    name: "Ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    baseUrlHelpUrl: "https://github.com/ollama/ollama/blob/main/docs/openai.md",
    provider: "ollama",
    apiStyle: "openai-chat",
    endpoints: {
      "openai-chat": "http://127.0.0.1:11434/v1",
    },
    models: [],
  },
  {
    // 本地 LM Studio：需在 LM Studio → Developer → Local Server 启动服务（默认 1234）
    active: false,
    apiKey: "",
    name: "LM Studio",
    baseUrl: "http://127.0.0.1:1234/v1",
    baseUrlHelpUrl: "https://lmstudio.ai/docs/developer/openai-compat",
    provider: "lmstudio",
    apiStyle: "openai-chat",
    endpoints: {
      "openai-chat": "http://127.0.0.1:1234/v1",
    },
    models: [],
  },
];
