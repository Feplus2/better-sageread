/**
 * 工具图片请求预算（2026-10-22）：工具结果的图片会被图片桥改挂到 user 消息，
 * 每张图都以 dataUrl 字符数（≈base64 字节）进入请求体并在后续每一步重复发送。
 * 预算卡的是"一次请求里工具图片的总 dataUrl 字符数"，不是张数：
 * - 最新工具批/最新一轮优先（从新往旧装），至少保留 1 张；
 * - 装不下的老图由图片桥替换成带路径的占位（可 readImage/viewImages 重看）。
 *
 * 700k ≈ 500KB base64，实测两张 2048 图（各 600k+）同轮已让单次请求拖到数分钟，
 * 700k 是"多图对比仍可用 + 请求体不失控"的折中。运行时可用
 * globalThis.__SAGEREAD_IMAGE_BUDGET_CHARS__ 覆盖（探针/排查用）。
 */

export const DEFAULT_TOOL_IMAGE_BUDGET_CHARS = 700_000;

/** 过小预算会让正常 1 张图都被省略，这里给一个下限 */
const MIN_TOOL_IMAGE_BUDGET_CHARS = 60_000;

let overrideBudgetChars: number | null = null;

function normalizeBudget(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_TOOL_IMAGE_BUDGET_CHARS;
  return Math.max(MIN_TOOL_IMAGE_BUDGET_CHARS, Math.floor(value));
}

/** 覆盖预算（传 null 恢复默认）；返回生效值 */
export function setToolImageBudgetChars(chars: number | null): number {
  overrideBudgetChars = chars == null ? null : normalizeBudget(chars);
  return getToolImageBudgetChars();
}

/** 当前生效的工具图片总预算（dataUrl 字符数） */
export function getToolImageBudgetChars(): number {
  const runtime = (globalThis as typeof globalThis & { __SAGEREAD_IMAGE_BUDGET_CHARS__?: unknown })
    .__SAGEREAD_IMAGE_BUDGET_CHARS__;
  if (typeof runtime === "number") return normalizeBudget(runtime);
  if (overrideBudgetChars != null) return overrideBudgetChars;
  return DEFAULT_TOOL_IMAGE_BUDGET_CHARS;
}
