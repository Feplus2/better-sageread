/**
 * 图书转换通道执行器（P2-1，docs/task-queue-p2-plan.md）。
 *
 * 吸收 convert-progress-store 原 startBookConvert / startBookConvertAuto 的：
 * 进度监听注册、阶段流水线推进（buildBookStages/markBookActiveError 复用 store 导出）、
 * 完成/失败/取消结算、AI 托管路径的自动入库与 10 分钟超时兜底。
 *
 * 运行态回写 convert-progress-store.bookConvert（大窗口详情数据源，UI 不动）；
 * 任务归属经 convert://progress 事件注入的 pdf_path 过滤（converter.rs 照抄
 * paper_converter.rs 注入模式），迟到/串台事件一律丢弃。
 *
 * 模块加载即自注册 book-convert 通道（并发 1：Rust 侧 ConverterState 单 child 句柄，
 * 并发放开是 P3 的事）。
 */

import { type ConvertProgress, cancelConvert, listenConvertProgress, startConvert } from "@/services/converter-service";
import { buildBookStages, markBookActiveError, useConvertProgressStore } from "@/store/convert-progress-store";
import { useConverterStore } from "@/store/converter-store";
import {
  type EnqueueResult,
  type TaskContext,
  type TaskItem,
  registerTaskChannel,
  useTaskCenterStore,
} from "@/store/task-center-store";

/** book-convert 通道 payload：translate 用 "none" 表示不翻译（对齐大窗口配置项口径） */
export interface BookConvertPayload {
  pdfPath: string;
  ocr: boolean;
  translate: string;
  /** AI convertPdf 托管路径：done 后自动入库（人工大窗口路径 false，等用户点「导入」） */
  autoImport: boolean;
}

/** 结算产物：enqueueAndWait（AI 工具）在 TaskItem.result 上取回 */
export interface BookConvertResult {
  epubPath: string;
  imported: boolean;
}

/** convert://progress 载荷（Rust 侧注入 pdf_path 归属字段；converter-service 的接口尚未声明，此处扩展） */
type BookConvertProgress = ConvertProgress & { pdf_path?: string };

/** 托管转换（convertPdf 工具路径）的超时兜底：10 分钟无终态 → 错误态 + 取消进程 */
const BOOK_AUTO_TIMEOUT_MS = 10 * 60 * 1000;

const pdfFileName = (pdfPath: string) => pdfPath.split(/[\\/]/).pop() ?? pdfPath;

async function executeBookConvert(task: TaskItem, ctx: TaskContext): Promise<void> {
  const payload = task.payload as BookConvertPayload;
  const { pdfPath, ocr, autoImport } = payload;
  const translate = payload.translate && payload.translate !== "none" ? payload.translate : undefined;

  // 任务启动才定格运行态：排队期间不得覆盖在跑任务的大窗口数据源
  useConvertProgressStore.setState((s) => ({
    bookConvert: {
      ...s.bookConvert,
      pdfPath,
      ocr,
      translate: payload.translate || "none",
      status: "converting",
      percent: 0,
      detail: "",
      stages: buildBookStages(!!translate, useConverterStore.getState().engine),
      errorMessage: "",
      epubPath: null,
      autoImport,
    },
    // 托管路径无人盯大窗口：直接以右下角小卡呈现；人工路径大窗口若已关（含排队落定前的
    // 亚秒窗口）也由小卡接管跟踪，大窗口开着则不动 minimized
    bookConvertMinimized: autoImport || !s.bookConvertDialogOpen || s.bookConvertMinimized,
  }));
  ctx.report(0, "启动转换…");

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let unlisten: (() => void) | null = null;
    let autoTimeout: ReturnType<typeof setTimeout> | null = null;
    /** detail-only 事件上报进度时沿用最近 percent（不把已推进的百分比打回 0） */
    let lastPercent = 0;

    const cleanup = () => {
      if (autoTimeout) {
        clearTimeout(autoTimeout);
        autoTimeout = null;
      }
      unlisten?.();
      unlisten = null;
      ctx.signal.removeEventListener("abort", onAbort);
    };
    const settleSuccess = (result: BookConvertResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      ctx.setResult(result);
      resolve();
    };
    const settleError = (message: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(message));
    };
    // 取消语义：cancelTask 触发 signal → 这里调既有 cancelConvert（Rust kill_tree 杀整棵进程树）。
    // 杀树后迟到的 terminated 事件由 settled 闸门吞掉，不会误报「意外退出」。
    const onAbort = () => {
      void cancelConvert().catch(() => {});
      settleError("任务已取消");
    };
    ctx.signal.addEventListener("abort", onAbort);

    // 托管路径长超时兜底：进程静默卡死且连 terminated 都丢失时给出错误态
    if (autoImport) {
      autoTimeout = setTimeout(() => {
        autoTimeout = null;
        if (settled) return;
        markBookActiveError();
        useConvertProgressStore.setState((s) => ({
          bookConvert: { ...s.bookConvert, status: "error", errorMessage: "转换超时（10 分钟无完成回执），已取消进程" },
        }));
        void cancelConvert().catch(() => {});
        settleError("转换超时（10 分钟无完成回执），已取消进程");
      }, BOOK_AUTO_TIMEOUT_MS);
    }

    // 进度事件 → 大窗口数据源回写（原 handleBookProgress 同款补丁逻辑）+ 队列进度上报 + 终态结算
    const handle = async (p: BookConvertProgress) => {
      // 任务归属过滤：上一进程退出后的迟到事件不归本任务（对齐论文侧 runOnePdf 口径）
      if (p.pdf_path && p.pdf_path !== pdfPath) return;
      if (settled) return;

      useConvertProgressStore.setState((s) => {
        const bookConvert = s.bookConvert;
        const patch: Partial<typeof bookConvert> = {};
        if (p.percent !== undefined) patch.percent = p.percent;
        if (p.detail) patch.detail = p.detail;
        switch (p.type) {
          case "progress":
            if (p.stage !== undefined) {
              patch.stages = bookConvert.stages.map((st) =>
                st.n === p.stage && st.status !== "done" ? { ...st, status: "active" as const } : st,
              );
            }
            break;
          case "stage_done":
            if (p.stage !== undefined) {
              patch.stages = bookConvert.stages.map((st) =>
                st.n === p.stage ? { ...st, status: "done" as const, elapsed: p.elapsed } : st,
              );
            }
            break;
          case "done":
            patch.stages = bookConvert.stages.map((st) => ({ ...st, status: "done" as const }));
            if (p.epub_path) patch.epubPath = p.epub_path;
            patch.percent = 100;
            patch.status = "done";
            break;
          case "error":
            patch.stages = bookConvert.stages.map((st) =>
              st.status === "active" ? { ...st, status: "error" as const } : st,
            );
            patch.errorMessage = p.message || "转换失败";
            patch.status = "error";
            break;
          case "terminated":
            // 进程退出但未收到 done/error（崩溃等），避免状态卡死在 converting
            if (bookConvert.status === "converting") {
              patch.stages = bookConvert.stages.map((st) =>
                st.status === "active" ? { ...st, status: "error" as const } : st,
              );
              patch.errorMessage = "转换进程意外退出，请查看日志";
              patch.status = "error";
            }
            break;
        }
        return { bookConvert: { ...bookConvert, ...patch } };
      });
      if (p.percent !== undefined) {
        lastPercent = p.percent;
        ctx.report(p.percent, p.detail);
      } else if (p.detail) {
        ctx.report(lastPercent, p.detail);
      }

      if (p.type === "done") {
        const epubPath = p.epub_path ?? "";
        lastPercent = 100;
        ctx.report(100, "转换完成");
        if (autoImport && epubPath) {
          // 托管路径 done 后自动入库（importBookConvertResult 内部 toast；失败保留 done 态卡片可手动重试）
          const imported = await useConvertProgressStore.getState().importBookConvertResult();
          settleSuccess({ epubPath, imported });
        } else {
          settleSuccess({ epubPath, imported: false });
        }
        return;
      }
      if (p.type === "error") {
        settleError(p.message || "转换失败");
        return;
      }
      if (p.type === "terminated") {
        // 取消路径已由 onAbort 结算（settled 闸门）；走到这里 = 崩溃等意外退出
        settleError("转换进程意外退出，请查看日志");
      }
    };

    listenConvertProgress((p) => {
      void handle(p);
    })
      .then((u) => {
        unlisten = u;
        // 监听注册完成前已结算（如 startConvert 前的同步取消）：立即解除
        if (settled) {
          unlisten();
          unlisten = null;
          return undefined;
        }
        return startConvert(pdfPath, ocr, translate);
      })
      .catch((e) => {
        const message = e instanceof Error ? e.message : String(e);
        markBookActiveError();
        useConvertProgressStore.setState((s) => ({
          bookConvert: { ...s.bookConvert, status: "error", errorMessage: message },
        }));
        settleError(message);
      });
  });
}

// ─── 入口薄壳（UI 与 AI 同一入口；模块加载即完成通道注册） ───

registerTaskChannel("book-convert", { executor: executeBookConvert, concurrency: 1 });

/** 大窗口「开始转换」提交：幂等去重由队列负责（同 pdfPath 在跑/排队拒入队） */
export function enqueueBookConvert(payload: BookConvertPayload): EnqueueResult {
  return useTaskCenterStore.getState().enqueue({
    channel: "book-convert",
    targetId: payload.pdfPath,
    title: pdfFileName(payload.pdfPath),
    payload,
  });
}

/** AI convertPdf 托管路径：阻塞等结算（保持工具"完成后告知结果"语义），成功 resolve 任务、失败/取消 reject */
export function enqueueBookConvertAndWait(payload: BookConvertPayload): Promise<TaskItem> {
  return useTaskCenterStore.getState().enqueueAndWait({
    channel: "book-convert",
    targetId: payload.pdfPath,
    title: pdfFileName(payload.pdfPath),
    payload,
  });
}

/** 取消大窗口当前对应的转换任务（running 发 abort → 执行器杀进程树；queued 直接撤）。
 *  返回是否有任务被撤（无在跑/排队任务时调用方不弹取消 toast）。 */
export function cancelBookConvertTask(): boolean {
  const pdfPath = useConvertProgressStore.getState().bookConvert.pdfPath;
  const { tasks, cancelTask } = useTaskCenterStore.getState();
  let cancelled = false;
  for (const task of Object.values(tasks)) {
    if (task.channel !== "book-convert") continue;
    if (task.status !== "running" && task.status !== "queued") continue;
    // 大窗口数据源对得上 → 撤它；对不上（数据源被重置等边角）→ 兜底撤通道当前活动项
    if (pdfPath && task.targetId !== pdfPath) continue;
    cancelTask(task.taskId);
    cancelled = true;
  }
  return cancelled;
}
