import type { UIMessage } from "@ai-sdk/react";
import { estimateMessageTokens, estimateMessagesTokens } from "./token-estimator";

/** 模型上下文上限参考值（现代模型 1M 起步）：与点火线同值 */
export const HISTORY_TOKEN_BUDGET = 256_000;
/** 活塞点火线：历史 token 超过此值才触发压缩（避免每轮频繁点火；2026-08-09 用户拍板 256k） */
export const COMPRESS_HIGH_WATER = 256_000;
/** 活塞泄压线：点火后从最新向前保留到此值以内，腾出约一半空间后才需下次点火（点火线的 1/2） */
export const COMPRESS_LOW_WATER = 128_000;
/** 保底保留的最近消息条数（单位：条，user/assistant 各算一条）：泄压时这些永不压缩，
 * 保证 Agent 不忘最近邻对话（2026-08-09 由 40 调为 10：40 过多，真正兜底只需最近几轮） */
export const RECENT_MESSAGE_FLOOR = 10;

export function selectValidMessages(messages: UIMessage[], maxCount = 8): UIMessage[] {
  if (messages.length === 0) return [];

  const lastUserIndex = messages.findLastIndex((msg) => msg.role === "user");
  if (lastUserIndex === -1) return [];

  const fromLastUser = messages.slice(lastUserIndex);

  if (fromLastUser.length > maxCount) {
    return [fromLastUser[0]];
  }

  const cleaned = cleanupAndValidate(fromLastUser);
  if (cleaned.length === 0) {
    return [fromLastUser[0]];
  }

  const remaining = maxCount - cleaned.length;
  if (remaining > 0 && lastUserIndex > 0) {
    const history = cleanupAndValidate(messages.slice(0, lastUserIndex));
    let historyToAdd = history.slice(-remaining);

    if (historyToAdd.length > 0 && historyToAdd[0].role !== "user") {
      const firstUserInHistory = historyToAdd.findIndex((m) => m.role === "user");
      if (firstUserInHistory > 0) {
        historyToAdd = historyToAdd.slice(firstUserInHistory);
      } else {
        historyToAdd = [];
      }
    }

    return [...historyToAdd, ...cleaned];
  }

  return cleaned;
}

function cleanupAndValidate(messages: UIMessage[]): UIMessage[] {
  if (messages.length === 0) return [];

  const firstUserIndex = messages.findIndex((msg) => msg.role === "user");
  if (firstUserIndex === -1) return [];

  const fromFirstUser = messages.slice(firstUserIndex);
  const merged = mergeConsecutiveRoles(fromFirstUser);

  if (!isValidSequence(merged)) return [];

  return merged;
}

function mergeConsecutiveRoles(messages: UIMessage[]): UIMessage[] {
  const result: UIMessage[] = [];

  for (const msg of messages) {
    const last = result[result.length - 1];

    if (last && last.role === msg.role) {
      last.parts = [...(Array.isArray(last.parts) ? last.parts : []), ...(Array.isArray(msg.parts) ? msg.parts : [])];
    } else {
      result.push({ ...msg });
    }
  }

  return result;
}

function isValidSequence(messages: UIMessage[]): boolean {
  if (messages.length === 0) return false;
  if (messages[0].role !== "user") return false;

  for (let i = 0; i < messages.length - 1; i++) {
    const current = messages[i].role;
    const next = messages[i + 1].role;

    if (current === "user" && next !== "assistant") return false;
    if (current === "assistant" && next !== "user") return false;
    if (current !== "user" && current !== "assistant") return false;
  }

  return true;
}

export interface BudgetSelection {
  /** 进入本轮请求的消息（已做序列合法性清理，首条为 user） */
  kept: UIMessage[];
  /** 被预算裁掉的前缀（原始顺序，供滚动压缩覆盖计数用） */
  dropped: UIMessage[];
}

/**
 * token 活塞制的消息选择（2026-08-09 由"超预算每轮裁剪"改为双水位活塞，替代固定 8 条硬截断）：
 * - 全量估算 ≤ 点火线（highWater）：全量保留，零压缩（大部分轮次走这里）；
 * - 超过点火线：从最新向前累积到泄压线（lowWater）以内，一次性腾出约半窗空间，
 *   之后要再攒约 highWater-lowWater 才会下次点火——避免每新一条消息就压一次；
 * - floor 条保底：最近 N 条即使超泄压线也永不压缩（Agent 不忘最近邻对话）；
 * - kept 复用 cleanupAndValidate 保证 user/assistant 交替；dropped 为原始数组前缀（滚入摘要）。
 */
export function selectMessagesWithinBudget(
  messages: UIMessage[],
  options?: { budget?: number; lowWater?: number; floor?: number },
): BudgetSelection {
  if (messages.length === 0) return { kept: [], dropped: [] };

  const lastUserIndex = messages.findLastIndex((msg) => msg.role === "user");
  if (lastUserIndex === -1) return { kept: [], dropped: [] };

  const highWater = options?.budget ?? COMPRESS_HIGH_WATER;
  const lowWater = options?.lowWater ?? COMPRESS_LOW_WATER;
  const floor = options?.floor ?? RECENT_MESSAGE_FLOOR;

  const fallback = (): BudgetSelection => ({
    kept: [messages[lastUserIndex]],
    dropped: messages.slice(0, lastUserIndex),
  });

  if (estimateMessagesTokens(messages) <= highWater) {
    const cleaned = cleanupAndValidate(messages);
    return cleaned.length > 0 ? { kept: cleaned, dropped: [] } : fallback();
  }

  // 点火：从最新向前累积 token，找到泄压线能容纳的分割点
  let accumulated = 0;
  let budgetSplit = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const tokens = estimateMessageTokens(messages[i]);
    if (accumulated + tokens > lowWater) {
      budgetSplit = i + 1;
      break;
    }
    accumulated += tokens;
  }

  // 三约束取最宽：泄压容量、floor 保底、必须含最后一条 user
  let splitAt = Math.min(budgetSplit, Math.max(messages.length - floor, 0), lastUserIndex);

  // 对齐到 user 消息（lastUserIndex 本身是 user，最多前进到那里）
  while (splitAt < messages.length && messages[splitAt].role !== "user") {
    splitAt++;
  }

  if (splitAt === 0) {
    const cleaned = cleanupAndValidate(messages);
    return cleaned.length > 0 ? { kept: cleaned, dropped: [] } : fallback();
  }

  const cleaned = cleanupAndValidate(messages.slice(splitAt));
  if (cleaned.length === 0) return fallback();

  return { kept: cleaned, dropped: messages.slice(0, splitAt) };
}
