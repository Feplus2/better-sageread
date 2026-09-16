/**
 * 模型映射表热更新运行时（2026-09-14）。
 *
 * 生效表三级来源，优先级只看版本新旧：
 *   1. 打包兜底（构建期 import 的 maps/*.json，离线/首启/远程失败的地板）；
 *   2. localStorage 缓存（上次成功拉取的远程表，模块加载时同步恢复，不阻塞启动）；
 *   3. 远程表（启动后异步拉取，见 services/model-maps-service.ts）。
 * 采纳即「整表替换」——远程表是全量事实源，不做逐行合并（合并会把远程已删除的
 * 过期行永久残留在客户端）。同步查询路径只读内存表，远程到达后原子换引用。
 */

export interface VersionedMapPayload<T> {
  /** 版本戳（ISO 日期串，如 "2026-09-10"；可带时间） */
  updatedAt: string;
  models: Record<string, T>;
}

export interface MapRuntime<T> {
  /** 当前生效表（启动=打包/缓存中较新者，远程到达后热替换；永远同步可读） */
  current: () => Record<string, T>;
  /** 当前生效表的版本戳 */
  currentUpdatedAt: () => string;
  /** 校验形状 + 版本比较后采纳（并写缓存）；返回是否采纳 */
  adopt: (raw: unknown) => boolean;
}

// 版本比较规则：updatedAt 解析为时间戳，严格更晚才采纳；相等/更旧/不可解析一律丢弃
function parseUpdatedAt(u: unknown): number | null {
  if (typeof u !== "string") return null;
  const t = Date.parse(u);
  return Number.isFinite(t) ? t : null;
}

export function createMapRuntime<T>(opts: {
  cacheKey: string;
  bundled: VersionedMapPayload<T>;
  validateModels: (u: unknown) => Record<string, T> | null;
}): MapRuntime<T> {
  let table = opts.bundled.models;
  let updatedAt = opts.bundled.updatedAt;
  let updatedAtTs = parseUpdatedAt(updatedAt) ?? 0;

  const validatePayload = (raw: unknown): VersionedMapPayload<T> | null => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const p = raw as { updatedAt?: unknown; models?: unknown };
    const ts = parseUpdatedAt(p.updatedAt);
    if (ts === null) return null;
    const models = opts.validateModels(p.models);
    // 空表拒绝：擦空必属部署事故（未收录默认放行等语义依赖非空表兜底）
    if (!models || Object.keys(models).length === 0) return null;
    return { updatedAt: p.updatedAt as string, models };
  };

  // 启动同步恢复缓存：严格更晚才接管（localStorage 同步可读，微秒级，不阻塞启动）
  try {
    const raw = localStorage.getItem(opts.cacheKey);
    if (raw) {
      const payload = validatePayload(JSON.parse(raw));
      const ts = payload ? parseUpdatedAt(payload.updatedAt) : null;
      if (payload && ts !== null && ts > updatedAtTs) {
        table = payload.models;
        updatedAt = payload.updatedAt;
        updatedAtTs = ts;
      }
    }
  } catch {
    // 静默：缓存损坏/环境无 localStorage 当不存在，继续用打包表
  }

  return {
    current: () => table,
    currentUpdatedAt: () => updatedAt,
    adopt: (raw: unknown): boolean => {
      const payload = validatePayload(raw);
      if (!payload) return false;
      const ts = parseUpdatedAt(payload.updatedAt);
      if (ts === null || ts <= updatedAtTs) return false; // 不更晚 → 丢弃
      table = payload.models;
      updatedAt = payload.updatedAt;
      updatedAtTs = ts;
      try {
        localStorage.setItem(opts.cacheKey, JSON.stringify(payload));
      } catch {
        // 静默：缓存写不进去（隐私模式等）不影响本次生效
      }
      return true;
    },
  };
}
