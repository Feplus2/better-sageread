/**
 * 图书向量化通道执行器（P2-2，docs/task-queue-p2-plan.md）。
 *
 * 吸收图书馆 book-item 直跑 indexEpub 的全链路（processing/success/failed 三态
 * book_status.metadata.vectorization 回写、epub://index-progress 进度事件、
 * 单本直发的 toast + 通知中心 + 图书馆列表收尾刷新），三入口
 * （book-item 按钮 / 设置页全量重建 / AI vectorizeBook 图书分支）统一入队——
 * 同书在队/在跑由 task-center 幂等拒入，根除删库重建竞态（白烧 embedding 费用）。
 *
 * 不动：每书一库删库重建语义（Rust 侧）；维度变化自愈；进度环视觉（book-item 读任务态）。
 * 取消语义：indexEpub 单次 invoke 不可中断，cancelChannel 撤排队项、在跑本本届跑完即停
 * （对齐设置页旧串行循环的"当前条目完成后停止"）。
 *
 * 模块加载即自注册 book-vectorize 通道（并发 1）。
 */

import { indexEpub, updateBookVectorizationMeta } from "@/services/book-service";
import { useLibraryStore } from "@/store/library-store";
import { useNotificationStore } from "@/store/notification-store";
import {
  type EnqueueResult,
  type TaskContext,
  type TaskItem,
  registerTaskChannel,
  selectChannelAggregate,
  useTaskCenterStore,
} from "@/store/task-center-store";
import { getCurrentVectorModelConfig } from "@/utils/model";
import { ensureTaskConflictChecker } from "@/utils/task-conflict";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";

/** book-vectorize 通道 payload：solo = book-item 单本直发（完成/失败给独立 toast + 通知 + 列表刷新） */
export interface BookVectorizePayload {
  solo?: boolean;
}

/** 结算产物：enqueueAndWait（AI 工具）在 TaskItem.result 上取回 */
export interface BookVectorizeResult {
  chunkCount: number;
}

async function executeBookVectorize(task: TaskItem, ctx: TaskContext): Promise<void> {
  const payload = (task.payload ?? {}) as BookVectorizePayload;
  const solo = payload.solo === true;
  ctx.report(0, "向量化中…");

  // 进度事件带 book_id 归属（复用既有通道，迟到/串台事件丢弃）——单本不可中断，无需接 ctx.signal
  const unlisten = await listen<{ book_id: string; percent: number }>("epub://index-progress", (e) => {
    const p = e.payload;
    if (!p || p.book_id !== task.targetId) return;
    ctx.report(Math.max(0, Math.min(100, Math.round(p.percent))), "向量化中…");
  });

  try {
    const vectorConfig = await getCurrentVectorModelConfig();
    await updateBookVectorizationMeta(task.targetId, {
      status: "processing",
      model: vectorConfig.model,
      dimension: vectorConfig.dimension,
      version: 1,
      startedAt: Date.now(),
    });

    const res = await indexEpub(task.targetId, {
      dimension: vectorConfig.dimension,
      embeddingsUrl: vectorConfig.embeddingsUrl,
      model: vectorConfig.model,
      apiKey: vectorConfig.apiKey,
    });

    if (res?.success && res.report) {
      await updateBookVectorizationMeta(task.targetId, {
        status: "success",
        chunkCount: res.report.total_chunks,
        dimension: res.report.vector_dimension,
        finishedAt: Date.now(),
      });
      ctx.setResult({ chunkCount: res.report.total_chunks } satisfies BookVectorizeResult);
      ctx.report(100, "向量化完成");
      if (solo) {
        const message = `《${task.title}》向量化完成，分块数：${res.report?.total_chunks ?? "未知"}`;
        toast.success(message);
        useNotificationStore.getState().addNotification(message);
      }
      return;
    }
    throw new Error(res?.message || "向量化失败");
  } catch (error) {
    // 失败态回写一次即可（旧路径 else/catch 双写内容相同，幂等合并为一处）
    await updateBookVectorizationMeta(task.targetId, { status: "failed", finishedAt: Date.now() }).catch(() => {});
    console.error(`向量化图书失败: ${task.targetId}`, error);
    if (solo) {
      toast.error("向量化失败，请检查嵌入服务是否可用");
      useNotificationStore.getState().addNotification(`《${task.title}》向量化失败`);
    }
    throw error;
  } finally {
    unlisten();
    // 单本直发收尾刷新图书馆列表（metadata 圆环转色；批量/AI 路径保持旧口径不逐本刷新）
    if (solo)
      useLibraryStore
        .getState()
        .refreshBooks()
        .catch(() => {});
  }
}

// ─── 入口薄壳（UI 与 AI 同一入口；模块加载即完成通道注册） ───

registerTaskChannel("book-vectorize", { executor: executeBookVectorize, concurrency: 1 });
ensureTaskConflictChecker();

/** 通道空闲时清掉已结算任务（卡片/聚合口径从 0 计起，对齐"下次入队前的视觉复位"注释口径） */
function dismissBookVectorizeIfIdle(): void {
  const st = useTaskCenterStore.getState();
  const agg = selectChannelAggregate(st, "book-vectorize");
  if (!agg.current && agg.queuedCount === 0) st.dismissSettled("book-vectorize");
}

/** 单本入队（book-item 按钮：solo toast/通知/收尾刷新）。拒入队不 toast，由调用方按 detail 提示 */
export function enqueueBookVectorize(input: { id: string; title: string; solo?: boolean }): EnqueueResult {
  dismissBookVectorizeIfIdle();
  return useTaskCenterStore.getState().enqueue({
    channel: "book-vectorize",
    targetId: input.id,
    title: input.title,
    payload: { solo: input.solo } satisfies BookVectorizePayload,
  });
}

/** AI vectorizeBook 图书分支：阻塞等结算（保持"全部完成后汇总返回"语义），成功 resolve / 失败、拒入队 reject */
export function enqueueBookVectorizeAndWait(input: { id: string; title: string }): Promise<TaskItem> {
  dismissBookVectorizeIfIdle();
  return useTaskCenterStore.getState().enqueueAndWait({
    channel: "book-vectorize",
    targetId: input.id,
    title: input.title,
    payload: {} satisfies BookVectorizePayload,
  });
}
