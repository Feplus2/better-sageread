/**
 * 聊天思考强度映射表 —— 枚举制（2026-08-28 定稿）。
 *
 * 用户可见档位 = 模型原生档位（不再经过 off/low/medium/high 四档映射）：
 * grok-4.6 支持 none/low/medium/high/xhigh → UI 直接呈现这五项；
 * GLM-5.3 思考不可关 → UI 只有 low/high/max 三项，没有 off。
 *
 * 两个下发通道按 provider 分派（与型号能力表正交）：
 * A. providerOptions（AI SDK 原生）：openai / google / openrouter / grok
 * B. 请求体补丁（自定义端点）：deepseek / GLM(bigmodel) / Qwen(dashscope) / Kimi(moonshot)
 *    / 混元(tencentmaas) / 豆包(volces) / MiMo
 *
 * 维护：新型号上线 → 查官方文档 → MODEL_REASONING 加一行 → UI 自动适配。
 */

export type ReasoningLevel = string;

/** 档位显示名（UI 渲染用；未收录的值原样显示） */
export const REASONING_LEVEL_DISPLAY: Record<string, string> = {
  off: "关闭",
  none: "关闭",
  on: "开启",
  auto: "自动",
  minimal: "极低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "超高",
  max: "最大",
};

/** 型号思考能力行 */
interface ReasoningCapability {
  /** 思考始终开启，不可关闭（GLM-5.3 传 disabled 直接 400、Kimi-K3 无 thinking 参数） */
  alwaysOn: boolean;
  /** off 档的 provider 参数值（alwaysOn=true 时无意义）；null = 不下发任何参数 */
  offParam: string | null;
  /** 该型号支持的 effort 值（provider 原生，从低到高 = UI 渲染顺序） */
  levels: string[];
  /** 传输格式：effort（reasoning_effort/thinkingLevel 直传）| budget（Qwen thinking_budget 滑块）| switch（仅开关） */
  transport: "effort" | "budget" | "switch";
  /** budget 型的滑块上限（Qwen 默认 32768）；budget 型必填 */
  maxBudget?: number;
}

// ---------------------------------------------------------------------------
// 精确型号枚举表（每行独立对照官方文档核实，2026-08-28 搜索调研）
// ---------------------------------------------------------------------------
const MODEL_REASONING: Readonly<Record<string, ReasoningCapability>> = {
  // ---- OpenAI（developers.openai.com/api/docs/guides/reasoning）----
  o1: { alwaysOn: false, offParam: "low", levels: ["low", "medium", "high"], transport: "effort" },
  "o1-pro": { alwaysOn: false, offParam: "low", levels: ["low", "medium", "high"], transport: "effort" },
  "o1-mini": { alwaysOn: false, offParam: "low", levels: ["low", "medium", "high"], transport: "effort" },
  o3: { alwaysOn: false, offParam: "low", levels: ["low", "medium", "high"], transport: "effort" },
  "o3-pro": { alwaysOn: false, offParam: "low", levels: ["low", "medium", "high"], transport: "effort" },
  "o4-mini": { alwaysOn: false, offParam: "low", levels: ["low", "medium", "high"], transport: "effort" },
  "gpt-5": { alwaysOn: false, offParam: "minimal", levels: ["minimal", "low", "medium", "high"], transport: "effort" },
  "gpt-5-pro": {
    alwaysOn: false,
    offParam: "minimal",
    levels: ["minimal", "low", "medium", "high"],
    transport: "effort",
  },
  "gpt-5-mini": {
    alwaysOn: false,
    offParam: "minimal",
    levels: ["minimal", "low", "medium", "high"],
    transport: "effort",
  },
  "gpt-5-nano": {
    alwaysOn: false,
    offParam: "minimal",
    levels: ["minimal", "low", "medium", "high"],
    transport: "effort",
  },
  "gpt-5.1": {
    alwaysOn: false,
    offParam: "none",
    levels: ["none", "minimal", "low", "medium", "high"],
    transport: "effort",
  },
  "gpt-5.1-mini": {
    alwaysOn: false,
    offParam: "none",
    levels: ["none", "minimal", "low", "medium", "high"],
    transport: "effort",
  },
  "gpt-5.2": {
    alwaysOn: false,
    offParam: "none",
    levels: ["none", "low", "medium", "high", "xhigh"],
    transport: "effort",
  },
  "gpt-5.3-codex": {
    alwaysOn: false,
    offParam: "none",
    levels: ["none", "low", "medium", "high", "xhigh"],
    transport: "effort",
  },
  "gpt-5.4": { alwaysOn: false, offParam: "none", levels: ["none", "low", "medium", "high"], transport: "effort" },
  "gpt-5.5": { alwaysOn: false, offParam: "none", levels: ["none", "low", "medium", "high"], transport: "effort" },
  "gpt-5.6-sol": {
    alwaysOn: false,
    offParam: "none",
    levels: ["none", "low", "medium", "high", "max"],
    transport: "effort",
  },
  "gpt-5.6-terra": {
    alwaysOn: false,
    offParam: "none",
    levels: ["none", "low", "medium", "high"],
    transport: "effort",
  },
  "gpt-5.6-luna": { alwaysOn: false, offParam: "none", levels: ["none", "low", "medium", "high"], transport: "effort" },

  // ---- Google Gemini（ai.google.dev/gemini-api/docs/thinking + /gemini-3）----
  "gemini-2.5-pro": { alwaysOn: false, offParam: "budget:0", levels: ["budget"], transport: "budget" },
  "gemini-2.5-flash": { alwaysOn: false, offParam: "budget:0", levels: ["budget"], transport: "budget" },
  "gemini-2.5-flash-lite": { alwaysOn: false, offParam: "budget:0", levels: ["budget"], transport: "budget" },
  "gemini-3-pro": { alwaysOn: true, offParam: null, levels: ["low", "medium", "high"], transport: "effort" },
  "gemini-3-flash": {
    alwaysOn: false,
    offParam: "minimal",
    levels: ["minimal", "low", "medium", "high"],
    transport: "effort",
  },
  "gemini-3.1-pro": { alwaysOn: true, offParam: null, levels: ["low", "medium", "high"], transport: "effort" },
  "gemini-3.1-flash": {
    alwaysOn: false,
    offParam: "minimal",
    levels: ["minimal", "low", "medium", "high"],
    transport: "effort",
  },
  "gemini-3.5-flash": {
    alwaysOn: false,
    offParam: "minimal",
    levels: ["minimal", "low", "medium", "high"],
    transport: "effort",
  },
  "gemini-3.5-flash-lite": {
    alwaysOn: false,
    offParam: "minimal",
    levels: ["minimal", "low", "medium", "high"],
    transport: "effort",
  },
  "gemini-3.6-flash": {
    alwaysOn: false,
    offParam: "minimal",
    levels: ["minimal", "low", "medium", "high"],
    transport: "effort",
  },
  "gemini-3.7-flash": { alwaysOn: true, offParam: null, levels: ["low", "medium", "high"], transport: "effort" },

  // ---- xAI Grok（docs.x.ai/developers/model-capabilities/text/reasoning）----
  "grok-4": { alwaysOn: false, offParam: "none", levels: ["none", "low", "medium", "high"], transport: "effort" },
  "grok-4.3": { alwaysOn: false, offParam: "none", levels: ["none", "low", "medium", "high"], transport: "effort" },
  "grok-4.5": { alwaysOn: true, offParam: null, levels: ["low", "medium", "high"], transport: "effort" },
  "grok-4.6": {
    alwaysOn: false,
    offParam: "none",
    levels: ["none", "low", "medium", "high", "xhigh"],
    transport: "effort",
  },
  "grok-4.20": { alwaysOn: false, offParam: "none", levels: ["none", "low", "medium", "high"], transport: "effort" },

  // ---- DeepSeek（api-docs.deepseek.com/guides/thinking_mode + updates）----
  "deepseek-v4-flash": {
    alwaysOn: false,
    offParam: "thinking:disabled",
    levels: ["low", "high", "max"],
    transport: "effort",
  },
  "deepseek-v4-pro": {
    alwaysOn: false,
    offParam: "thinking:disabled",
    levels: ["low", "high", "max"],
    transport: "effort",
  },
  "deepseek-v4-flash-vision-exp": {
    alwaysOn: false,
    offParam: "thinking:disabled",
    levels: ["low", "high", "max"],
    transport: "effort",
  },

  // ---- 智谱 GLM（docs.bigmodel.cn/cn/guide/capabilities/thinking）----
  "glm-5.3": { alwaysOn: true, offParam: null, levels: ["low", "high", "max"], transport: "effort" },
  "glm-5.3-flash": { alwaysOn: true, offParam: null, levels: ["low", "high", "max"], transport: "effort" },
  "glm-5.2": { alwaysOn: false, offParam: "thinking:disabled", levels: ["low", "high", "max"], transport: "effort" },
  "glm-5.1": { alwaysOn: false, offParam: "thinking:disabled", levels: [], transport: "switch" },
  "glm-5": { alwaysOn: false, offParam: "thinking:disabled", levels: [], transport: "switch" },
  "glm-4.7": { alwaysOn: false, offParam: "thinking:disabled", levels: [], transport: "switch" },
  "glm-4.6": { alwaysOn: false, offParam: "thinking:disabled", levels: [], transport: "switch" },
  "glm-4.6-flash": { alwaysOn: false, offParam: "thinking:disabled", levels: [], transport: "switch" },
  "glm-5v-turbo": { alwaysOn: false, offParam: "thinking:disabled", levels: [], transport: "switch" },

  // ---- 阿里 Qwen/DashScope（help.aliyun.com/zh/model-studio/deep-thinking）----
  // enable_thinking 开关 + thinking_budget 整数（1-32768，默认 4000）
  // UI 呈现 off/low/medium/high 四档，内部映射 budget 数值
  "qwen3.5-plus": {
    alwaysOn: false,
    offParam: "enable_thinking:false",
    levels: ["off", "low", "medium", "high"],
    transport: "budget",
    maxBudget: 32768,
  },
  "qwen3.5-flash": {
    alwaysOn: false,
    offParam: "enable_thinking:false",
    levels: ["off", "low", "medium", "high"],
    transport: "budget",
    maxBudget: 32768,
  },
  "qwen3.6-plus": {
    alwaysOn: false,
    offParam: "enable_thinking:false",
    levels: ["off", "low", "medium", "high"],
    transport: "budget",
    maxBudget: 32768,
  },
  "qwen3.6-flash": {
    alwaysOn: false,
    offParam: "enable_thinking:false",
    levels: ["off", "low", "medium", "high"],
    transport: "budget",
    maxBudget: 32768,
  },
  "qwen3.7-plus": {
    alwaysOn: false,
    offParam: "enable_thinking:false",
    levels: ["off", "low", "medium", "high"],
    transport: "budget",
    maxBudget: 32768,
  },
  "qwen3.7-flash": {
    alwaysOn: false,
    offParam: "enable_thinking:false",
    levels: ["off", "low", "medium", "high"],
    transport: "budget",
    maxBudget: 32768,
  },
  "qwen3.7-max": {
    alwaysOn: false,
    offParam: "enable_thinking:false",
    levels: ["off", "low", "medium", "high"],
    transport: "budget",
    maxBudget: 32768,
  },
  "qwen3.7-max-2026-06-08": {
    alwaysOn: false,
    offParam: "enable_thinking:false",
    levels: ["off", "low", "medium", "high"],
    transport: "budget",
    maxBudget: 32768,
  },
  "qwen3.8-max": {
    alwaysOn: false,
    offParam: "enable_thinking:false",
    levels: ["off", "low", "medium", "high"],
    transport: "budget",
    maxBudget: 32768,
  },
  "qwen3.8-27b": {
    alwaysOn: false,
    offParam: "enable_thinking:false",
    levels: ["off", "low", "medium", "high"],
    transport: "budget",
    maxBudget: 32768,
  },
  "qwen3.8-flash-next": {
    alwaysOn: false,
    offParam: "enable_thinking:false",
    levels: ["off", "low", "medium", "high"],
    transport: "budget",
    maxBudget: 32768,
  },
  "qwen3.8-2.4t": {
    alwaysOn: true,
    offParam: null,
    levels: ["off", "low", "medium", "high"],
    transport: "budget",
    maxBudget: 32768,
  },
  "qwen3-max": {
    alwaysOn: false,
    offParam: "enable_thinking:false",
    levels: ["off", "low", "medium", "high"],
    transport: "budget",
    maxBudget: 32768,
  },
  "qvq-max": { alwaysOn: true, offParam: null, levels: [], transport: "switch" },

  // ---- 月之暗面 Kimi（platform.kimi.ai/docs/guide/use-thinking-models）----
  "kimi-k3": { alwaysOn: true, offParam: null, levels: ["low", "high", "max"], transport: "effort" },
  "kimi-k2.7-code": { alwaysOn: true, offParam: null, levels: [], transport: "switch" },
  "kimi-k2.7-code-highspeed": { alwaysOn: true, offParam: null, levels: [], transport: "switch" },
  "kimi-k2.6": { alwaysOn: false, offParam: "thinking:disabled", levels: [], transport: "switch" },
  "kimi-k2.5": { alwaysOn: false, offParam: "thinking:disabled", levels: [], transport: "switch" },
  "kimi-k2-thinking": { alwaysOn: true, offParam: null, levels: [], transport: "switch" },
  "kimi-k2-turbo": { alwaysOn: false, offParam: "thinking:disabled", levels: [], transport: "switch" },
  "kimi-k2": { alwaysOn: false, offParam: "thinking:disabled", levels: [], transport: "switch" },

  // ---- Cohere（docs.cohere.com/docs/models）----
  "command-a-reasoning": { alwaysOn: true, offParam: null, levels: [], transport: "switch" },
  "command-a-plus": { alwaysOn: true, offParam: null, levels: [], transport: "switch" },
  "command-a": { alwaysOn: false, offParam: null, levels: [], transport: "switch" },
  "command-a-vision": { alwaysOn: false, offParam: null, levels: [], transport: "switch" },
  "command-r-plus": { alwaysOn: false, offParam: null, levels: [], transport: "switch" },
  "command-r": { alwaysOn: false, offParam: null, levels: [], transport: "switch" },

  // ---- 小米 MiMo（mimo.mi.com/docs）----
  "mimo-v2.5": {
    alwaysOn: false,
    offParam: "enable_thinking:false",
    levels: ["off", "low", "medium", "high"],
    transport: "budget",
    maxBudget: 32768,
  },
  "mimo-v2.5-pro": {
    alwaysOn: false,
    offParam: "enable_thinking:false",
    levels: ["off", "low", "medium", "high"],
    transport: "budget",
    maxBudget: 32768,
  },
  "mimo-v2-omni": {
    alwaysOn: false,
    offParam: "enable_thinking:false",
    levels: ["off", "low", "medium", "high"],
    transport: "budget",
    maxBudget: 32768,
  },

  // ---- OpenAI 旧系（仍在售，官方 Models 页全系 same-modality）----
  "gpt-4o": { alwaysOn: false, offParam: "low", levels: ["low", "medium", "high"], transport: "effort" },
  "gpt-4o-mini": { alwaysOn: false, offParam: "low", levels: ["low", "medium", "high"], transport: "effort" },
  "gpt-4.1": { alwaysOn: false, offParam: "low", levels: ["low", "medium", "high"], transport: "effort" },
  "gpt-4.1-mini": { alwaysOn: false, offParam: "low", levels: ["low", "medium", "high"], transport: "effort" },
  "gpt-4.1-nano": { alwaysOn: false, offParam: "low", levels: ["low", "medium", "high"], transport: "effort" },
  "o3-mini": { alwaysOn: false, offParam: "low", levels: ["low", "medium", "high"], transport: "effort" },

  // ---- Qwen 3.5+ 变体（DashScope 官方文档确认全系支持 enable_thinking + thinking_budget）----
  "qwen3.5-32b": {
    alwaysOn: false,
    offParam: "enable_thinking:false",
    levels: ["off", "low", "medium", "high"],
    transport: "budget",
    maxBudget: 32768,
  },
  "qwen3.5-72b": {
    alwaysOn: false,
    offParam: "enable_thinking:false",
    levels: ["off", "low", "medium", "high"],
    transport: "budget",
    maxBudget: 32768,
  },
  "qwen3.5-omni": {
    alwaysOn: false,
    offParam: "enable_thinking:false",
    levels: ["off", "low", "medium", "high"],
    transport: "budget",
    maxBudget: 32768,
  },
  "qwen3.5-ocr": {
    alwaysOn: false,
    offParam: "enable_thinking:false",
    levels: ["off", "low", "medium", "high"],
    transport: "budget",
    maxBudget: 32768,
  },
  "qwen3-vl-plus": {
    alwaysOn: false,
    offParam: "enable_thinking:false",
    levels: ["off", "low", "medium", "high"],
    transport: "budget",
    maxBudget: 32768,
  },
  "qwen3-vl-flash": {
    alwaysOn: false,
    offParam: "enable_thinking:false",
    levels: ["off", "low", "medium", "high"],
    transport: "budget",
    maxBudget: 32768,
  },
  "qwen3-coder-plus": {
    alwaysOn: false,
    offParam: "enable_thinking:false",
    levels: ["off", "low", "medium", "high"],
    transport: "budget",
    maxBudget: 32768,
  },
  "qwen3-coder-flash": {
    alwaysOn: false,
    offParam: "enable_thinking:false",
    levels: ["off", "low", "medium", "high"],
    transport: "budget",
    maxBudget: 32768,
  },

  // ---- GLM 4.x 变体（bigmodel 文档全系 thinking 开关；v 系视觉同基座）----
  "glm-4.5": { alwaysOn: false, offParam: "thinking:disabled", levels: [], transport: "switch" },
  "glm-4.5-air": { alwaysOn: false, offParam: "thinking:disabled", levels: [], transport: "switch" },
  "glm-4.5-flash": { alwaysOn: false, offParam: "thinking:disabled", levels: [], transport: "switch" },
  "glm-4.5v": { alwaysOn: false, offParam: "thinking:disabled", levels: [], transport: "switch" },
  "glm-4.1v": { alwaysOn: false, offParam: "thinking:disabled", levels: [], transport: "switch" },
  "glm-4.1v-thinking": { alwaysOn: true, offParam: null, levels: [], transport: "switch" },
  "glm-4v-flash": { alwaysOn: false, offParam: "thinking:disabled", levels: [], transport: "switch" },
  "glm-4v-plus": { alwaysOn: false, offParam: "thinking:disabled", levels: [], transport: "switch" },
  "glm-4-plus": { alwaysOn: false, offParam: "thinking:disabled", levels: [], transport: "switch" },
  "glm-4-air": { alwaysOn: false, offParam: "thinking:disabled", levels: [], transport: "switch" },
  "glm-4-flash": { alwaysOn: false, offParam: "thinking:disabled", levels: [], transport: "switch" },
  "glm-4-long": { alwaysOn: false, offParam: "thinking:disabled", levels: [], transport: "switch" },

  // ---- DeepSeek 旧系（已退役，防御存量配置）----
  "deepseek-reasoner": { alwaysOn: true, offParam: null, levels: [], transport: "switch" },
  "deepseek-chat": { alwaysOn: false, offParam: null, levels: [], transport: "switch" },
  "deepseek-coder": { alwaysOn: false, offParam: null, levels: [], transport: "switch" },

  // ---- MiniMax（platform.minimax.io；thinking 开关，无 effort 档位，预算自适应）----
  "minimax-m3": { alwaysOn: false, offParam: "thinking:disabled", levels: [], transport: "switch" },
  "minimax-m2.5": { alwaysOn: false, offParam: "thinking:disabled", levels: [], transport: "switch" },
  "minimax-h3": { alwaysOn: false, offParam: "thinking:disabled", levels: [], transport: "switch" },

  // ---- 百度文心 ERNIE（千帆平台 cloud.baidu.com/doc/qianfan；enable_thinking 开关）----
  "ernie-5.0": { alwaysOn: false, offParam: "enable_thinking:false", levels: [], transport: "switch" },
  "ernie-5.1": { alwaysOn: false, offParam: "enable_thinking:false", levels: [], transport: "switch" },
  "ernie-x1.1": { alwaysOn: true, offParam: null, levels: [], transport: "switch" },
  "ernie-4.5-vl-28b-a3b": { alwaysOn: false, offParam: "enable_thinking:false", levels: [], transport: "switch" },
  "ernie-4.5-vl-28b-a3b-thinking": { alwaysOn: true, offParam: null, levels: [], transport: "switch" },
  "ernie-4.5-turbo-128k": { alwaysOn: false, offParam: "enable_thinking:false", levels: [], transport: "switch" },

  // ---- 腾讯混元 Hunyuan（TokenHub 混元调用指南 cloud.tencent.com/document/product/1823/132252）----
  // Hy4 preview（2026-08-28 发布，770B/49B MoE）：默认开启深度思考且无文档化关闭方式；
  // reasoning_effort 支持 low/high 两档（默认 high）。注意「仅支持 max」是 Kimi-K3 的口径
  // （132232 为 Kimi 指南），搜索摘要曾张冠李戴，勿混淆。TokenHub 短名 hy4-preview 同行。
  "hunyuan-hy4-preview": { alwaysOn: true, offParam: null, levels: ["low", "high"], transport: "effort" },
  "hy4-preview": { alwaysOn: true, offParam: null, levels: ["low", "high"], transport: "effort" },
  "hunyuan-hy3": { alwaysOn: false, offParam: "thinking:disabled", levels: [], transport: "switch" },
  "hunyuan-hy3-preview": { alwaysOn: false, offParam: "thinking:disabled", levels: [], transport: "switch" },
  hy3: { alwaysOn: false, offParam: "thinking:disabled", levels: [], transport: "switch" }, // TokenHub 短名
  "hy3-preview": { alwaysOn: false, offParam: "thinking:disabled", levels: [], transport: "switch" }, // TokenHub 短名（2026-08-31 下线，防御存量）
  "hunyuan-turbo": { alwaysOn: false, offParam: null, levels: [], transport: "switch" },
  "hunyuan-pro": { alwaysOn: false, offParam: null, levels: [], transport: "switch" },

  // ---- 字节豆包 Doubao（火山方舟深度思考 docs.volcengine.com/docs/82379/1956279；2026-08-30 核实）----
  // thinking:{type: enabled|disabled|auto} 三态开关（与 GLM/Moonshot/混元同形），无 effort 档位。
  // API ID 连字符式（doubao-seed-1-6），六位日期快照（-260628）由 lookupCap 归一剥离
  "doubao-seed-2-1-pro": { alwaysOn: false, offParam: "thinking:disabled", levels: [], transport: "switch" },
  "doubao-seed-2-1-turbo": { alwaysOn: false, offParam: "thinking:disabled", levels: [], transport: "switch" },
  "doubao-seed-2-0-pro": { alwaysOn: false, offParam: "thinking:disabled", levels: [], transport: "switch" },
  "doubao-seed-2-0-lite": { alwaysOn: false, offParam: "thinking:disabled", levels: [], transport: "switch" },
  "doubao-seed-2-0-mini": {
    // 官方称四种推理强度（极简/低/中/高），但 API 参数面未核实 → 先按已核实的开关基线
    alwaysOn: false,
    offParam: "thinking:disabled",
    levels: [],
    transport: "switch",
  },
  "doubao-seed-1-8": { alwaysOn: false, offParam: "thinking:disabled", levels: [], transport: "switch" },
  "doubao-seed-1-6": { alwaysOn: false, offParam: "thinking:disabled", levels: [], transport: "switch" }, // 三模式 auto/thinking/non-thinking
  "doubao-seed-1-6-flash": { alwaysOn: false, offParam: "thinking:disabled", levels: [], transport: "switch" },
  "doubao-seed-1-6-thinking": { alwaysOn: true, offParam: null, levels: [], transport: "switch" }, // 思考专用变体
  "doubao-1.5-thinking-pro": { alwaysOn: true, offParam: null, levels: [], transport: "switch" },
  "doubao-1.5-thinking-pro-vision": { alwaysOn: true, offParam: null, levels: [], transport: "switch" },
  "doubao-seed-evolving": { alwaysOn: true, offParam: null, levels: [], transport: "switch" }, // 深度思考/Agent/Coding 专用，未见可关口径

  // ---- Grok 旧系/专用（docs.x.ai；3-mini 退役前支持 effort）----
  "grok-3": { alwaysOn: false, offParam: "none", levels: ["none", "low", "medium", "high"], transport: "effort" },
  "grok-build-0.1": {
    alwaysOn: false,
    offParam: "none",
    levels: ["none", "low", "medium", "high"],
    transport: "effort",
  },
  "grok-code-fast-1": {
    alwaysOn: false,
    offParam: "none",
    levels: ["none", "low", "medium", "high"],
    transport: "effort",
  },

  // ---- Skywork R1V（视觉思维链推理模型 → alwaysOn）----
  "skywork-r1v": { alwaysOn: true, offParam: null, levels: [], transport: "switch" },
  "skywork-r1v-3": { alwaysOn: true, offParam: null, levels: [], transport: "switch" },
};

// ---------------------------------------------------------------------------
// 公共接口：UI 动态渲染
// ---------------------------------------------------------------------------

/** 模型的思考传输类型（UI 选择控件形态的依据） */
export type ReasoningTransport = "effort" | "budget" | "switch" | "auto";
export function getReasoningTransport(modelId: string | undefined): ReasoningTransport {
  const cap = lookupCap(modelId ?? "");
  if (!cap) return "auto"; // 不在表内 → 自动（不下发参数，模型自行决定）
  return cap.transport;
}

/** 获取模型支持的思考档位（effort 型 UI 渲染用）；switch 型返回 ["off","on"] */
export function getReasoningOptions(modelId: string | undefined): string[] {
  const cap = lookupCap(modelId ?? "");
  if (!cap) return []; // auto 型无选项
  if (cap.transport === "switch") return cap.alwaysOn ? [] : ["off", "on"];
  return cap.levels;
}

/** budget 型的滑块上限（默认 32768） */
export function getMaxBudget(modelId: string | undefined): number {
  const cap = lookupCap(modelId ?? "");
  return cap?.maxBudget ?? 32768;
}

/** 获取档位显示名 */
export function reasoningLevelLabel(level: string): string {
  return REASONING_LEVEL_DISPLAY[level] ?? level;
}

// ---------------------------------------------------------------------------
// 通道 A：AI SDK 原生 providerOptions
// ---------------------------------------------------------------------------
export function chatReasoningProviderOptions(
  providerId: string,
  modelId: string,
  level: ReasoningLevel,
): Record<string, Record<string, any>> | undefined {
  const id = modelId.toLowerCase();
  const cap = lookupCap(id);
  if (!cap) return undefined;

  switch (providerId) {
    case "openai": {
      if (cap.transport === "effort") {
        return { openai: { reasoningEffort: level } };
      }
      return undefined;
    }
    case "google":
    case "gemini": {
      if (cap.transport === "budget") {
        // 2.5 系走 budget 整数
        const budget = level === "off" ? 0 : level === "low" ? 1024 : level === "medium" ? 8192 : -1;
        return { google: { thinkingConfig: { thinkingBudget: budget } } };
      }
      if (cap.transport === "effort") {
        return { google: { thinkingConfig: { thinkingLevel: level } } };
      }
      return undefined;
    }
    case "openrouter": {
      return { openrouter: { reasoning: { effort: level === "off" ? "low" : level } } };
    }
    case "grok": {
      if (cap.transport === "effort") {
        return { openai: { reasoningEffort: level } };
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// 通道 B：自定义端点请求体补丁
// ---------------------------------------------------------------------------
export type ReasoningBodyPatch = (body: Record<string, unknown>) => void;

export function chatReasoningBodyPatch(
  providerId: string,
  baseUrl: string | undefined,
  modelId: string | undefined,
  level: ReasoningLevel,
): ReasoningBodyPatch | null {
  const id = (modelId ?? "").toLowerCase();
  const host = (baseUrl ?? "").toLowerCase();
  const cap = lookupCap(id);

  // auto / on 特殊值处理
  if (level === "auto") return null; // 不下发任何参数

  // DeepSeek
  if (providerId === "deepseek") {
    if (level === "off" || level === "none")
      return (body) => {
        body.thinking = { type: "disabled" };
      };
    return (body) => {
      body.reasoning_effort = level;
    };
  }
  // GLM（bigmodel）
  if (host.includes("bigmodel.cn")) {
    if (!cap) return null;
    if (cap.alwaysOn) {
      return (body) => {
        body.reasoning_effort = level;
      };
    }
    if (level === "off" || level === "none") {
      return (body) => {
        body.thinking = { type: "disabled" };
      };
    }
    if (level === "on") {
      return (body) => {
        body.thinking = { type: "enabled" };
      };
    }
    if (cap.levels.length > 0) {
      return (body) => {
        body.reasoning_effort = level;
      };
    }
    return null;
  }
  // Qwen（dashscope）— budget 型：level 是数字字符串（0 = off）
  if (host.includes("dashscope")) {
    const budget = Number.parseInt(level, 10);
    if (budget === 0 || level === "off" || level === "none") {
      return (body) => {
        body.enable_thinking = false;
      };
    }
    if (Number.isFinite(budget) && budget > 0) {
      return (body) => {
        body.enable_thinking = true;
        body.thinking_budget = budget;
      };
    }
    // 兼容旧的枚举值（低/中/高 → budget 数值）
    const legacy = level === "low" ? 1024 : level === "medium" ? 8192 : 32768;
    return (body) => {
      body.enable_thinking = true;
      body.thinking_budget = legacy;
    };
  }
  // Kimi（moonshot）
  if (host.includes("moonshot") || host.includes("kimi.com") || host.includes("kimi.ai")) {
    if (!cap) return null;
    if (cap.alwaysOn) {
      if (cap.levels.length === 0) return null;
      return (body) => {
        body.reasoning_effort = level;
      };
    }
    if (level === "off" || level === "none") {
      return (body) => {
        body.thinking = { type: "disabled" };
      };
    }
    if (level === "on") {
      return (body) => {
        body.thinking = { type: "enabled" };
      };
    }
    return null;
  }
  // 腾讯 TokenHub（tokenhub.tencentmaas.com，广州/新加坡同域）——混元系（132252 混元调用指南）。
  // 补此分支前表里的 hunyuan 行是死条目：自定义端点无 tencent 分派，思考参数从未真正下发
  if (host.includes("tencentmaas")) {
    if (!cap) return null;
    if (cap.alwaysOn) {
      // Hy4 preview：思考不可关，reasoning_effort 直传（low/high）
      return (body) => {
        body.reasoning_effort = level;
      };
    }
    if (level === "off" || level === "none") {
      return (body) => {
        body.thinking = { type: "disabled" };
      };
    }
    if (level === "on") {
      return (body) => {
        body.thinking = { type: "enabled" };
      };
    }
    return null;
  }
  // 豆包（火山方舟 ark.*.volces.com）——thinking:{type} 三态开关（深度思考文档 1956279）。
  // 补此分支前表里的 doubao 行是死条目：预置 provider 走 openai-compatible 通道，无 volces
  // 分派则思考参数从未真正下发（与混元 132252 同款缺口）
  if (host.includes("volces.com")) {
    if (!cap) return null;
    if (cap.alwaysOn) return null; // 思考专用型（-thinking/evolving）不下发
    if (level === "off" || level === "none")
      return (body) => {
        body.thinking = { type: "disabled" };
      };
    if (level === "on")
      return (body) => {
        body.thinking = { type: "enabled" };
      };
    return null;
  }
  // MiMo — budget 型同 Qwen
  if (host.includes("mimo.mi.com") || host.includes("mimo.xiaomi")) {
    const budget = Number.parseInt(level, 10);
    if (budget === 0 || level === "off" || level === "none") {
      return (body) => {
        body.enable_thinking = false;
      };
    }
    if (Number.isFinite(budget) && budget > 0) {
      return (body) => {
        body.enable_thinking = true;
        body.thinking_budget = budget;
      };
    }
    if (level === "on") {
      return (body) => {
        body.enable_thinking = true;
      };
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/** 轻量任务（标题/标签/摘要）的思考档位（用户口径：能禁则禁，不能禁取最低档）：
 *  effort 型返回 offParam（模型的地板档，如 gpt-5 的 minimal）或恒思考模型的 levels[0]；
 *  budget/switch 型与无行模型返回 undefined（由各通道的既有分支处理） */
export function auxThinkingLevel(cap: ReasoningCapability): string | undefined {
  if (cap.transport !== "effort") return undefined;
  if (cap.alwaysOn) return cap.levels[0];
  return cap.offParam ?? cap.levels[0];
}

/** 型号能力查询（factory 轻量任务分派共用；含作者前缀/日期快照归一，\d{6} 为豆包式六位日期） */
export function lookupCap(modelId: string): ReasoningCapability | undefined {
  let slug = modelId.toLowerCase();
  // OpenRouter/中转站的 "作者/" 前缀剥离（与 vision-map canonicalSlug 同源）：
  // openai/gpt-5.6-luna → gpt-5.6-luna
  if (slug.includes("/")) slug = slug.slice(slug.indexOf("/") + 1);
  const stripped = slug.replace(/-(\d{4}-\d{2}-\d{2}|\d{8}|\d{6})$/, "");
  return MODEL_REASONING[slug] ?? MODEL_REASONING[stripped] ?? findLongestPrefix(slug);
}

function findLongestPrefix(slug: string): ReasoningCapability | undefined {
  let best = "";
  let cap: ReasoningCapability | undefined;
  for (const [key, val] of Object.entries(MODEL_REASONING)) {
    if (slug.startsWith(key) && key.length > best.length) {
      best = key;
      cap = val;
    }
  }
  return cap;
}
