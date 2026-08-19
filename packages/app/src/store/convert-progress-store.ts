/**
 * 全局转换进度 store：论文 PDF 解析导入 + 图书 PDF→EPUB 转换。
 *
 * 两类长任务此前都把运行状态放在页面组件里（PapersPage / ConverterPage），
 * 离开页面即丢卡（论文）或丢监听（图书——窗口被点掉后转换进程还在跑，
 * 但进度/结果再无人接收，用户无从判断是后台进行还是静默中断，2026-08-14 实证）。
 * 现统一沉到模块级 store：队列与事件监听的生命周期独立于任何视图，
 * 右下角全局进度卡（components/global-convert-progress）跨页面呈现，
 * 仅在全局助手聊天页与书籍/论文阅读器三个视图豁免（避免遮挡正文）。
 */

import { callMcpServerTool, findZoteroBrainServer, parseMcpToolJson } from "@/ai/mcp/mcp-manager";
import { parsePaperMarkdown } from "@/pages/paper-reader/paper-metadata";
import {
  type ConvertProgress,
  cancelConvert,
  importConvertedEpub,
  listenConvertProgress,
  startConvert,
} from "@/services/converter-service";
import { invalidateLibraryPaperIndex } from "@/services/paper-reference-service";
import {
  type PaperConvertProgress,
  cancelPaperPdfImport,
  importPapers,
  listenPaperConvertProgress,
  paperEngineTokenError,
  startPaperPdfImport,
} from "@/services/paper-service";
import { useConverterStore } from "@/store/converter-store";
import { useLibraryStore } from "@/store/library-store";
import { findDegenerateLoop } from "@/utils/degenerate";
import { join } from "@tauri-apps/api/path";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { toast } from "sonner";
import { create } from "zustand";

// ----------------------------------------------------------------------
// 论文 PDF 解析导入（状态类型自 PapersPage 迁入，字段不变）
// ----------------------------------------------------------------------
export type PdfStageStatus = "pending" | "active" | "done" | "error";
/** 单篇结算结果：队列据此计数并推进（skipped = 已入库过内容未变化） */
export type PdfOutcome = "imported" | "skipped" | "failed" | "cancelled";

export interface PaperImportState {
  status: "running" | "success" | "error";
  fileName: string;
  /** 总进度：按篇数加权（(k-1+当前篇percent/100)/N） */
  percent: number;
  detail: string;
  /** 当前篇的四阶段 */
  stages: { n: number; name: string; status: PdfStageStatus }[];
  error?: string;
  title?: string;
  /** 队列位置：当前第几篇 / 共几篇（单篇时均为 1，卡片不显示批次信息） */
  index: number;
  total: number;
  /** 已结算计数（成功入库 / 跳过 / 失败） */
  importedCount: number;
  skippedCount: number;
  failedCount: number;
  /** 失败文件名（收尾卡列出） */
  failedNames: string[];
}

const PDF_STAGE_NAMES = ["OCR 解析", "元数据提取", "内容处理", "渲染装订"];

function buildPdfStages(): PaperImportState["stages"] {
  return PDF_STAGE_NAMES.map((name, i) => ({ n: i + 1, name, status: "pending" as PdfStageStatus }));
}

/** 更新某阶段状态（active 时把之前阶段全部置 done） */
function markStages(stages: PaperImportState["stages"], n: number | undefined, status: PdfStageStatus) {
  if (!n) return stages;
  return stages.map((s) => ({
    ...s,
    status: s.n < n ? "done" : s.n === n ? status : s.status,
  }));
}

// ----------------------------------------------------------------------
// 图书 PDF→EPUB 转换（状态类型自 ConverterPage 迁入，字段不变 + 配置项）
// ----------------------------------------------------------------------
export type BookConvertStatus = "idle" | "converting" | "done" | "error";
export type BookStageStatus = "pending" | "active" | "done" | "error";

export interface BookStageState {
  n: number;
  name: string;
  status: BookStageStatus;
  elapsed?: number;
}

export interface BookConvertState {
  status: BookConvertStatus;
  pdfPath: string | null;
  ocr: boolean;
  translate: string;
  percent: number;
  detail: string;
  stages: BookStageState[];
  errorMessage: string;
  epubPath: string | null;
  importing: boolean;
}

const BOOK_CONVERT_INITIAL: BookConvertState = {
  status: "idle",
  pdfPath: null,
  ocr: true,
  translate: "none",
  percent: 0,
  detail: "",
  stages: [],
  errorMessage: "",
  epubPath: null,
  importing: false,
};

/** 按是否翻译与引擎构建阶段流水线（编号对齐后端协议：无翻译 1/2/3，有翻译 1/2/3/4） */
function buildBookStages(withTranslate: boolean, engine: "mineru" | "paddleocr"): BookStageState[] {
  const stages = [
    { n: 1, name: engine === "paddleocr" ? "PaddleOCR 解析" : "MinerU 解析" },
    { n: 2, name: "Hybrid 结构重建" },
  ];
  if (withTranslate) stages.push({ n: 3, name: "全书翻译" });
  stages.push({ n: withTranslate ? 4 : 3, name: "EPUB 生成" });
  return stages.map((s) => ({ ...s, status: "pending" as BookStageStatus }));
}

// ----------------------------------------------------------------------
// store 本体
// ----------------------------------------------------------------------
interface ConvertProgressState {
  paperImport: PaperImportState | null;
  bookConvert: BookConvertState;
  /** 图书转换大窗口（图书馆页弹层）是否打开 */
  bookConvertDialogOpen: boolean;
  /** 图书转换是否最小化（右下角小卡呈现；点击小卡还原大窗口） */
  bookConvertMinimized: boolean;

  setPaperImportDismissed: () => void;
  openBookConvertDialog: () => void;
  /** 关闭图书转换大窗口：转换中/有结果 → 最小化为右下角小卡；空闲 → 彻底关闭 */
  closeBookConvertDialog: () => void;
  setBookConvertConfig: (patch: Pick<BookConvertState, "ocr" | "translate"> | { pdfPath: string | null }) => void;
  startBookConvert: () => Promise<void>;
  cancelBookConvert: () => Promise<void>;
  importBookConvertResult: () => Promise<void>;
  /** 丢弃图书转换状态（小卡 X / 换文件重置）：解除监听回到 idle */
  resetBookConvert: () => void;
}

export const useConvertProgressStore = create<ConvertProgressState>()((set, get) => ({
  paperImport: null,
  bookConvert: BOOK_CONVERT_INITIAL,
  bookConvertDialogOpen: false,
  bookConvertMinimized: false,

  setPaperImportDismissed: () => {
    dismissPaperImport();
  },

  openBookConvertDialog: () => {
    set({ bookConvertDialogOpen: true, bookConvertMinimized: false });
  },

  closeBookConvertDialog: () => {
    const { status } = get().bookConvert;
    set({
      bookConvertDialogOpen: false,
      // 空闲态直接关掉（无任务可跟踪）；转换中/有结果/失败 → 缩为小卡持续可见
      bookConvertMinimized: status !== "idle",
    });
  },

  setBookConvertConfig: (patch) => {
    set((s) => ({ bookConvert: { ...s.bookConvert, ...patch } }));
  },

  startBookConvert: async () => {
    const { pdfPath, ocr, translate } = get().bookConvert;
    if (!pdfPath) return;
    // 结果区重置 + 阶段流水线构建（与旧 ConverterPage.handleStart 一致）
    set((s) => ({
      bookConvert: {
        ...s.bookConvert,
        status: "converting",
        percent: 0,
        detail: "",
        stages: buildBookStages(translate !== "none", useConverterStore.getState().engine),
        errorMessage: "",
        epubPath: null,
      },
    }));
    try {
      bookUnlisten?.();
      bookUnlisten = await listenConvertProgress(handleBookProgress);
      await startConvert(pdfPath, ocr, translate === "none" ? undefined : translate);
    } catch (e) {
      markBookActiveError();
      set((s) => ({
        bookConvert: { ...s.bookConvert, status: "error", errorMessage: e instanceof Error ? e.message : String(e) },
      }));
    }
  },

  cancelBookConvert: async () => {
    try {
      await cancelConvert();
    } catch (e) {
      console.warn("取消转换失败:", e);
    }
    set((s) => ({ bookConvert: { ...s.bookConvert, status: "idle" } }));
    toast.info("已取消转换");
  },

  importBookConvertResult: async () => {
    const { epubPath } = get().bookConvert;
    if (!epubPath) return;
    set((s) => ({ bookConvert: { ...s.bookConvert, importing: true } }));
    try {
      await importConvertedEpub(epubPath);
      await useLibraryStore.getState().refreshBooks();
      toast.success("已导入图书馆");
      resetBookConvertState();
    } catch (e) {
      toast.error(`导入失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      set((s) => ({ bookConvert: { ...s.bookConvert, importing: false } }));
    }
  },

  resetBookConvert: () => {
    resetBookConvertState();
  },
}));

// zustand 模块内辅助：直接走 setState，避免把 set 混进 state
function resetBookConvertState() {
  bookUnlisten?.();
  bookUnlisten = null;
  const prev = useConvertProgressStore.getState().bookConvert;
  // 配置项（文件/OCR/翻译）保留，运行结果清空
  useConvertProgressStore.setState({
    bookConvert: { ...BOOK_CONVERT_INITIAL, pdfPath: prev.pdfPath, ocr: prev.ocr, translate: prev.translate },
    bookConvertMinimized: false,
  });
}

function markBookActiveError() {
  useConvertProgressStore.setState((s) => ({
    bookConvert: {
      ...s.bookConvert,
      stages: s.bookConvert.stages.map((st) => (st.status === "active" ? { ...st, status: "error" } : st)),
    },
  }));
}

/** Books_Converter 进度事件 → store（监听挂在模块级，视图卸载不影响接收） */
let bookUnlisten: (() => void) | null = null;

function handleBookProgress(p: ConvertProgress) {
  useConvertProgressStore.setState((s) => {
    const bookConvert = s.bookConvert;
    const patch: Partial<BookConvertState> = {};
    if (p.percent !== undefined) patch.percent = p.percent;
    if (p.detail) patch.detail = p.detail;
    switch (p.type) {
      case "progress":
        if (p.stage !== undefined) {
          patch.stages = bookConvert.stages.map((st) =>
            st.n === p.stage && st.status !== "done" ? { ...st, status: "active" as BookStageStatus } : st,
          );
        }
        break;
      case "stage_done":
        if (p.stage !== undefined) {
          patch.stages = bookConvert.stages.map((st) =>
            st.n === p.stage ? { ...st, status: "done" as BookStageStatus, elapsed: p.elapsed } : st,
          );
        }
        break;
      case "done":
        patch.stages = bookConvert.stages.map((st) => ({ ...st, status: "done" as BookStageStatus }));
        if (p.epub_path) patch.epubPath = p.epub_path;
        patch.percent = 100;
        patch.status = "done";
        break;
      case "error":
        patch.stages = bookConvert.stages.map((st) => (st.status === "active" ? { ...st, status: "error" } : st));
        patch.errorMessage = p.message || "转换失败";
        patch.status = "error";
        break;
      case "terminated":
        // 进程退出但未收到 done/error（崩溃等），避免状态卡死在 converting
        if (bookConvert.status === "converting") {
          patch.stages = bookConvert.stages.map((st) => (st.status === "active" ? { ...st, status: "error" } : st));
          patch.errorMessage = "转换进程意外退出，请查看日志";
          patch.status = "error";
        }
        break;
    }
    return { bookConvert: { ...bookConvert, ...patch } };
  });
}

// ----------------------------------------------------------------------
// 论文 PDF 解析导入队列（模块级，逻辑自 PapersPage 迁入不变）
// ----------------------------------------------------------------------
let paperCancelRequested = false;
let paperCurrentSettle: (() => void) | null = null;
/** 批量结算后的列表刷新回调（PapersPage 挂载时注册，卸载置空——页面重进时会全量加载） */
let paperRefresh: (() => void) | null = null;

export function setPaperImportRefresh(fn: (() => void) | null) {
  paperRefresh = fn;
}

/** 启动批量解析导入（PapersPage 弹窗确认与页面拖入共用入口；folderId 在启动时定格） */
export async function startPaperImportBatch(incomingPaths: string[], folderId?: string) {
  let paths = incomingPaths;
  const { paperEngine } = useConverterStore.getState();
  const tokenError = paperEngineTokenError(paperEngine);
  if (tokenError) {
    toast.error(tokenError);
    return;
  }
  if (paths.length === 0) return;
  const { paperImport } = useConvertProgressStore.getState();
  if (paperImport?.status === "running") {
    toast.info("已有解析任务进行中");
    return;
  }

  // 预转换去重（PDF 内容哈希）：批内重复 + 与库中 source.pdf 相同的——
  // 不烧解析配额直接跳过；全部重复则连队列都不起
  try {
    const { findPaperDuplicates } = await import("@/services/paper-dedup");
    const dup = await findPaperDuplicates(paths);
    if (dup.size > 0) {
      let batchDup = 0;
      let inLibrary = 0;
      for (const [, v] of dup) {
        if (v.kind === "batch") batchDup += 1;
        else inLibrary += 1;
      }
      const parts: string[] = [];
      if (inLibrary > 0) {
        const names = [...new Set([...dup.values()].filter((v) => v.kind === "library").map((v) => `《${v.title}》`))];
        parts.push(
          `已在库中（PDF 内容一致）：${names.slice(0, 3).join("、")}${names.length > 3 ? ` 等 ${names.length} 篇` : ""}`,
        );
      }
      if (batchDup > 0) parts.push(`批内重复 ${batchDup} 份（只解析首份）`);
      toast.info(`已跳过 ${dup.size} 份重复 PDF——${parts.join("；")}`, { duration: 6000 });
      paths = paths.filter((p) => !dup.has(p));
      if (paths.length === 0) return;
    }
  } catch (e) {
    console.warn("预转换去重失败（继续正常解析）:", e);
  }

  paperCancelRequested = false;
  const setPaperImport = (updater: (prev: PaperImportState | null) => PaperImportState | null) =>
    useConvertProgressStore.setState((s) => ({ paperImport: updater(s.paperImport) }));

  const total = paths.length;
  let imported = 0;
  let skipped = 0;
  let failed = 0;
  const failedNames: string[] = [];

  // Rust 侧 convert_paper_pdf 是单子进程：逐篇串行，等当前篇结算再下一篇（单篇失败不中断队列）
  for (let i = 0; i < total; i++) {
    if (paperCancelRequested) break;
    const pdfPath = paths[i];
    const fileName = pdfPath.split(/[\\/]/).pop() ?? pdfPath;
    setPaperImport(() => ({
      status: "running",
      fileName,
      percent: Math.round((i / total) * 100),
      detail: "启动解析…",
      stages: buildPdfStages(),
      index: i + 1,
      total,
      importedCount: imported,
      skippedCount: skipped,
      failedCount: failed,
      failedNames: [...failedNames],
    }));
    const outcome = await runOnePdf(pdfPath, i + 1, total, folderId);
    if (outcome === "imported") imported += 1;
    else if (outcome === "skipped") skipped += 1;
    else if (outcome === "failed") {
      failed += 1;
      failedNames.push(fileName);
    } else {
      paperCancelRequested = true;
    }
  }

  // 全部（或取消前已完成部分）结算后刷新列表（页面不在场时跳过，重进自会加载）
  paperRefresh?.();

  if (paperCancelRequested) {
    const remaining = total - imported - skipped - failed;
    setPaperImport((prev) =>
      prev
        ? {
            ...prev,
            status: "error",
            error:
              total === 1
                ? "已取消解析"
                : `已取消：完成 ${imported} 篇${skipped > 0 ? ` · 跳过 ${skipped}` : ""}${failed > 0 ? ` · 失败 ${failed}` : ""}，剩余 ${remaining} 篇未解析`,
            importedCount: imported,
            skippedCount: skipped,
            failedCount: failed,
            failedNames: [...failedNames],
          }
        : prev,
    );
    return;
  }
  // 批量收尾卡：汇总完成/跳过/失败（单篇保持 runOnePdf 写好的原收尾文案）
  if (total > 1) {
    const extras: string[] = [];
    if (skipped > 0) extras.push(`跳过 ${skipped}`);
    if (failed > 0) extras.push(`失败 ${failed}`);
    const summary = `完成 ${imported} 篇${extras.length > 0 ? `（${extras.join(" · ")}）` : ""}`;
    setPaperImport((prev) =>
      prev
        ? {
            ...prev,
            status: "success",
            percent: 100,
            detail: summary,
            stages: prev.stages.map((s) => ({ ...s, status: "done" as PdfStageStatus })),
            importedCount: imported,
            skippedCount: skipped,
            failedCount: failed,
            failedNames: [...failedNames],
          }
        : prev,
    );
    if (failed > 0) toast.error(`批量解析结束：${failed} 篇失败`);
    else toast.success(`批量解析完成：${summary}`);
  }
}

/** 解析单篇并等待结算：注册进度监听 → 启动转换 → done 后入库；失败/取消也正常结算（队列据此推进）。
 * stageOffset：调用方在解析阶段前插了前置段（如获取 PDF 的下载段）时，进度事件的阶段号按偏移对齐。 */
async function runOnePdf(
  pdfPath: string,
  index: number,
  total: number,
  folderId?: string,
  stageOffset = 0,
): Promise<PdfOutcome> {
  const fileName = pdfPath.split(/[\\/]/).pop() ?? pdfPath;
  let filePercent = 0;
  const weighted = (p: number) => Math.round(((index - 1 + p / 100) / total) * 100);
  const setPaperImport = (updater: (prev: PaperImportState | null) => PaperImportState | null) =>
    useConvertProgressStore.setState((s) => ({ paperImport: updater(s.paperImport) }));
  let settled = false;
  let unlisten: (() => void) | null = null;
  let resolveOutcome: (outcome: PdfOutcome) => void = () => {};
  const outcomePromise = new Promise<PdfOutcome>((resolve) => {
    resolveOutcome = resolve;
  });
  const settle = (outcome: PdfOutcome) => {
    if (settled) return;
    settled = true;
    unlisten?.();
    paperCurrentSettle = null;
    resolveOutcome(outcome);
  };
  paperCurrentSettle = () => settle("cancelled");

  try {
    unlisten = await listenPaperConvertProgress(async (progress: PaperConvertProgress) => {
      if (progress.type === "progress" || progress.type === "stage_done") {
        if (progress.percent != null) filePercent = progress.percent;
        const stage = progress.stage === undefined ? undefined : progress.stage + stageOffset;
        setPaperImport((prev) =>
          prev && prev.status === "running"
            ? {
                ...prev,
                percent: weighted(filePercent),
                detail: progress.detail ?? prev.detail,
                stages: markStages(prev.stages, stage, progress.type === "stage_done" ? "done" : "active"),
              }
            : prev,
        );
        return;
      }
      if (progress.type === "done" && progress.paper_dir) {
        try {
          const result = await importPapers(progress.paper_dir, folderId);
          setPaperImport((prev) =>
            prev
              ? {
                  ...prev,
                  status: "success",
                  percent: weighted(100),
                  title: progress.title,
                  detail: `已入库《${progress.title ?? progress.slug}》`,
                  stages: prev.stages.map((s) => ({ ...s, status: "done" as PdfStageStatus })),
                }
              : prev,
          );
          if (result.skipped > 0 && result.imported === 0) {
            toast.info(total > 1 ? `「${fileName}」已入库过（内容未变化）` : "该论文已入库过（内容未变化）");
            settle("skipped");
          } else {
            toast.success(`论文解析入库完成：${progress.title ?? progress.slug}`);
            // 完整性闸（converter 重试+降级后仍缺内容）：明确提示，不静默交付
            if (progress.incomplete === true) {
              toast.warning(`《${progress.title ?? progress.slug}》检测到内容缺失（图/表或整页未解析出）`, {
                description: `${progress.qc_warnings?.[0] ?? "完整性检查未通过"}。建议在 设置 → PDF 转换 中更换解析引擎后重新解析`,
                duration: 10000,
              });
            }
            // 退化循环检测（引擎 VLM 偶发模式延续失控）：本地检测 + converter 质量守卫双通道
            try {
              const raw = await readTextFile(await join(progress.paper_dir, "paper.md"));
              if (progress.degenerate === true || findDegenerateLoop(parsePaperMarkdown(raw).body)) {
                toast.warning(`《${progress.title ?? progress.slug}》检测到异常重复内容（解析引擎失控）`, {
                  description: "建议在 设置 → PDF 转换 中更换解析引擎后重新解析",
                  duration: 8000,
                });
              }
            } catch {
              // 检测失败不影响入库
            }
            settle("imported");
          }
        } catch (error) {
          const message = `解析成功但入库失败：${error instanceof Error ? error.message : String(error)}`;
          setPaperImport((prev) => (prev ? { ...prev, status: "error", error: message } : prev));
          if (total > 1) toast.error(`「${fileName}」${message}`);
          settle("failed");
        }
        return;
      }
      if (progress.type === "error") {
        const message = progress.message ?? "解析失败";
        setPaperImport((prev) => (prev ? { ...prev, status: "error", error: message } : prev));
        if (total > 1) toast.error(`「${fileName}」解析失败：${message}`);
        settle("failed");
        return;
      }
      if (progress.type === "terminated") {
        setPaperImport((prev) =>
          prev && prev.status === "running"
            ? { ...prev, status: "error", error: progress.success === false ? "解析进程异常退出" : "解析已取消" }
            : prev,
        );
        settle(progress.success === false ? "failed" : "cancelled");
      }
    });
    await startPaperPdfImport(pdfPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setPaperImport((prev) => (prev ? { ...prev, status: "error", error: message } : prev));
    if (total > 1) toast.error(`「${fileName}」${message}`);
    settle("failed");
  }
  return outcomePromise;
}

/** 取消解析：kill 当前篇子进程并立即结算当前篇（队列不再推进，卡片显示部分结果；幂等） */
export async function cancelPaperImport() {
  paperCancelRequested = true;
  try {
    await cancelPaperPdfImport();
  } catch (error) {
    console.warn("取消论文解析失败:", error);
  }
  paperCurrentSettle?.();
  useConvertProgressStore.setState((s) => ({
    paperImport:
      s.paperImport && s.paperImport.status === "running"
        ? { ...s.paperImport, status: "error", error: "已取消解析" }
        : s.paperImport,
  }));
}

/** 关闭论文进度卡（running 时等同取消） */
export function dismissPaperImport() {
  const { paperImport } = useConvertProgressStore.getState();
  if (paperImport?.status === "running") {
    void cancelPaperImport();
    return;
  }
  useConvertProgressStore.setState({ paperImport: null });
}

/**
 * P2 参考文献卡片「获取 PDF」全链路入口：Zotero Brain 下载 → 解析 → 入库。
 * 下载可能分钟级（多源瀑布），作为前置阶段进全局进度卡（可见性规则与转换进度层一致：
 * 右下角常驻，阅读/聊天视图豁免）；解析复用 runOnePdf（事件阶段号 +1 对齐前置下载段）。
 * 失败落在进度卡 error 态并 toast（阅读器内 toast 可见，不依赖豁免视图的卡片）。
 */
export async function startPaperAcquireImport(input: { doi?: string; title: string; url?: string }): Promise<void> {
  const setPaperImport = (updater: (prev: PaperImportState | null) => PaperImportState | null) =>
    useConvertProgressStore.setState((s) => ({ paperImport: updater(s.paperImport) }));
  if (useConvertProgressStore.getState().paperImport?.status === "running") {
    toast.info("已有解析任务进行中");
    return;
  }
  const fail = (message: string) => {
    setPaperImport((prev) =>
      prev
        ? {
            ...prev,
            status: "error",
            error: message,
            stages: prev.stages.map((s) => (s.status === "active" ? { ...s, status: "error" as PdfStageStatus } : s)),
          }
        : prev,
    );
    toast.error(message);
  };

  // 阶段流水线：1=Zotero Brain 下载（active），2-5=解析四阶段（事件 stage 经 runOnePdf 偏移对齐）
  setPaperImport(() => ({
    status: "running",
    fileName: input.title || input.doi || "参考文献",
    percent: 0,
    detail: "经 Zotero Brain 下载 PDF…",
    stages: [
      { n: 1, name: "Zotero Brain 下载 PDF", status: "active" as PdfStageStatus },
      ...buildPdfStages().map((s) => ({ ...s, n: s.n + 1 })),
    ],
    index: 1,
    total: 1,
    importedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    failedNames: [],
  }));

  const server = findZoteroBrainServer();
  if (!server) {
    fail("未配置 Zotero Brain MCP，请到 AI 中心 → MCP 配置后重试");
    return;
  }
  // 阅读/聊天视图豁免进度卡：启动即 toast 让当前视图有即时反馈
  toast.info("已开始获取 PDF（Zotero Brain 下载中），完成后自动解析入库");
  let pdfPath: string;
  try {
    const raw = await callMcpServerTool(server, "download_paper", {
      doi: input.doi,
      title: input.title,
      url: input.url,
    });
    const result = parseMcpToolJson(raw);
    if (!result?.success || typeof result?.pdf_path !== "string" || !result.pdf_path) {
      // 兼容 no_pdf 结构化返回（reason/tried/landing_page）与旧版 {message}
      const reason = result?.reason ?? result?.message ?? "全部下载源失败";
      fail(`未能获取 PDF：${reason}${result?.landing_page ? "，可经「访问页面」人工下载" : ""}`);
      return;
    }
    pdfPath = result.pdf_path;
  } catch (error) {
    fail(`获取 PDF 失败：${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  setPaperImport((prev) =>
    prev ? { ...prev, detail: "PDF 下载完成，开始解析…", stages: markStages(prev.stages, 1, "done") } : prev,
  );
  const outcome = await runOnePdf(pdfPath, 1, 1, undefined, 1);
  // 新入库论文加入在库检查索引（引用卡片「打开」即时可见）
  if (outcome === "imported") invalidateLibraryPaperIndex();
}
