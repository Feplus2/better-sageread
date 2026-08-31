/**
 * 论文向量化通道执行器（P2-3，docs/task-queue-p2-plan.md）。
 *
 * 迁移自 paper-task-store 的 vectorizeQueue/drainVectorize 与 trackSoloVectorize（迁移而非重写）：
 * - 注册表打点（paper-task-registry 的 vectorize 槽，解析×向量化互斥的事实源不变）；
 * - vectorizePercent 圆环喂养与 paper://index-progress 进度事件（按 paper_id 归属过滤）；
 * - solo 独立 toast、批量收尾汇总 toast（`批量向量化完成 N 篇`）、onSettled 列表刷新联动；
 * - 先删后插幂等由 vectorizePaper/index_paper 内部保持，不在此重复。
 *
 * solo 卡的 `total===1 && title===标题` 双重比对所有权守卫退役——统一队列按 taskId 发卡天然无串台。
 * 取消语义：index_paper 单次 invoke 不可中断，cancelChannel 撤排队项、在跑本篇跑完即停
 * （对齐旧 drainVectorize 的 cancelVectorize 检查点语义）。
 *
 * 模块加载即自注册 paper-vectorize 通道（并发 1）并注入冲突检查器。
 */

import { vectorizePaper } from "@/services/paper-service";
import { usePaperTaskRegistry } from "@/store/paper-task-registry";
import { usePaperTaskStore } from "@/store/paper-task-store";
import {
  type EnqueueResult,
  type TaskContext,
  type TaskItem,
  registerTaskChannel,
  selectChannelAggregate,
  useTaskCenterStore,
} from "@/store/task-center-store";
import { ensureTaskConflictChecker } from "@/utils/task-conflict";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";

/** paper-vectorize 通道 payload：author 供 index_paper 元数据；solo = 单篇直发（完成/失败独立 toast） */
export interface PaperVectorizePayload {
  author?: string;
  solo?: boolean;
}

/** 结算产物：enqueueAndWait（AI 工具）在 TaskItem.result 上取回 */
export interface PaperVectorizeResult {
  chunkCount: number;
}

async function executePaperVectorize(task: TaskItem, ctx: TaskContext): Promise<void> {
  const payload = (task.payload ?? {}) as PaperVectorizePayload;
  const mark = usePaperTaskRegistry.getState().mark;
  mark(task.targetId, "vectorize", true);
  usePaperTaskStore.setState((s) => ({ vectorizePercent: { ...s.vectorizePercent, [task.targetId]: 0 } }));
  ctx.report(0, "向量化中…");

  // 进度事件按 paper_id 归属过滤：实时喂圆环（兼喂任务 percent——store 模块级与视图无关，
  // 页面不在场也照喂，对齐旧 trackSoloVectorize 修复口径）
  const unlisten = await listen<{ paper_id: string; percent: number }>("paper://index-progress", (e) => {
    const p = e.payload;
    if (!p || p.paper_id !== task.targetId) return;
    const pct = Math.max(0, Math.min(100, Math.round(p.percent)));
    usePaperTaskStore.setState((s) => ({ vectorizePercent: { ...s.vectorizePercent, [task.targetId]: pct } }));
    ctx.report(pct, "向量化中…");
  });

  try {
    const res = await vectorizePaper({ id: task.targetId, title: task.title, author: payload.author ?? "" });
    const chunkCount = res.report?.total_chunks ?? 0;
    ctx.setResult({ chunkCount } satisfies PaperVectorizeResult);
    ctx.report(100, "向量化完成");
    if (payload.solo) {
      toast.success(`《${task.title}》向量化完成，分块数：${res.report?.total_chunks ?? "未知"}`);
    }
  } catch (error) {
    console.error(`向量化论文失败: ${task.targetId}`, error);
    if (payload.solo) {
      toast.error(`《${task.title}》向量化失败：${error instanceof Error ? error.message : String(error)}`);
    }
    throw error;
  } finally {
    unlisten();
    mark(task.targetId, "vectorize", false);
    // 按 id 摘除圆环（迟到事件由页面监听兜底重写，无害）
    usePaperTaskStore.setState((s) => {
      const next = { ...s.vectorizePercent };
      delete next[task.targetId];
      return { vectorizePercent: next };
    });
  }
}

// ─── 通道收尾感知（旧 drainVectorize 收尾段的等价物） ───
// 活跃→空闲沿：批量汇总 toast（取消不收尾 toast，对齐旧 `if (!cancelled && total > 1)`）+
// onSettled 列表刷新联动（PapersPage 注册；含 solo/reader 之外的全部通道任务）。
let vectorizeWasActive = false;
useTaskCenterStore.subscribe((s) => {
  const agg = selectChannelAggregate(s, "paper-vectorize");
  const active = agg.current !== null || agg.queuedCount > 0;
  if (vectorizeWasActive && !active) {
    const settled = agg.settled;
    const done = settled.filter((t) => t.status === "success").length;
    const failed = settled.filter((t) => t.status === "error").length;
    const cancelled = settled.some((t) => t.status === "cancelled");
    if (!cancelled && settled.length > 1) {
      toast.success(`批量向量化完成 ${done} 篇${failed > 0 ? `，失败 ${failed} 篇` : ""}`);
    }
    usePaperTaskStore.getState().onSettled?.();
  }
  vectorizeWasActive = active;
});

// ─── 入口薄壳（UI 与 AI 同一入口；模块加载即完成通道注册 + 冲突检查器注入） ───

registerTaskChannel("paper-vectorize", { executor: executePaperVectorize, concurrency: 1 });
ensureTaskConflictChecker();

/** 通道空闲时清掉已结算任务（新批次卡片从 0 计起，对齐旧 drain 重置进度卡语义） */
function dismissPaperVectorizeIfIdle(): void {
  const st = useTaskCenterStore.getState();
  const agg = selectChannelAggregate(st, "paper-vectorize");
  if (!agg.current && agg.queuedCount === 0) st.dismissSettled("paper-vectorize");
}

const toInput = (item: { id: string; title: string; author?: string; solo?: boolean }) => ({
  channel: "paper-vectorize" as const,
  targetId: item.id,
  title: item.title,
  payload: { author: item.author, solo: item.solo } satisfies PaperVectorizePayload,
});

/** 单篇入队（右键/卡片按钮）。拒入队不 toast，由调用方按 detail 提示 */
export function enqueuePaperVectorize(item: {
  id: string;
  title: string;
  author?: string;
  solo?: boolean;
}): EnqueueResult {
  dismissPaperVectorizeIfIdle();
  return useTaskCenterStore.getState().enqueue(toInput(item));
}

/** 批量入队：复刻旧 paper-task-store.enqueue 口径——逐篇幂等去重 + 冲突拒绝，聚合提示单条 toast */
export function enqueuePaperVectorizeBatch(items: { id: string; title: string; author?: string; solo?: boolean }[]): {
  ok: boolean;
  rejectedCount: number;
} {
  dismissPaperVectorizeIfIdle();
  const st = useTaskCenterStore.getState();
  let accepted = 0;
  let rejectedCount = 0;
  const rejectedSamples: string[] = [];
  for (const item of items) {
    const res = st.enqueue(toInput(item));
    if (res.ok) {
      accepted += 1;
      continue;
    }
    rejectedCount += 1;
    if (rejectedSamples.length < 3) {
      rejectedSamples.push(
        res.reason === "duplicate" ? (res.detail ?? `《${item.title}》已在该队列中`) : `《${item.title}》${res.detail}`,
      );
    }
  }
  if (rejectedCount > 0) {
    toast.info(
      `跳过 ${rejectedCount} 篇：${rejectedSamples.join("；")}${rejectedCount > rejectedSamples.length ? " 等" : ""}`,
      { duration: 6000 },
    );
  }
  return { ok: accepted > 0, rejectedCount };
}

/** AI vectorizeBook 论文分支：阻塞等结算（保持工具返回语义），成功 resolve / 失败、取消、拒入队 reject */
export function enqueuePaperVectorizeAndWait(item: { id: string; title: string; author?: string }): Promise<TaskItem> {
  dismissPaperVectorizeIfIdle();
  return useTaskCenterStore.getState().enqueueAndWait(toInput(item));
}
