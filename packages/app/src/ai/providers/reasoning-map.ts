/**
 * 聊天思考强度映射表（P3，2026-08-05 调研落地；2026-08-24 复核修订，见 docs/vision-map-research.md 第四节）。
 *
 * 用户可见四档：off / low / medium / high → 各端参数面。两个下发通道：
 * A. providerOptions（AI SDK 原生参数族）：openai / google / openrouter / grok
 * B. 请求体补丁（自定义端点参数）：deepseek / GLM(bigmodel) / Qwen(dashscope) / Kimi(moonshot)，
 *    经 factory 的动态 fetch 包装注入，400 报思考参数相关错误时去补丁重放（兜底端点变更）。
 *
 * 维护原则：只下发核实过的 provider+model 组合；不认识的一律返回 undefined/null（不下发防 400）。
 * 2026-08 复核关键事实（源自各厂文档；Google/xAI 为二手交叉，待有网环境复核）：
 * - Anthropic 4.6 代 budget_tokens 为 deprecated-but-functional，硬 400 从 4.7 起（含全部 5 代）；
 *   effort 枚举 low/medium/high/xhigh/max，位置在顶层 output_config.effort；但本应用 anthropic 走
 *   OpenAI 兼容通道，官方兼容页明示 reasoning_effort: Ignored → 不下发（另注意 4.7+ 连
 *   temperature/top_p/top_k 非默认值都 400）
 * - Gemini 3.x 起废弃 thinkingBudget 整数改 thinkingLevel 枚举；3.1 Pro 与 3.7-flash 不认 minimal，
 *   gemini-3-pro 仅 low/high 且不可关
 * - OpenAI 按模型子集支持 none/minimal/low/medium/high（minimal 仅初代 gpt-5 族，none 是 5.1 起的
 *   "不推理"档，xhigh 从 5.2/5.3-codex 起，max 仅 GPT-5.6 族；稳妥起见不映射 xhigh/max）
 * - DeepSeek：thinking 开关 + reasoning_effort low/high/max 三档（2026-08-13 起支持 low 档）
 * - Kimi K3：reasoning_effort low/high/max 且思考始终开启（off 映射 low）；思考常开型号
 *   （kimi-k3、kimi-k2.7-code(-highspeed)，传 disabled 直接 400）关不掉；kimi-k2-thinking 已下线
 */

export type ReasoningLevel = "off" | "low" | "medium" | "high";

export const REASONING_LEVEL_LABELS: Record<ReasoningLevel, string> = {
  off: "关闭",
  low: "低",
  medium: "中",
  high: "高",
};

/** 通道 A：AI SDK 原生 providerOptions（streamText 直接可传）。
 * 返回值为 JSON 兼容字面量（string/number），v7 的 SharedV4ProviderOptions 要求 JSON 值域，
 * 故标 any 而非 unknown（unknown 不可赋给 JSONValue）。 */
export function chatReasoningProviderOptions(
  providerId: string,
  modelId: string,
  level: ReasoningLevel,
): Record<string, Record<string, any>> | undefined {
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
      // 3.x+ 系：thinkingLevel 枚举
      if (/gemini-[3-9]/.test(id)) {
        // gemini-3-pro 仅 low/high 且不可关：off/low→low，medium/high→high（medium 无此档，就近上取）
        if (/^gemini-3-pro/.test(id)) {
          return { google: { thinkingConfig: { thinkingLevel: level === "off" || level === "low" ? "low" : "high" } } };
        }
        if (level === "off") {
          // 3.1 Pro 与 3.7-flash 不认 minimal（传 minimal 直接报错），off 映射 low；
          // 3.7-flash-lite 是否保留 minimal 无实证（调研未覆盖），不动
          const noMinimal = id.includes("pro") || (id.startsWith("gemini-3.7-flash") && !id.includes("lite"));
          return { google: { thinkingConfig: { thinkingLevel: noMinimal ? "low" : "minimal" } } };
        }
        return { google: { thinkingConfig: { thinkingLevel: level } } };
      }
      return undefined;
    case "openrouter":
      // OpenRouter 对不支持推理的模型自动忽略 reasoning 参数，可安全下发；
      // none 档已有官方实证（"Disables reasoning entirely"），但 reasoning.mandatory=true 的模型
      // （如 gemini-3.1-pro-preview）会拒绝 effort:"none"——off 映射 low 恰好规避该坑，保留
      return { openrouter: { reasoning: { effort: level === "off" ? "low" : level } } };
    case "grok":
      // 仅 grok-3-mini 系列支持 reasoning_effort（low/high）——2026 年 2–5 月已陆续退役，此分支仅防御存量配置。
      // 现役矩阵（grok-4.3 none/low/medium/high、grok-4.5 low/medium/high 不可关、grok-4.6 含 xhigh、
      // grok-4.20 走 reasoning.enabled 开关）为二手来源（docs.x.ai 本环境不可直连），未经核实前不下发
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

  // DeepSeek：thinking 开关 + reasoning_effort low/high/max 三档
  // （2026-08-13 官方 Change Log：V4-Pro/V4-Flash 支持 low/high/max；off 走 thinking disabled）
  if (providerId === "deepseek") {
    if (level === "off")
      return (body) => {
        body.thinking = { type: "disabled" };
      };
    return (body) => {
      body.reasoning_effort = level === "low" ? "low" : level === "high" ? "max" : "high";
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
  // Kimi（Moonshot）：K3 系 reasoning_effort low/high/max（K3 思考始终开启无 off，off/low 映射 low）；
  // K2.x 混合模型仅开关；思考常开型号（kimi-k2.7-code(-highspeed)；kimi-k2-thinking 已下线）关不掉，
  // 传 disabled 直接 400 → 不下发
  if (host.includes("moonshot") || host.includes("kimi.com") || host.includes("kimi.ai")) {
    if (/^(kimi-)?k3/.test(id)) {
      const effort = level === "off" || level === "low" ? "low" : level === "high" ? "max" : "high";
      return (body) => {
        body.reasoning_effort = effort;
      };
    }
    if (/^(kimi-)?k2\.7-code/.test(id) || id.includes("thinking")) return null;
    if (level === "off")
      return (body) => {
        body.thinking = { type: "disabled" };
      };
    return null;
  }
  return null;
}
