import { isPaperQueuedOrRunning } from "@/store/convert-progress-store";
import { type PaperTaskKind, conflictKinds, registryActiveKinds } from "@/store/paper-task-registry";
import type { TaskChannel } from "@/store/task-center-store";

/**
 * 组合冲突判定（解析队列 × 向量化/翻译注册表）——批量按钮禁用态与入队守卫共用的唯一口径。
 * 本模块同时依赖两个 store（单向：两 store 均不 import 本模块），页面/队列在此汇合。
 * P2-4：parse 读源已从 convert-progress-store 的内存队列迁到 task-center 的 paper-parse
 * 通道（isPaperQueuedOrRunning 内部改读通道任务表，含刷新恢复占用任务；判定口径不变）。
 * 2026-08-31（图书转换队列卡 2）：入队口注入迁移到 utils/task-conflict 的
 * ensureTaskConflictChecker（论文半区 + 图书半区合成单一检查器），本模块只留判定函数。
 */

/** 该论文当前的活跃任务清单（解析排队/运行 记作 parse） */
export function paperActiveKinds(paperId: string): PaperTaskKind[] {
  const active = registryActiveKinds(paperId);
  if (isPaperQueuedOrRunning(paperId)) active.push("parse");
  // 刷新兜底：注册表内存态丢失时走 metadata（异步——首次调用可能缺，但批量按钮
  // 灾难场景是刷新后立即操作，恢复 effect 已先跑过了）
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

const CHANNEL_TO_KIND: Partial<Record<TaskChannel, PaperTaskKind>> = {
  "paper-parse": "parse",
  "paper-vectorize": "vectorize",
  "paper-translate": "translate",
};

/**
 * 论文通道入队冲突判定（组合冲突检查器的论文侧半区；图书侧半区在 utils/book-conflict，
 * 注入点统一在 utils/task-conflict 的 ensureTaskConflictChecker——单槽注册，两半区合成一个
 * 检查器，与模块加载顺序无关）。
 * 判定口径与批量按钮禁用态/旧队列入队守卫完全一致：注册表运行标记 + 解析通道任务表
 * （P2-4 起 parse 状态源为 task-center 的 paper-parse 通道）。图书通道返回 null。
 * 返回值为原因摘要（如「解析中、翻译中」），标题与后续引导语由调用方拼装。
 */
export function paperTaskConflict(channel: TaskChannel, targetId: string): string | null {
  const kind = CHANNEL_TO_KIND[channel];
  if (!kind) return null;
  const conflicts = paperConflicts(targetId, kind);
  if (conflicts.length === 0) return null;
  // 原因摘要 + 后续动作引导（对齐旧入口 toast 口径：「《t》解析中，完成后再向量化」）
  const verb = kind === "vectorize" ? "向量化" : kind === "translate" ? "翻译" : "再试";
  return `${conflictReasonText(conflicts)}，完成后再${verb}`;
}
