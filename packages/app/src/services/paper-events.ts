/**
 * 论文库变更通知总线（叶子模块，零依赖——service/store/页面三方共用，避免循环引用）：
 * - 状态变化（向量化 processing/success/failed 落盘后）：页面按 id 局部刷新该篇 status，不重挂载不整表刷新
 * - 列表变化（新论文入库）：页面去抖后增量重载列表
 *
 * 动机（2026-08-24 用户实测）：向量化完成圆环卡 100% 不转绿（status 落盘与列表订阅断裂）、
 * 解析完成新条目不出现（AI 工具路径不过队列收尾的 paperRefresh）。调用方在阅读视图时
 * PapersPage 未挂载，通知自然落空，下次挂载 loadAll 兜底——全程无强制整页刷新。
 */

const statusListeners = new Set<(paperId: string) => void>();
const listListeners = new Set<() => void>();

/** 某篇论文的 status（metadata.vectorization 等）已落盘变更 */
export function notifyPaperStatusChanged(paperId: string): void {
  for (const l of statusListeners) {
    try {
      l(paperId);
    } catch {
      /* 监听器异常不阻断其余 */
    }
  }
}

/** 论文库清单发生变化（新增入库等） */
export function notifyPaperListChanged(): void {
  for (const l of listListeners) {
    try {
      l();
    } catch {
      /* 同上 */
    }
  }
}

export function onPaperStatusChanged(listener: (paperId: string) => void): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

export function onPaperListChanged(listener: () => void): () => void {
  listListeners.add(listener);
  return () => listListeners.delete(listener);
}
