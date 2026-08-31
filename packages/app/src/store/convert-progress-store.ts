/**
 * 全局转换进度 store：论文全文解析导入（PDF/XML）+ 图书 PDF→EPUB 转换。
 *
 * 两类长任务此前都把运行状态放在页面组件里（PapersPage / ConverterPage），
 * 离开页面即丢卡（论文）或丢监听（图书——窗口被点掉后转换进程还在跑，
 * 但进度/结果再无人接收，用户无从判断是后台进行还是静默中断，2026-08-14 实证）。
 * 现统一沉到模块级 store：队列与事件监听的生命周期独立于任何视图，
 * 右下角全局进度卡（components/global-convert-progress）跨页面呈现，
 * 仅在全局助手聊天页与书籍/论文阅读器三个视图豁免（避免遮挡正文）。
 *
 * P2-1（统一任务队列）：图书转换的执行（监听注册/阶段推进/结算/自动导入）已迁入
 * services/task-executors/book-convert.ts 并注册为 task-center 的 book-convert 通道。
 * 卡 1（2026-08-31，docs/book-convert-queue-plan.md）：转换窗口改造为双态任务台——
 * 内容模型是通道队列（拖入/选入多份 PDF 即逐本入队、串行连转、完成自动导入自动出队），
 * 窗口态 ⇄ 右下角通道卡由 bookConvertDialogOpen/bookConvertMinimized 状态机承载；
 * 本 store 的 bookConvert 收窄为「当前在跑任务的详情数据源 + 转换配置 + 窗口状态机 +
 * 拖放悬停旗标」，队列现场始终在 task-center 通道聚合（点卡还原零状态损失）。
 *
 * P2-4：论文解析通道同样迁入 services/task-executors/paper-parse.ts（task-center 的
 * paper-parse 通道；队列泵/取消/刷新恢复三情形均在执行器侧）。本节只保留入口薄壳
 * （startPaperImportBatch/startPaperReparse/startPaperAcquireImport 签名不变，调用点零改动）、
 * reparsedPapers 横幅标记与 paperRefresh 持有槽。本模块不静态 import 执行器（无环约束，
 * 对齐 P2-1 模式）；执行器经 global-convert-progress 的静态 import 在 app 启动时完成注册。
 */

import { findZoteroBrainServer } from "@/ai/mcp/mcp-manager";
import { paperEngineTokenError } from "@/services/paper-service";
import type { PaperParsePayload } from "@/services/task-executors/paper-parse";
import { useConverterStore } from "@/store/converter-store";
import { useLayoutStore } from "@/store/layout-store";
import { selectChannelAggregate, useTaskCenterStore } from "@/store/task-center-store";
import { toast } from "sonner";
import { create } from "zustand";
import { isPaperTaskActive, usePaperTaskRegistry } from "./paper-task-registry";

// ----------------------------------------------------------------------
// 论文 PDF 解析导入（状态类型自 PapersPage 迁入，字段不变；P2-4 起仅作卡片视图模型形状，
// 数据源是 task-center 的 paper-parse 通道聚合——折算见 paper-parse.ts 的 paperParseCardOf）
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
  /** 当前在跑任务的源 PDF（执行器在任务启动时定格；通道卡文件名兜底与调试归属用） */
  pdfPath: string | null;
  ocr: boolean;
  translate: string;
  percent: number;
  detail: string;
  stages: BookStageState[];
  errorMessage: string;
  epubPath: string | null;
  /** done 后自动入库（卡 1 起窗口路径与 AI 托管路径恒 true——转换完成默认自动导入，用户拍板） */
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
};

/** 按是否翻译与引擎构建阶段流水线（编号对齐后端协议：无翻译 1/2/3，有翻译 1/2/3/4）。
 *  导出给 book-convert 通道执行器复用（任务启动时定格运行态阶段） */
export function buildBookStages(withTranslate: boolean, engine: "mineru" | "paddleocr"): BookStageState[] {
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
  bookConvert: BookConvertState;
  /** 重解析完成标记（paperId → 完成时间戳）：仅当该篇有打开的标签页时写入；
   *  阅读器据此刻意出「已重新解析」横幅（不自动刷新，避免打断阅读位置） */
  reparsedPapers: Record<string, number>;
  /** 阅读器「重新加载」后回执清除标记 */
  ackPaperReparsed: (paperId: string) => void;
  /** 图书转换任务台（图书馆页弹层 / /converter 页）是否打开 */
  bookConvertDialogOpen: boolean;
  /** 图书转换是否最小化（右下角通道卡呈现；点击卡片还原任务台） */
  bookConvertMinimized: boolean;
  /** 拖放悬停转换窗口标记（home-layout 的 Tauri 拖放监听判定窗口可见时写入；
   *  窗口本体渲染局部遮罩——卡 1 遮罩范围修正，不再盖全主页） */
  bookConvertDragOver: boolean;

  setPaperImportDismissed: () => void;
  openBookConvertDialog: () => void;
  /** 关闭图书转换任务台：通道有任务（在跑/排队/未清除的结算行）→ 最小化为右下角通道卡
   *  （不询问）；空队列 → 彻底关闭 */
  closeBookConvertDialog: () => void;
  setBookConvertDragOver: (on: boolean) => void;
  /** 转换配置（OCR/翻译目标语言）：作用于此后入队的任务（队列每行在入队时定格配置快照） */
  setBookConvertConfig: (patch: Partial<Pick<BookConvertState, "ocr" | "translate">>) => void;
  /** 丢弃图书转换详情数据源（通道卡 X 收尾）：回 idle（任务监听在执行器内，结算即解除） */
  resetBookConvert: () => void;
}

export const useConvertProgressStore = create<ConvertProgressState>()((set, get) => ({
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
  bookConvertDragOver: false,

  setPaperImportDismissed: () => {
    dismissPaperImport();
  },

  openBookConvertDialog: () => {
    set({ bookConvertDialogOpen: true, bookConvertMinimized: false });
  },

  closeBookConvertDialog: () => {
    // 队列口径（卡 1）：是否转通道卡看 book-convert 通道聚合（排队中的任务尚未定格详情态），
    // 不再看单任务 bookConvert.status；cancelled 结算行不撑卡（对齐通道卡可见性过滤）
    const agg = selectChannelAggregate(useTaskCenterStore.getState(), "book-convert");
    const hasTasks = agg.current !== null || agg.queuedCount > 0 || agg.settled.some((t) => t.status !== "cancelled");
    set({
      bookConvertDialogOpen: false,
      bookConvertMinimized: hasTasks,
    });
  },

  setBookConvertDragOver: (on) => {
    if (get().bookConvertDragOver === on) return;
    set({ bookConvertDragOver: on });
  },

  setBookConvertConfig: (patch) => {
    set((s) => ({ bookConvert: { ...s.bookConvert, ...patch } }));
  },

  resetBookConvert: () => {
    resetBookConvertState();
  },
}));

// zustand 模块内辅助：直接走 setState，避免把 set 混进 state
function resetBookConvertState() {
  const prev = useConvertProgressStore.getState().bookConvert;
  // 配置项（文件/OCR/翻译）保留，运行结果清空
  useConvertProgressStore.setState({
    bookConvert: { ...BOOK_CONVERT_INITIAL, pdfPath: prev.pdfPath, ocr: prev.ocr, translate: prev.translate },
    bookConvertMinimized: false,
  });
}

/** 把 active 阶段标错（执行器在启动失败/超时兜底时调用；导出给 book-convert 通道执行器复用） */
export function markBookActiveError() {
  useConvertProgressStore.setState((s) => ({
    bookConvert: {
      ...s.bookConvert,
      stages: s.bookConvert.stages.map((st) => (st.status === "active" ? { ...st, status: "error" } : st)),
    },
  }));
}

// ----------------------------------------------------------------------
// 论文 PDF 解析导入：入口薄壳（P2-4）
// 队列/执行/恢复迁入 task-center 的 paper-parse 通道（执行器：services/task-executors/paper-parse.ts，
// 模块加载即自注册）。P3：Rust 侧 convert_paper_pdf 已多句柄化，通道有界并发 2。
// ----------------------------------------------------------------------

/** 解析通道聚合快照（薄壳共用） */
const paperParseAgg = () => selectChannelAggregate(useTaskCenterStore.getState(), "paper-parse");

/** 批量结算后的列表刷新回调（PapersPage 挂载时注册，卸载置空——页面重进时会全量加载）。
 *  持有槽仍在模块级；paper-parse 执行器在通道活跃→空闲沿经动态 import 调 runPaperImportRefresh。 */
let paperRefresh: (() => void) | null = null;

export function setPaperImportRefresh(fn: (() => void) | null) {
  paperRefresh = fn;
}

/** 通道收尾时的列表刷新（旧 drainPaperQueue 收尾 paperRefresh?.() 的等价物；执行器侧调用） */
export function runPaperImportRefresh() {
  paperRefresh?.();
}

/** 通道空闲时清掉已结算任务（新批次卡片从 0 计起，对齐旧 drain 重置进度卡语义） */
function dismissPaperParseIfIdle(): void {
  const st = useTaskCenterStore.getState();
  const agg = selectChannelAggregate(st, "paper-parse");
  if (!agg.current && agg.queuedCount === 0) st.dismissSettled("paper-parse");
}

/** 启动批量解析导入（PapersPage 弹窗确认与页面拖入共用入口；folderId 在提交时定格。
 *  运行中提交不拒绝：去重后整批入队，当前篇结算后自动接续。 */
export async function startPaperImportBatch(incomingPaths: string[], folderId?: string) {
  // 执行器模块加载保险：正常已由 global-convert-progress 静态加载完成注册，此处兜底
  await import("@/services/task-executors/paper-parse");
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

  const wasActive = paperParseAgg().current !== null || paperParseAgg().queuedCount > 0;
  dismissPaperParseIfIdle();
  const st = useTaskCenterStore.getState();
  for (const pdfPath of paths) {
    // 幂等去重（同 pdfPath 在跑/排队拒入队）由队列负责
    st.enqueue({
      channel: "paper-parse",
      targetId: pdfPath,
      title: pdfPath.split(/[\\/]/).pop() ?? pdfPath,
      payload: { kind: "parse", pdfPath, folderId } satisfies PaperParsePayload,
    });
  }
  // 运行中卡片的队列计数经通道聚合实时呈现（旧 setPaperImportState 手动刷新计数已不需要）
  if (wasActive) {
    toast.info(`已加入解析队列（当前任务完成后接续，待处理 ${paperParseAgg().queuedCount} 篇）`);
  }
}

/** P2 参考文献卡片「获取全文」入口：Zotero Brain 双格式下载（XML 优先）→ 解析 → 入库，随全局队列串行接续 */
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
  const wasActive = paperParseAgg().current !== null || paperParseAgg().queuedCount > 0;
  dismissPaperParseIfIdle();
  useTaskCenterStore.getState().enqueue({
    channel: "paper-parse",
    targetId: input.doi ?? input.arxivId ?? input.url ?? input.displayName ?? crypto.randomUUID(),
    title: input.title?.trim() || input.displayName || input.doi || input.arxivId || "参考文献",
    payload: {
      kind: "acquire",
      doi: input.doi,
      title: input.title,
      displayName: input.displayName,
      url: input.url,
      arxivId: input.arxivId,
    } satisfies PaperParsePayload,
  });
  // 阅读/聊天视图豁免进度卡：toast 让当前视图有即时反馈
  if (wasActive) {
    toast.info(`已加入队列（待处理 ${paperParseAgg().queuedCount} 篇），轮到后自动下载解析`);
  } else {
    toast.info("已开始获取全文（Zotero Brain 下载中，XML 优先），完成后自动解析入库");
  }
}

/** 该论文是否在解析队列中（排队或正在解析）——重解析防重入/翻译撞车判定共用。
 *  P2-4 起读 task-center 的 paper-parse 通道（含刷新恢复占用注入的任务；镜像任务不算） */
export function isPaperQueuedOrRunning(paperId: string): boolean {
  const { tasks } = useTaskCenterStore.getState();
  return Object.values(tasks).some(
    (t) =>
      t.channel === "paper-parse" &&
      !t.mirror &&
      t.targetId === paperId &&
      (t.status === "queued" || t.status === "running"),
  );
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
  const wasActive = paperParseAgg().current !== null || paperParseAgg().queuedCount > 0;
  dismissPaperParseIfIdle();
  const res = useTaskCenterStore.getState().enqueue({
    channel: "paper-parse",
    targetId: input.id,
    title: input.title,
    payload: {
      kind: "reparse",
      paperId: input.id,
      title: input.title,
      sourcePdfPath: input.filePath,
    } satisfies PaperParsePayload,
  });
  if (!res.ok) {
    // 竞态兜底（预检到入队间状态翻转）；detail 与上面预检文案同族
    const message = res.detail ?? `《${input.title}》入队失败`;
    if (!silent) toast.info(message);
    return { ok: false, message };
  }
  if (wasActive) {
    const message = `已加入解析队列（待处理 ${paperParseAgg().queuedCount} 篇）`;
    toast.info(message);
    return { ok: true, message };
  }
  return { ok: true, message: `《${input.title}》已开始重新解析` };
}

/** 取消解析：撤掉通道全部排队 + 运行中任务（cancelTask → signal → 执行器调 cancelPaperPdfImport
 *  杀进程树；先结算再杀进程的顺序在执行器/恢复占用侧保持）。卡片经通道聚合呈现部分结果。
 *  取消后才提交的新任务视为新意图，不清（泵收尾自动接续）。 */
export async function cancelPaperImport() {
  useTaskCenterStore.getState().cancelChannel("paper-parse");
}

/** 关闭论文进度卡（running 时等同取消） */
export function dismissPaperImport() {
  const agg = paperParseAgg();
  if (agg.current !== null || agg.queuedCount > 0) {
    void cancelPaperImport();
    return;
  }
  useTaskCenterStore.getState().dismissSettled("paper-parse");
}

/** 页面刷新后的解析通道恢复（GlobalConvertProgress 挂载时调用一次；幂等）。
 *  三情形语义不变，实现在 paper-parse 执行器模块（恢复卡改在 task-center 模型上重建）；
 *  此处薄壳同时兜底执行器模块加载（动态 import 触发模块自注册）。 */
export async function recoverPaperImportAfterReload(): Promise<void> {
  const { recoverPaperParseAfterReload } = await import("@/services/task-executors/paper-parse");
  await recoverPaperParseAfterReload();
}
