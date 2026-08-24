import { create } from "zustand";

/**
 * 论文任务注册表（2026-08-23 批量任务冲突模型统一）：
 * 同篇任务互斥的单一事实源（向量化/翻译两个通道的"运行中"状态）。
 * 解析通道的排队/运行状态在 task-center 的 paper-parse 通道（P2-4 起；原 convert-progress-store），
 * 组合判定（解析×其它）见 utils/paper-conflict.ts。
 *
 * 本模块为叶子（不 import 任何其它 store/service），解析通道与翻译互斥的入队判定
 * 经 paper-conflict 适配层注入 task-center——保持无环。
 */

export type PaperTaskKind = "parse" | "vectorize" | "translate";

/**
 * 冲突矩阵（纯函数，可单测）：
 * - parse 被三类全部阻塞（防重入 / 向量化读旧产物 / 重转使译文错位——翻译白做）
 * - vectorize 被 parse（产物将被替换）+ vectorize（幂等去重）阻塞；× translate 并行（读写不相干）
 * - translate 被 parse + translate（幂等续翻）阻塞；× vectorize 并行
 */
export function conflictKinds(requested: PaperTaskKind, active: PaperTaskKind[]): PaperTaskKind[] {
  const table: Record<PaperTaskKind, PaperTaskKind[]> = {
    parse: ["parse", "vectorize", "translate"],
    vectorize: ["parse", "vectorize"],
    translate: ["parse", "translate"],
  };
  const blockers = table[requested];
  return active.filter((k) => blockers.includes(k));
}

interface PaperTaskRegistryState {
  /** 正在向量化的论文 id 集 */
  activeVectorize: Record<string, true>;
  /** 正在翻译的论文 id 集（批量队列与阅读器单篇直翻共用打点） */
  activeTranslate: Record<string, true>;
  mark: (paperId: string, kind: "vectorize" | "translate", on: boolean) => void;
}

export const usePaperTaskRegistry = create<PaperTaskRegistryState>((set) => ({
  activeVectorize: {},
  activeTranslate: {},
  mark: (paperId, kind, on) =>
    set((state) => {
      const key = kind === "vectorize" ? "activeVectorize" : "activeTranslate";
      const next = { ...state[key] };
      if (on) next[paperId] = true;
      else delete next[paperId];
      return { [key]: next } as Pick<PaperTaskRegistryState, "activeVectorize" | "activeTranslate">;
    }),
}));

/** 命令式读取（非 React 上下文：队列 drain / 工具守卫） */
export function isPaperTaskActive(paperId: string, kind: "vectorize" | "translate"): boolean {
  const state = usePaperTaskRegistry.getState();
  return kind === "vectorize" ? !!state.activeVectorize[paperId] : !!state.activeTranslate[paperId];
}

/** 批量按钮禁用态需要响应式订阅（selection × 注册表），导出浅比较友好的结构 */
export function registryActiveKinds(paperId: string): PaperTaskKind[] {
  const state = usePaperTaskRegistry.getState();
  const active: PaperTaskKind[] = [];
  if (state.activeVectorize[paperId]) active.push("vectorize");
  if (state.activeTranslate[paperId]) active.push("translate");
  return active;
}
