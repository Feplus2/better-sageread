import { vectorizePaper } from "@/services/paper-service";
import { translatePaper } from "@/services/paper-translation-service";
import { usePaperTaskRegistry } from "@/store/paper-task-registry";
import { conflictReasonText, paperConflicts } from "@/utils/paper-conflict";
import { appDataDir } from "@tauri-apps/api/path";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { toast } from "sonner";
import { create } from "zustand";

/**
 * 论文批量任务队列（2026-08-23）：向量化/翻译通道队列化，对齐重解析的既有模式——
 * 单篇=批量=入队、运行中可加队、通道内串行、通道间（含解析通道）天然并行。
 * 同篇互斥在入队口经 utils/paper-conflict 统一判定（冲突矩阵见 paper-task-registry）。
 * 批量按钮的禁用态不在此判（页面按 selection×注册表实时推导），入队口的冲突拒绝
 * 仅作点击竞态的兜底，单条聚合提示。
 */

export type TaskKind = "vectorize" | "translate";

interface TaskItem {
  id: string;
  title: string;
  author?: string;
  /** 单篇直发（卡片按钮）：完成时给该篇独立 toast；批量收尾只走进度卡汇总 */
  solo?: boolean;
}

/** 进度卡状态（与 PapersPage 既有 BatchProgressCard 字段一一对应） */
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

interface PaperTaskState {
  vectorizeQueue: TaskItem[];
  translateQueue: TaskItem[];
  vectorizeDraining: boolean;
  translateDraining: boolean;
  /** 每通道独立进度卡（通道并行时各显示各的） */
  progress: Partial<Record<TaskKind, ChannelProgress>>;
  /** 每篇向量化百分比（卡片圆环用，与旧 setVectorizing 兼容） */
  vectorizePercent: Record<string, number>;
  enqueue: (kind: TaskKind, papers: TaskItem[]) => { ok: boolean; rejectedCount: number };
  cancel: (kind: TaskKind) => void;
  /** 通道收尾后回调（PapersPage 注册刷新列表用） */
  onSettled: (() => void) | null;
  setOnSettled: (cb: (() => void) | null) => void;
}

const cancelVectorize = { current: false };
let translateAbort: AbortController | null = null;

const patchProgress = (kind: TaskKind, patch: Partial<ChannelProgress>) =>
  usePaperTaskStore.setState((s) => ({
    progress: { ...s.progress, [kind]: { ...(s.progress[kind] as ChannelProgress), ...patch } },
  }));

export const usePaperTaskStore = create<PaperTaskState>((set, get) => ({
  vectorizeQueue: [],
  translateQueue: [],
  vectorizeDraining: false,
  translateDraining: false,
  progress: {},
  vectorizePercent: {},
  onSettled: null,
  setOnSettled: (cb) => set({ onSettled: cb }),

  enqueue: (kind, papers) => {
    const accepted: TaskItem[] = [];
    let rejectedCount = 0;
    const rejectedSamples: string[] = [];
    // 入队口幂等：已在同通道队列中也算冲突（防重复入队）
    const queuedIds = new Set((kind === "vectorize" ? get().vectorizeQueue : get().translateQueue).map((t) => t.id));
    for (const paper of papers) {
      if (queuedIds.has(paper.id)) {
        rejectedCount += 1;
        if (rejectedSamples.length < 3) rejectedSamples.push(`《${paper.title}》已在该队列中`);
        continue;
      }
      const conflicts = paperConflicts(paper.id, kind);
      if (conflicts.length > 0) {
        rejectedCount += 1;
        if (rejectedSamples.length < 3) rejectedSamples.push(`《${paper.title}》${conflictReasonText(conflicts)}`);
        continue;
      }
      accepted.push(paper);
    }
    if (rejectedCount > 0) {
      toast.info(
        `跳过 ${rejectedCount} 篇：${rejectedSamples.join("；")}${rejectedCount > rejectedSamples.length ? " 等" : ""}`,
        { duration: 6000 },
      );
    }
    if (accepted.length === 0) return { ok: false, rejectedCount };

    if (kind === "vectorize") {
      set((s) => ({ vectorizeQueue: [...s.vectorizeQueue, ...accepted] }));
      void drainVectorize();
    } else {
      set((s) => ({ translateQueue: [...s.translateQueue, ...accepted] }));
      void drainTranslate();
    }
    return { ok: true, rejectedCount };
  },

  cancel: (kind) => {
    if (kind === "vectorize") {
      cancelVectorize.current = true;
      set((s) => ({
        vectorizeQueue: [],
        progress: s.progress.vectorize
          ? { ...s.progress, vectorize: { ...s.progress.vectorize, cancelling: true, detail: "正在取消…" } }
          : s.progress,
      }));
    } else {
      translateAbort?.abort();
      set((s) => ({
        translateQueue: [],
        progress: s.progress.translate
          ? { ...s.progress, translate: { ...s.progress.translate, cancelling: true, detail: "正在取消…" } }
          : s.progress,
      }));
    }
  },
}));

async function drainVectorize() {
  const state = usePaperTaskStore.getState();
  if (state.vectorizeDraining) return;
  usePaperTaskStore.setState({ vectorizeDraining: true });
  cancelVectorize.current = false;

  const total = state.vectorizeQueue.length;
  let done = 0;
  const failedNames: string[] = [];
  const mark = usePaperTaskRegistry.getState().mark;

  usePaperTaskStore.setState({
    progress: {
      vectorize: {
        status: "running",
        index: 0,
        total,
        title: "",
        detail: "准备向量化…",
        percent: 0,
        doneCount: 0,
        failedCount: 0,
        skippedCount: 0,
        failedNames: [],
      },
    },
  });

  while (true) {
    const item = usePaperTaskStore.getState().vectorizeQueue[0];
    if (!item) break;
    // 取消语义对齐解析通道：cancel() 已就地清队，此后入队的项是新意图——
    // 本泵遇到取消标即收尾（不二次清队），收尾后由结尾段重泵续跑新意图
    if (cancelVectorize.current) break;
    const index = done + failedNames.length;
    patchProgress("vectorize", {
      index,
      title: item.title,
      detail: "向量化中…",
      percent: Math.round((index / total) * 100),
    });
    usePaperTaskStore.setState((s) => ({ vectorizePercent: { ...s.vectorizePercent, [item.id]: 0 } }));
    mark(item.id, "vectorize", true);
    try {
      const res = await vectorizePaper({ id: item.id, title: item.title, author: item.author ?? "" });
      done += 1;
      if (item.solo) {
        toast.success(`《${item.title}》向量化完成，分块数：${res.report?.total_chunks ?? "未知"}`);
      }
    } catch (error) {
      failedNames.push(item.title);
      console.error(`向量化论文失败: ${item.id}`, error);
      if (item.solo) {
        toast.error(`《${item.title}》向量化失败：${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      mark(item.id, "vectorize", false);
      // 按 id 摘除当前篇（不能 slice(1)：取消窗口内新入队的项占据了队首会被误吞）
      usePaperTaskStore.setState((s) => {
        const next = { ...s.vectorizePercent };
        delete next[item.id];
        return { vectorizePercent: next, vectorizeQueue: s.vectorizeQueue.filter((t) => t.id !== item.id) };
      });
      patchProgress("vectorize", { doneCount: done, failedCount: failedNames.length, failedNames: [...failedNames] });
    }
  }

  const cancelled = cancelVectorize.current;
  const remaining = Math.max(0, total - done - failedNames.length);
  patchProgress("vectorize", {
    status: failedNames.length > 0 ? "error" : "success",
    percent: 100,
    summary: cancelled
      ? `已取消：完成 ${done} · 失败 ${failedNames.length}，剩余 ${remaining} 篇未处理`
      : `完成 ${done} 篇${failedNames.length > 0 ? ` · 失败 ${failedNames.length}` : ""}`,
  });
  if (!cancelled && total > 1) {
    toast.success(`批量向量化完成 ${done} 篇${failedNames.length > 0 ? `，失败 ${failedNames.length} 篇` : ""}`);
  }
  usePaperTaskStore.setState({ vectorizeDraining: false });
  usePaperTaskStore.getState().onSettled?.();
  // 取消后又有新提交（新意图）：重新起泵接续（对齐解析通道 drainPaperQueue 收尾段语义）
  if (cancelled && usePaperTaskStore.getState().vectorizeQueue.length > 0) void drainVectorize();
}

async function drainTranslate() {
  const state = usePaperTaskStore.getState();
  if (state.translateDraining) return;
  usePaperTaskStore.setState({ translateDraining: true });

  const total = state.translateQueue.length;
  let done = 0;
  const failedNames: string[] = [];
  const mark = usePaperTaskRegistry.getState().mark;
  const base = await appDataDir();

  usePaperTaskStore.setState({
    progress: {
      translate: {
        status: "running",
        index: 0,
        total,
        title: "",
        detail: "准备翻译…",
        percent: 0,
        doneCount: 0,
        failedCount: 0,
        skippedCount: 0,
        failedNames: [],
      },
    },
  });

  while (true) {
    const item = usePaperTaskStore.getState().translateQueue[0];
    if (!item) break;
    const index = done + failedNames.length;
    translateAbort = new AbortController();
    patchProgress("translate", {
      index,
      title: item.title,
      detail: "读取正文…",
      percent: Math.round((index / total) * 100),
    });
    mark(item.id, "translate", true);
    try {
      const markdown = await readTextFile(`${base}/books/${item.id}/paper.md`);
      const result = await translatePaper({
        paperId: item.id,
        markdown,
        force: false,
        signal: translateAbort.signal,
        onProgress: ({ done: d, total: t }) =>
          patchProgress("translate", {
            detail: t > 0 ? `翻译块 ${d}/${t}` : undefined,
            percent: Math.round(((index + (t > 0 ? d / t : 0)) / total) * 100),
          }),
      });
      if (result.cancelled) break;
      done += 1;
      if (item.solo) {
        toast.success(
          result.translated > 0
            ? `《${item.title}》翻译完成：新翻 ${result.translated} 块，跳过已翻 ${result.skipped} 块`
            : `《${item.title}》翻译完成：所有块均已有译文`,
        );
      }
    } catch (error) {
      if (translateAbort.signal.aborted) break;
      failedNames.push(item.title);
      console.error(`翻译论文失败: ${item.id}`, error);
      if (item.solo) {
        toast.error(`《${item.title}》翻译失败：${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      mark(item.id, "translate", false);
      // 按 id 摘除当前篇（不能 slice(1)：取消窗口内新入队的项占据了队首会被误吞）
      usePaperTaskStore.setState((s) => ({ translateQueue: s.translateQueue.filter((t) => t.id !== item.id) }));
      patchProgress("translate", { doneCount: done, failedCount: failedNames.length, failedNames: [...failedNames] });
    }
  }

  const cancelled = translateAbort?.signal.aborted ?? false;
  const remaining = Math.max(0, total - done - failedNames.length);
  patchProgress("translate", {
    status: failedNames.length > 0 ? "error" : "success",
    percent: 100,
    summary: cancelled
      ? `已取消：完成 ${done} · 失败 ${failedNames.length}，剩余 ${remaining} 篇未处理（已翻部分已落盘，可续翻）`
      : `完成 ${done} 篇${failedNames.length > 0 ? ` · 失败 ${failedNames.length}` : ""}`,
  });
  translateAbort = null;
  usePaperTaskStore.setState({ translateDraining: false });
  usePaperTaskStore.getState().onSettled?.();
  // 取消后又有新提交（新意图）：重新起泵接续（对齐解析通道 drainPaperQueue 收尾段语义）
  if (cancelled && usePaperTaskStore.getState().translateQueue.length > 0) void drainTranslate();
}

/** 队列容量探测（按钮禁用态的"排队中也算冲突"要与入队口径一致，供 paper-conflict 侧页面拼装） */
export function queuedIdsOf(kind: TaskKind): Set<string> {
  const s = usePaperTaskStore.getState();
  return new Set((kind === "vectorize" ? s.vectorizeQueue : s.translateQueue).map((t) => t.id));
}
