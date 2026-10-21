/** P1-3 单轮读取预算：限制一轮对话里 readDocument/readImage 的原文/图片总量，防止模型连续扩读把上下文打满。 */
export const READ_BUDGET_CHARS = 32000;
/** 单张图片按多少字符预算折算（dataUrl 会随每步重复计费，实际远高于此，用保守值） */
export const IMAGE_BUDGET_COST = 8000;

let usedChars = 0;

export function resetReadBudget(): void {
  usedChars = 0;
}

export function readBudgetUsed(): number {
  return usedChars;
}

export function readBudgetRemaining(): number {
  return Math.max(0, READ_BUDGET_CHARS - usedChars);
}

/** 申请预算：返回实际可用的字符数（可能小于请求值）。 */
export function takeReadBudget(requested: number): number {
  const remaining = readBudgetRemaining();
  const granted = Math.max(0, Math.min(requested, remaining));
  usedChars += granted;
  return granted;
}
