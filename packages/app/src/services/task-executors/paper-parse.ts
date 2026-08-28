/**
 * 论文解析通道执行器（P2-4，docs/task-queue-p2-plan.md）。
 *
 * 迁移自 convert-progress-store 的 paperQueue/drainPaperQueue/runOnePdf（迁移而非重写，
 * 不动清单逐条保持）：
 * - 三类工作项 parse/reparse/acquire 以 payload 区分；进度事件按 pdf_path 归属过滤；
 * - 取消语义：cancelTask → signal → 先结算再调 cancelPaperPdfImport（Rust kill_tree 树杀），
 *   迟到的 terminated 由 settled 闸吞掉（对齐旧 paperCurrentSettle 顺序教训）；
 * - 刷新恢复锚点（localStorage 记录）与 pending_done 落盘槽口径不变：任务启动写记录、
 *   结算清记录，落库成功才清 pending_done（失败保留供下次启动重试）；
 * - 恢复链路三情形（A 在跑/B 补落库/C 中断报错）改在 task-center 模型上重建：
 *   occupyForRecovery 占泵位（旧 paperDraining 等价物）→ settleRecoveredTask 释放并接续队列；
 * - 收尾联动：活跃→空闲沿做列表刷新（paperRefresh）与多篇汇总 toast（对齐旧 drain 收尾）；
 * - reparse 完成且标签页开着 → 写 reparsedPapers 横幅标记（阅读器「已重新解析」横幅不动）。
 *
 * 卡片数据源：paperParseCardOf 把通道聚合视图折算回 PaperImportState 形状（卡片 markup 不动）。
 * AI importPaper 链路（importPaperPdf）以 payload.silent 抑制执行器 toast（旧自持监听全程静默）。
 *
 * 模块加载即自注册 paper-parse 通道（P3 有界并发 2：Rust 侧 convert_paper_pdf 已多句柄化，
 * 取消/pending_done/状态查询均按 pdf_path 定向）并注入冲突检查器。
 * 注意：本模块不得静态 import convert-progress-store（其入口薄壳经动态 import 调本模块）——
 * reparsedPapers 写入与 paperRefresh 调用走动态 import，保持无环。
 */

import { callMcpServerTool, findZoteroBrainServer, parseMcpToolJson } from "@/ai/mcp/mcp-manager";
import { type PaperMetadata, parsePaperMarkdown } from "@/pages/paper-reader/paper-metadata";
import { invalidateLibraryPaperIndex } from "@/services/paper-reference-service";
import { replacePaperWithConverted, resolvePaperSourcePdf } from "@/services/paper-reparse-service";
import {
  type PaperConvertPendingDone,
  type PaperConvertProgress,
  cancelPaperPdfImport,
  clearPaperConvertPendingDone,
  getPaperConvertStatus,
  importPapers,
  listenPaperConvertProgress,
  startPaperPdfImport,
} from "@/services/paper-service";
import type { PaperImportState, PdfStageStatus } from "@/store/convert-progress-store";
import { useLayoutStore } from "@/store/layout-store";
import {
  type ChannelAggregate,
  type TaskContext,
  type TaskItem,
  registerTaskChannel,
  selectChannelAggregate,
  useTaskCenterStore,
} from "@/store/task-center-store";
import { findDegenerateLoop } from "@/utils/degenerate";
import { ensurePaperTaskConflictChecker } from "@/utils/paper-conflict";
import { invoke } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { toast } from "sonner";

// ----------------------------------------------------------------------
// 通道 payload / 结算产物
// ----------------------------------------------------------------------
/** 三类工作项（对齐旧 PaperWorkItem）；recovered 仅恢复占用注入的任务携带（卡片计数排除） */
export type PaperParsePayload =
  | { kind: "parse"; pdfPath: string; folderId?: string; silent?: boolean; recovered?: boolean }
  | {
      kind: "acquire";
      doi?: string;
      /** 真标题（可空：APS 老版式条目无标题）——只用于 download_paper 的标题校验，空则不校验 */
      title?: string;
      /** 进度卡显示名（真标题缺位时由调用方用 raw 切片兜底——显示串不进检索参数） */
      displayName?: string;
      url?: string;
      arxivId?: string;
      recovered?: boolean;
    }
  | {
      kind: "reparse";
      paperId: string;
      title: string;
      /** AI 工具 filePath 参数显式指定的源 PDF（入队前已预检存在性，执行侧仍复核；缺省走 zotero 回链 → 书库 source.pdf） */
      sourcePdfPath?: string;
      recovered?: boolean;
    };

/** 结算产物：成功（imported/skipped）与失败都写（importPaperPdf 据此分类旧返回语义；取消无 result） */
export type PaperParseResult =
  | {
      outcome: "imported" | "skipped";
      title?: string;
      slug?: string;
      paperDir: string;
      degenerate?: boolean;
      incomplete?: boolean;
    }
  | { outcome: "failed"; stage: "download" | "parse" | "import"; error: string };

const pdfFileName = (pdfPath: string) => pdfPath.split(/[\\/]/).pop() ?? pdfPath;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ----------------------------------------------------------------------
// 阶段行（自 convert-progress-store 迁入；卡片经 extra.stages 实时读取）
// ----------------------------------------------------------------------
const PDF_STAGE_NAMES = ["OCR 解析", "元数据提取", "内容处理", "渲染装订"];
type PdfStages = PaperImportState["stages"];

function buildPdfStages(): PdfStages {
  return PDF_STAGE_NAMES.map((name, i) => ({ n: i + 1, name, status: "pending" as PdfStageStatus }));
}

/** 更新某阶段状态（active 时把之前阶段全部置 done） */
function markStages(stages: PdfStages, n: number | undefined, status: PdfStageStatus): PdfStages {
  if (!n) return stages;
  return stages.map((s) => ({
    ...s,
    status: s.n < n ? "done" : s.n === n ? status : s.status,
  }));
}

const allDoneStages = (stages: PdfStages): PdfStages => stages.map((s) => ({ ...s, status: "done" as const }));
const activeToErrorStages = (stages: PdfStages): PdfStages =>
  stages.map((s) => (s.status === "active" ? { ...s, status: "error" as const } : s));

/** 当前任务的阶段行（extra 未写时给初始态） */
function stagesOf(taskId: string): PdfStages {
  return (useTaskCenterStore.getState().tasks[taskId]?.extra?.stages as PdfStages | undefined) ?? buildPdfStages();
}

/** 批次总篇数（toast 口径分单篇/多篇用；对齐旧 item 启动时的 completed+1+queue.length） */
function batchTotalNow(): number {
  const agg = selectChannelAggregate(useTaskCenterStore.getState(), "paper-parse");
  const processed = agg.settled.filter(
    (t) => t.startedAt && !(t.payload as { recovered?: boolean } | undefined)?.recovered,
  );
  return processed.length + agg.running.length + agg.queuedCount;
}

// ----------------------------------------------------------------------
// 刷新恢复锚点（localStorage 记录；键名不变。P3 起按 pdfPath 分键存多条——并发 2 下两篇
// 同时在跑时各自留锚；旧版单对象记录读取时静默迁移为 map 形态，跨版本恢复兼容）
// ----------------------------------------------------------------------
const PAPER_TASK_RECORD_KEY = "paperImportCurrentTask";

interface PaperTaskRecord {
  pdfPath: string;
  kind: "parse" | "reparse";
  folderId?: string;
  paperId?: string;
  title?: string;
  startedAt: number;
}

function readAllPaperTaskRecords(): Record<string, PaperTaskRecord> {
  try {
    const raw = localStorage.getItem(PAPER_TASK_RECORD_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, PaperTaskRecord> | PaperTaskRecord;
    // 旧版单对象（自带 pdfPath 字段）→ 迁移为按 pdfPath 分键的 map
    if ("pdfPath" in parsed && typeof parsed.pdfPath === "string") {
      const legacy = parsed as PaperTaskRecord;
      return legacy.pdfPath ? { [legacy.pdfPath]: legacy } : {};
    }
    const out: Record<string, PaperTaskRecord> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, PaperTaskRecord>)) {
      if (v && typeof v.pdfPath === "string" && v.pdfPath) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function writeAllPaperTaskRecords(records: Record<string, PaperTaskRecord>): void {
  try {
    if (Object.keys(records).length === 0) localStorage.removeItem(PAPER_TASK_RECORD_KEY);
    else localStorage.setItem(PAPER_TASK_RECORD_KEY, JSON.stringify(records));
  } catch {
    // 持久化失败不阻断解析
  }
}

function writePaperTaskRecord(record: PaperTaskRecord): void {
  const all = readAllPaperTaskRecords();
  all[record.pdfPath] = record;
  writeAllPaperTaskRecords(all);
}

function clearPaperTaskRecord(pdfPath: string): void {
  const all = readAllPaperTaskRecords();
  if (!(pdfPath in all)) return;
  delete all[pdfPath];
  writeAllPaperTaskRecords(all);
}

// ----------------------------------------------------------------------
// 执行器本体
// ----------------------------------------------------------------------

/** 解析单篇并等待结算：注册进度监听 → 启动转换 → done 后入库；失败/取消抛错（泵据此记 error/cancelled）。
 *  成功 resolve "imported" | "skipped"（队列后处理据此分流）。stageOffset：调用方在解析阶段前插了
 *  前置段（acquire 的下载段）时，进度事件的阶段号按偏移对齐。
 *  onParsed：自定义 done 落库逻辑（reparse 的产物整体替换）；缺省走 importPapers 新建条目。
 *  reparseCtx：reparse 项的恢复上下文（写入 localStorage 记录，刷新后恢复落库链路用） */
async function runParseInner(
  task: TaskItem,
  ctx: TaskContext,
  opts: {
    pdfPath: string;
    folderId?: string;
    stageOffset?: number;
    silent?: boolean;
    /** toast 用的显示名（对齐旧 fileName 口径） */
    fileName: string;
    /** 启动时的批次总篇数（toast 单/多篇口径） */
    batchTotal: number;
    onParsed?: (progress: PaperConvertProgress) => Promise<void>;
    reparseCtx?: { paperId: string; title: string };
  },
): Promise<"imported" | "skipped"> {
  const { pdfPath, stageOffset = 0, silent = false, fileName, batchTotal } = opts;
  let filePercent = 0;
  let settled = false;
  /** 收尾中标志：done 事件已进入落库/替换路径——此后取消不再翻转成功结算
   *  （实况：done→替换→report(100) 的毫秒窗口内 abort 抢闸，成功任务被记 cancelled） */
  let finishing = false;
  let unlisten: (() => void) | null = null;

  return new Promise<"imported" | "skipped">((resolve, reject) => {
    const cleanup = () => {
      unlisten?.();
      unlisten = null;
      ctx.signal.removeEventListener("abort", onAbort);
    };
    const settleSuccess = (outcome: "imported" | "skipped") => {
      if (settled) return;
      settled = true;
      cleanup();
      clearPaperTaskRecord(pdfPath);
      // 落库成功 → 确认清除 Rust 侧 pending_done（刷新恢复槽；失败则保留，下次启动恢复重试）
      void clearPaperConvertPendingDone(pdfPath).catch(() => {});
      resolve(outcome);
    };
    const settleFailure = (stage: "download" | "parse" | "import", message: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      clearPaperTaskRecord(pdfPath);
      ctx.setResult({ outcome: "failed", stage, error: message } satisfies PaperParseResult);
      reject(new Error(message));
    };
    const settleCancelled = () => {
      if (settled) return;
      settled = true;
      cleanup();
      clearPaperTaskRecord(pdfPath);
      reject(new Error("任务已取消"));
    };
    // 取消语义：先结算再杀进程——树杀（taskkill /T /F）把取消等待拉长到百毫秒级，
    // terminated 事件可能先于 invoke 返回到达；settled 闸 + 卡片状态守卫挡住它，
    // 保证取消语义落在「已取消」而非「异常退出」。P3：按 pdfPath 定向杀本任务进程。
    // finishing 守卫：done 已进落库路径后取消不生效（产物已可落库，翻转成 cancelled 是假态）。
    const onAbort = () => {
      if (finishing) return;
      settleCancelled();
      void cancelPaperPdfImport(pdfPath).catch(() => {});
    };
    ctx.signal.addEventListener("abort", onAbort);

    // 刷新恢复锚点：任务上下文落 localStorage（刷新不丢；settle 即清除）
    writePaperTaskRecord({
      pdfPath,
      kind: opts.reparseCtx ? "reparse" : "parse",
      folderId: opts.folderId,
      paperId: opts.reparseCtx?.paperId,
      title: opts.reparseCtx?.title,
      startedAt: Date.now(),
    });

    const handle = async (progress: PaperConvertProgress) => {
      // 任务归属过滤：上一篇进程退出后的迟到 terminated、以及其他来源（Zotero 批量导入/重解析）
      // 共用同一事件通道，不归本任务的进度一律忽略（2026-08-20 实测迟到 terminated 秒杀下一篇）
      if (progress.pdf_path && progress.pdf_path !== pdfPath) return;
      if (settled) return;
      if (progress.type === "progress" || progress.type === "stage_done") {
        if (progress.percent != null) filePercent = progress.percent;
        const stage = progress.stage === undefined ? undefined : progress.stage + stageOffset;
        if (stage !== undefined) {
          // 阶段名跟随 converter 实报（XML 管线 stage1 是「XML 解析」而非「OCR 解析」；
          // 引擎名同理），静态 PDF_STAGE_NAMES 只是初值
          const renamed = progress.stage_name
            ? stagesOf(task.taskId).map((s) => (s.n === stage ? { ...s, name: progress.stage_name! } : s))
            : stagesOf(task.taskId);
          ctx.reportExtra({
            stages: markStages(renamed, stage, progress.type === "stage_done" ? "done" : "active"),
          });
        }
        ctx.report(filePercent, progress.detail);
        return;
      }
      if (progress.type === "done" && progress.paper_dir) {
        // 进入落库路径即标记收尾中（abort 自此不翻转——done 产物已可落库）
        finishing = true;
        // 自定义落库路径（重解析的产物整体替换）：委托给调用方的 onParsed（自带成功卡/toast/result）
        if (opts.onParsed) {
          try {
            await opts.onParsed(progress);
            settleSuccess("imported");
          } catch (error) {
            const message = `解析成功但落库失败：${errMsg(error)}`;
            if (!silent) toast.error(`「${fileName}」${message}`);
            settleFailure("import", message);
          }
          return;
        }
        try {
          const result = await importPapers(progress.paper_dir, opts.folderId);
          // 静默失败闸：importPapers 把单篇失败收进 result.failed（不抛），此前只判 skipped
          // 导致"入库失败报成功"（2026-08-20 队列验收实测：save_paper 失败被吞、卡片显示成功）
          if (result.failed.length > 0 && result.imported === 0 && result.skipped === 0) {
            const message = `解析成功但入库失败：${result.failed[0].error}`;
            if (!silent) toast.error(`「${fileName}」${message}`);
            settleFailure("import", message);
            return;
          }
          ctx.reportExtra({ stages: allDoneStages(stagesOf(task.taskId)) });
          ctx.report(100, `已入库《${progress.title ?? progress.slug}》`);
          const outcome: "imported" | "skipped" = result.skipped > 0 && result.imported === 0 ? "skipped" : "imported";
          ctx.setResult({
            outcome,
            title: progress.title,
            slug: progress.slug,
            paperDir: progress.paper_dir,
            degenerate: progress.degenerate === true,
            incomplete: progress.incomplete === true,
          } satisfies PaperParseResult);
          if (outcome === "skipped") {
            if (!silent) {
              const reason = result.skippedByDoi > 0 ? "同 DOI 判重" : "内容未变化";
              toast.info(batchTotal > 1 ? `「${fileName}」已入库过（${reason}）` : `该论文已入库过（${reason}）`);
            }
            settleSuccess("skipped");
          } else {
            if (!silent) {
              toast.success(`论文解析入库完成：${progress.title ?? progress.slug}`);
              // 完整性闸（converter 重试+降级后仍缺内容）：明确提示，不静默交付
              if (progress.incomplete === true) {
                toast.warning(`《${progress.title ?? progress.slug}》检测到内容缺失（图/表或整页未解析出）`, {
                  description: `${progress.qc_warnings?.[0] ?? "完整性检查未通过"}。建议在 设置 → PDF 转换 中更换解析引擎后重新解析`,
                  duration: 10000,
                });
              }
            }
            // 退化循环检测（引擎 VLM 偶发模式延续失控）：本地检测 + converter 质量守卫双通道
            try {
              const raw = await readTextFile(await join(progress.paper_dir, "paper.md"));
              if (progress.degenerate === true || findDegenerateLoop(parsePaperMarkdown(raw).body)) {
                if (!silent) {
                  toast.warning(`《${progress.title ?? progress.slug}》检测到异常重复内容（解析引擎失控）`, {
                    description: "建议在 设置 → PDF 转换 中更换解析引擎后重新解析",
                    duration: 8000,
                  });
                }
              }
            } catch {
              // 检测失败不影响入库
            }
            settleSuccess("imported");
          }
        } catch (error) {
          const message = `解析成功但入库失败：${errMsg(error)}`;
          if (!silent && batchTotal > 1) toast.error(`「${fileName}」${message}`);
          settleFailure("import", message);
        }
        return;
      }
      if (progress.type === "error") {
        const message = progress.message ?? "解析失败";
        if (!silent && batchTotal > 1) toast.error(`「${fileName}」解析失败：${message}`);
        settleFailure("parse", message);
        return;
      }
      if (progress.type === "terminated") {
        // finishing 守卫：done 已进落库路径（importPapers 进行中）时进程退场是正常时序
        // （done → 进程退出 → terminated），不算取消——落库路径自会 settle。
        // XML 管线秒级解析把该窗口撑到必现（PDF 路径 PyInstaller 收尾慢，历史上偶隐）
        if (progress.success === false) settleFailure("parse", "解析进程异常退出");
        else if (!finishing) settleCancelled();
      }
    };

    listenPaperConvertProgress((p) => {
      void handle(p);
    })
      .then((u) => {
        unlisten = u;
        // 监听注册完成前已结算（如启动前的同步取消）：立即解除
        if (settled) {
          unlisten();
          unlisten = null;
          return undefined;
        }
        return startPaperPdfImport(pdfPath);
      })
      .catch((e) => {
        const message = errMsg(e);
        if (!silent && batchTotal > 1) toast.error(`「${fileName}」${message}`);
        settleFailure("parse", message);
      });
  });
}

/** acquire 项的下载段：MCP 直调 Zotero Brain；取消在下载中即时结算（MCP 调用不可中止，晚到结果被丢弃） */
async function downloadReferencePdf(
  item: {
    doi?: string;
    /** 可空（APS 老版式条目无标题）——空串跳过 PDF 标题校验（见下方调用处注释） */
    title?: string;
    url?: string;
    arxivId?: string;
  },
  signal: AbortSignal,
): Promise<{ pdfPath?: string; message?: string; cancelled?: boolean }> {
  const server = findZoteroBrainServer();
  if (!server) return { message: "未配置 Zotero Brain MCP，请到 AI 中心 → MCP 配置后重试" };
  return new Promise((resolve) => {
    let done = false;
    const onAbort = () => {
      if (done) return;
      done = true;
      resolve({ cancelled: true });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    // title 只传真标题（空串——slim 端空标题跳过 PDF 标题校验，防 raw 引文切片被误当标题比对而拒收）
    callMcpServerTool(server, "download_paper", {
      doi: item.doi,
      title: item.title?.trim() || "",
      url: item.url,
      arxiv_id: item.arxivId,
    }).then(
      (raw) => {
        if (done) return;
        done = true;
        signal.removeEventListener("abort", onAbort);
        const result = parseMcpToolJson(raw);
        if (result?.success && typeof result?.pdf_path === "string" && result.pdf_path) {
          resolve({ pdfPath: result.pdf_path });
        } else {
          // 兼容 no_pdf 结构化返回（reason/tried/landing_page）与旧版 {message}
          const reason = result?.reason ?? result?.message ?? "全部下载源失败";
          resolve({ message: `未能获取 PDF：${reason}${result?.landing_page ? "，可经「访问页面」人工下载" : ""}` });
        }
      },
      (error) => {
        if (done) return;
        done = true;
        signal.removeEventListener("abort", onAbort);
        resolve({ message: `获取 PDF 失败：${errMsg(error)}` });
      },
    );
  });
}

/** reparse 项执行：解析源 PDF（显式 sourcePdfPath → zotero 回链 → 书库 source.pdf）→ runParseInner → 产物整体替换（保留 id/归属/对话/标注） */
async function runReparseTask(
  task: TaskItem,
  ctx: TaskContext,
  payload: Extract<PaperParsePayload, { kind: "reparse" }>,
): Promise<void> {
  // 旧元数据（zotero_key/zotero_pdf_path 回链字段在替换产物时要保留）
  let meta: PaperMetadata | null = null;
  try {
    meta = JSON.parse(await readTextFile(await join(await appDataDir(), "books", payload.paperId, "metadata.json")));
  } catch {
    // 无 metadata.json：走书库 source.pdf 兜底
  }
  // 显式路径优先（AI 工具 filePath；存在性复核用 Rust path_exists——plugin-fs 看不到库外路径）
  const explicit = payload.sourcePdfPath?.trim();
  const pdfPath =
    explicit && (await invoke<boolean>("path_exists", { path: explicit }).catch(() => false))
      ? explicit
      : await resolvePaperSourcePdf(payload.paperId, meta);
  if (!pdfPath) {
    const message = `《${payload.title}》找不到源 PDF，无法重新解析`;
    toast.error(message);
    ctx.setResult({ outcome: "failed", stage: "parse", error: message } satisfies PaperParseResult);
    throw new Error(message);
  }
  const outcome = await runParseInner(task, ctx, {
    pdfPath,
    stageOffset: 0,
    fileName: payload.title,
    batchTotal: batchTotalNow(),
    reparseCtx: { paperId: payload.paperId, title: payload.title },
    onParsed: async (progress) => {
      const suspect = await replacePaperWithConverted(
        { id: payload.paperId, title: payload.title },
        progress.paper_dir as string,
        meta ?? undefined,
      );
      ctx.reportExtra({ stages: allDoneStages(stagesOf(task.taskId)) });
      ctx.report(100, `已更新《${payload.title}》`);
      ctx.setResult({
        outcome: "imported",
        title: payload.title,
        paperDir: progress.paper_dir as string,
        degenerate: progress.degenerate === true,
        incomplete: progress.incomplete === true,
      } satisfies PaperParseResult);
      toast.success(`重新解析完成：《${payload.title}》`);
      // 完整性/退化警告与原批量路径同口径（converter 守卫 + 本地检测双通道）
      if (suspect || progress.degenerate === true || progress.incomplete === true) {
        toast.warning(`《${payload.title}》重解析后检测到内容异常（退化循环或内容缺失），建议换引擎重试`, {
          duration: 8000,
        });
      }
    },
  });
  // 重解析完成且该篇标签页开着 → 写标记（阅读器出「已重新解析」横幅，不自动刷新）
  if (outcome === "imported") {
    const tabOpen = useLayoutStore.getState().tabs.some((t) => t.id === `paper-${payload.paperId}`);
    if (tabOpen) {
      const { useConvertProgressStore } = await import("@/store/convert-progress-store");
      useConvertProgressStore.setState((s) => ({
        reparsedPapers: { ...s.reparsedPapers, [payload.paperId]: Date.now() },
      }));
    }
  }
}

async function executePaperParse(task: TaskItem, ctx: TaskContext): Promise<void> {
  const payload = task.payload as PaperParsePayload;
  const batchTotal = batchTotalNow();

  if (payload.kind === "acquire") {
    // 初始阶段行：下载段 + 解析四阶段（阶段号偏移 1）
    ctx.reportExtra({
      stages: [
        { n: 1, name: "Zotero Brain 下载 PDF", status: "active" as PdfStageStatus },
        ...buildPdfStages().map((s) => ({ ...s, n: s.n + 1 })),
      ],
    });
    ctx.report(0, "经 Zotero Brain 下载 PDF…");
    const dl = await downloadReferencePdf(payload, ctx.signal);
    if (dl.cancelled) throw new Error("任务已取消");
    if (!dl.pdfPath) {
      const message = dl.message ?? "未能获取 PDF";
      ctx.reportExtra({ stages: activeToErrorStages(stagesOf(task.taskId)) });
      ctx.setResult({ outcome: "failed", stage: "download", error: message } satisfies PaperParseResult);
      toast.error(message);
      throw new Error(message);
    }
    ctx.reportExtra({ stages: markStages(stagesOf(task.taskId), 1, "done") });
    ctx.report(0, "PDF 下载完成，开始解析…");
    const fileName = payload.title?.trim() || payload.displayName || payload.doi || payload.arxivId || "参考文献";
    const outcome = await runParseInner(task, ctx, {
      pdfPath: dl.pdfPath,
      stageOffset: 1,
      fileName,
      batchTotal,
    });
    // 新入库论文加入在库检查索引（引用卡片「打开」即时可见）
    if (outcome === "imported") invalidateLibraryPaperIndex();
    return;
  }

  if (payload.kind === "reparse") {
    ctx.reportExtra({ stages: buildPdfStages() });
    ctx.report(0, "启动解析…");
    await runReparseTask(task, ctx, payload);
    return;
  }

  // parse
  const fileName = pdfFileName(payload.pdfPath);
  ctx.reportExtra({ stages: buildPdfStages() });
  ctx.report(0, "启动解析…");
  await runParseInner(task, ctx, {
    pdfPath: payload.pdfPath,
    folderId: payload.folderId,
    stageOffset: 0,
    silent: payload.silent,
    fileName,
    batchTotal,
  });
}

// ─── 通道收尾感知（旧 drainPaperQueue 收尾段的等价物） ───
// 活跃→空闲沿：批量汇总 toast（取消不收尾 toast，对齐旧口径）+ paperRefresh 列表刷新联动
// （PapersPage 挂载时注册到 convert-progress-store，此处动态 import 调用保持无环）。
let parseWasActive = false;
useTaskCenterStore.subscribe((s) => {
  const agg = selectChannelAggregate(s, "paper-parse");
  const active = agg.current !== null || agg.queuedCount > 0;
  if (parseWasActive && !active) {
    // 恢复占用注入的任务不进批次计数（旧恢复链路本无收尾汇总 toast）
    const processed = agg.settled.filter(
      (t) => t.startedAt && !(t.payload as { recovered?: boolean } | undefined)?.recovered,
    );
    const imported = processed.filter(
      (t) => t.status === "success" && (t.result as PaperParseResult | undefined)?.outcome === "imported",
    ).length;
    const skipped = processed.filter(
      (t) => t.status === "success" && (t.result as PaperParseResult | undefined)?.outcome === "skipped",
    ).length;
    const failed = processed.filter((t) => t.status === "error");
    const cancelled = processed.some((t) => t.status === "cancelled");
    if (!cancelled && processed.length > 1) {
      if (failed.length > 0) toast.error(`批量解析结束：${failed.length} 篇失败`);
      else {
        const extras: string[] = [];
        if (skipped > 0) extras.push(`跳过 ${skipped}`);
        const summary = `完成 ${imported} 篇${extras.length > 0 ? `（${extras.join(" · ")}）` : ""}`;
        toast.success(`批量解析完成：${summary}`);
      }
    }
    void import("@/store/convert-progress-store").then((m) => m.runPaperImportRefresh());
  }
  parseWasActive = active;
});

// ─── 通道注册（模块加载即完成；冲突检查器幂等注入，与向量化/翻译通道同一实现） ───

registerTaskChannel("paper-parse", { executor: executePaperParse, concurrency: 2 });
ensurePaperTaskConflictChecker();

/** 通道空闲时清掉已结算任务（新批次卡片从 0 计起，对齐旧 drain 重置进度卡语义）。
 *  UI 入口薄壳（convert-progress-store）与 AI 直发链路（paper-service.importPaperPdf）各自调用。 */
export function dismissPaperParseIfIdle(): void {
  const st = useTaskCenterStore.getState();
  const agg = selectChannelAggregate(st, "paper-parse");
  if (!agg.current && agg.queuedCount === 0) st.dismissSettled("paper-parse");
}

// ----------------------------------------------------------------------
// 通道聚合 → 解析卡视图模型（PaperImportState 形状，global-convert-progress 卡片 markup 不动）
// ----------------------------------------------------------------------
/**
 * 口径对齐旧 paperImport 卡：index/total 动态含排队；percent 按篇数加权（含当前篇内进度）；
 * 计数只算「跑过且非恢复占用」的任务（排队中被撤的静默丢弃，对齐旧 drain 计数口径）；
 * 恢复占用注入的任务（payload.recovered）单独成卡，不并入批次计数（旧恢复卡 index/total 恒 1/1）。
 */
export function paperParseCardOf(agg: ChannelAggregate): PaperImportState | null {
  const { current, queuedCount, settled } = agg;
  if (!current && queuedCount === 0 && settled.length === 0) return null;
  const isRecovered = (t: TaskItem) => (t.payload as { recovered?: boolean } | undefined)?.recovered === true;
  const batchSettled = settled.filter((t) => t.startedAt && !isRecovered(t));
  const recoveredSettled = settled.filter((t) => isRecovered(t));
  const countsOf = (list: TaskItem[]) => ({
    importedCount: list.filter(
      (t) => t.status === "success" && (t.result as PaperParseResult | undefined)?.outcome === "imported",
    ).length,
    skippedCount: list.filter(
      (t) => t.status === "success" && (t.result as PaperParseResult | undefined)?.outcome === "skipped",
    ).length,
    failed: list.filter((t) => t.status === "error"),
  });

  if (current) {
    // 运行中卡（含恢复占用任务的监控卡）
    const done = isRecovered(current) ? 0 : batchSettled.length;
    const index = done + 1;
    const total = index + queuedCount;
    const { importedCount, skippedCount, failed } = countsOf(batchSettled);
    return {
      status: "running",
      fileName: current.title,
      percent: total > 0 ? Math.min(100, Math.round(((done + current.percent / 100) / total) * 100)) : 0,
      detail: current.detail,
      stages: (current.extra?.stages as PdfStages | undefined) ?? buildPdfStages(),
      index,
      total,
      queuedCount,
      importedCount,
      skippedCount,
      failedCount: failed.length,
      failedNames: failed.map((t) => t.title),
    };
  }

  // 收尾卡：批次任务优先；只有恢复任务时按单篇卡展示（对齐旧恢复卡）
  if (batchSettled.length === 0) {
    const last = recoveredSettled.at(-1);
    if (!last) return null;
    const { importedCount, skippedCount, failed } = countsOf(recoveredSettled);
    const base = {
      fileName: last.title,
      percent: 100,
      detail: last.detail,
      stages: (last.extra?.stages as PdfStages | undefined) ?? buildPdfStages(),
      index: 1,
      total: 1,
      queuedCount: 0,
      importedCount,
      skippedCount,
      failedCount: failed.length,
      failedNames: failed.map((t) => t.title),
    };
    if (last.status === "success") {
      return { ...base, status: "success", title: last.title, detail: last.detail };
    }
    return {
      ...base,
      status: "error",
      error: last.status === "cancelled" ? "已取消解析" : (last.error ?? "解析失败"),
    };
  }

  const { importedCount, skippedCount, failed } = countsOf(batchSettled);
  const failedNames = failed.map((t) => t.title);
  const cancelledCount = batchSettled.filter((t) => t.status === "cancelled").length;
  const base = {
    fileName: batchSettled.at(-1)?.title ?? "",
    percent: 100,
    detail: "",
    stages: allDoneStages((batchSettled.at(-1)?.extra?.stages as PdfStages | undefined) ?? buildPdfStages()),
    index: batchSettled.length,
    total: batchSettled.length,
    queuedCount: 0,
    importedCount,
    skippedCount,
    failedCount: failed.length,
    failedNames,
  };
  if (cancelledCount > 0) {
    const cancelledSummary =
      importedCount + skippedCount + failed.length <= 1
        ? "已取消解析"
        : `已取消：完成 ${importedCount} 篇${skippedCount > 0 ? ` · 跳过 ${skippedCount}` : ""}${failed.length > 0 ? ` · 失败 ${failed.length}` : ""}，队列已清空`;
    return { ...base, status: "error", error: cancelledSummary };
  }
  if (batchSettled.length > 1) {
    const extras: string[] = [];
    if (skippedCount > 0) extras.push(`跳过 ${skippedCount}`);
    if (failed.length > 0) extras.push(`失败 ${failed.length}`);
    const summary = `完成 ${importedCount} 篇${extras.length > 0 ? `（${extras.join(" · ")}）` : ""}`;
    return { ...base, status: "success", detail: summary };
  }
  const last = batchSettled[0];
  if (last.status === "success") {
    return {
      ...base,
      status: "success",
      percent: 100,
      title: (last.result as PaperParseResult | undefined)?.outcome !== "skipped" ? last.title : undefined,
      detail: last.detail,
    };
  }
  return { ...base, status: "error", error: last.error ?? "解析失败" };
}

// ----------------------------------------------------------------------
// 刷新恢复（三情形语义自 convert-progress-store 原样迁移，卡在 task-center 模型上重建）
// 情形 A：解析仍在跑 → 占住队列泵位 + 恢复进度卡 + 完成监听（结算后接续新提交）；
// 情形 B：done 在刷新窗口丢失（进程已退场、产物未消费）→ 直接补落库；
// 情形 C：进程与产物都没了但有残留记录 → 解析中断在刷新窗口，出错误卡引导重发。
// ----------------------------------------------------------------------

/** 恢复路径的 done 落库：record 指认 reparse → 产物整体替换（保留 id/归属/对话/标注）；
 *  否则按纯 parse 走 importPapers 新建入库（无记录时也保证产物落库）。
 *  落库成功才清 Rust pending_done 槽；失败保留供下次启动重试（产物不落库是更严重事故）。
 *  卡片经 occ.report/reportExtra 回写（旧 setPaperImportState 的等价物）；toast/横幅逐项对齐。 */
async function settleRecoveredDone(
  done: PaperConvertPendingDone,
  record: PaperTaskRecord | null,
  occ: { report: (percent: number, detail?: string) => void; reportExtra: (patch: Record<string, unknown>) => void },
  taskId: string,
): Promise<{ outcome: "imported" | "skipped" | "failed"; error?: string }> {
  if (record?.kind === "reparse" && record.paperId) {
    const paperId = record.paperId;
    const title = record.title ?? done.title ?? "";
    // 旧元数据（zotero 回链字段替换产物时要保留）——从磁盘重读（对齐 runReparseTask）
    let meta: PaperMetadata | null = null;
    try {
      meta = JSON.parse(await readTextFile(await join(await appDataDir(), "books", paperId, "metadata.json")));
    } catch {
      // 无 metadata.json：照样替换
    }
    try {
      const suspect = await replacePaperWithConverted({ id: paperId, title }, done.paperDir, meta ?? undefined);
      occ.reportExtra({ stages: allDoneStages(stagesOf(taskId)) });
      occ.report(100, `已更新《${title}》`);
      toast.success(`重新解析完成：《${title}》`);
      if (suspect || done.degenerate === true || done.incomplete === true) {
        toast.warning(`《${title}》重解析后检测到内容异常（退化循环或内容缺失），建议换引擎重试`, {
          duration: 8000,
        });
      }
      // 标签页开着 → 写「已重新解析」横幅标记（对齐执行器 reparse 路径行为）
      const tabOpen = useLayoutStore.getState().tabs.some((t) => t.id === `paper-${paperId}`);
      if (tabOpen) {
        const { useConvertProgressStore } = await import("@/store/convert-progress-store");
        useConvertProgressStore.setState((s) => ({
          reparsedPapers: { ...s.reparsedPapers, [paperId]: Date.now() },
        }));
      }
      void clearPaperConvertPendingDone(done.pdfPath).catch(() => {});
      return { outcome: "imported" };
    } catch (error) {
      const message = `解析成功但落库失败：${errMsg(error)}`;
      toast.error(`《${title}》${message}`);
      return { outcome: "failed", error: message };
    }
  }
  try {
    const result = await importPapers(done.paperDir, record?.folderId);
    // 静默失败闸（对齐 runParseInner：importPapers 把单篇失败收进 result.failed 不抛）
    if (result.failed.length > 0 && result.imported === 0 && result.skipped === 0) {
      const message = `解析成功但入库失败：${result.failed[0].error}`;
      toast.error(message);
      return { outcome: "failed", error: message };
    }
    const label = done.title ?? done.slug ?? done.paperDir;
    occ.reportExtra({ stages: allDoneStages(stagesOf(taskId)) });
    occ.report(100, `已入库《${label}》`);
    if (result.skipped > 0 && result.imported === 0) {
      toast.info("该论文已入库过（内容未变化）");
      void clearPaperConvertPendingDone(done.pdfPath).catch(() => {});
      return { outcome: "skipped" };
    }
    toast.success(`论文解析入库完成：${label}`);
    if (done.incomplete === true) {
      toast.warning(`《${label}》检测到内容缺失（图/表或整页未解析出）`, {
        description: "建议在 设置 → PDF 转换 中更换解析引擎后重新解析",
        duration: 10000,
      });
    }
    // 退化循环检测（converter 守卫 + 本地检测双通道，对齐 runParseInner）
    try {
      const raw = await readTextFile(await join(done.paperDir, "paper.md"));
      if (done.degenerate === true || findDegenerateLoop(parsePaperMarkdown(raw).body)) {
        toast.warning(`《${label}》检测到异常重复内容（解析引擎失控）`, {
          description: "建议在 设置 → PDF 转换 中更换解析引擎后重新解析",
          duration: 8000,
        });
      }
    } catch {
      // 检测失败不影响入库
    }
    // acquire 来源的恢复也走这里：入库后失效在库检查索引（引用卡片「打开」即时可见）
    invalidateLibraryPaperIndex();
    void clearPaperConvertPendingDone(done.pdfPath).catch(() => {});
    return { outcome: "imported" };
  } catch (error) {
    const message = `解析成功但入库失败：${errMsg(error)}`;
    toast.error(message);
    return { outcome: "failed", error: message };
  }
}

let paperRecoveryAttempted = false;

/** 恢复占用任务的 payload（record 指认 reparse 则携带 paperId，否则纯 parse；recovered 标记供卡片计数排除） */
function recoveredPayload(rec: PaperTaskRecord | null, pdfPath: string, fileName: string): PaperParsePayload {
  return rec?.kind === "reparse" && rec.paperId
    ? { kind: "reparse", paperId: rec.paperId, title: rec.title ?? fileName, recovered: true }
    : { kind: "parse", pdfPath, folderId: rec?.folderId, recovered: true };
}

/** 恢复占用任务的归属键：reparse 用 paperId（冲突/去重与正常 reparse 同口径），否则 pdfPath */
const recoveredTargetId = (rec: PaperTaskRecord | null, pdfPath: string) =>
  rec?.kind === "reparse" && rec.paperId ? rec.paperId : pdfPath;

/** 情形 A 单篇接管：占住一个并发槽（新提交只能填剩余空槽，结算后自动接续），恢复进度卡与完成监听 */
async function recoverRunningTask(runningPdf: string, rec: PaperTaskRecord | null): Promise<void> {
  const st = useTaskCenterStore.getState();
  const fileName = rec?.title || pdfFileName(runningPdf);
  const occ = st.occupyForRecovery({
    channel: "paper-parse",
    targetId: recoveredTargetId(rec, runningPdf),
    title: fileName,
    payload: recoveredPayload(rec, runningPdf, fileName),
  });
  // 槽位满（正常不会发生：刷新后 store 为空，在跑数 ≤ 通道并发上限）——放弃监控，
  // 该篇 done 会落 pending_done 槽，下次启动走情形 B 补落库
  if (!occ) return;
  occ.reportExtra({ stages: buildPdfStages() });
  occ.report(0, "解析进行中（页面刷新后恢复监控）…");

  let settled = false;
  let unlisten: (() => void) | null = null;
  let lastPercent = 0;
  const settleRecovered = (finalStatus: "success" | "error" | "cancelled", error?: string) => {
    if (settled) return;
    settled = true;
    unlisten?.();
    clearPaperTaskRecord(runningPdf);
    // 释放并发槽 + 排队接续在 settleRecoveredTask 内完成（对齐旧 settleRecovered 收尾语义）；
    // 列表刷新由通道活跃→空闲沿的订阅统一触发
    useTaskCenterStore.getState().settleRecoveredTask(occ.taskId, finalStatus, error);
  };
  // 取消按钮（cancelPaperImport → cancelTask → signal）驱动恢复任务即时结算：先结算再定向杀进程
  occ.signal.addEventListener("abort", () => {
    settleRecovered("cancelled");
    void cancelPaperPdfImport(runningPdf).catch(() => {});
  });

  try {
    unlisten = await listenPaperConvertProgress(async (progress) => {
      // 任务归属过滤（对齐 runParseInner：不归本任务的事件一律忽略）
      if (progress.pdf_path && progress.pdf_path !== runningPdf) return;
      if (settled) return;
      if (progress.type === "progress" || progress.type === "stage_done") {
        if (progress.percent != null) lastPercent = progress.percent;
        if (progress.stage !== undefined) {
          occ.reportExtra({
            stages: markStages(
              stagesOf(occ.taskId),
              progress.stage,
              progress.type === "stage_done" ? "done" : "active",
            ),
          });
        }
        occ.report(lastPercent, progress.detail);
        return;
      }
      if (progress.type === "done" && progress.paper_dir) {
        const r = await settleRecoveredDone(
          {
            pdfPath: progress.pdf_path ?? runningPdf,
            paperDir: progress.paper_dir,
            title: progress.title,
            slug: progress.slug,
            degenerate: progress.degenerate,
            incomplete: progress.incomplete,
          },
          rec,
          occ,
          occ.taskId,
        );
        settleRecovered(r.outcome === "failed" ? "error" : "success", r.outcome === "failed" ? r.error : undefined);
        return;
      }
      if (progress.type === "error") {
        settleRecovered("error", progress.message ?? "解析失败");
        return;
      }
      if (progress.type === "terminated") {
        settleRecovered(
          progress.success === false ? "error" : "cancelled",
          progress.success === false ? "解析进程异常退出" : undefined,
        );
      }
    });
  } catch {
    // 监听注册失败：进程还在跑但接不上事件——按中断处理并释放并发槽
    settleRecovered("error", "恢复解析监控失败，请查看日志后重新发起");
    return;
  }

  // 竞态收口：监听挂好的空窗内进程可能已退场（done/error 无人接收）→ 复查状态直结
  const recheck = await getPaperConvertStatus().catch(() => null);
  if (!settled && recheck && !recheck.runningPdfPaths.includes(runningPdf)) {
    const pending = recheck.pendingDones.find((d) => d.pdfPath === runningPdf);
    if (pending) {
      const r = await settleRecoveredDone(pending, rec, occ, occ.taskId);
      settleRecovered(r.outcome === "failed" ? "error" : "success", r.outcome === "failed" ? r.error : undefined);
    } else {
      settleRecovered("error", "解析在恢复监控前已中断");
    }
  }
}

/** 页面刷新后的解析通道恢复（GlobalConvertProgress 挂载时经 convert-progress-store 薄壳调用一次；幂等）。
 *  P3 多任务版：pending_dones 逐条情形 B 补落库、running_pdf_paths 逐条情形 A 接管、
 *  两边都不搭界的残留记录按情形 C 出错误卡。 */
export async function recoverPaperParseAfterReload(): Promise<void> {
  if (paperRecoveryAttempted) return;
  paperRecoveryAttempted = true;
  // 实时通道健在（未刷新/已起泵/运行中任务在）→ 不恢复（对齐旧「draining 或卡在跑」判定）
  const st = useTaskCenterStore.getState();
  const agg0 = selectChannelAggregate(st, "paper-parse");
  if (agg0.current !== null || agg0.queuedCount > 0) return;

  const status = await getPaperConvertStatus().catch(() => null);
  if (!status) return;
  const records = readAllPaperTaskRecords();

  // 情形 B：done 产物滞留（可多条；含「done 已发但进程未退」的刷新瞬间——产物已可消费，不必再等进程）
  const pendingPdfs = new Set<string>();
  for (const pending of status.pendingDones) {
    pendingPdfs.add(pending.pdfPath);
    const rec = records[pending.pdfPath] ?? null;
    delete records[pending.pdfPath];
    const fileName = rec?.title || pending.title || pdfFileName(pending.pdfPath);
    const occ = st.occupyForRecovery({
      channel: "paper-parse",
      targetId: recoveredTargetId(rec, pending.pdfPath),
      title: fileName,
      payload: recoveredPayload(rec, pending.pdfPath, fileName),
    });
    // 槽位满（理论上不会发生）→ 滞留槽保留在 pending_done，下次启动重试
    if (!occ) continue;
    occ.report(100, "恢复解析产物入库（页面刷新前已完成解析）…");
    const settledDone = await settleRecoveredDone(pending, rec, occ, occ.taskId);
    clearPaperTaskRecord(pending.pdfPath);
    useTaskCenterStore
      .getState()
      .settleRecoveredTask(
        occ.taskId,
        settledDone.outcome === "failed" ? "error" : "success",
        settledDone.outcome === "failed" ? settledDone.error : undefined,
      );
  }

  // 情形 A：仍在跑的逐条接管（pending 已覆盖的同源跳过——done 已落槽被情形 B 消费）
  for (const runningPdf of status.runningPdfPaths) {
    if (pendingPdfs.has(runningPdf)) continue;
    const rec = records[runningPdf] ?? null;
    delete records[runningPdf];
    await recoverRunningTask(runningPdf, rec);
  }

  // 情形 C：残留记录既不在跑也无产物 = error/terminated 丢失在刷新窗口（每条一张错误卡）
  for (const record of Object.values(records)) {
    clearPaperTaskRecord(record.pdfPath);
    const fileName = record.title || pdfFileName(record.pdfPath);
    const occ = st.occupyForRecovery({
      channel: "paper-parse",
      targetId: recoveredTargetId(record, record.pdfPath),
      title: fileName,
      payload: recoveredPayload(record, record.pdfPath, fileName),
    });
    if (occ) st.settleRecoveredTask(occ.taskId, "error", "解析在页面刷新期间中断，请重新发起");
  }
}
