import { create } from "zustand";

/**
 * 论文任务配套状态（P2-3 收编后）：
 * 向量化/翻译队列已迁入 task-center（执行器见 services/task-executors/paper-vectorize.ts /
 * paper-translate.ts；入队口冲突判定经 utils/paper-conflict 注入，冲突矩阵仍在 paper-task-registry）。
 * 本 store 只保留视图配套切片：
 * - vectorizePercent：每篇向量化百分比（卡片圆环；由通道执行器/恢复扫描/页面监听喂）；
 * - readerTranslate：阅读器单篇翻译的右下角小卡（执行器回写；阅读器页内由栈禁区隐藏）；
 * - progress.vectorize：刷新后的「恢复监控」卡（Rust 侧 index_paper 跨刷新存活的挂载扫描恢复，
 *   见 docs/archive/task-queue-p2-plan.md §0 内存态保持原则）；
 * - onSettled：通道收尾回调（PapersPage 注册刷新列表；由执行器模块的通道空闲沿触发）。
 */

export type TaskKind = "vectorize" | "translate";

/** 进度卡状态（恢复监控卡沿用 PapersPage BatchProgressCard 字段口径） */
export interface ChannelProgress {
  status: "running" | "success" | "error";
  index: number;
  total: number;
  title: string;
  detail: string;
  percent: number;
  doneCount: number;
  failedCount: number;
  skippedCount: number;
  failedNames: string[];
  summary?: string;
  cancelling?: boolean;
}

/** 阅读页单篇翻译的全局进度（阅读器发起的翻译经翻译通道执行器回写此切片，
 *  进右下角卡片栈，主页/文献库可见；阅读器页内由栈的禁区规则隐藏，页内自有进度 UI） */
export interface ReaderTranslateState {
  paperId: string;
  title: string;
  done: number;
  total: number;
  /** 收尾阶段（如「句词对齐中…」）；正文翻译阶段为 undefined */
  detail?: string;
}

interface PaperTaskState {
  /** 恢复监控卡（仅 vectorize 槽位在用；翻译无跨刷新恢复场景） */
  progress: Partial<Record<TaskKind, ChannelProgress>>;
  /** 每篇向量化百分比（卡片圆环用，与旧 setVectorizing 兼容） */
  vectorizePercent: Record<string, number>;
  /** 阅读页单篇翻译进度（null=无）；onCancel 由通道执行器注册（卡片取消按钮 → cancelTask） */
  readerTranslate: ReaderTranslateState | null;
  startReaderTranslate: (s: ReaderTranslateState, onCancel: () => void) => void;
  patchReaderTranslate: (patch: Partial<Pick<ReaderTranslateState, "done" | "total" | "detail">>) => void;
  clearReaderTranslate: () => void;
  cancelReaderTranslate: (() => void) | null;
  /** 通道收尾后回调（PapersPage 注册刷新列表用；通道空闲沿触发——徽标即时转绿/黄） */
  onSettled: (() => void) | null;
  setOnSettled: (cb: (() => void) | null) => void;
}

export const usePaperTaskStore = create<PaperTaskState>((set) => ({
  progress: {},
  vectorizePercent: {},
  onSettled: null,
  setOnSettled: (cb) => set({ onSettled: cb }),
  readerTranslate: null,
  cancelReaderTranslate: null,
  startReaderTranslate: (s, onCancel) => set({ readerTranslate: s, cancelReaderTranslate: onCancel }),
  patchReaderTranslate: (patch) =>
    set((state) => (state.readerTranslate ? { readerTranslate: { ...state.readerTranslate, ...patch } } : {})),
  clearReaderTranslate: () => set({ readerTranslate: null, cancelReaderTranslate: null }),
}));
