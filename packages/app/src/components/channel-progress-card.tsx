/**
 * 通道聚合进度卡（papers 页批量向量化/翻译卡的共用抽取；卡 2 起图书馆页图书翻译卡复用，
 * docs/plans/book-convert-queue-plan.md）。
 *
 * 数据源 = task-center 通道聚合折算（channelCardOf）；卡本体样式即原 papers 页批量任务卡。
 * 点击卡弹子任务面板由调用方套 TaskRunPanel；取消/关闭回调由调用方接通道操作
 * （cancelChannel / dismissSettled）；出入场动效由调用方套 MotionStackCard。
 */

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import type { ChannelAggregate } from "@/store/task-center-store";
import clsx from "clsx";
import { X } from "lucide-react";

/** 通道卡视图模型（字段口径与 paper-task-store 的 ChannelProgress 一致——恢复监控卡直接复用本组件） */
export interface ChannelCardState {
  status: "running" | "success" | "error";
  /** 当前条目序号（0 基） */
  index: number;
  total: number;
  /** 当前条目标题 */
  title: string;
  /** 当前条目细节（阶段/块进度） */
  detail: string;
  /** 总进度百分比 */
  percent: number;
  doneCount: number;
  failedCount: number;
  skippedCount: number;
  failedNames: string[];
  /** 收尾汇总（status 非 running 时展示） */
  summary?: string;
  /** 取消中（cancel 已触发、当前条目收尾中）——取消按钮置灰文案用 */
  cancelling?: boolean;
}

/**
 * 通道聚合 → 进度卡视图模型。口径对齐旧批量队列卡：index/total 动态含排队；
 * percent 按条目数加权（含当前条目内进度）；summary/状态文案同旧 drain 收尾。
 * unit = 计数单位（论文「篇」/图书「本」）；resumable = 取消汇总追加「已翻部分已落盘可续翻」（翻译类通道）。
 * 返回 null = 通道无任何任务（不渲染卡）。
 */
export function channelCardOf(
  agg: ChannelAggregate,
  cancelling: boolean,
  opts?: { unit?: string; resumable?: boolean },
): ChannelCardState | null {
  const { current, queuedCount, settled } = agg;
  if (!current && queuedCount === 0 && settled.length === 0) return null;
  const unit = opts?.unit ?? "篇";
  const doneCount = settled.filter((t) => t.status === "success").length;
  const failed = settled.filter((t) => t.status === "error");
  const cancelledCount = settled.filter((t) => t.status === "cancelled").length;
  const running = current !== null || queuedCount > 0;
  const total = settled.length + queuedCount + (current ? 1 : 0);
  const percent =
    running && total > 0
      ? Math.min(100, Math.round(((settled.length + (current ? current.percent / 100 : 0)) / total) * 100))
      : 100;
  return {
    status: running ? "running" : failed.length > 0 ? "error" : "success",
    index: settled.length,
    total,
    title: current?.title ?? "",
    detail: current?.detail ?? (queuedCount > 0 ? "排队中…" : ""),
    percent,
    doneCount,
    failedCount: failed.length,
    skippedCount: 0,
    failedNames: failed.map((t) => t.title),
    summary: running
      ? undefined
      : cancelledCount > 0
        ? `已取消：完成 ${doneCount} · 失败 ${failed.length}，剩余 ${cancelledCount} ${unit}未处理${opts?.resumable ? "（已翻部分已落盘，可续翻）" : ""}`
        : `完成 ${doneCount} ${unit}${failed.length > 0 ? ` · 失败 ${failed.length}` : ""}`,
    cancelling,
  };
}

/** 通道卡本体（原 papers 页 BatchProgressCard markup 不变；标题由调用方给） */
export function ChannelProgressCard({
  card,
  title,
  onCancel,
  onDismiss,
}: {
  card: ChannelCardState;
  title: string;
  onCancel: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="w-80 rounded-xl border bg-background p-3.5 shadow-lg">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="min-w-0 flex-1 truncate font-medium text-sm">{title}</span>
        <span className="shrink-0 text-muted-foreground text-xs">
          {Math.min(card.index + 1, card.total)}/{card.total}
        </span>
        <button
          type="button"
          className="shrink-0 rounded p-0.5 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
          onClick={(e) => {
            // 卡本体已接 TaskRunPanel 触发器：阻止冒泡，dismiss 不触发面板开合
            e.stopPropagation();
            onDismiss();
          }}
        >
          <X className="size-3.5" />
        </button>
      </div>

      {card.status === "running" ? (
        <>
          <Progress value={card.percent} className="h-1.5" />
          <div className="mt-2 flex items-center justify-between gap-2 text-muted-foreground text-xs">
            <span className="min-w-0 flex-1 truncate">
              {card.title ? `《${card.title}》 ` : ""}
              {card.detail}
            </span>
            <span className="shrink-0">{card.percent}%</span>
          </div>
          <div className="mt-2.5 flex items-center justify-between gap-2">
            <span className="text-muted-foreground text-xs">
              完成 {card.doneCount}
              {card.failedCount > 0 ? ` · 失败 ${card.failedCount}` : ""}
              {card.skippedCount > 0 ? ` · 跳过 ${card.skippedCount}` : ""}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2.5 text-xs"
              onClick={(e) => {
                // 同上：取消整批不触发面板开合
                e.stopPropagation();
                onCancel();
              }}
              disabled={card.cancelling === true}
            >
              {card.cancelling ? "正在取消…" : "取消"}
            </Button>
          </div>
        </>
      ) : (
        <>
          <p
            className={clsx(
              "text-xs",
              card.status === "success" ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400",
            )}
          >
            {card.summary}
          </p>
          {card.failedNames.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-red-600 text-xs dark:text-red-400">
              {card.failedNames.map((name) => (
                <li key={name} className="truncate" title={name}>
                  {name}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
