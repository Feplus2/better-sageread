/**
 * 聊天思考强度映射表 —— 枚举制（2026-08-28 定稿，对齐 vision-map 纯静态表方案）。
 *
 * 用户可见四档：off / low / medium / high → 各端参数面。
 *
 * 形态：MODEL_REASONING 精确型号 → 能力行，每个型号独立核实官方文档。
 * 属性行含义：
 *   alwaysOn：思考不可关闭（GLM-5.3 传 disabled 直接 400、Kimi-K3 无 thinking 参数）
 *   canOff：是否支持 off 档（off = 真正关掉思考或映射到最低档）
 *   levels：该型号支持的 effort 值（provider 原生口径，按档位从低到高）
 *   offParam：off 档下发的参数值（"none"/"minimal"/"disabled"/"low" 等）
 *
 * 两个下发通道（按 provider 分派，与型号能力表正交）：
 * A. providerOptions（AI SDK 原生）：openai / google / openrouter / grok
 * B. 请求体补丁（自定义端点）：deepseek / GLM(bigmodel) / Qwen(dashscope) / Kimi(moonshot) / MiMo
 *
 * 维护：新型号上线 → 查官方文档 → 表里加一行。
 * 调研底稿：本文件头注 + 2026-08-28 逐家搜索（OpenAI/Gemini/Claude/Grok/DeepSeek/GLM/Qwen/Kimi）。
 */

export type ReasoningLevel = "off" | "low" | "medium" | "high";

export const REASONING_LEVEL_LABELS: Record<ReasoningLevel, string> = {
  off: "关闭",
  low: "低",
  medium: "中",
  high: "高",
};

/** 型号思考能力行 */
interface ReasoningCapability {
  /** 思考始终开启，不可关闭（传 disabled/off 参数会 400 或被忽略） */
  alwaysOn: boolean;
  /** off 档的 provider 参数值（alwaysOn=true 时无意义）；null = 不下发任何参数 */
  offParam: string | null;
  /** 支持的 effort 值（provider 原生，从低到高排列）；用户 low/medium/high 向此序列映射 */
  levels: string[];
}

// ---------------------------------------------------------------------------
// 精确型号枚举表（每行独立对照官方文档核实）
// ---------------------------------------------------------------------------
const MODEL_REASONING: Readonly<Record<string, ReasoningCapability>> = {
  // ---- OpenAI（developers.openai.com/api/docs/guides/reasoning）----
  // o 系列：仅 low/medium/high；GPT-5.x：minimal 作关；GPT-5.1+ 有 none；GPT-5.6 独有 max
  "o1": { alwaysOn: false, offParam: "low", levels: ["low", "medium", "high"] },
  "o1-pro": { alwaysOn: false, offParam: "low", levels: ["low", "medium", "high"] },
  "o1-mini": { alwaysOn: false, offParam: "low", levels: ["low", "medium", "high"] },
  "o3": { alwaysOn: false, offParam: "low", levels: ["low", "medium", "high"] },
  "o3-pro": { alwaysOn: false, offParam: "low", levels: ["low", "medium", "high"] },
  "o4-mini": { alwaysOn: false, offParam: "low", levels: ["low", "medium", "high"] },
  "gpt-5": { alwaysOn: false, offParam: "minimal", levels: ["minimal", "low", "medium", "high"] },
  "gpt-5-pro": { alwaysOn: false, offParam: "minimal", levels: ["minimal", "low", "medium", "high"] },
  "gpt-5-mini": { alwaysOn: false, offParam: "minimal", levels: ["minimal", "low", "medium", "high"] },
  "gpt-5-nano": { alwaysOn: false, offParam: "minimal", levels: ["minimal", "low", "medium", "high"] },
  "gpt-5.1": { alwaysOn: false, offParam: "none", levels: ["none", "minimal", "low", "medium", "high"] },
  "gpt-5.1-mini": { alwaysOn: false, offParam: "none", levels: ["none", "minimal", "low", "medium", "high"] },
  "gpt-5.2": { alwaysOn: false, offParam: "none", levels: ["none", "low", "medium", "high", "xhigh"] },
  "gpt-5.3-codex": { alwaysOn: false, offParam: "none", levels: ["none", "low", "medium", "high", "xhigh"] },
  "gpt-5.4": { alwaysOn: false, offParam: "none", levels: ["none", "low", "medium", "high"] },
  "gpt-5.5": { alwaysOn: false, offParam: "none", levels: ["none", "low", "medium", "high"] },
  "gpt-5.6-sol": { alwaysOn: false, offParam: "none", levels: ["none", "low", "medium", "high", "max"] },
  "gpt-5.6-terra": { alwaysOn: false, offParam: "none", levels: ["none", "low", "medium", "high"] },
  "gpt-5.6-luna": { alwaysOn: false, offParam: "none", levels: ["none", "low", "medium", "high"] },

  // ---- Google Gemini（ai.google.dev/gemini-api/docs/thinking + /gemini-3）----
  // 2.5 系走 thinkingBudget 整数；3.x 走 thinkingLevel 枚举；Pro 与 Flash 档位集不同
  "gemini-2.5-pro": { alwaysOn: false, offParam: "budget:0", levels: ["budget:0", "budget:1024", "budget:8192", "budget:-1"] },
  "gemini-2.5-flash": { alwaysOn: false, offParam: "budget:0", levels: ["budget:0", "budget:1024", "budget:8192", "budget:-1"] },
  "gemini-2.5-flash-lite": { alwaysOn: false, offParam: "budget:0", levels: ["budget:0", "budget:1024", "budget:8192", "budget:-1"] },
  "gemini-3-pro": { alwaysOn: true, offParam: null, levels: ["low", "medium", "high"] }, // 官方 "cannot be turned off"
  "gemini-3-flash": { alwaysOn: false, offParam: "minimal", levels: ["minimal", "low", "medium", "high"] },
  "gemini-3.1-pro": { alwaysOn: true, offParam: null, levels: ["low", "medium", "high"] },
  "gemini-3.1-flash": { alwaysOn: false, offParam: "minimal", levels: ["minimal", "low", "medium", "high"] },
  "gemini-3.5-flash": { alwaysOn: false, offParam: "minimal", levels: ["minimal", "low", "medium", "high"] },
  "gemini-3.5-flash-lite": { alwaysOn: false, offParam: "minimal", levels: ["minimal", "low", "medium", "high"] },
  "gemini-3.6-flash": { alwaysOn: false, offParam: "minimal", levels: ["minimal", "low", "medium", "high"] },
  "gemini-3.7-flash": { alwaysOn: true, offParam: null, levels: ["low", "medium", "high"] }, // minimal 已移除（Reddit/eesel 实证）

  // ---- xAI Grok（docs.x.ai/developers/model-capabilities/text/reasoning）----
  // Grok 4.3+ 均支持 reasoning_effort（none/low/medium/high）；4.5 思考常开但 effort 可调
  "grok-4": { alwaysOn: false, offParam: "none", levels: ["none", "low", "medium", "high"] },
  "grok-4.3": { alwaysOn: false, offParam: "none", levels: ["none", "low", "medium", "high"] },
  "grok-4.5": { alwaysOn: true, offParam: null, levels: ["low", "medium", "high"] }, // 思考常开
  "grok-4.6": { alwaysOn: false, offParam: "none", levels: ["none", "low", "medium", "high", "xhigh"] }, // 含 xhigh
  "grok-4.20": { alwaysOn: false, offParam: "none", levels: ["none", "low", "medium", "high"] }, // 走 reasoning.enabled

  // ---- DeepSeek（api-docs.deepseek.com/guides/thinking_mode + updates）----
  // V4：thinking 开关 + reasoning_effort low/high/max（无 medium）；2026-08-13 changelog
  "deepseek-v4-flash": { alwaysOn: false, offParam: "thinking:disabled", levels: ["low", "high", "max"] },
  "deepseek-v4-pro": { alwaysOn: false, offParam: "thinking:disabled", levels: ["low", "high", "max"] },
  "deepseek-v4-flash-vision-exp": { alwaysOn: false, offParam: "thinking:disabled", levels: ["low", "high", "max"] },

  // ---- 智谱 GLM（docs.bigmodel.cn/cn/guide/capabilities/thinking）----
  // GLM-5.3/5.3-Flash：思考不可关闭（传 disabled 直接 400）；reasoning_effort low/high/max
  // GLM-5.2 及以下：thinking 开关；GLM-4.6 及以下仅开关无 effort
  "glm-5.3": { alwaysOn: true, offParam: null, levels: ["low", "high", "max"] },
  "glm-5.3-flash": { alwaysOn: true, offParam: null, levels: ["low", "high", "max"] },
  "glm-5.2": { alwaysOn: false, offParam: "thinking:disabled", levels: ["low", "high", "max"] },
  "glm-5.1": { alwaysOn: false, offParam: "thinking:disabled", levels: [] },
  "glm-5": { alwaysOn: false, offParam: "thinking:disabled", levels: [] },
  "glm-4.7": { alwaysOn: false, offParam: "thinking:disabled", levels: [] },
  "glm-4.6": { alwaysOn: false, offParam: "thinking:disabled", levels: [] },
  "glm-4.6-flash": { alwaysOn: false, offParam: "thinking:disabled", levels: [] },
  "glm-5v-turbo": { alwaysOn: false, offParam: "thinking:disabled", levels: [] },

  // ---- 阿里 Qwen/DashScope（help.aliyun.com/zh/model-studio/deep-thinking）----
  // enable_thinking 开关 + thinking_budget 整数（1-32768，默认 4000）
  // 3.5-3.8 全系支持；部分开源型号（3.8-2.4t）强制开启
  "qwen3.5-plus": { alwaysOn: false, offParam: "enable_thinking:false", levels: ["budget"] },
  "qwen3.5-flash": { alwaysOn: false, offParam: "enable_thinking:false", levels: ["budget"] },
  "qwen3.6-plus": { alwaysOn: false, offParam: "enable_thinking:false", levels: ["budget"] },
  "qwen3.6-flash": { alwaysOn: false, offParam: "enable_thinking:false", levels: ["budget"] },
  "qwen3.7-plus": { alwaysOn: false, offParam: "enable_thinking:false", levels: ["budget"] },
  "qwen3.7-flash": { alwaysOn: false, offParam: "enable_thinking:false", levels: ["budget"] },
  "qwen3.8-max": { alwaysOn: false, offParam: "enable_thinking:false", levels: ["budget"] },
  "qwen3.8-27b": { alwaysOn: false, offParam: "enable_thinking:false", levels: ["budget"] },
  "qwen3.8-flash-next": { alwaysOn: false, offParam: "enable_thinking:false", levels: ["budget"] },
  "qwen3.8-2.4t": { alwaysOn: true, offParam: null, levels: ["budget"] }, // 开源 2.4T 强制开启
  "qwen3-max": { alwaysOn: false, offParam: "enable_thinking:false", levels: ["budget"] },
  "qvq-max": { alwaysOn: true, offParam: null, levels: [] }, // 视觉推理"仅思考"系

  // ---- 月之暗面 Kimi（platform.kimi.ai/docs/guide/use-thinking-models）----
  // K3：思考始终开启，无 thinking 参数，用顶层 reasoning_effort low/high/max（默认 max）
  // K2.7-code：思考常开；K2.x：thinking 开关
  "kimi-k3": { alwaysOn: true, offParam: null, levels: ["low", "high", "max"] },
  "kimi-k2.7-code": { alwaysOn: true, offParam: null, levels: [] },
  "kimi-k2.7-code-highspeed": { alwaysOn: true, offParam: null, levels: [] },
  "kimi-k2.6": { alwaysOn: false, offParam: "thinking:disabled", levels: [] },
  "kimi-k2.5": { alwaysOn: false, offParam: "thinking:disabled", levels: [] },

  // ---- Cohere（docs.cohere.com/docs/models）----
  // Command A Reasoning / A+：推理模型；无标准 effort 参数
  "command-a-reasoning": { alwaysOn: true, offParam: null, levels: [] },
  "command-a-plus": { alwaysOn: true, offParam: null, levels: [] },

  // ---- 小米 MiMo（mimo.mi.com/docs）----
  "mimo-v2.5": { alwaysOn: false, offParam: "enable_thinking:false", levels: ["budget"] },
  "mimo-v2.5-pro": { alwaysOn: false, offParam: "enable_thinking:false", levels: ["budget"] },
};

// ---------------------------------------------------------------------------
// 通道 A：AI SDK 原生 providerOptions（streamText 直接可传）
// ---------------------------------------------------------------------------
export function chatReasoningProviderOptions(
  providerId: string,
  modelId: string,
  level: ReasoningLevel,
): Record<string, Record<string, any>> | undefined {
  const id = modelId.toLowerCase();

  switch (providerId) {
    case "openai": {
      const cap = lookupCap(id);
      if (!cap) return undefined;
      if (cap.alwaysOn || level === "off") {
        // alwaysOn：off/low 都映射到最低档；可关的 off 用 offParam
        const offVal = cap.alwaysOn ? cap.levels[0] : cap.offParam;
        if (offVal === null) return undefined;
        return { openai: { reasoningEffort: offVal } };
      }
      return { openai: { reasoningEffort: mapLevel(level, cap.levels) } };
    }
    case "google":
    case "gemini": {
      const cap = lookupCap(id);
      if (!cap) return undefined;
      // 2.5 系走 budget
      if (cap.levels[0]?.startsWith("budget:")) {
        const budget = level === "off" ? 0 : level === "low" ? 1024 : level === "medium" ? 8192 : -1;
        return { google: { thinkingConfig: { thinkingBudget: budget } } };
      }
      // 3.x 走 level 枚举
      if (cap.alwaysOn || level === "off") {
        const offVal = cap.alwaysOn ? cap.levels[0] : cap.offParam;
        if (offVal === null) return undefined;
        return { google: { thinkingConfig: { thinkingLevel: offVal } } };
      }
      return { google: { thinkingConfig: { thinkingLevel: mapLevel(level, cap.levels) } } };
    }
    case "openrouter":
      return { openrouter: { reasoning: { effort: level === "off" ? "low" : level } } };
    case "grok": {
      const cap = lookupCap(id);
      if (!cap) return undefined;
      if (cap.alwaysOn || level === "off") {
        const offVal = cap.alwaysOn ? cap.levels[0] : cap.offParam;
        if (offVal === null) return undefined;
        return { openai: { reasoningEffort: offVal } };
      }
      return { openai: { reasoningEffort: mapLevel(level, cap.levels) } };
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

  // DeepSeek：thinking 开关 + reasoning_effort low/high/max
  if (providerId === "deepseek") {
    if (level === "off")
      return (body) => { body.thinking = { type: "disabled" }; };
    return (body) => {
      body.reasoning_effort = level === "low" ? "low" : level === "high" ? "max" : "high";
    };
  }
  // GLM（bigmodel）：5.3 系 alwaysOn 不下发 disabled；5.2 及以下走开关
  if (host.includes("bigmodel.cn")) {
    const cap = lookupCap(id);
    if (cap?.alwaysOn) {
      // 5.3/5.3-flash：思考不可关，仅调 effort
      return (body) => {
        body.reasoning_effort = level === "low" ? "low" : level === "high" ? "max" : "high";
      };
    }
    if (level === "off")
      return (body) => { body.thinking = { type: "disabled" }; };
    // 5.2 支持 effort；4.x 及以下仅开关
    if (cap && cap.levels.length > 0) {
      return (body) => {
        body.reasoning_effort = level === "low" ? "low" : level === "high" ? "max" : "high";
      };
    }
    return null;
  }
  // Qwen（dashscope）：enable_thinking 开关 + thinking_budget
  if (host.includes("dashscope")) {
    if (level === "off")
      return (body) => { body.enable_thinking = false; };
    // 开启时调 budget（1024/8192/16384/32768 映射 low/medium/high/max）
    const budget = level === "low" ? 1024 : level === "medium" ? 8192 : 32768;
    return (body) => {
      body.enable_thinking = true;
      body.thinking_budget = budget;
    };
  }
  // Kimi（moonshot）：K3 alwaysOn + reasoning_effort；K2.7-code alwaysOn 不下发；K2.x 走开关
  if (host.includes("moonshot") || host.includes("kimi.com") || host.includes("kimi.ai")) {
    const cap = lookupCap(id);
    if (cap?.alwaysOn) {
      if (cap.levels.length === 0) return null; // K2.7-code：常开无参数
      // K3：reasoning_effort low/high/max
      const effort = level === "off" || level === "low" ? "low" : level === "high" ? "max" : "high";
      return (body) => { body.reasoning_effort = effort; };
    }
    if (level === "off")
      return (body) => { body.thinking = { type: "disabled" }; };
    return null;
  }
  // MiMo（mimo）
  if (host.includes("mimo.mi.com") || host.includes("mimo.xiaomi")) {
    if (level === "off")
      return (body) => { body.enable_thinking = false; };
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/** 精确查表（含前缀剥离：日期快照别名） */
function lookupCap(modelId: string): ReasoningCapability | undefined {
  const slug = modelId.toLowerCase();
  const stripped = slug.replace(/-(\d{4}-\d{2}-\d{2}|\d{8})$/, "");
  return MODEL_REASONING[slug] ?? MODEL_REASONING[stripped] ?? findLongestPrefix(slug);
}

/** 无精确命中时按最长前缀找（gpt-5.1-codex → gpt-5.1；gemini-3.1-flash-lite → gemini-3.1-flash） */
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

/** 用户档位 → provider 档位（就近映射到 levels 序列中最近的值） */
function mapLevel(level: ReasoningLevel, levels: string[]): string {
  const idx = level === "low" ? 0 : level === "medium" ? Math.floor(levels.length / 2) : levels.length - 1;
  return levels[Math.min(idx, levels.length - 1)] ?? levels[0];
}
