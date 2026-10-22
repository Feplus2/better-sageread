/**
 * 聊天思考强度映射表 —— 枚举制（2026-08-28 定稿，最近更新 2026-09-22）。
 *
 * 用户可见档位 = 模型原生档位（不再经过 off/low/medium/high 四档映射）：
 * grok-4.6 支持 none/low/medium/high/xhigh → UI 直接呈现这五项；
 * GLM-5.3 思考不可关 → UI 只有 low/high/max 三项，没有 off。
 *
 * 两个下发通道按 provider 分派（与型号能力表正交）：
 * A. providerOptions（AI SDK 原生）：openai / google / openrouter / grok
 * B. 请求体补丁（自定义端点）：deepseek / GLM(bigmodel) / Qwen(dashscope) / Kimi(moonshot)
 *    / 混元(tencentmaas) / 豆包(volces) / MiMo / MiniMax
 *
 * 维护：新型号上线 → 查官方文档 → JSON 表加一行 → UI 自动适配。
 *
 * 表体已迁至 maps/reasoning-map.json（唯一事实源；打包兜底 + 远程热更新与
 * vision-map 同链路，见 maps/map-runtime.ts 与 services/model-maps-service.ts）。
 * 改表 = 改 JSON 并递增 updatedAt。
 */
import { type VersionedMapPayload, createMapRuntime } from "./maps/map-runtime";
import bundledReasoningMap from "./maps/reasoning-map.json";

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
// 精确型号枚举表（每行独立对照官方文档核实，2026-08-28 搜索调研）。
// 唯一事实源 = maps/reasoning-map.json；runtime 启动用打包表/缓存表，远程更晚则热替换
// ---------------------------------------------------------------------------
const REASONING_TRANSPORTS = new Set(["effort", "budget", "switch"]);

function validateReasoningModels(u: unknown): Record<string, ReasoningCapability> | null {
  if (!u || typeof u !== "object" || Array.isArray(u)) return null;
  for (const v of Object.values(u)) {
    if (!v || typeof v !== "object") return null;
    const c = v as Record<string, unknown>;
    if (typeof c.alwaysOn !== "boolean") return null;
    if (c.offParam !== null && typeof c.offParam !== "string") return null;
    if (!Array.isArray(c.levels) || !c.levels.every((l) => typeof l === "string")) return null;
    if (typeof c.transport !== "string" || !REASONING_TRANSPORTS.has(c.transport)) return null;
    if (c.maxBudget !== undefined && typeof c.maxBudget !== "number") return null;
  }
  return u as Record<string, ReasoningCapability>;
}

const runtime = createMapRuntime<ReasoningCapability>({
  cacheKey: "reasoningMapCache",
  // 打包 JSON 由 TS 表导出、构建期可信（远程表才走运行时校验）
  bundled: bundledReasoningMap as unknown as VersionedMapPayload<ReasoningCapability>,
  validateModels: validateReasoningModels,
});

/** 远程热更新入口（services/model-maps-service 调用）：形状校验+版本比较在运行时内 */
export function adoptRemoteReasoningMap(raw: unknown): boolean {
  return runtime.adopt(raw);
}

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
  // 存量档位钳制（审计 P2-5）：persist 值不在型号原生档位内时钳到最近合法档，防直接下发 400
  const lv = clampReasoningLevel(cap.levels, level);
  // 恒思考型号不接受控制词：off/none 落到最低原生档（与 auxThinkingLevel 同口径）。
  // 2026-10-20：Gemini 4 Argon / MiniMax M3.1 Flash 等 alwaysOn 行若把 off/none 原样下发必 400。
  const effectiveLevel = cap.alwaysOn && (lv === "off" || lv === "none") && cap.levels.length > 0 ? cap.levels[0] : lv;

  switch (providerId) {
    case "openai": {
      if (cap.transport === "effort") {
        return { openai: { reasoningEffort: effectiveLevel } };
      }
      return undefined;
    }
    case "google":
    case "gemini": {
      if (cap.transport === "budget") {
        // 数字档（滑块，UI 存数字字符串）直接下发（审计 P2-2：此前只认预设词，
        // 用户拖到 4096 等值全部落空成 -1 动态预算）；预设词走映射；off=0、high=-1 动态
        const n = Number.parseInt(effectiveLevel, 10);
        const budget = Number.isFinite(n)
          ? n
          : effectiveLevel === "off"
            ? 0
            : effectiveLevel === "low"
              ? 1024
              : effectiveLevel === "medium"
                ? 8192
                : -1;
        return { google: { thinkingConfig: { thinkingBudget: budget } } };
      }
      if (cap.transport === "effort") {
        return { google: { thinkingConfig: { thinkingLevel: effectiveLevel } } };
      }
      return undefined;
    }
    case "openrouter": {
      // 按 transport 分派（审计 P2-4：此前一律 effort 直传，switch 的 "on" 与 budget 的
      // 数字串会被当成 effort 非法值下发）
      if (cap.transport === "effort") {
        return { openrouter: { reasoning: { effort: effectiveLevel === "off" ? "low" : effectiveLevel } } };
      }
      if (cap.transport === "switch") {
        return { openrouter: { reasoning: { enabled: effectiveLevel !== "off" && effectiveLevel !== "none" } } };
      }
      if (cap.transport === "budget") {
        const n = Number.parseInt(effectiveLevel, 10);
        if (Number.isFinite(n)) return { openrouter: { reasoning: { max_tokens: n } } };
        return undefined; // 预设词无法映射 max_tokens，不下发
      }
      return undefined;
    }
    case "grok": {
      if (cap.transport === "effort") {
        return { openai: { reasoningEffort: effectiveLevel } };
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

  // 存量档位钳制（审计 P2-5）：deepseek 等无 medium 档型号上 persist 的 "medium" 必 400；
  // 控制词（off/none/on）与数字串（budget 滑块）由 clamp 内部放行
  level = cap ? (clampReasoningLevel(cap.levels, level) as ReasoningLevel) : level;
  // 恒思考型号不接受控制词：off/none 落到最低原生档（Gemini 4 Argon / MiniMax M3.1 Flash 等）
  if (cap?.alwaysOn && (level === "off" || level === "none") && cap.levels.length > 0) {
    level = cap.levels[0];
  }

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
  // MiMo（api.xiaomimimo.com）——官方深度思考文档：thinking:{type:enabled|disabled} 开关，
  // 默认开启（V2.6 全系/V2.5 同口径）。旧 host 检查 mimo.mi.com 不匹配官方端点 api.xiaomimimo.com，
  // 补上前表里的 mimo 行是死条目（与混元/豆包同款缺口，2026-09-22 随 V2.6 入表修复）。
  // 数字档保留 enable_thinking+thinking_budget，兼容存量 budget 行（v2.5 系）。
  // MiniMax（api.minimax.io / api.minimaxi.com / api.minimax.chat）——2026-10-20 补分派：
  // 补此分支前表里的 minimax 行是死条目（与 stepfun/mistral 同款缺口）。
  // M3.1-Flash 恒思考：thinking:{type:"disabled"} 或 reasoning_effort:"none" 直接 400，
  // 思考深度走 reasoning_effort（low/medium/high/xhigh/max，省略默认 max）；
  // 存量 M3/M2.5/H3 行为 switch 型（thinking:{type}），保持原口径。
  if (host.includes("minimax")) {
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
  if (host.includes("xiaomimimo.com") || host.includes("mimo.mi.com") || host.includes("mimo.xiaomi")) {
    const budget = Number.parseInt(level, 10);
    if (budget === 0 || level === "off" || level === "none") {
      return (body) => {
        body.thinking = { type: "disabled" };
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
        body.thinking = { type: "enabled" };
      };
    }
    return null;
  }
  return null;
}

/**
 * Anthropic Messages 原生通道的思考参数补丁（2026-10-22 纠偏）。
 *
 * 背景：DeepSeek/Kimi/智谱/MiniMax 的 Anthropic 兼容端点没有 AI SDK 的 providerOptions 通道
 * （factory 走 fetch 包装），所以直接在 JSON 请求体上写 thinking 字段。
 * 实网验证：DeepSeek 支持 disabled / enabled+budget_tokens / adaptive；Kimi 支持 disabled；
 * 恒思考型号发 disabled 会 400，因此夹到最低档后用 enabled 下发（失败时 wrapper 去补丁重放）。
 */
export function anthropicThinkingBodyPatch(modelId: string, level: ReasoningLevel): ReasoningBodyPatch | null {
  if (level === "auto") return null;
  const cap = lookupCap(modelId);
  const lv = cap ? clampReasoningLevel(cap.levels, level) : level;

  // 可关闭的型号：off/none 直接关思考（已实网验证 DeepSeek/Kimi）
  if ((lv === "off" || lv === "none") && !cap?.alwaysOn) {
    return (body) => {
      delete body.reasoning_effort;
      delete body.enable_thinking;
      body.thinking = { type: "disabled" };
    };
  }

  // 恒思考型号的 off/none 夹到最低原生档；其余档位按映射表折算 budget_tokens
  const effective = cap?.alwaysOn && (lv === "off" || lv === "none") && cap.levels.length > 0 ? cap.levels[0] : lv;
  const budget = budgetTokensForLevel(effective);
  return (body) => {
    delete body.reasoning_effort;
    delete body.enable_thinking;
    body.thinking = budget ? { type: "enabled", budget_tokens: budget } : { type: "enabled" };
  };
}

/** 思考档位 → Anthropic budget_tokens（官方要求 ≥1024；未知词用 2048） */
function budgetTokensForLevel(level: string): number | undefined {
  const n = Number.parseInt(level, 10);
  if (Number.isFinite(n) && n > 0) return Math.max(1024, n);
  switch (level) {
    case "minimal":
    case "low":
      return 1024;
    case "medium":
    case "on":
      return 2048;
    case "high":
      return 4096;
    case "xhigh":
      return 6144;
    case "max":
      return 8192;
    default:
      return undefined;
  }
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
  // offParam 含冒号者（"thinking:disabled"/"budget:0"）是请求体指令而非 effort 值——
  // 原样返回会经 OpenRouter 辅助通道下发非法 effort（2026-08-30 审计 P2-3）
  const off = cap.offParam;
  if (off && !off.includes(":")) return off;
  return cap.levels[0];
}

/** 档位强度序（钳制用）：off/none < low < medium < high < max/xhigh */
const LEVEL_RANK: Record<string, number> = { off: 0, none: 0, low: 1, medium: 2, high: 3, max: 4, xhigh: 4 };

/** 存量档位钳制（2026-08-30 审计 P2-5）：persist/历史值不在型号原生 levels 内时，钳到
 * 「不超过原档的最高可用档，没有更低则取最低档」——防换型号后 UI 显示无效档并直接下发 400。
 * 控制词（off/none/on/auto）与数字串（budget 滑块）原样放行；levels 为空（switch 型）原样放行。 */
export function clampReasoningLevel(levels: readonly string[], level: string): string {
  if (levels.length === 0 || levels.includes(level)) return level;
  if (level === "off" || level === "none" || level === "on" || level === "auto") return level;
  const rank = LEVEL_RANK[level];
  if (rank === undefined) return level;
  let best: string | undefined;
  for (const l of levels) {
    const r = LEVEL_RANK[l];
    if (r === undefined || r > rank) continue;
    if (best === undefined || (LEVEL_RANK[best] as number) < r) best = l;
  }
  return best ?? levels[0];
}

/** 型号能力查询（factory 轻量任务分派共用；含作者前缀/日期快照归一，\d{6} 为豆包式六位日期） */
export function lookupCap(modelId: string): ReasoningCapability | undefined {
  const table = runtime.current();
  let slug = modelId.toLowerCase();
  // OpenRouter/中转站的 "作者/" 前缀剥离（与 vision-map canonicalSlug 同源）：
  // openai/gpt-5.6-luna → gpt-5.6-luna
  if (slug.includes("/")) slug = slug.slice(slug.indexOf("/") + 1);
  const stripped = slug.replace(/-(\d{4}-\d{2}-\d{2}|\d{8}|\d{6})$/, "");
  return table[slug] ?? table[stripped] ?? findLongestPrefix(slug);
}

function findLongestPrefix(slug: string): ReasoningCapability | undefined {
  let best = "";
  let cap: ReasoningCapability | undefined;
  for (const [key, val] of Object.entries(runtime.current())) {
    if (slug.startsWith(key) && key.length > best.length) {
      best = key;
      cap = val;
    }
  }
  return cap;
}
