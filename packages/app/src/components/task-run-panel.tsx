/**
 * 通用子任务面板（P2-5，docs/task-queue-p2-plan.md）：通道聚合卡点击弹出，
 * 列出该通道当前 run/近期任务的子任务清单（题名 + 状态图标 + 实时 percent/detail + 单项取消）。
 *
 * 形态对齐项目 radix 浮层惯例（进出场动画沿用 ui/popover 的 animate 类），但直用
 * PopoverPrimitive：ui/popover 的 Portal 不暴露 container，这里必须显式挂进
 * #bottom-right-stack——面板随栈在阅读/聊天页禁区一起 display:none（BottomRightStackHost
 * 口径），且栈内 fixed 定位不参与 flex 布局、不扰乱卡片堆叠。卡片卸载（dismiss/自动消失）
 * 时 Popover 随组件树卸载，不留残影。
 *
 * 数据订阅 task-center（列表只在面板开着时由 radix 挂载订阅）；镜像任务（mirror:true，
 * Zotero 批量导入解析段）不进面板。图书转换通道经 detailAction 挂「打开详情窗口」入口
 * （该通道专属详情，通用清单之外的可选增强）。
 */

import { Progress } from "@/components/ui/progress";
import { type TaskChannel, type TaskItem, type TaskStatus, useTaskCenterStore } from "@/store/task-center-store";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import clsx from "clsx";
import { Ban, CheckCircle, Clock, Loader2, X, XCircle } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

/** 面板标题（与聚合卡标题口径对齐：papers 页卡用「批量向量化/批量翻译」） */
const CHANNEL_LABELS: Record<TaskChannel, string> = {
  "paper-parse": "论文解析",
  "paper-vectorize": "批量向量化",
  "paper-translate": "批量翻译",
  "book-convert": "图书转换",
  "book-vectorize": "图书向量化",
};

function TaskStatusIcon({ status }: { status: TaskStatus }) {
  switch (status) {
    case "running":
      return <Loader2 className="size-3.5 animate-spin text-primary" />;
    case "queued":
      return <Clock className="size-3.5 text-muted-foreground" />;
    case "success":
      return <CheckCircle className="size-3.5 text-green-600 dark:text-green-400" />;
    case "error":
      return <XCircle className="size-3.5 text-red-600 dark:text-red-400" />;
    case "cancelled":
      return <Ban className="size-3.5 text-muted-foreground" />;
  }
}

/** 单行子任务：题名 + 状态图标 + 实时 percent/detail；排队/运行中带单项取消按钮 */
function TaskRunRow({ task }: { task: TaskItem }) {
  const cancellable = task.status === "queued" || task.status === "running";
  return (
    <li className="flex items-start gap-2 py-1.5">
      <span className="mt-0.5 shrink-0">
        <TaskStatusIcon status={task.status} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="min-w-0 flex-1 truncate text-xs" title={task.title}>
            {task.title}
          </span>
          {task.status === "running" && <span className="shrink-0 text-muted-foreground text-xs">{task.percent}%</span>}
        </div>
        {task.status === "running" && (
          <>
            <Progress value={task.percent} className="mt-1 h-1" />
            <p className="mt-0.5 truncate text-muted-foreground text-xs" title={task.detail}>
              {task.detail || "处理中…"}
            </p>
          </>
        )}
        {task.status === "queued" && <p className="text-muted-foreground text-xs">排队中</p>}
        {task.status === "success" && <p className="text-green-600 text-xs dark:text-green-400">已完成</p>}
        {task.status === "cancelled" && <p className="text-muted-foreground text-xs">已取消</p>}
        {task.status === "error" && (
          <p className="truncate text-red-600 text-xs dark:text-red-400" title={task.error}>
            {task.error || "失败"}
          </p>
        )}
      </div>
      {cancellable && (
        <button
          type="button"
          title="取消该任务"
          className="shrink-0 rounded p-0.5 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
          onClick={(e) => {
            e.stopPropagation();
            useTaskCenterStore.getState().cancelTask(task.taskId);
          }}
        >
          <X className="size-3" />
        </button>
      )}
    </li>
  );
}

interface TaskRunPanelDetailAction {
  label: string;
  onClick: () => void;
}

/** 面板内容（仅 open 时挂载，订阅 task-center 实时刷新） */
function TaskRunList({
  channel,
  detailAction,
  onClose,
}: {
  channel: TaskChannel;
  detailAction?: TaskRunPanelDetailAction;
  onClose: () => void;
}) {
  const tasks = useTaskCenterStore((s) => s.tasks);
  const order = useTaskCenterStore((s) => s.order);
  // 清单 = 该通道全部非镜像任务：在跑/排队按入队序置顶，已结算倒序贴底（最新完成的靠上）
  const rows = useMemo(() => {
    const items: TaskItem[] = [];
    for (const id of order) {
      const task = tasks[id];
      if (task && task.channel === channel && !task.mirror) items.push(task);
    }
    const active = items.filter((t) => t.status === "running" || t.status === "queued");
    const settled = items.filter((t) => t.status !== "running" && t.status !== "queued");
    return [...active, ...settled.reverse()];
  }, [tasks, order, channel]);

  const summaryParts: string[] = [];
  const runningCount = rows.filter((t) => t.status === "running").length;
  const queuedCount = rows.filter((t) => t.status === "queued").length;
  const settledCount = rows.length - runningCount - queuedCount;
  if (runningCount > 0) summaryParts.push(`进行中 ${runningCount}`);
  if (queuedCount > 0) summaryParts.push(`排队 ${queuedCount}`);
  if (settledCount > 0) summaryParts.push(`已结算 ${settledCount}`);

  return (
    <>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="font-medium text-sm">{CHANNEL_LABELS[channel]}</span>
        <span className="shrink-0 text-muted-foreground text-xs">{summaryParts.join(" · ")}</span>
      </div>
      {rows.length === 0 ? (
        <p className="py-2 text-center text-muted-foreground text-xs">暂无任务</p>
      ) : (
        <ul className="max-h-64 divide-y divide-border overflow-y-auto">
          {rows.map((task) => (
            <TaskRunRow key={task.taskId} task={task} />
          ))}
        </ul>
      )}
      {detailAction && (
        <button
          type="button"
          className="mt-2.5 w-full rounded-md border px-2.5 py-1.5 text-left text-xs hover:bg-muted"
          onClick={() => {
            onClose();
            detailAction.onClick();
          }}
        >
          {detailAction.label}
        </button>
      )}
    </>
  );
}

/**
 * 聚合卡点开子任务面板：children 为聚合卡本体（视觉/布局原样，外包一层触发器接管点击
 * ——卡内按钮须自行 stopPropagation，避免冒泡触发面板开合）。
 */
export function TaskRunPanel({
  channel,
  children,
  detailAction,
}: {
  channel: TaskChannel;
  children: ReactNode;
  detailAction?: TaskRunPanelDetailAction;
}) {
  const [open, setOpen] = useState(false);
  // 面板挂进右下角栈容器（随栈禁区隐藏；容器由 BottomRightStackHost 常驻渲染，
  // 卡片经 BottomRightPortal 入栈，能见到卡片即容器已在）
  const stackEl = typeof document === "undefined" ? null : document.getElementById("bottom-right-stack");
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <div
          role="button"
          tabIndex={0}
          title="点击查看任务清单"
          className="cursor-pointer outline-none"
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.currentTarget.click();
            }
          }}
        >
          {children}
        </div>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal container={stackEl}>
        <PopoverPrimitive.Content
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={8}
          className={clsx(
            "pointer-events-auto z-50 w-80 rounded-xl border bg-background p-3 text-popover-foreground shadow-lg outline-hidden",
            "data-[state=closed]:animate-out data-[state=open]:animate-in",
            "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0",
            "data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95",
            "data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2",
            "data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
            "origin-(--radix-popover-content-transform-origin)",
          )}
        >
          <TaskRunList channel={channel} detailAction={detailAction} onClose={() => setOpen(false)} />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
