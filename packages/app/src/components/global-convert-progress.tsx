/**
 * 全局转换进度层（右下角浮层，挂在 ReaderLayout——独立于任何路由页面）。
 *
 * 卡纵向堆叠（互不重叠）：
 * - 论文解析进度卡（PDF/XML 全文）：P2-4 起数据源是 task-center 的 paper-parse 通道聚合（跨页面持续呈现）；
 * - 图书 PDF→EPUB 转换小卡：转换大窗口被最小化时出现，点击卡片还原详情窗口；
 * - 向量化/翻译通道卡：papers 页经 BottomRightPortal 入同一栈（统一队列后不再区分
 *   单篇/批量卡片——2026-08-26 用户拍板，原「阅读页单篇翻译小卡」与通道卡重复，已退役）。
 *
 * 豁免视图（不渲染任何卡，避免遮挡正文）：全局助手聊天页（/chat）、
 * 书籍阅读器 tab、论文阅读器 tab——即任何阅读器 tab 激活期间。
 * 豁免只影响可见性：进度状态与事件接收在 store，退出豁免视图即恢复呈现。
 * 解析卡点击经 TaskRunPanel 弹出子任务面板（P2-5）。
 */

import { TaskRunPanel } from "@/components/task-run-panel";
import { MotionStackCard } from "@/components/ui/bottom-right-stack";
import { Progress } from "@/components/ui/progress";
import { paperParseCardOf } from "@/services/task-executors/paper-parse";
import {
  type BookConvertState,
  type PaperImportState,
  dismissPaperImport,
  recoverPaperImportAfterReload,
  useConvertProgressStore,
} from "@/store/convert-progress-store";
import { type ChannelAggregate, selectChannelAggregate, useTaskCenterStore } from "@/store/task-center-store";
import clsx from "clsx";
import { BookText, Check, FileText, X } from "lucide-react";
import { useEffect, useMemo } from "react";
import { useNavigate } from "react-router";

/** 论文解析进度卡（markup 自 PapersPage 迁入；成功 6s 自动消失逻辑一并迁移）。
 *  P2-4 起数据源为 task-center 的 paper-parse 通道聚合（paperParseCardOf 折算），markup 不动。 */
function PaperImportCard({ paperImport }: { paperImport: PaperImportState }) {
  // 成功态 6 秒后自动消失（批量有失败、失败/取消态保留待手动关闭）
  useEffect(() => {
    if (paperImport.status !== "success") return;
    if (paperImport.failedCount > 0) return;
    const timer = setTimeout(() => {
      // 定时器到期时通道可能已被接续的下一篇换成 running——dismiss 对 running 等于取消，
      // 必须只在仍是 success 时执行（队列化后接续间隔可能超过 6s，2026-08-20 实测误杀下一篇）
      const current = paperParseCardOf(selectChannelAggregate(useTaskCenterStore.getState(), "paper-parse"));
      if (current?.status === "success") dismissPaperImport();
    }, 6000);
    return () => clearTimeout(timer);
  }, [paperImport.status, paperImport.failedCount]);

  return (
    <div className="pointer-events-auto w-80 rounded-xl border bg-background p-3.5 shadow-lg">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="min-w-0 flex-1 truncate font-medium text-sm">{paperImport.fileName}</span>
        {(paperImport.total > 1 || paperImport.queuedCount > 0) && (
          <span className="shrink-0 text-muted-foreground text-xs">
            第 {paperImport.index}/{paperImport.total} 篇
            {paperImport.queuedCount > 0 && `（待 ${paperImport.queuedCount} 篇）`}
          </span>
        )}
        <button
          type="button"
          className="shrink-0 rounded p-0.5 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
          onClick={(e) => {
            // 卡本体已接 TaskRunPanel 触发器：阻止冒泡，dismiss 不触发面板开合
            e.stopPropagation();
            dismissPaperImport();
          }}
        >
          <X className="size-3.5" />
        </button>
      </div>

      {/* 阶段行（紧凑：4 个状态点 + 当前阶段名） */}
      <div className="mb-2.5 flex items-center gap-1.5">
        {paperImport.stages.map((stage) => (
          <span
            key={stage.n}
            className={clsx(
              "flex size-4 items-center justify-center rounded-full text-[9px]",
              stage.status === "done" && "bg-primary text-primary-foreground",
              stage.status === "active" && "border border-primary text-primary",
              stage.status === "pending" && "border text-muted-foreground",
              stage.status === "error" && "bg-destructive text-destructive-foreground",
            )}
          >
            {stage.status === "done" ? <Check className="size-2.5" /> : stage.n}
          </span>
        ))}
        <span className="ml-1 truncate text-muted-foreground text-xs">
          {paperImport.stages.find((s) => s.status === "active")?.name ??
            (paperImport.status === "success" ? "完成" : paperImport.status === "error" ? "失败" : "准备中")}
        </span>
      </div>

      {paperImport.status === "running" && (
        <>
          <Progress value={paperImport.percent} className="h-1.5" />
          <div className="mt-1.5 flex items-center justify-between gap-2 text-muted-foreground text-xs">
            <span className="min-w-0 flex-1 truncate">{paperImport.detail}</span>
            <span className="shrink-0">{paperImport.percent}%</span>
          </div>
        </>
      )}
      {paperImport.status === "success" && (
        <p className="truncate text-green-600 text-xs dark:text-green-400">{paperImport.detail}</p>
      )}
      {paperImport.status === "error" && <p className="text-red-600 text-xs dark:text-red-400">{paperImport.error}</p>}
      {paperImport.failedNames.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-red-600 text-xs dark:text-red-400">
          {paperImport.failedNames.map((name) => (
            <li key={name} className="truncate" title={name}>
              {name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 图书转换小卡（大窗口最小化/未开时呈现；点击卡片直接还原详情窗口——不需要中间面板层，
 *  2026-08-26 用户拍板：图书转换只有卡片态/详情窗口态两种；X 丢弃状态）。
 *  P2-1 起可见性与进度读 task-center 的 book-convert 通道聚合（agg 由父组件传入，
 *  离场动画期定格快照）；阶段行/错误文案仍读 convert-progress-store.bookConvert
 *  （执行器回写的大窗口详情数据源） */
function BookConvertMiniCard({ agg, bookConvert }: { agg: ChannelAggregate; bookConvert: BookConvertState }) {
  const navigate = useNavigate();
  const displayTask = agg.current ?? agg.settled.at(-1) ?? null;
  const mode: "converting" | "done" | "error" = agg.current
    ? "converting"
    : displayTask?.status === "success"
      ? "done"
      : displayTask
        ? "error"
        : "converting";
  const fileName = displayTask?.title ?? bookConvert.pdfPath?.split(/[\\/]/).pop() ?? "";
  const active = bookConvert.stages.find((s) => s.status === "active");

  const restore = () => {
    // 大窗口挂在图书馆页弹层：不在图书馆页时先回图书馆再开窗
    useConvertProgressStore.getState().openBookConvertDialog();
    navigate("/");
  };

  const dismiss = () => {
    void (async () => {
      // 有在跑/排队任务 → 先撤（cancelTask → 执行器杀进程树；内部 toast）；
      // await 保证 cancelled 落账后再清已结算，小卡不因迟到的 cancelled 残影复活
      await useConvertProgressStore.getState().cancelBookConvert();
      useTaskCenterStore.getState().dismissSettled("book-convert");
      useConvertProgressStore.getState().resetBookConvert();
    })();
  };

  return (
    <div
      className="pointer-events-auto w-80 cursor-pointer rounded-xl border bg-background p-3.5 shadow-lg transition-colors hover:border-primary/40"
      role="button"
      tabIndex={0}
      title="点击查看转换详情"
      onClick={restore}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          restore();
        }
      }}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate font-medium text-sm">
          <BookText className="size-3.5 shrink-0 text-primary" />
          <span className="truncate">PDF 转 EPUB · {fileName}</span>
        </span>
        <button
          type="button"
          className="shrink-0 rounded p-0.5 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
          onClick={(e) => {
            e.stopPropagation();
            dismiss();
          }}
        >
          <X className="size-3.5" />
        </button>
      </div>

      {/* 阶段行（与论文卡同款紧凑样式） */}
      <div className="mb-2.5 flex items-center gap-1.5">
        {bookConvert.stages.map((stage) => (
          <span
            key={stage.n}
            className={clsx(
              "flex size-4 items-center justify-center rounded-full text-[9px]",
              stage.status === "done" && "bg-primary text-primary-foreground",
              stage.status === "active" && "border border-primary text-primary",
              stage.status === "pending" && "border text-muted-foreground",
              stage.status === "error" && "bg-destructive text-destructive-foreground",
            )}
          >
            {stage.status === "done" ? <Check className="size-2.5" /> : stage.n}
          </span>
        ))}
        <span className="ml-1 truncate text-muted-foreground text-xs">
          {active?.name ?? (mode === "done" ? "完成" : mode === "error" ? "失败" : "准备中")}
        </span>
      </div>

      {mode === "converting" && (
        <>
          <Progress value={agg.current?.percent ?? 0} className="h-1.5" />
          <div className="mt-1.5 flex items-center justify-between gap-2 text-muted-foreground text-xs">
            <span className="min-w-0 flex-1 truncate">{agg.current?.detail ?? "排队中…"}</span>
            <span className="shrink-0">{agg.current?.percent ?? 0}%</span>
          </div>
        </>
      )}
      {mode === "done" && (
        <p className="flex items-center gap-1.5 truncate text-green-600 text-xs dark:text-green-400">
          <FileText className="size-3 shrink-0" />
          转换完成，点击查看并导入图书馆
        </p>
      )}
      {mode === "error" && (
        <p className="truncate text-red-600 text-xs dark:text-red-400">
          {displayTask?.error ?? bookConvert.errorMessage}
        </p>
      )}
    </div>
  );
}

export default function GlobalConvertProgress() {
  const bookConvert = useConvertProgressStore((s) => s.bookConvert);
  const bookConvertMinimized = useConvertProgressStore((s) => s.bookConvertMinimized);
  // 解析卡/小卡可见性与进度读 task-center 通道聚合：有在跑/排队/未清除的已结算任务即呈现；
  // cancelled 结算不驱动显示（对齐旧口径：取消即回 idle 无卡）。
  // 注意：selectChannelAggregate 每次返回新对象，不能直接作 zustand 选择器（getSnapshot 须缓存，
  // 否则无限重渲染）——此处订阅稳定的 tasks/order 引用再 useMemo 聚合。
  const taskCenterTasks = useTaskCenterStore((s) => s.tasks);
  const taskCenterOrder = useTaskCenterStore((s) => s.order);
  const paperParseAgg = useMemo(
    () => selectChannelAggregate({ tasks: taskCenterTasks, order: taskCenterOrder }, "paper-parse"),
    [taskCenterTasks, taskCenterOrder],
  );
  // 解析卡视图模型：通道聚合折算回 PaperImportState 形状（paper-parse.ts；卡片 markup 不动）
  const paperImport = useMemo(() => paperParseCardOf(paperParseAgg), [paperParseAgg]);
  const bookConvertAgg = useMemo(
    () =>
      selectChannelAggregate(
        { tasks: taskCenterTasks, order: taskCenterOrder } as Parameters<typeof selectChannelAggregate>[0],
        "book-convert",
      ),
    [taskCenterTasks, taskCenterOrder],
  );
  const bookConvertVisibleSettled = bookConvertAgg.settled.filter((t) => t.status !== "cancelled");
  const hasBookConvertCard =
    bookConvertAgg.current !== null || bookConvertAgg.queuedCount > 0 || bookConvertVisibleSettled.length > 0;

  // 刷新恢复（挂载即探测）：Rust 侧解析进程/未消费产物跨刷新存活，恢复进度卡与落库监听
  useEffect(() => {
    void recoverPaperImportAfterReload();
  }, []);

  // 禁区由 BottomRightStackHost 统一管理（display:none），此处不再判豁免
  // 三张卡均经 MotionStackCard 出入场：数据消失 → closing 播离场动画（渲染最后快照）→ 卸载
  return (
    <>
      <MotionStackCard show={!!paperImport}>
        {paperImport && (
          <TaskRunPanel channel="paper-parse">
            <PaperImportCard paperImport={paperImport} />
          </TaskRunPanel>
        )}
      </MotionStackCard>
      <MotionStackCard show={bookConvertMinimized && hasBookConvertCard}>
        {hasBookConvertCard && (
          <BookConvertMiniCard
            agg={{ ...bookConvertAgg, settled: bookConvertVisibleSettled }}
            bookConvert={bookConvert}
          />
        )}
      </MotionStackCard>
    </>
  );
}
