/**
 * 图书翻译通道执行器（docs/plans/book-translation-plan.md 一期）。
 *
 * 链路：translateBook（全书一键、批级落盘、断点续翻）→ 句级对齐一条龙
 * （alignBookTranslation，幂等补齐；无嵌入能力服务内跳过）→ book_status.metadata.translation
 * 状态回写（vectorization 同款模式）。收尾广播 book-translation-updated，阅读器监听后
 * 重渲染当前章以显示译文（transformer 在章节加载时注入）。
 *
 * 取消语义与论文侧对齐：signal 中止时已翻部分均已落盘，回写 partial 后按取消结算；
 * 守卫失败（中文书/fixed-layout/非 EPUB）按任务失败透传文案。
 *
 * 模块加载即自注册 book-translate 通道（并发 1）。
 */

import { updateBookTranslationMeta } from "@/services/book-service";
import { type BookAlignResult, alignBookTranslation } from "@/services/book-translation/book-alignment";
import {
  type BookTranslateResult,
  listBookTranslationSectionIndexes,
  translateBook,
} from "@/services/book-translation/book-translation-service";
import { useLibraryStore } from "@/store/library-store";
import {
  type EnqueueResult,
  type TaskContext,
  type TaskItem,
  registerTaskChannel,
  selectChannelAggregate,
  useTaskCenterStore,
} from "@/store/task-center-store";
import { ensureTaskConflictChecker } from "@/utils/task-conflict";
import { toast } from "sonner";

/** book-translate 通道 payload：force=全量重翻（覆盖既有译文）；
 *  alignOnly=跳过翻译只跑对齐（翻译菜单对齐入口）；alignPhase=对齐相位（08-29 裁定拆开：
 *  sentence=句级【force 时重算句级并作废词级】；words=句级补齐+词级【force 只作用于词级】）；
 *  solo=图书馆右键单本直发（结算后刷新图书馆列表，translation meta 即时反映到书卡右键菜单） */
export interface BookTranslatePayload {
  force?: boolean;
  alignOnly?: boolean;
  alignPhase?: "sentence" | "words";
  solo?: boolean;
}

/** 结算产物（TaskItem.result） */
export interface BookTranslateTaskResult {
  translation?: BookTranslateResult;
  alignment?: BookAlignResult;
  /** 翻译后对齐抛错（非取消）时的错误文案（对齐失败不记翻译任务失败，由此透传） */
  alignError?: string;
}

async function executeBookTranslate(task: TaskItem, ctx: TaskContext): Promise<void> {
  const payload = (task.payload ?? {}) as BookTranslatePayload;
  ctx.report(0, payload.alignOnly ? "对齐中…" : "读取书籍…");
  if (!payload.alignOnly) {
    await updateBookTranslationMeta(task.targetId, { status: "processing", startedAt: Date.now() });
  }

  try {
    let translation: BookTranslateResult | undefined;
    if (!payload.alignOnly) {
      translation = await translateBook({
        bookId: task.targetId,
        force: payload.force ?? false,
        signal: ctx.signal,
        onProgress: ({ done, total }) => {
          ctx.report(
            total > 0 ? Math.round((done / total) * 100) : 0,
            total > 0 ? `翻译段落 ${done}/${total}` : undefined,
          );
        },
      });

      const sectionCount = (await listBookTranslationSectionIndexes(task.targetId)).length;
      if (translation.cancelled) {
        await updateBookTranslationMeta(task.targetId, {
          status: "partial",
          totalBlocks: translation.total,
          doneBlocks: translation.skipped + translation.translated,
          sectionCount,
          finishedAt: Date.now(),
        });
        toast.info("翻译已取消，已翻译部分已保存，可随时续翻");
        throw new Error("任务已取消");
      }

      const doneBlocks = translation.skipped + translation.translated;
      await updateBookTranslationMeta(task.targetId, {
        status: translation.failedBatches > 0 ? "partial" : "complete",
        totalBlocks: translation.total,
        doneBlocks,
        sectionCount,
        failedBatches: translation.failedBatches,
        finishedAt: Date.now(),
      });
      if (translation.failedBatches > 0) {
        toast.warning(
          `翻译完成：新翻 ${translation.translated} 段，${translation.failedBatches} 个批次失败已跳过（可重新翻译补齐）`,
        );
      } else {
        toast.success(
          translation.translated > 0
            ? `翻译完成：新翻 ${translation.translated} 段，跳过已翻 ${translation.skipped} 段`
            : "翻译完成：所有段落均已有译文",
        );
      }
    }

    // 对齐：翻译路径一条龙幂等补齐（force 重翻后译文 hash 全变，对齐自然全量重算）；
    // alignOnly 路径按相位拆开（sentence/words，force 语义见 BookAlignPayload）
    const alignMode = payload.alignPhase ?? "sentence";
    ctx.report(100, alignMode === "words" ? "词对齐中…" : "句对齐中…");
    let alignment: BookAlignResult | undefined;
    let alignError: string | undefined;
    try {
      alignment = await alignBookTranslation({
        bookId: task.targetId,
        mode: alignMode,
        force: payload.alignOnly ? (payload.force ?? false) : false,
        signal: ctx.signal,
        onProgress: ({ done, total, phase }) => {
          const label = phase === "words" ? "词对齐" : "句对齐";
          ctx.report(100, total > 0 ? `${label} ${done}/${total}` : `${label}中…`);
        },
      });
      if (alignment.reason === "no-vector-capability") {
        toast.info(
          payload.alignOnly
            ? "未配置嵌入模型，无法对齐（请先在设置中配置向量模型）"
            : "未配置嵌入模型，句对齐已跳过（翻译不受影响）",
        );
      } else if (alignment.status === "partial") {
        toast.warning(`句对齐部分完成：${alignment.computed + alignment.reused}/${alignment.total} 段已对齐`);
      }
      // 词级相位独立降级提示（仅 words 模式有词级活动）
      if (alignMode === "words" && alignment.words.status === "partial") {
        toast.warning(
          `词对齐部分完成：${alignment.words.computed + alignment.words.reused}/${alignment.words.total} 段已对齐，可重建`,
        );
      }
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      // alignOnly 的对齐是主产物：失败即任务失败；翻译路径不记失败（译本是主产物，可重建）
      if (payload.alignOnly) throw error;
      console.warn(`翻译后句对齐失败: ${task.targetId}`, error);
      alignError = error instanceof Error ? error.message : String(error);
    }

    ctx.setResult({ translation, alignment, alignError } satisfies BookTranslateTaskResult);
  } catch (error) {
    if (!ctx.signal.aborted && !payload.alignOnly) {
      await updateBookTranslationMeta(task.targetId, { status: "failed", finishedAt: Date.now() }).catch(() => {});
    }
    if (!ctx.signal.aborted) {
      console.error(`翻译图书失败: ${task.targetId}`, error);
      toast.error(error instanceof Error ? error.message : "图书翻译失败");
    }
    throw error;
  } finally {
    // 收尾广播：阅读器若开着此书，对当前章注入译文/更新对齐（含取消场景的已翻部分）
    window.dispatchEvent(new CustomEvent("book-translation-updated", { detail: { bookId: task.targetId } }));
    // 单本直发（图书馆右键）收尾刷新图书馆列表（translation meta 回写即时反映到书卡右键菜单；
    // 对齐 book-vectorize solo 口径，批量/AI 路径不逐本刷新）
    if (payload.solo)
      useLibraryStore
        .getState()
        .refreshBooks()
        .catch(() => {});
  }
}

// ─── 入口薄壳（UI 与 AI 同一入口；模块加载即完成通道注册） ───

registerTaskChannel("book-translate", { executor: executeBookTranslate, concurrency: 1 });
ensureTaskConflictChecker();

/** 通道空闲时清掉已结算任务（新任务卡片从 0 计起） */
function dismissBookTranslateIfIdle(): void {
  const st = useTaskCenterStore.getState();
  const agg = selectChannelAggregate(st, "book-translate");
  if (!agg.current && agg.queuedCount === 0) st.dismissSettled("book-translate");
}

/** 单本入队（阅读器翻译下拉：翻译/重建句对齐/构建·重建词对齐；图书馆右键：翻译/重新翻译 solo 直发）。
 *  拒入队不 toast，由调用方按 detail 提示 */
export function enqueueBookTranslate(input: { id: string; title: string } & BookTranslatePayload): EnqueueResult {
  dismissBookTranslateIfIdle();
  return useTaskCenterStore.getState().enqueue({
    channel: "book-translate",
    targetId: input.id,
    title: input.title,
    payload: {
      force: input.force,
      alignOnly: input.alignOnly,
      alignPhase: input.alignPhase,
      solo: input.solo,
    } satisfies BookTranslatePayload,
  });
}

/** AI translateBook 工具路径：阻塞等结算（保持工具"完成后告知结果"语义），成功 resolve / 失败、取消、拒入队 reject */
export function enqueueBookTranslateAndWait(
  input: { id: string; title: string } & BookTranslatePayload,
): Promise<TaskItem> {
  dismissBookTranslateIfIdle();
  return useTaskCenterStore.getState().enqueueAndWait({
    channel: "book-translate",
    targetId: input.id,
    title: input.title,
    payload: {
      force: input.force,
      alignOnly: input.alignOnly,
      alignPhase: input.alignPhase,
    } satisfies BookTranslatePayload,
  });
}
