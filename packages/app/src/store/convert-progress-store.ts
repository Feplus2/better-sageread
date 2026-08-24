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
import { type PaperMetadata, parsePaperMarkdown } from "@/pages/paper-reader/paper-metadata";
import {
  type ConvertProgress,
  cancelConvert,
  importConvertedEpub,
  listenConvertProgress,
  startConvert,
} from "@/services/converter-service";
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
  paperEngineTokenError,
  startPaperPdfImport,
} from "@/services/paper-service";
import { useConverterStore } from "@/store/converter-store";
import { useLayoutStore } from "@/store/layout-store";
import { useLibraryStore } from "@/store/library-store";
import { findDegenerateLoop } from "@/utils/degenerate";
import { invoke } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { toast } from "sonner";
import { create } from "zustand";
import { isPaperTaskActive, usePaperTaskRegistry } from "./paper-task-registry";

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
  /** 队列位置：当前第几篇 / 共几篇（单篇时均为 1，卡片不显示批次信息；N 动态含排队中篇数） */
  index: number;
  total: number;
  /** 排队待处理篇数（0 时不展示） */
  queuedCount: number;
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
  /** AI 工具 convertPdf 的托管转换标记：done 后自动入库（人工大窗口路径缺省 false，等用户点「导入」） */
  autoImport?: boolean;
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
  /** 重解析完成标记（paperId → 完成时间戳）：仅当该篇有打开的标签页时写入；
   *  阅读器据此刻意出「已重新解析」横幅（不自动刷新，避免打断阅读位置） */
  reparsedPapers: Record<string, number>;
  /** 阅读器「重新加载」后回执清除标记 */
  ackPaperReparsed: (paperId: string) => void;
  /** 图书转换大窗口（图书馆页弹层）是否打开 */
  bookConvertDialogOpen: boolean;
  /** 图书转换是否最小化（右下角小卡呈现；点击小卡还原大窗口） */
  bookConvertMinimized: boolean;

  setPaperImportDismissed: () => void;
  openBookConvertDialog: () => void;
  /** 关闭图书转换大窗口：转换中/有结果 → 最小化为右下角小卡；空闲 → 彻底关闭 */
  closeBookConvertDialog: () => void;
  setBookConvertConfig: (
    patch: Partial<Pick<BookConvertState, "ocr" | "translate"> | { pdfPath: string | null }>,
  ) => void;
  startBookConvert: () => Promise<void>;
  /** AI 工具 convertPdf 的托管转换入口：单飞守卫 → 右下角小卡跟踪 → done 自动入库；10 分钟无终态兜底错误 */
  startBookConvertAuto: (input: { pdfPath: string; ocr: boolean; translate?: string }) => Promise<void>;
  cancelBookConvert: () => Promise<void>;
  importBookConvertResult: () => Promise<void>;
  /** 丢弃图书转换状态（小卡 X / 换文件重置）：解除监听回到 idle */
  resetBookConvert: () => void;
}

export const useConvertProgressStore = create<ConvertProgressState>()((set, get) => ({
  paperImport: null,
  bookConvert: BOOK_CONVERT_INITIAL,
  reparsedPapers: {},

  ackPaperReparsed: (paperId) => {
    set((s) => {
      if (!(paperId in s.reparsedPapers)) return s;
      const next = { ...s.reparsedPapers };
      delete next[paperId];
      return { reparsedPapers: next };
    });
  },
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
        // 人工路径显式复位托管标记（防沿用上一轮 convertPdf 的 autoImport 而误自动入库）
        autoImport: false,
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

  startBookConvertAuto: async ({ pdfPath, ocr, translate }) => {
    // 后端为单子进程模型（converter.rs 单 child），事件无归属字段——单飞即归属，有任务在跑时拒起
    if (get().bookConvert.status === "converting") {
      throw new Error("已有 PDF 转换任务进行中，请待其完成后再试");
    }
    clearBookAutoTimeout();
    set((s) => ({
      bookConvert: {
        ...s.bookConvert,
        pdfPath,
        ocr,
        translate: translate ?? "none",
        status: "converting",
        percent: 0,
        detail: "",
        stages: buildBookStages(!!translate && translate !== "none", useConverterStore.getState().engine),
        errorMessage: "",
        epubPath: null,
        autoImport: true,
      },
      // 托管路径无人盯大窗口：直接以右下角小卡呈现进度（与人工转换最小化同款卡片）
      bookConvertMinimized: true,
    }));
    // 长超时兜底：进程静默卡死且连 terminated 都丢失时给出错误态（10 分钟足以覆盖正常转换）
    bookAutoTimeout = setTimeout(() => {
      bookAutoTimeout = null;
      if (useConvertProgressStore.getState().bookConvert.status !== "converting") return;
      markBookActiveError();
      useConvertProgressStore.setState((s) => ({
        bookConvert: { ...s.bookConvert, status: "error", errorMessage: "转换超时（10 分钟无完成回执），已取消进程" },
      }));
      void cancelConvert().catch(() => {});
    }, BOOK_AUTO_TIMEOUT_MS);
    try {
      bookUnlisten?.();
      bookUnlisten = await listenConvertProgress(handleBookProgress);
      await startConvert(pdfPath, ocr, translate);
    } catch (e) {
      clearBookAutoTimeout();
      markBookActiveError();
      set((s) => ({
        bookConvert: { ...s.bookConvert, status: "error", errorMessage: e instanceof Error ? e.message : String(e) },
      }));
      throw e;
    }
  },

  cancelBookConvert: async () => {
    // 先落 idle 再杀进程：树杀（taskkill /T /F）期间 terminated 事件到达时，
    // handleBookProgress 见状态非 converting 不再误报「意外退出」
    set((s) => ({ bookConvert: { ...s.bookConvert, status: "idle" } }));
    try {
      await cancelConvert();
    } catch (e) {
      console.warn("取消转换失败:", e);
    }
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
  clearBookAutoTimeout();
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

/** 托管转换（convertPdf 工具路径）的超时兜底定时器：10 分钟无终态 → 错误态 + 取消进程 */
const BOOK_AUTO_TIMEOUT_MS = 10 * 60 * 1000;
let bookAutoTimeout: ReturnType<typeof setTimeout> | null = null;

function clearBookAutoTimeout() {
  if (bookAutoTimeout) {
    clearTimeout(bookAutoTimeout);
    bookAutoTimeout = null;
  }
}

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
  // 托管转换（autoImport）终态收尾：解除超时兜底；done 带产物 → 自动入库
  // （导入失败时 importBookConvertResult 内部 toast 且卡片保留 done 态，可点小卡回大窗口手动重试）
  if (p.type === "done" || p.type === "error" || p.type === "terminated") clearBookAutoTimeout();
  if (p.type === "done" && p.epub_path && useConvertProgressStore.getState().bookConvert.autoImport) {
    void useConvertProgressStore.getState().importBookConvertResult();
  }
}

// ----------------------------------------------------------------------
// 论文 PDF 解析导入队列（模块级，逻辑自 PapersPage 迁入）
// 2026-08-20 队列化：运行中新提交入队接续（原来是 toast 拒绝）。
// Rust 侧 convert_paper_pdf 是单子进程，解析段严格串行；获取 PDF 的下载段
// 不占解析子进程，但为状态机简单也随队列串行（下载完即在本 item 内接续解析）。
// ----------------------------------------------------------------------
/** 工作项：parse = 本地 PDF 解析入库；acquire = Zotero Brain 下载后解析入库（P2 参考文献卡片）；
 * reparse = 在库论文源 PDF 重解析并整体替换产物（保留 id/归属/对话/标注） */
type PaperWorkItem =
  | { kind: "parse"; pdfPath: string; folderId?: string }
  | {
      kind: "acquire";
      doi?: string;
      /** 真标题（可空：APS 老版式条目无标题）——只用于 download_paper 的标题校验，空则不校验 */
      title?: string;
      /** 进度卡显示名（真标题缺位时由调用方用 raw 切片兜底——显示串不进检索参数） */
      displayName?: string;
      url?: string;
      arxivId?: string;
    }
  | {
      kind: "reparse";
      paperId: string;
      title: string;
      /** AI 工具 filePath 参数显式指定的源 PDF（入队前已预检存在性，执行侧仍复核；缺省走 zotero 回链 → 书库 source.pdf） */
      sourcePdfPath?: string;
    };

let paperQueue: PaperWorkItem[] = [];
/** 正在执行的队列项（重复入队判定用；item 结算后清空） */
let paperCurrentItem: PaperWorkItem | null = null;
let paperDraining = false;
let paperCancelRequested = false;
let paperCurrentSettle: (() => void) | null = null;
/** 批量结算后的列表刷新回调（PapersPage 挂载时注册，卸载置空——页面重进时会全量加载） */
let paperRefresh: (() => void) | null = null;

export function setPaperImportRefresh(fn: (() => void) | null) {
  paperRefresh = fn;
}

const setPaperImportState = (updater: (prev: PaperImportState | null) => PaperImportState | null) =>
  useConvertProgressStore.setState((s) => ({ paperImport: updater(s.paperImport) }));

/** 启动批量解析导入（PapersPage 弹窗确认与页面拖入共用入口；folderId 在提交时定格。
 *  运行中提交不拒绝：去重后整批入队，当前篇结算后自动接续。 */
export async function startPaperImportBatch(incomingPaths: string[], folderId?: string) {
  let paths = incomingPaths;
  const { paperEngine } = useConverterStore.getState();
  const tokenError = paperEngineTokenError(paperEngine);
  if (tokenError) {
    toast.error(tokenError);
    return;
  }
  if (paths.length === 0) return;

  // 预转换去重（PDF 内容哈希）：批内重复 + 与库中 source.pdf 相同的——
  // 不烧解析配额直接跳过；全部重复则连队列都不进
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

  const wasDraining = paperDraining;
  paperQueue.push(...paths.map((pdfPath): PaperWorkItem => ({ kind: "parse", pdfPath, folderId })));
  // 入队即刷新运行中卡片的队列计数（total/queuedCount 否则要等下一篇启动才更新）
  setPaperImportState((prev) =>
    prev && prev.status === "running"
      ? { ...prev, total: prev.index + paperQueue.length, queuedCount: paperQueue.length }
      : prev,
  );
  if (wasDraining) {
    toast.info(`已加入解析队列（当前任务完成后接续，待处理 ${paperQueue.length} 篇）`);
  }
  void drainPaperQueue();
}

/** P2 参考文献卡片「获取 PDF」入口：Zotero Brain 下载 → 解析 → 入库，随全局队列串行接续 */
export function startPaperAcquireImport(input: {
  doi?: string;
  title?: string;
  displayName?: string;
  url?: string;
  arxivId?: string;
}): void {
  // 引擎 token 在下载前预检：解析段必用，缺失时早失败（不白烧一次下载）
  const { paperEngine } = useConverterStore.getState();
  const tokenError = paperEngineTokenError(paperEngine);
  if (tokenError) {
    toast.error(tokenError);
    return;
  }
  const server = findZoteroBrainServer();
  if (!server) {
    toast.error("未配置 Zotero Brain MCP，请到 AI 中心 → MCP 配置后重试");
    return;
  }
  const wasDraining = paperDraining;
  paperQueue.push({
    kind: "acquire",
    doi: input.doi,
    title: input.title,
    displayName: input.displayName,
    url: input.url,
    arxivId: input.arxivId,
  });
  setPaperImportState((prev) =>
    prev && prev.status === "running"
      ? { ...prev, total: prev.index + paperQueue.length, queuedCount: paperQueue.length }
      : prev,
  );
  // 阅读/聊天视图豁免进度卡：toast 让当前视图有即时反馈
  if (wasDraining) {
    toast.info(`已加入队列（待处理 ${paperQueue.length} 篇），轮到后自动下载解析`);
  } else {
    toast.info("已开始获取 PDF（Zotero Brain 下载中），完成后自动解析入库");
  }
  void drainPaperQueue();
}

/** 该论文是否在解析队列中（排队或正在解析）——重解析防重入/翻译撞车判定共用 */
export function isPaperQueuedOrRunning(paperId: string): boolean {
  if (paperCurrentItem?.kind === "reparse" && paperCurrentItem.paperId === paperId) return true;
  return paperQueue.some((item) => item.kind === "reparse" && item.paperId === paperId);
}

// ---- 向量化 per-paper 跟踪（任务冲突模型：解析×向量化同篇互斥/同篇向量化幂等去重） ----
// 2026-08-24 双轨合一：activeVectorize 唯一事实源收进 paper-task-registry（UI 队列/AI 工具/
// 设置页全量向量化共用）。下面两个函数保持既有导出签名，内部改读/写新注册表——
// startPaperReparse 的互斥判定与 UI 入口的 paperConflicts 由此看到同一个源。
export function markPaperVectorizing(paperId: string, on: boolean): void {
  usePaperTaskRegistry.getState().mark(paperId, "vectorize", on);
}

export function isPaperVectorizing(paperId: string): boolean {
  return isPaperTaskActive(paperId, "vectorize");
}

/** startPaperReparse 的入队结果：message 与 toast 同款文案（AI 工具原样透传为成功/失败消息） */
export interface PaperReparseEnqueue {
  ok: boolean;
  message: string;
}

/** 在库论文重解析入队（PapersPage「重新解析」与 AI 工具 processPaper 的统一入口）：保留 id/归属/对话/标注的产物整体替换。
 *  重复入队/正在向量化/引擎未就绪 → 拒入队并提示；标签页打开中 → 警告引导（不强制）。
 *  filePath：AI 工具显式指定的源 PDF（工具侧已预检存在性）。 */
export function startPaperReparse(
  input: { id: string; title: string; filePath?: string },
  options?: { silent?: boolean },
): PaperReparseEnqueue {
  const { paperEngine } = useConverterStore.getState();
  const tokenError = paperEngineTokenError(paperEngine);
  if (tokenError) {
    toast.error(tokenError);
    return { ok: false, message: tokenError };
  }
  const silent = options?.silent ?? false;
  if (isPaperQueuedOrRunning(input.id)) {
    const message = `《${input.title}》已在解析队列中`;
    if (!silent) toast.info(message);
    return { ok: false, message };
  }
  // 解析 × 向量化（同篇）互斥：向量化读的是旧产物，解析一替换就白算
  if (isPaperVectorizing(input.id)) {
    const message = `《${input.title}》正在向量化，完成后再重新解析`;
    if (!silent) toast.info(message);
    return { ok: false, message };
  }
  // 解析 × 翻译（同篇）互斥（2026-08-23 补）：译文按块索引对齐，重转替换正文会让
  // 在跑的翻译白做（成品译给旧块）——翻译期间拒绝入队
  if (isPaperTaskActive(input.id, "translate")) {
    const message = `《${input.title}》正在翻译，完成后再重新解析（否则在翻的译文会作废）`;
    if (!silent) toast.info(message);
    return { ok: false, message };
  }
  const tabOpen = useLayoutStore.getState().tabs.some((t) => t.id === `paper-${input.id}`);
  if (tabOpen) {
    toast.warning(`《${input.title}》标签页打开中：重新解析将替换产物，建议关闭标签页，完成后重新打开`, {
      duration: 6000,
    });
  }
  const wasDraining = paperDraining;
  paperQueue.push({ kind: "reparse", paperId: input.id, title: input.title, sourcePdfPath: input.filePath });
  setPaperImportState((prev) =>
    prev && prev.status === "running"
      ? { ...prev, total: prev.index + paperQueue.length, queuedCount: paperQueue.length }
      : prev,
  );
  if (wasDraining) {
    const message = `已加入解析队列（待处理 ${paperQueue.length} 篇）`;
    toast.info(message);
    void drainPaperQueue();
    return { ok: true, message };
  }
  void drainPaperQueue();
  return { ok: true, message: `《${input.title}》已开始重新解析` };
}

/** 队列泵：无泵在跑时启动一个，逐 item 串行结算；运行中新提交由循环自然拾取 */
async function drainPaperQueue() {
  if (paperDraining) return;
  paperDraining = true;
  paperCancelRequested = false;
  let imported = 0;
  let skipped = 0;
  let failed = 0;
  const failedNames: string[] = [];
  let completed = 0;

  try {
    while (paperQueue.length > 0) {
      if (paperCancelRequested) break;
      const item = paperQueue.shift() as PaperWorkItem;
      paperCurrentItem = item;
      const total = completed + 1 + paperQueue.length;
      const fileName =
        item.kind === "parse"
          ? (item.pdfPath.split(/[\\/]/).pop() ?? item.pdfPath)
          : item.kind === "reparse"
            ? item.title?.trim() || "重新解析"
            : item.title?.trim() || item.displayName || item.doi || item.arxivId || "参考文献";
      setPaperImportState(() => ({
        status: "running",
        fileName,
        percent: Math.round((completed / total) * 100),
        detail: item.kind === "acquire" ? "经 Zotero Brain 下载 PDF…" : "启动解析…",
        stages:
          item.kind === "acquire"
            ? [
                { n: 1, name: "Zotero Brain 下载 PDF", status: "active" as PdfStageStatus },
                ...buildPdfStages().map((s) => ({ ...s, n: s.n + 1 })),
              ]
            : buildPdfStages(),
        index: completed + 1,
        total,
        queuedCount: paperQueue.length,
        importedCount: imported,
        skippedCount: skipped,
        failedCount: failed,
        failedNames: [...failedNames],
      }));

      let outcome: PdfOutcome;
      if (item.kind === "acquire") {
        const dl = await downloadReferencePdf(item);
        if (dl.cancelled) {
          outcome = "cancelled";
        } else if (!dl.pdfPath) {
          setPaperImportState((prev) =>
            prev
              ? {
                  ...prev,
                  status: "error",
                  error: dl.message ?? "未能获取 PDF",
                  stages: prev.stages.map((s) =>
                    s.status === "active" ? { ...s, status: "error" as PdfStageStatus } : s,
                  ),
                }
              : prev,
          );
          toast.error(dl.message ?? "未能获取 PDF");
          outcome = "failed";
        } else {
          setPaperImportState((prev) =>
            prev ? { ...prev, detail: "PDF 下载完成，开始解析…", stages: markStages(prev.stages, 1, "done") } : prev,
          );
          outcome = await runOnePdf(dl.pdfPath, completed + 1, total, undefined, 1);
        }
      } else if (item.kind === "reparse") {
        outcome = await runReparseItem(item, completed + 1, total);
      } else {
        outcome = await runOnePdf(item.pdfPath, completed + 1, total, item.folderId, 0);
      }

      if (outcome === "imported") {
        imported += 1;
        // 新入库论文加入在库检查索引（引用卡片「打开」即时可见）
        if (item.kind === "acquire") invalidateLibraryPaperIndex();
        // 重解析完成且该篇标签页开着 → 写标记（阅读器出「已重新解析」横幅，不自动刷新）
        if (item.kind === "reparse") {
          const tabOpen = useLayoutStore.getState().tabs.some((t) => t.id === `paper-${item.paperId}`);
          if (tabOpen) {
            useConvertProgressStore.setState((s) => ({
              reparsedPapers: { ...s.reparsedPapers, [item.paperId]: Date.now() },
            }));
          }
        }
      } else if (outcome === "skipped") skipped += 1;
      else if (outcome === "failed") {
        failed += 1;
        failedNames.push(fileName);
      } else {
        paperCancelRequested = true;
      }
      completed += 1;
      paperCurrentItem = null;
      // 取消语义：取消按钮 = 取消当前篇 + 清空队列（清空在 cancelPaperImport 做；
      // 此后新提交的是新意图，保留在队列里，finally 段重新起泵续跑）
      if (paperCancelRequested) break;
    }
  } finally {
    paperDraining = false;
    paperCurrentItem = null;
  }

  // 全部（或取消前已完成部分）结算后刷新列表（页面不在场时跳过，重进自会加载）
  paperRefresh?.();

  if (paperCancelRequested) {
    const cancelledSummary =
      imported + skipped + failed <= 1
        ? "已取消解析"
        : `已取消：完成 ${imported} 篇${skipped > 0 ? ` · 跳过 ${skipped}` : ""}${failed > 0 ? ` · 失败 ${failed}` : ""}，队列已清空`;
    setPaperImportState((prev) =>
      prev
        ? {
            ...prev,
            status: "error",
            error: cancelledSummary,
            importedCount: imported,
            skippedCount: skipped,
            failedCount: failed,
            failedNames: [...failedNames],
            queuedCount: 0,
          }
        : prev,
    );
    // 取消后又有新提交（新意图）：重新起泵接续
    if (paperQueue.length > 0) void drainPaperQueue();
    return;
  }

  // 收尾卡：多篇汇总完成/跳过/失败（单篇保持 runOnePdf 写好的原收尾文案）
  const total = imported + skipped + failed;
  if (total > 1) {
    const extras: string[] = [];
    if (skipped > 0) extras.push(`跳过 ${skipped}`);
    if (failed > 0) extras.push(`失败 ${failed}`);
    const summary = `完成 ${imported} 篇${extras.length > 0 ? `（${extras.join(" · ")}）` : ""}`;
    setPaperImportState((prev) =>
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
            queuedCount: 0,
          }
        : prev,
    );
    if (failed > 0) toast.error(`批量解析结束：${failed} 篇失败`);
    else toast.success(`批量解析完成：${summary}`);
  }
}

/** reparse 项执行：解析源 PDF（显式 sourcePdfPath → zotero 回链 → 书库 source.pdf）→ runOnePdf → 产物整体替换（保留 id/归属/对话/标注） */
async function runReparseItem(
  item: { kind: "reparse"; paperId: string; title: string; sourcePdfPath?: string },
  index: number,
  total: number,
): Promise<PdfOutcome> {
  // 旧元数据（zotero_key/zotero_pdf_path 回链字段在替换产物时要保留）
  let meta: PaperMetadata | null = null;
  try {
    meta = JSON.parse(await readTextFile(await join(await appDataDir(), "books", item.paperId, "metadata.json")));
  } catch {
    // 无 metadata.json：走书库 source.pdf 兜底
  }
  // 显式路径优先（AI 工具 filePath；存在性复核用 Rust path_exists——plugin-fs 看不到库外路径）
  const explicit = item.sourcePdfPath?.trim();
  const pdfPath =
    explicit && (await invoke<boolean>("path_exists", { path: explicit }).catch(() => false))
      ? explicit
      : await resolvePaperSourcePdf(item.paperId, meta);
  if (!pdfPath) {
    const message = `《${item.title}》找不到源 PDF，无法重新解析`;
    setPaperImportState((prev) => (prev ? { ...prev, status: "error", error: message } : prev));
    toast.error(message);
    return "failed";
  }
  return runOnePdf(
    pdfPath,
    index,
    total,
    undefined,
    0,
    async (progress) => {
      const suspect = await replacePaperWithConverted(
        { id: item.paperId, title: item.title },
        progress.paper_dir as string,
        meta ?? undefined,
      );
      setPaperImportState((prev) =>
        prev
          ? {
              ...prev,
              status: "success",
              percent: 100,
              title: item.title,
              detail: `已更新《${item.title}》`,
              stages: prev.stages.map((s) => ({ ...s, status: "done" as PdfStageStatus })),
            }
          : prev,
      );
      toast.success(`重新解析完成：《${item.title}》`);
      // 完整性/退化警告与原批量路径同口径（converter 守卫 + 本地检测双通道）
      if (suspect || progress.degenerate === true || progress.incomplete === true) {
        toast.warning(`《${item.title}》重解析后检测到内容异常（退化循环或内容缺失），建议换引擎重试`, {
          duration: 8000,
        });
      }
      return "imported";
    },
    { paperId: item.paperId, title: item.title },
  );
}

/** acquire 项的下载段：MCP 直调 Zotero Brain；取消在下载中即时结算（MCP 调用不可中止，晚到结果被丢弃） */
async function downloadReferencePdf(item: {
  doi?: string;
  /** 可空（APS 老版式条目无标题）——空串跳过 PDF 标题校验（见下方调用处注释） */
  title?: string;
  url?: string;
  arxivId?: string;
}): Promise<{ pdfPath?: string; message?: string; cancelled?: boolean }> {
  const server = findZoteroBrainServer();
  if (!server) return { message: "未配置 Zotero Brain MCP，请到 AI 中心 → MCP 配置后重试" };
  return new Promise((resolve) => {
    let done = false;
    paperCurrentSettle = () => {
      if (done) return;
      done = true;
      resolve({ cancelled: true });
    };
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
        paperCurrentSettle = null;
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
        paperCurrentSettle = null;
        resolve({ message: `获取 PDF 失败：${error instanceof Error ? error.message : String(error)}` });
      },
    );
  });
}

/** 解析单篇并等待结算：注册进度监听 → 启动转换 → done 后入库；失败/取消也正常结算（队列据此推进）。
 * stageOffset：调用方在解析阶段前插了前置段（如获取 PDF 的下载段）时，进度事件的阶段号按偏移对齐。
 * onParsed：自定义 done 落库逻辑（reparse 的产物整体替换）；缺省走 importPapers 新建条目。
 * reparseCtx：reparse 项的恢复上下文（写入 localStorage 记录，刷新后恢复落库链路用） */
async function runOnePdf(
  pdfPath: string,
  index: number,
  total: number,
  folderId?: string,
  stageOffset = 0,
  onParsed?: (progress: PaperConvertProgress) => Promise<PdfOutcome>,
  reparseCtx?: { paperId: string; title: string },
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
    clearPaperTaskRecord();
    // 落库成功 → 确认清除 Rust 侧 pending_done（刷新恢复槽）；失败则保留，下次启动恢复重试
    if (outcome === "imported" || outcome === "skipped") {
      void clearPaperConvertPendingDone().catch(() => {});
    }
    resolveOutcome(outcome);
  };
  paperCurrentSettle = () => settle("cancelled");
  // 刷新恢复锚点：任务上下文落 localStorage（刷新不丢；settle 即清除）
  writePaperTaskRecord({
    pdfPath,
    kind: reparseCtx ? "reparse" : "parse",
    folderId,
    paperId: reparseCtx?.paperId,
    title: reparseCtx?.title,
    startedAt: Date.now(),
  });

  try {
    unlisten = await listenPaperConvertProgress(async (progress: PaperConvertProgress) => {
      // 任务归属过滤：上一篇进程退出后的迟到 terminated、以及其他来源（Zotero 批量导入/重解析）
      // 共用同一事件通道，不归本任务的进度一律忽略（2026-08-20 实测迟到 terminated 秒杀下一篇）
      if (progress.pdf_path && progress.pdf_path !== pdfPath) return;
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
        // 自定义落库路径（重解析的产物整体替换）：委托给调用方的 onParsed
        if (onParsed) {
          try {
            settle(await onParsed(progress));
          } catch (error) {
            const message = `解析成功但落库失败：${error instanceof Error ? error.message : String(error)}`;
            setPaperImport((prev) => (prev ? { ...prev, status: "error", error: message } : prev));
            toast.error(`「${fileName}」${message}`);
            settle("failed");
          }
          return;
        }
        try {
          const result = await importPapers(progress.paper_dir, folderId);
          // 静默失败闸：importPapers 把单篇失败收进 result.failed（不抛），此前只判 skipped
          // 导致"入库失败报成功"（2026-08-20 队列验收实测：save_paper 失败被吞、卡片显示成功）
          if (result.failed.length > 0 && result.imported === 0 && result.skipped === 0) {
            const message = `解析成功但入库失败：${result.failed[0].error}`;
            setPaperImport((prev) => (prev ? { ...prev, status: "error", error: message } : prev));
            toast.error(`「${fileName}」${message}`);
            settle("failed");
            return;
          }
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

/** 取消解析：kill 当前篇子进程并立即结算当前篇 + 清空队列（卡片显示部分结果；幂等）。
 *  取消后才提交的新任务视为新意图，不清（由 drain 收尾段重新起泵接续）。
 *  顺序注意：先结算再杀进程——树杀（taskkill /T /F）把取消等待拉长到百毫秒级，
 *  terminated 事件可能先于 invoke 返回到达；settled 闸 + 卡片状态守卫挡住它，
 *  保证取消语义落在「已取消」而非「异常退出」。 */
export async function cancelPaperImport() {
  paperCancelRequested = true;
  paperQueue = [];
  paperCurrentSettle?.();
  useConvertProgressStore.setState((s) => ({
    paperImport:
      s.paperImport && s.paperImport.status === "running"
        ? { ...s.paperImport, status: "error", error: "已取消解析" }
        : s.paperImport,
  }));
  try {
    await cancelPaperPdfImport();
  } catch (error) {
    console.warn("取消论文解析失败:", error);
  }
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

// ----------------------------------------------------------------------
// 刷新恢复（2026-08-24）：解析队列是纯内存态——页面刷新后 Rust 侧 sidecar 仍在跑、
// paper-convert://progress 事件仍在发，但前端队列/监听全丢：进度卡消失，且 done 的
// 落库收尾（importPapers / replace_paper_content）脱钩，产物滞留 papers-converter 目录。
// 参照向量化通道的「刷新恢复」模式（papers/index.tsx 挂载扫描）：当前任务上下文落
// localStorage（刷新不丢），挂载时经 paper_convert_status 探测 Rust 侧在跑任务与
// 未消费 done 产物（pending_done 槽），恢复进度卡与完成监听，把落库链路接回去。
// ----------------------------------------------------------------------
const PAPER_TASK_RECORD_KEY = "paperImportCurrentTask";

/** 当前解析任务的持久化记录（刷新后恢复落库链路用；正常 settle 即清除） */
interface PaperTaskRecord {
  pdfPath: string;
  kind: "parse" | "reparse";
  folderId?: string;
  paperId?: string;
  title?: string;
  startedAt: number;
}

function writePaperTaskRecord(record: PaperTaskRecord): void {
  try {
    localStorage.setItem(PAPER_TASK_RECORD_KEY, JSON.stringify(record));
  } catch {
    // 持久化失败不阻断解析
  }
}

function readPaperTaskRecord(): PaperTaskRecord | null {
  try {
    const raw = localStorage.getItem(PAPER_TASK_RECORD_KEY);
    if (!raw) return null;
    const r = JSON.parse(raw) as PaperTaskRecord;
    return typeof r.pdfPath === "string" && r.pdfPath ? r : null;
  } catch {
    return null;
  }
}

function clearPaperTaskRecord(): void {
  try {
    localStorage.removeItem(PAPER_TASK_RECORD_KEY);
  } catch {
    // ignore
  }
}

/** 恢复态卡片的初始 State（进度由后续事件喂；情形 B 直接 percent=100） */
function recoveredCard(fileName: string, detail: string, percent = 0): PaperImportState {
  return {
    status: "running",
    fileName,
    percent,
    detail,
    stages: buildPdfStages(),
    index: 1,
    total: 1,
    queuedCount: 0,
    importedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    failedNames: [],
  };
}

/** 恢复路径的 done 落库：record 指认 reparse → 产物整体替换（保留 id/归属/对话/标注）；
 *  否则按纯 parse 走 importPapers 新建入库（无记录时也保证产物落库）。
 *  落库成功才清 Rust pending_done 槽；失败保留供下次启动重试（产物不落库是更严重事故）。 */
async function settleRecoveredDone(done: PaperConvertPendingDone, record: PaperTaskRecord | null): Promise<PdfOutcome> {
  let outcome: PdfOutcome;
  if (record?.kind === "reparse" && record.paperId) {
    const paperId = record.paperId;
    const title = record.title ?? done.title ?? "";
    // 旧元数据（zotero 回链字段替换产物时要保留）——从磁盘重读（对齐 runReparseItem）
    let meta: PaperMetadata | null = null;
    try {
      meta = JSON.parse(await readTextFile(await join(await appDataDir(), "books", paperId, "metadata.json")));
    } catch {
      // 无 metadata.json：照样替换
    }
    try {
      const suspect = await replacePaperWithConverted({ id: paperId, title }, done.paperDir, meta ?? undefined);
      setPaperImportState((prev) =>
        prev
          ? {
              ...prev,
              status: "success",
              percent: 100,
              title,
              detail: `已更新《${title}》`,
              stages: prev.stages.map((s) => ({ ...s, status: "done" as PdfStageStatus })),
            }
          : prev,
      );
      toast.success(`重新解析完成：《${title}》`);
      if (suspect || done.degenerate === true || done.incomplete === true) {
        toast.warning(`《${title}》重解析后检测到内容异常（退化循环或内容缺失），建议换引擎重试`, {
          duration: 8000,
        });
      }
      // 标签页开着 → 写「已重新解析」横幅标记（对齐 drain 行为）
      const tabOpen = useLayoutStore.getState().tabs.some((t) => t.id === `paper-${paperId}`);
      if (tabOpen) {
        useConvertProgressStore.setState((s) => ({
          reparsedPapers: { ...s.reparsedPapers, [paperId]: Date.now() },
        }));
      }
      outcome = "imported";
    } catch (error) {
      const message = `解析成功但落库失败：${error instanceof Error ? error.message : String(error)}`;
      setPaperImportState((prev) => (prev ? { ...prev, status: "error", error: message } : prev));
      toast.error(`《${title}》${message}`);
      outcome = "failed";
    }
  } else {
    try {
      const result = await importPapers(done.paperDir, record?.folderId);
      // 静默失败闸（对齐 runOnePdf：importPapers 把单篇失败收进 result.failed 不抛）
      if (result.failed.length > 0 && result.imported === 0 && result.skipped === 0) {
        const message = `解析成功但入库失败：${result.failed[0].error}`;
        setPaperImportState((prev) => (prev ? { ...prev, status: "error", error: message } : prev));
        toast.error(message);
        outcome = "failed";
      } else {
        const label = done.title ?? done.slug ?? done.paperDir;
        setPaperImportState((prev) =>
          prev
            ? {
                ...prev,
                status: "success",
                percent: 100,
                title: done.title,
                detail: `已入库《${label}》`,
                stages: prev.stages.map((s) => ({ ...s, status: "done" as PdfStageStatus })),
              }
            : prev,
        );
        if (result.skipped > 0 && result.imported === 0) {
          toast.info("该论文已入库过（内容未变化）");
          outcome = "skipped";
        } else {
          toast.success(`论文解析入库完成：${label}`);
          if (done.incomplete === true) {
            toast.warning(`《${label}》检测到内容缺失（图/表或整页未解析出）`, {
              description: "建议在 设置 → PDF 转换 中更换解析引擎后重新解析",
              duration: 10000,
            });
          }
          // 退化循环检测（converter 守卫 + 本地检测双通道，对齐 runOnePdf）
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
          outcome = "imported";
        }
      }
    } catch (error) {
      const message = `解析成功但入库失败：${error instanceof Error ? error.message : String(error)}`;
      setPaperImportState((prev) => (prev ? { ...prev, status: "error", error: message } : prev));
      toast.error(message);
      outcome = "failed";
    }
  }
  if (outcome === "imported" || outcome === "skipped") {
    void clearPaperConvertPendingDone().catch(() => {});
  }
  return outcome;
}

let paperRecoveryAttempted = false;

/** 页面刷新后的解析通道恢复（GlobalConvertProgress 挂载时调用一次；幂等）。
 *  情形 A：解析仍在跑 → 占住队列泵位 + 恢复进度卡 + 完成监听（结算后接续新提交）；
 *  情形 B：done 在刷新窗口丢失（进程已退场、产物未消费）→ 直接补落库；
 *  情形 C：进程与产物都没了但有残留记录 → 解析中断在刷新窗口，出错误卡引导重发。 */
export async function recoverPaperImportAfterReload(): Promise<void> {
  if (paperRecoveryAttempted) return;
  paperRecoveryAttempted = true;
  // 实时通道健在（未刷新/已起泵/运行中卡片在）→ 不恢复（对齐向量化恢复③防覆盖实时卡）
  if (paperDraining) return;
  if (useConvertProgressStore.getState().paperImport?.status === "running") return;

  const status = await getPaperConvertStatus().catch(() => null);
  if (!status) return;
  const record = readPaperTaskRecord();

  // 情形 B：done 产物滞留（含「done 已发但进程未退」的刷新瞬间——产物已可消费，不必再等进程）
  if (status.pendingDone) {
    const pending = status.pendingDone;
    const rec = record?.pdfPath === pending.pdfPath ? record : null;
    const fileName = rec?.title || pending.title || pending.pdfPath.split(/[\\/]/).pop() || pending.pdfPath;
    setPaperImportState(() => recoveredCard(fileName, "恢复解析产物入库（页面刷新前已完成解析）…", 100));
    await settleRecoveredDone(pending, rec);
    clearPaperTaskRecord();
    paperRefresh?.();
    if (!status.runningPdfPath || status.runningPdfPath === pending.pdfPath) return;
    // 防御：pending 与在跑任务不同源（正常不会发生——新任务启动即清 pending），继续走情形 A
  }

  const runningPdf = status.runningPdfPath;
  if (!runningPdf) {
    // 情形 C：有残留记录但进程/产物都没了 = error/terminated 丢失在刷新窗口
    if (record) {
      clearPaperTaskRecord();
      const fileName = record.title || record.pdfPath.split(/[\\/]/).pop() || record.pdfPath;
      setPaperImportState(() => ({
        ...recoveredCard(fileName, ""),
        status: "error",
        error: "解析在页面刷新期间中断，请重新发起",
      }));
    }
    return;
  }

  // 情形 A：解析仍在跑——占住泵位（新提交排队，结算后自动接续），恢复进度卡与完成监听
  const rec = record?.pdfPath === runningPdf ? record : null;
  paperDraining = true;
  paperCancelRequested = false;
  paperCurrentItem =
    rec?.kind === "reparse" && rec.paperId
      ? { kind: "reparse", paperId: rec.paperId, title: rec.title ?? "" }
      : { kind: "parse", pdfPath: runningPdf, folderId: rec?.folderId };
  const fileName = rec?.title || runningPdf.split(/[\\/]/).pop() || runningPdf;
  setPaperImportState(() => recoveredCard(fileName, "解析进行中（页面刷新后恢复监控）…"));

  let settled = false;
  let unlisten: (() => void) | null = null;
  const settleRecovered = () => {
    if (settled) return;
    settled = true;
    unlisten?.();
    paperCurrentSettle = null;
    paperCurrentItem = null;
    paperDraining = false;
    clearPaperTaskRecord();
    paperRefresh?.();
    // 恢复期间新提交的排队任务接续（对齐 drain 收尾语义）
    if (paperQueue.length > 0) void drainPaperQueue();
  };
  // 取消按钮（cancelPaperImport → paperCurrentSettle）驱动恢复任务即时结算
  paperCurrentSettle = () => settleRecovered();

  try {
    unlisten = await listenPaperConvertProgress(async (progress) => {
      // 任务归属过滤（对齐 runOnePdf：不归本任务的事件一律忽略）
      if (progress.pdf_path && progress.pdf_path !== runningPdf) return;
      if (progress.type === "progress" || progress.type === "stage_done") {
        setPaperImportState((prev) =>
          prev && prev.status === "running"
            ? {
                ...prev,
                percent: progress.percent ?? prev.percent,
                detail: progress.detail ?? prev.detail,
                stages: markStages(prev.stages, progress.stage, progress.type === "stage_done" ? "done" : "active"),
              }
            : prev,
        );
        return;
      }
      if (progress.type === "done" && progress.paper_dir) {
        await settleRecoveredDone(
          {
            pdfPath: progress.pdf_path ?? runningPdf,
            paperDir: progress.paper_dir,
            title: progress.title,
            slug: progress.slug,
            degenerate: progress.degenerate,
            incomplete: progress.incomplete,
          },
          rec,
        );
        settleRecovered();
        return;
      }
      if (progress.type === "error") {
        const message = progress.message ?? "解析失败";
        setPaperImportState((prev) => (prev ? { ...prev, status: "error", error: message } : prev));
        settleRecovered();
        return;
      }
      if (progress.type === "terminated") {
        setPaperImportState((prev) =>
          prev && prev.status === "running"
            ? { ...prev, status: "error", error: progress.success === false ? "解析进程异常退出" : "解析已取消" }
            : prev,
        );
        settleRecovered();
      }
    });
  } catch {
    // 监听注册失败：进程还在跑但接不上事件——按中断处理并释放泵位
    setPaperImportState((prev) =>
      prev ? { ...prev, status: "error", error: "恢复解析监控失败，请查看日志后重新发起" } : prev,
    );
    settleRecovered();
    return;
  }

  // 竞态收口：监听挂好的空窗内进程可能已退场（done/error 无人接收）→ 复查状态直结
  const recheck = await getPaperConvertStatus().catch(() => null);
  if (!settled && recheck && recheck.runningPdfPath !== runningPdf) {
    if (recheck.pendingDone && recheck.pendingDone.pdfPath === runningPdf) {
      await settleRecoveredDone(recheck.pendingDone, rec);
      settleRecovered();
    } else if (!recheck.pendingDone) {
      setPaperImportState((prev) =>
        prev && prev.status === "running" ? { ...prev, status: "error", error: "解析在恢复监控前已中断" } : prev,
      );
      settleRecovered();
    }
  }
}
