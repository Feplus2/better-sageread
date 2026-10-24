/**
 * 模型上下文窗口解析与压缩水位（2026-10-22 晚重构，2026-10-23 按调研对齐 DSH/Cherry）。
 *
 * 旧实现硬编码点火线 256k / 泄压线 128k：对 128k 窗口的模型会把请求顶爆，
 * 对 1M 窗口的模型又压得太早。现按所选模型的真实窗口计算，公式参考 DeepSeek Harness
 * dsh-compaction-basic（threshold = min(0.8W, W−O−B)，retain = 16%×(W−O)）与
 * CherryStudio（inputRoom=max(W−O,0.2W)，trigger=80%×inputRoom，keep≈0.3W）：
 *
 *   O = 模型单次最大输出（模型列表 max_output_tokens，缺省 0）
 *   IR = max(W − O, 0.2W)                 // 可用于历史/输入的预算
 *   B = clamp(0.1W, 8k, 64k)              // 给 system/tools/本轮工具结果的余量
 *   触发线 = min(0.8W, max(MIN, IR − B))
 *   压缩后保留 = min(0.75×触发线, max(12k, 0.3×IR))，最近消息最少保留（selector 内保证）
 *
 * 容量来源优先级：模型列表接口 context_window > 内置家族表 > 默认 1M。
 * 2026-10 用户拍板：现代 Agent 模型基本 1M 标配，128k/256k 兜底过于保守会频繁误压。
 */
import { estimateMessagesTokens } from "@/ai/utils/token-estimator";
import type { UIMessage } from "@ai-sdk/react";

/**
 * 未知模型的默认窗口：现代 Agent 模型基本 1M 标配（用户 2026-10-23 拍板）。
 * 模型列表接口真实值 / 内置家族表仍优先；未知的极小窗口若溢出，后续用溢出重试兜底。
 */
export const DEFAULT_CONTEXT_WINDOW = 1_000_000;
/** 触发线占窗口比例（对齐 DSH / CherryStudio 默认 80%） */
export const TRIGGER_RATIO = 0.8;
/** 压缩后保留 ≈ 输入预算的 30%（对齐 Cherry 0.3×窗口口径） */
export const KEEP_RATIO = 0.3;
/** system/tools/本轮工具结果余量：窗口的 10%，限制在 8k–64k（DSH 用固定 64k，小窗口按比例缩放） */
export const MIN_HEADROOM = 8_000;
export const MAX_HEADROOM = 64_000;
/** 历史预算下限与压缩后下限 */
export const MIN_HISTORY_BUDGET = 24_000;
export const MIN_KEEP_BUDGET = 12_000;
/** 保留最近消息条数（token 预算优先，条数只作兜底） */
export const RECENT_MESSAGE_FLOOR = 10;

/** 模型家族 → 窗口（保守值；精确值优先取模型列表接口返回的 contextWindow） */
const FAMILY_WINDOWS: Array<{ pattern: RegExp; window: number; label: string }> = [
  { pattern: /^gemini/, window: 1_048_576, label: "gemini" },
  { pattern: /^(gpt-5|gpt-6|o[1-9])/, window: 400_000, label: "openai-gpt5+" },
  { pattern: /^gpt-4\.1/, window: 1_000_000, label: "gpt-4.1" },
  { pattern: /^gpt-4/, window: 128_000, label: "gpt-4" },
  { pattern: /^claude/, window: 200_000, label: "claude" },
  { pattern: /^grok/, window: 256_000, label: "grok" },
  // DeepSeek 官方 /models 实测 context_window=1048576（2026-10-22，deepseek-flash/v4-pro）
  { pattern: /^deepseek/, window: 1_048_576, label: "deepseek" },
  { pattern: /^kimi/, window: 262_144, label: "kimi" },
  { pattern: /^glm-5/, window: 204_800, label: "glm-5" },
  { pattern: /^glm/, window: 131_072, label: "glm" },
  { pattern: /^minimax/, window: 204_800, label: "minimax" },
  { pattern: /^mimo/, window: 262_144, label: "mimo" },
  { pattern: /^qwen/, window: 131_072, label: "qwen" },
  { pattern: /^doubao/, window: 262_144, label: "doubao" },
];

/** 身份归一：去 provider/ 前缀与日期快照后缀（与 vision-map/reasoning-map 同口径） */
export function canonicalModelSlug(modelId: string): string {
  let slug = (modelId ?? "").toLowerCase();
  if (slug.includes("/")) slug = slug.slice(slug.indexOf("/") + 1);
  return slug.replace(/-(\d{4}-\d{2}-\d{2}|\d{8}|\d{6})$/, "");
}

/** 解析模型窗口：显式值 > 家族表 > 默认保守值 */
export function resolveContextWindow(
  modelId: string | undefined,
  explicit?: number,
): { window: number; source: "model" | "family" | "default" } {
  if (explicit && Number.isFinite(explicit) && explicit > 0) {
    return { window: Math.max(1_000, Math.floor(explicit)), source: "model" };
  }
  const slug = canonicalModelSlug(modelId ?? "");
  for (const rule of FAMILY_WINDOWS) {
    if (rule.pattern.test(slug)) return { window: rule.window, source: "family" };
  }
  return { window: DEFAULT_CONTEXT_WINDOW, source: "default" };
}

export interface ContextBudget {
  /** 触发压缩的历史 token 线 */
  highWater: number;
  /** 压缩后保留到的历史 token 线 */
  lowWater: number;
  /** 最近消息保底条数 */
  floor: number;
  /** 解析出的窗口与来源（日志/设置展示用） */
  contextWindow: number;
  source: "model" | "family" | "default";
  /** 本次预算使用的输出预留与余量（调试用） */
  outputReserve: number;
  headroom: number;
}

/** 按模型窗口计算压缩水位（纯函数，可单测） */
export function resolveContextBudget(
  modelId: string | undefined,
  explicitWindow?: number,
  explicitMaxOutput?: number,
): ContextBudget {
  const { window: W, source } = resolveContextWindow(modelId, explicitWindow);
  const O =
    explicitMaxOutput && Number.isFinite(explicitMaxOutput) && explicitMaxOutput > 0
      ? Math.min(Math.floor(explicitMaxOutput), Math.floor(W * 0.5))
      : 0;
  const inputRoom = Math.max(W - O, Math.floor(W * 0.2));
  const headroom = Math.min(MAX_HEADROOM, Math.max(MIN_HEADROOM, Math.floor(W * 0.1)));
  const highWater = Math.min(Math.floor(W * TRIGGER_RATIO), Math.max(MIN_HISTORY_BUDGET, inputRoom - headroom));
  const lowWater = Math.min(
    Math.floor(highWater * 0.75),
    Math.max(MIN_KEEP_BUDGET, Math.floor(inputRoom * KEEP_RATIO)),
  );
  return { highWater, lowWater, floor: RECENT_MESSAGE_FLOOR, contextWindow: W, source, outputReserve: O, headroom };
}

/** 当前消息是否已超过触发线（供 transport 日志/调试） */
export function shouldCompact(messages: UIMessage[], budget: ContextBudget): boolean {
  return estimateMessagesTokens(messages) > budget.highWater;
}
