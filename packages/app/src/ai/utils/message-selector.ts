import type { UIMessage } from "@ai-sdk/react";
import { estimateMessageTokens, estimateMessagesTokens } from "./token-estimator";

/** 历史消息 token 预算：现代模型 1M 上下文起步，256k 约占 1/4，给 system prompt 与输出留余量 */
export const HISTORY_TOKEN_BUDGET = 256_000;
/** 保底保留的最近消息条数（预算再紧也不低于此，对齐"放宽到 40+ 条"的拍板） */
export const RECENT_MESSAGE_FLOOR = 40;

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
 * token 预算制的消息选择（替代固定 8 条硬截断）：
 * - 全量估算 ≤ budget：沿用原有清理逻辑全量保留；
 * - 超出：从最新向前累积，budget 内尽量多留，但不少于 floor 条、且至少保留最后一条 user 起；
 * - kept 复用 cleanupAndValidate 保证 user/assistant 交替；dropped 为原始数组前缀。
 */
export function selectMessagesWithinBudget(
  messages: UIMessage[],
  options?: { budget?: number; floor?: number },
): BudgetSelection {
  if (messages.length === 0) return { kept: [], dropped: [] };

  const lastUserIndex = messages.findLastIndex((msg) => msg.role === "user");
  if (lastUserIndex === -1) return { kept: [], dropped: [] };

  const budget = options?.budget ?? HISTORY_TOKEN_BUDGET;
  const floor = options?.floor ?? RECENT_MESSAGE_FLOOR;

  const fallback = (): BudgetSelection => ({
    kept: [messages[lastUserIndex]],
    dropped: messages.slice(0, lastUserIndex),
  });

  if (estimateMessagesTokens(messages) <= budget) {
    const cleaned = cleanupAndValidate(messages);
    return cleaned.length > 0 ? { kept: cleaned, dropped: [] } : fallback();
  }

  // 从最新向前累积 token，找到 budget 能容纳的分割点
  let accumulated = 0;
  let budgetSplit = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const tokens = estimateMessageTokens(messages[i]);
    if (accumulated + tokens > budget) {
      budgetSplit = i + 1;
      break;
    }
    accumulated += tokens;
  }

  // 三约束取最宽：budget 容量、floor 保底、必须含最后一条 user
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
