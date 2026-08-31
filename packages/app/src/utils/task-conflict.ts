import { setTaskConflictChecker } from "@/store/task-center-store";
import { bookTaskConflict } from "./book-conflict";
import { paperTaskConflict } from "./paper-conflict";

/**
 * 任务冲突检查器统一注入点（2026-08-31，docs/book-convert-queue-plan.md 卡 2）。
 *
 * task-executor-registry 的冲突检查器是单槽（setTaskConflictChecker 后者覆盖前者），
 * 而论文/图书两侧执行器的模块加载顺序不固定（静态 import 链 + 动态 import 混合）——
 * 若各侧各注一个"只管自己通道"的检查器，后加载的一侧会把先加载的一侧覆盖掉。
 * 因此六个通道执行器统一在模块加载时调用本函数，注入同一个合成检查器
 * （论文半区 → 图书半区，互不认识的通道各自返回 null），与加载顺序无关、幂等。
 */
export function ensureTaskConflictChecker(): void {
  setTaskConflictChecker(
    (channel, targetId) => paperTaskConflict(channel, targetId) ?? bookTaskConflict(channel, targetId),
  );
}
