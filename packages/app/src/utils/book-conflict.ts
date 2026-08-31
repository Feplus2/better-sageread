import { type TaskChannel, useTaskCenterStore } from "@/store/task-center-store";

/**
 * 图书任务冲突矩阵（2026-08-31，docs/plans/book-convert-queue-plan.md 卡 2）：
 * book-translate × book-vectorize × book-convert 同一归属互斥（翻译中禁止向量化/重转换等），
 * 不同书全豁免；论文通道返回 null（论文半区在 utils/paper-conflict）。
 *
 * 与论文侧的差异：图书三通道的排队/运行态都直接读 task-center 任务表（无独立注册表）。
 * 注意 book-convert 的归属键是源 pdfPath（转换完成才入库成书，决策 1 不留 source.pdf），
 * 与 translate/vectorize 的 bookId 天然不撞——转换腿结构性在阵中，实际互斥发生在
 * 翻译×向量化之间。同通道同归属的幂等去重由队列自身先行拦截（dup 先于冲突判定）。
 */

const BOOK_CHANNEL_LABEL: Partial<Record<TaskChannel, string>> = {
  "book-translate": "翻译",
  "book-vectorize": "向量化",
  "book-convert": "转换",
};

/** 该书当前在跑/排队的其它图书通道标签（同通道排除——同通道同归属已被队列幂等拦截） */
function bookChannelBlockers(channel: TaskChannel, targetId: string): string[] {
  const { tasks } = useTaskCenterStore.getState();
  const blockers = new Set<string>();
  for (const task of Object.values(tasks)) {
    if (task.mirror || task.channel === channel || task.targetId !== targetId) continue;
    const label = BOOK_CHANNEL_LABEL[task.channel];
    if (!label) continue;
    if (task.status === "queued" || task.status === "running") blockers.add(label);
  }
  return [...blockers];
}

/** 图书通道入队冲突判定：返回拒绝原因文案（null = 无冲突）。对齐论文侧文案口径（「翻译中，完成后再向量化」） */
export function bookTaskConflict(channel: TaskChannel, targetId: string): string | null {
  const verb = BOOK_CHANNEL_LABEL[channel];
  if (!verb) return null;
  const blockers = bookChannelBlockers(channel, targetId);
  if (blockers.length === 0) return null;
  return `${blockers.map((l) => `${l}中`).join("、")}，完成后再${verb}`;
}
