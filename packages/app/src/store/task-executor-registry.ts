/**
 * 任务通道注册表（独立叶子模块，刻意与 task-center-store 分离）。
 *
 * 为什么独立：执行器在模块加载时自注册（registerTaskChannel）。若注册表住在
 * task-center-store 模块里，dev 模式 HMR 重估 store 模块时注册表被清空、而执行器
 * 模块未变更不重跑 → 通道丢失（enqueue 报 no-executor）。本模块永不编辑，
 * HMR 不重估，注册随之存活。生产环境无此问题（模块只加载一次），这是 dev 健壮性。
 */

import type { TaskChannel, TaskExecutor } from "./task-center-store";

export interface ChannelDef {
  executor: TaskExecutor;
  /** P2 恒 1；P3 解析通道可调 2 */
  concurrency: number;
}

/** 冲突检查器：返回拒绝原因文案（null = 无冲突）。由 paper-conflict 适配层注入。 */
export type ConflictChecker = (channel: TaskChannel, targetId: string) => string | null;

const channelDefs = new Map<TaskChannel, ChannelDef>();
let conflictChecker: ConflictChecker | null = null;

/** 通道注册（执行器模块初始化时调用；重复注册后者覆盖，便于 HMR/测试重置） */
export function registerTaskChannel(channel: TaskChannel, def: ChannelDef): void {
  channelDefs.set(channel, def);
}

export function getChannelDef(channel: TaskChannel): ChannelDef | undefined {
  return channelDefs.get(channel);
}

/** 冲突检查器注入（paper-conflict 适配层）；null 清除 */
export function setTaskConflictChecker(checker: ConflictChecker | null): void {
  conflictChecker = checker;
}

export function getTaskConflictChecker(): ConflictChecker | null {
  return conflictChecker;
}

/** 测试专用：清空注册表（勿在生产路径调用） */
export function __resetTaskExecutorRegistryForTests(): void {
  channelDefs.clear();
  conflictChecker = null;
}
