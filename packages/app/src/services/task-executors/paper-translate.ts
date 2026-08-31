/**
 * 论文翻译通道执行器（P2-3，docs/archive/task-queue-p2-plan.md）。
 *
 * 迁移自 paper-task-store 的 translateQueue/drainTranslate 与阅读器 handleTranslate 直跑路径
 * （迁移而非重写，不动清单逐条保持）：
 * - 翻译批次 3 路并发 / 每批落盘幂等 / 续翻·重翻·sourceHash 陈旧判定 / 脚注 fn: 键相位：
 *   全部在 paper-translation-service 内部，执行器原样调用；
 * - 翻译收尾接句词对齐一条龙（alignPaperTranslation force=false 幂等补齐；无嵌入能力服务内跳过）；
 * - 注册表 translate 槽打点（解析×翻译互斥的事实源不变）；
 * - readerTranslate 页内卡由执行器回写（与通道卡并存：阅读页看页内卡，主页看通道卡），
 *   取消窗口语义不变——卡片取消按钮撤的就是本任务（cancelTask → signal → translatePaper 取消优先）；
 * - solo/reader 的收尾 toast 措辞分别对齐旧队列卡与旧阅读器路径。
 *
 * alignOnly（AI processPaper action=align）复用本通道：同篇翻译/对齐幂等去重，force 透传为对齐重算标志。
 *
 * 模块加载即自注册 paper-translate 通道（并发 1）并注入冲突检查器。
 */

import { type AlignResult, alignPaperTranslation } from "@/services/paper-alignment-service";
import { type TranslateResult, translatePaper } from "@/services/paper-translation-service";
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
import { appDataDir } from "@tauri-apps/api/path";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { toast } from "sonner";

/** paper-translate 通道 payload：force=全量重翻（alignOnly 时=对齐全量重算）；solo=队列单篇直发；reader=阅读器翻译下拉 */
export interface PaperTranslatePayload {
  force?: boolean;
  solo?: boolean;
  reader?: boolean;
  alignOnly?: boolean;
}

/** 结算产物：enqueueAndWait（AI 工具）在 TaskItem.result 上取回（取消/失败时可能缺 translation） */
export interface PaperTranslateResult {
  translation?: TranslateResult;
  alignment?: AlignResult;
  /** 翻译后对齐抛错（非取消）时的错误文案：AI processPaper 旧口径为整体失败，由此透传；批量/阅读器路径忽略 */
  alignError?: string;
}

/** 阅读器路径的对齐收尾 toast（对齐旧 runAlignment(trigger="auto") 措辞逐条保留） */
function toastReaderAlignResult(alignment: AlignResult): void {
  if (alignment.reason === "no-vector-capability") {
    toast.info("未配置嵌入模型，句词对齐已跳过（翻译不受影响；配置后可在翻译菜单重建）");
  } else if (alignment.status === "partial") {
    if (alignment.reason === "embed-failed") {
      toast.warning("嵌入服务调用失败，对齐未完成（请检查嵌入模型配置后重建）");
    } else {
      toast.warning(`句对齐部分完成：${alignment.computed + alignment.reused}/${alignment.total} 块已对齐，可稍后重建`);
    }
  } else if (alignment.computed > 0 || alignment.words.computed > 0) {
    toast.success(
      `对齐完成：句 新算 ${alignment.computed} 块（复用 ${alignment.reused}），词 新算 ${alignment.words.computed} 块（复用 ${alignment.words.reused}）`,
    );
  }
  // 词级相位独立降级：句级成功但词级部分失败时追加提示（不影响句级结果）
  if (alignment.status !== "skipped" && alignment.words.status === "partial" && alignment.status !== "partial") {
    toast.warning("词对齐部分完成，可稍后在翻译菜单重建");
  }
}

async function executePaperTranslate(task: TaskItem, ctx: TaskContext): Promise<void> {
  const payload = (task.payload ?? {}) as PaperTranslatePayload;
  const mark = usePaperTaskRegistry.getState().mark;
  mark(task.targetId, "translate", true);
  // reader 任务：页内卡（readerTranslate 切片）由执行器回写；取消回调撤本任务（取消窗口语义不变）
  if (payload.reader) {
    usePaperTaskStore
      .getState()
      .startReaderTranslate({ paperId: task.targetId, title: task.title, done: 0, total: 0 }, () =>
        useTaskCenterStore.getState().cancelTask(task.taskId),
      );
  }
  ctx.report(0, payload.alignOnly ? "对齐中…" : "读取正文…");

  try {
    const base = await appDataDir();
    const markdown = await readTextFile(`${base}/books/${task.targetId}/paper.md`);

    let translation: TranslateResult | undefined;
    if (!payload.alignOnly) {
      try {
        translation = await translatePaper({
          paperId: task.targetId,
          markdown,
          force: payload.force ?? false,
          signal: ctx.signal,
          onProgress: ({ done: d, total: t }) => {
            ctx.report(t > 0 ? Math.round((d / t) * 100) : 0, t > 0 ? `翻译块 ${d}/${t}` : undefined);
            if (payload.reader) {
              usePaperTaskStore.getState().patchReaderTranslate({ done: d, total: t, detail: undefined });
            }
          },
        });
      } catch (error) {
        // 取消优先：signal 中止时的抛错按取消结算（store 据 signal.aborted 记 cancelled）
        if (ctx.signal.aborted && payload.reader) {
          toast.info("翻译已取消，已翻译部分已保存，可随时续翻");
        }
        throw error;
      }
      if (translation.cancelled) {
        if (payload.reader) {
          toast.info(`翻译已取消，已翻译的 ${translation.translated} 块已保存，可随时续翻`);
        }
        throw new Error("任务已取消");
      }
      // 收尾 toast：reader 用旧阅读器措辞（无书名号），solo 用旧队列措辞
      if (payload.reader) {
        if (translation.failedBatches > 0) {
          toast.warning(
            `翻译完成：新翻 ${translation.translated} 块，${translation.failedBatches} 个批次失败已跳过（可重新翻译补齐）`,
          );
        } else {
          toast.success(
            translation.translated > 0
              ? `翻译完成：新翻 ${translation.translated} 块，跳过已翻 ${translation.skipped} 块`
              : "翻译完成：所有块均已有译文",
          );
        }
      } else if (payload.solo) {
        toast.success(
          translation.translated > 0
            ? `《${task.title}》翻译完成：新翻 ${translation.translated} 块，跳过已翻 ${translation.skipped} 块`
            : `《${task.title}》翻译完成：所有块均已有译文`,
        );
      }
    }

    // 翻译收尾接句词对齐（与旧队列/阅读器/AI 三路径同函数同口径，保证产物一致）：
    // 翻译后 force=false 幂等补齐——force 重翻后译文 hash 全变，对齐自然全量重算
    if (payload.reader) usePaperTaskStore.getState().patchReaderTranslate({ detail: "句词对齐中…" });
    ctx.report(100, "句词对齐中…");
    let alignment: AlignResult | undefined;
    let alignError: string | undefined;
    try {
      alignment = await alignPaperTranslation({
        paperId: task.targetId,
        markdown,
        force: payload.alignOnly ? (payload.force ?? false) : false,
        signal: ctx.signal,
        onProgress: ({ done: d, total: t }) => {
          ctx.report(100, t > 0 ? `句词对齐 ${d}/${t}` : "句词对齐中…");
          // 旧阅读器卡对齐阶段恒显「句词对齐中…」（不逐块更新），保持原样
          if (payload.reader) usePaperTaskStore.getState().patchReaderTranslate({ detail: "句词对齐中…" });
        },
      });
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      // alignOnly 的对齐是主产物：失败即任务失败（对齐旧 processPaper align 抛错口径）
      if (payload.alignOnly) throw error;
      // 翻译路径：对齐失败不记该篇失败——译本是主产物，alignStatus 已在服务内落 partial/skipped
      // （可经阅读器翻译菜单重建）；错误文案记入 result，供 AI processPaper 按旧口径回报整体失败
      console.warn(`翻译后句词对齐失败: ${task.targetId}`, error);
      alignError = error instanceof Error ? error.message : String(error);
    }
    if (payload.reader && alignment) toastReaderAlignResult(alignment);
    ctx.setResult({ translation, alignment, alignError } satisfies PaperTranslateResult);
  } catch (error) {
    if (!ctx.signal.aborted) {
      console.error(`翻译论文失败: ${task.targetId}`, error);
      if (payload.reader) {
        toast.error(error instanceof Error ? error.message : "论文翻译失败");
      } else if (payload.solo) {
        toast.error(`《${task.title}》翻译失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw error;
  } finally {
    mark(task.targetId, "translate", false);
    if (payload.reader) usePaperTaskStore.getState().clearReaderTranslate();
  }
}

// ─── 通道收尾感知（旧 drainTranslate 收尾段的等价物） ───
// 旧翻译通道收尾无批量 toast（仅进度卡汇总），此处只接 onSettled 列表刷新联动
// （翻译徽标 metadata 回写在 translatePaper 内，这里触发列表重读即时上徽标）。
let translateWasActive = false;
useTaskCenterStore.subscribe((s) => {
  const agg = selectChannelAggregate(s, "paper-translate");
  const active = agg.current !== null || agg.queuedCount > 0;
  if (translateWasActive && !active) {
    usePaperTaskStore.getState().onSettled?.();
  }
  translateWasActive = active;
});

// ─── 入口薄壳（UI 与 AI 同一入口；模块加载即完成通道注册 + 冲突检查器注入） ───

registerTaskChannel("paper-translate", { executor: executePaperTranslate, concurrency: 1 });
ensureTaskConflictChecker();

/** 通道空闲时清掉已结算任务（新批次卡片从 0 计起） */
function dismissPaperTranslateIfIdle(): void {
  const st = useTaskCenterStore.getState();
  const agg = selectChannelAggregate(st, "paper-translate");
  if (!agg.current && agg.queuedCount === 0) st.dismissSettled("paper-translate");
}

const toInput = (item: { id: string; title: string } & PaperTranslatePayload) => ({
  channel: "paper-translate" as const,
  targetId: item.id,
  title: item.title,
  payload: {
    force: item.force,
    solo: item.solo,
    reader: item.reader,
    alignOnly: item.alignOnly,
  } satisfies PaperTranslatePayload,
});

/** 单篇入队（阅读器翻译下拉 reader=true；右键/卡片 solo=true）。拒入队不 toast，由调用方按 detail 提示 */
export function enqueuePaperTranslate(item: { id: string; title: string } & PaperTranslatePayload): EnqueueResult {
  dismissPaperTranslateIfIdle();
  return useTaskCenterStore.getState().enqueue(toInput(item));
}

/** 批量入队：复刻旧 paper-task-store.enqueue 口径——逐篇幂等去重 + 冲突拒绝，聚合提示单条 toast */
export function enqueuePaperTranslateBatch(items: ({ id: string; title: string } & PaperTranslatePayload)[]): {
  ok: boolean;
  rejectedCount: number;
} {
  dismissPaperTranslateIfIdle();
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

/** AI processPaper translate/align：阻塞等结算（保持工具返回语义），成功 resolve / 失败、取消、拒入队 reject */
export function enqueuePaperTranslateAndWait(
  item: { id: string; title: string } & PaperTranslatePayload,
): Promise<TaskItem> {
  dismissPaperTranslateIfIdle();
  return useTaskCenterStore.getState().enqueueAndWait(toInput(item));
}
