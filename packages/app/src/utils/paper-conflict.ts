import { isPaperQueuedOrRunning } from "@/store/convert-progress-store";
import { type PaperTaskKind, conflictKinds, registryActiveKinds } from "@/store/paper-task-registry";

/**
 * 组合冲突判定（解析队列 × 向量化/翻译注册表）——批量按钮禁用态与入队守卫共用的唯一口径。
 * 本模块同时依赖两个 store（单向：两 store 均不 import 本模块），页面/队列在此汇合。
 */

/** 该论文当前的活跃任务清单（解析排队/运行 记作 parse） */
export function paperActiveKinds(paperId: string): PaperTaskKind[] {
  const active = registryActiveKinds(paperId);
  if (isPaperQueuedOrRunning(paperId)) active.push("parse");
  return active;
}

/** 对 kind 任务的冲突清单（空 = 可执行） */
export function paperConflicts(paperId: string, kind: PaperTaskKind): PaperTaskKind[] {
  return conflictKinds(kind, paperActiveKinds(paperId));
}

const KIND_LABEL: Record<PaperTaskKind, string> = {
  parse: "解析中",
  vectorize: "向量化中",
  translate: "翻译中",
};

/** 冲突原因的可读摘要（按钮 tooltip / 拒绝 toast 共用） */
export function conflictReasonText(conflicts: PaperTaskKind[]): string {
  return conflicts.map((k) => KIND_LABEL[k]).join("、");
}
