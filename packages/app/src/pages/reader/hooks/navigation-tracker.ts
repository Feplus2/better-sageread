/**
 * 用户翻页活动追踪（进程内单例）：
 * 供同步落地时做"防跳动保护"——60 秒内用户刚翻过页的书不自动跳转位置。
 */
const lastNavigationAt = new Map<string, number>();

/** 记录一次用户翻页（位置变化时调用）；用户翻页=接管位置，同步待采纳保护随之解除 */
export function markUserNavigation(bookId: string): void {
  lastNavigationAt.set(bookId, Date.now());
  pendingSyncLocations.delete(bookId);
}

/** 距上次用户翻页的毫秒数；从未翻过返回 Infinity */
export function msSinceUserNavigation(bookId: string): number {
  const at = lastNavigationAt.get(bookId);
  return at === undefined ? Number.POSITIVE_INFINITY : Date.now() - at;
}

/** 程序化跳转（同步落地 goTo）时间戳：该时间窗内的位置变化不算用户翻页 */
const programmaticNavigationAt = new Map<string, number>();
const PROGRAMMATIC_WINDOW_MS = 2_000;

/** 标记一次程序化跳转（goTo 前调用） */
export function markProgrammaticNavigation(bookId: string): void {
  programmaticNavigationAt.set(bookId, Date.now());
}

/** 当前是否处于程序化跳转时间窗内 */
export function isProgrammaticNavigation(bookId: string): boolean {
  const at = programmaticNavigationAt.get(bookId);
  return at !== undefined && Date.now() - at < PROGRAMMATIC_WINDOW_MS;
}

/**
 * 同步已落地但阅读器未跳转的书：远端位置待采纳（防跳动分支只提示不跳转）。
 * 此期间阅读器仍持旧位置，其自动保存必须跳过，否则把陈旧位置回写覆盖刚同步的行。
 */
const pendingSyncLocations = new Map<string, string>();

/** 标记"远端位置待采纳"（防跳动分支调用，value 为远端位置） */
export function markSyncPending(bookId: string, location: string): void {
  pendingSyncLocations.set(bookId, location);
}

/** 是否存在待采纳远端位置且阅读器仍停在旧位置（= 现在保存会陈旧回写） */
export function hasStalePendingSync(bookId: string, currentLocation: string | null): boolean {
  const pending = pendingSyncLocations.get(bookId);
  return pending !== undefined && pending !== currentLocation;
}
