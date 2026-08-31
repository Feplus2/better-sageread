/**
 * 图书转换通道执行器（P2-1，docs/archive/task-queue-p2-plan.md；卡 1 队列化，docs/plans/book-convert-queue-plan.md）。
 *
 * 吸收 convert-progress-store 原 startBookConvert / startBookConvertAuto 的：
 * 进度监听注册、阶段流水线推进（buildBookStages/markBookActiveError 复用 store 导出）、
 * 完成/失败/取消结算、自动入库（卡 1 起窗口路径也默认开——完成 → 自动导入 + toast + 自动出队）
 * 与 10 分钟超时兜底（无回执的托管死等防护）。
 *
 * 运行态回写 convert-progress-store.bookConvert（在跑任务详情数据源：通道卡阶段行/窗口
 * 运行行详情）；队列现场（排队/运行/结算各行）始终以 task-center 通道聚合为准——
 * 窗口队列列表与通道卡都读聚合，点卡还原零状态损失。
 * 任务归属经 convert://progress 事件注入的 pdf_path 过滤（converter.rs 照抄
 * paper_converter.rs 注入模式），迟到/串台事件一律丢弃。
 *
 * 模块加载即自注册 book-convert 通道（并发 1：Rust 侧 ConverterState 单 child 句柄，
 * 并发放开是 P3 的事；卡 1 拍板队列不并发）并注入冲突检查器（统一注入点 task-conflict）。
 */

import {
  type ConvertProgress,
  cancelConvert,
  importConvertedEpub,
  listenConvertProgress,
  resolveLlmParams,
  startConvert,
} from "@/services/converter-service";
import { buildBookStages, markBookActiveError, useConvertProgressStore } from "@/store/convert-progress-store";
import { useConverterStore } from "@/store/converter-store";
import { useLibraryStore } from "@/store/library-store";
import {
  type EnqueueResult,
  type TaskContext,
  type TaskItem,
  registerTaskChannel,
  useTaskCenterStore,
} from "@/store/task-center-store";
import { ensureTaskConflictChecker } from "@/utils/task-conflict";
import { toast } from "sonner";

/** book-convert 通道 payload：translate 用 "none" 表示不翻译（对齐任务台配置项口径） */
export interface BookConvertPayload {
  pdfPath: string;
  ocr: boolean;
  translate: string;
  /** done 后自动入库（卡 1 起恒 true：窗口路径与 AI convertPdf 托管路径同口径，用户拍板默认开） */
  autoImport: boolean;
}

/** 结算产物：enqueueAndWait（AI 工具）在 TaskItem.result 上取回 */
export interface BookConvertResult {
  epubPath: string;
  imported: boolean;
}

/** convert://progress 载荷（Rust 侧注入 pdf_path 归属字段；converter-service 的接口尚未声明，此处扩展） */
type BookConvertProgress = ConvertProgress & { pdf_path?: string };

/** 托管转换的超时兜底：10 分钟无终态 → 错误态 + 取消进程 */
const BOOK_AUTO_TIMEOUT_MS = 10 * 60 * 1000;

/** 成功行自动出队延迟：窗口/通道卡先闪出「完成」态再移除（失败行滞留，不在此列） */
const BOOK_AUTO_DEQUEUE_MS = 2500;

const pdfFileName = (pdfPath: string) => pdfPath.split(/[\\/]/).pop() ?? pdfPath;

/** 转换产物 EPUB 自动入库（完成 → 自动导入图书馆 + toast；库中已存在按幂等提示算成功） */
async function importConvertedBook(title: string, epubPath: string): Promise<boolean> {
  try {
    await importConvertedEpub(epubPath);
    await useLibraryStore.getState().refreshBooks();
    toast.success(`《${title}》转换完成，已导入图书馆`);
    return true;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes("已存在")) {
      await useLibraryStore
        .getState()
        .refreshBooks()
        .catch(() => {});
      toast.info(`《${title}》转换完成，书库已存在同名书籍`);
      return true;
    }
    // 导入失败不算转换失败：任务按 success 结算（imported=false）且滞留队列，产物路径在结果里可追
    toast.error(`《${title}》自动导入失败：${message}`);
    return false;
  }
}

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
    // 窗口开着则不转通道卡（任务台就在眼前）；AI 托管/主页拖放落队时窗口未开 → 通道卡接管跟踪。
    // （卡 1 前此处还叠了 autoImport 强制最小化——卡 1 起窗口路径也自动导入，两语义拆开）
    bookConvertMinimized: !s.bookConvertDialogOpen || s.bookConvertMinimized,
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
          // 卡 1：完成 → 自动导入图书馆 + toast + 自动出队（窗口与 AI 托管同口径）
          const imported = await importConvertedBook(task.title, epubPath);
          settleSuccess({ epubPath, imported });
          if (imported) {
            // 自动出队：延迟移除成功行（先让窗口/通道卡闪出完成态；imported=false 的滞留待手动处理）
            setTimeout(() => {
              useTaskCenterStore.getState().removeTask(task.taskId);
            }, BOOK_AUTO_DEQUEUE_MS);
          }
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

// ─── 入口薄壳（UI 与 AI 同一入口；模块加载即完成通道注册 + 冲突检查器注入） ───

registerTaskChannel("book-convert", { executor: executeBookConvert, concurrency: 1 });
ensureTaskConflictChecker();

/** 单本入队：幂等去重由队列负责（同 pdfPath 在跑/排队拒入队）。
 *  失败/取消行不清（卡 1「失败滞留队列」），成功行由执行器自动出队 */
export function enqueueBookConvert(payload: BookConvertPayload): EnqueueResult {
  return useTaskCenterStore.getState().enqueue({
    channel: "book-convert",
    targetId: payload.pdfPath,
    title: pdfFileName(payload.pdfPath),
    payload,
  });
}

/** 批量入队（任务台拖入/选入、主页拖放共用入口）：引擎 Token + 辅助模型预检（早报错不空排队），
 *  逐本 enqueue（幂等去重/同书冲突由队列拒入），汇总 toast。返回入队/跳过计数。 */
export function enqueueBookConvertBatch(
  paths: string[],
  config: { ocr: boolean; translate: string },
): { queued: number; skipped: number } {
  if (paths.length === 0) return { queued: 0, skipped: 0 };
  const { engine, mineruToken, paddleocrToken } = useConverterStore.getState();
  const tokenMissing = engine === "paddleocr" ? !paddleocrToken : !mineruToken;
  if (tokenMissing) {
    toast.error(
      `尚未配置 ${engine === "paddleocr" ? "PaddleOCR" : "MinerU"} Token，请前往 设置 → PDF 转换 填写后再转换`,
    );
    return { queued: 0, skipped: paths.length };
  }
  try {
    resolveLlmParams();
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e));
    return { queued: 0, skipped: paths.length };
  }
  let queued = 0;
  const skippedNames: string[] = [];
  for (const pdfPath of paths) {
    const res = enqueueBookConvert({ pdfPath, ocr: config.ocr, translate: config.translate, autoImport: true });
    if (res.ok) {
      queued += 1;
    } else if (skippedNames.length < 3) {
      skippedNames.push(pdfFileName(pdfPath));
    }
  }
  const skipped = paths.length - queued;
  if (skipped > 0) {
    toast.info(
      `跳过 ${skipped} 份：${skippedNames.join("、")}${skipped > skippedNames.length ? " 等" : ""}（已在队列中）`,
    );
  }
  if (queued > 0) {
    toast.success(`已加入转换队列 ${queued} 份（串行连转，完成自动导入书库）`, { duration: 4000 });
  }
  return { queued, skipped };
}

/** 失败/已取消行重试（任务台队列行按钮）：移除旧结算行 + 同 payload 重新入队（先移除才过幂等去重） */
export function retryBookConvertTask(taskId: string): void {
  const st = useTaskCenterStore.getState();
  const task = st.tasks[taskId];
  if (!task || task.channel !== "book-convert" || task.status === "running" || task.status === "queued") return;
  const payload = task.payload as BookConvertPayload;
  st.removeTask(taskId);
  const res = enqueueBookConvert(payload);
  if (!res.ok) toast.info(res.detail ?? "重新入队失败");
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
