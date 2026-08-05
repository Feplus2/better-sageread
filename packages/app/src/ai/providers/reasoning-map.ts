/**
 * 聊天思考强度映射表（P3，2026-08-05 调研落地）。
 *
 * 用户可见四档：off / low / medium / high → 各端参数面。两个下发通道：
 * A. providerOptions（AI SDK 原生参数族）：openai / google / openrouter / grok
 * B. 请求体补丁（自定义端点参数）：deepseek / GLM(bigmodel) / Qwen(dashscope) / Kimi(moonshot)，
 *    经 factory 的动态 fetch 包装注入，400 报思考参数相关错误时去补丁重放（兜底端点变更）。
 *
 * 维护原则：只下发核实过的 provider+model 组合；不认识的一律返回 undefined/null（不下发防 400）。
 * 2026 年中关键事实（源自各厂文档与实测社区报告）：
 * - Anthropic 4.6/4.7 起废弃 thinking.budget_tokens 改 effort 档位（Sonnet 5 收旧写法 400）；
 *   但本应用 anthropic 走 OpenAI 兼容通道，effort 参数面无实证 → 不下发
 * - Gemini 3.x 起废弃 thinkingBudget 整数改 thinkingLevel 枚举；3.1 Pro 不认 minimal
 * - OpenAI 按模型子集支持 none/minimal/low/medium/high（更新的有 xhigh/max，稳妥起见不映射）
 * - DeepSeek：thinking 开关 + reasoning_effort 仅 high/max
 * - Kimi K3：reasoning_effort low/high/max；K2.x 混合模型仅开关；思考专用型号关不掉
 */

export type ReasoningLevel = "off" | "low" | "medium" | "high";

export const REASONING_LEVEL_LABELS: Record<ReasoningLevel, string> = {
  off: "关闭",
  low: "低",
  medium: "中",
  high: "高",
};

/** 通道 A：AI SDK 原生 providerOptions（streamText 直接可传） */
export function chatReasoningProviderOptions(
  providerId: string,
  modelId: string,
  level: ReasoningLevel,
): Record<string, Record<string, unknown>> | undefined {
  const id = modelId.toLowerCase();
  switch (providerId) {
    case "openai":
      // o 系列仅 low/medium/high（off 映射 low）；gpt-5+ 用 minimal 作关
      if (/^o\d/.test(id)) {
        return { openai: { reasoningEffort: level === "off" ? "low" : level } };
      }
      if (/^gpt-5/.test(id)) {
        return { openai: { reasoningEffort: level === "off" ? "minimal" : level } };
      }
      return undefined;
    case "google":
    case "gemini":
      // 2.5 系：thinkingBudget 整数（0=关，-1=动态）
      if (/gemini-2\.5/.test(id)) {
        const budget = level === "off" ? 0 : level === "low" ? 1024 : level === "medium" ? 8192 : -1;
        return { google: { thinkingConfig: { thinkingBudget: budget } } };
      }
      // 3.x+ 系：thinkingLevel 枚举；Pro 系不认 minimal，off 映射 low
      if (/gemini-[3-9]/.test(id)) {
        if (level === "off") {
          return { google: { thinkingConfig: { thinkingLevel: id.includes("pro") ? "low" : "minimal" } } };
        }
        return { google: { thinkingConfig: { thinkingLevel: level } } };
      }
      return undefined;
    case "openrouter":
      // OpenRouter 对不支持推理的模型自动忽略 reasoning 参数，可安全下发；无实证 none 档，off 映射 low
      return { openrouter: { reasoning: { effort: level === "off" ? "low" : level } } };
    case "grok":
      // 仅 grok-3-mini 系列支持 reasoning_effort（low/high；grok-4 恒思考关不掉）
      if (id.includes("grok-3-mini")) {
        return { openai: { reasoningEffort: level === "high" ? "high" : "low" } };
      }
      return undefined;
    default:
      return undefined;
  }
}

export type ReasoningBodyPatch = (body: Record<string, unknown>) => void;

/** 通道 B：自定义端点请求体补丁；不认识或关不掉的返回 null（不乱发防 400） */
export function chatReasoningBodyPatch(
  providerId: string,
  baseUrl: string | undefined,
  modelId: string | undefined,
  level: ReasoningLevel,
): ReasoningBodyPatch | null {
  const id = (modelId ?? "").toLowerCase();
  const host = (baseUrl ?? "").toLowerCase();

  // DeepSeek：thinking 开关 + reasoning_effort 仅 high/max（无 low 档，off/low 都按关处理）
  if (providerId === "deepseek") {
    if (level === "off" || level === "low")
      return (body) => {
        body.thinking = { type: "disabled" };
      };
    return (body) => {
      body.reasoning_effort = level === "high" ? "max" : "high";
    };
  }
  // GLM（智谱 bigmodel）：仅开关有实证
  if (host.includes("bigmodel.cn")) {
    if (level === "off")
      return (body) => {
        body.thinking = { type: "disabled" };
      };
    return null;
  }
  // Qwen（阿里 dashscope）：仅开关有实证（enable_thinking）
  if (host.includes("dashscope")) {
    if (level === "off")
      return (body) => {
        body.enable_thinking = false;
      };
    return null;
  }
  // Kimi（Moonshot）：K3 系 reasoning_effort low/high/max（无 off，off/low 映射 low）；
  // K2.x 混合模型仅开关；思考专用型号（kimi-k2-thinking 等）关不掉，不下发
  if (host.includes("moonshot") || host.includes("kimi.com") || host.includes("kimi.ai")) {
    if (/^(kimi-)?k3/.test(id)) {
      const effort = level === "off" || level === "low" ? "low" : level === "high" ? "max" : "high";
      return (body) => {
        body.reasoning_effort = effort;
      };
    }
    if (id.includes("thinking")) return null;
    if (level === "off")
      return (body) => {
        body.thinking = { type: "disabled" };
      };
    return null;
  }
  return null;
}
