import { create } from "zustand";

/**
 * Agent 确认卡桥（P1）：transport 的 tool-guard 与 React 树无连接，
 * 写工具的 execute 需要用户确认时，经此 store 挂起等待；确认卡 UI 订阅 queue[0] 渲染。
 * 队列式：ReAct 循环/并行工具调用可能连续触发多个确认，逐张处理。
 * sessionAllowlist：确认卡勾选"本次会话不再询问"后按 key 直通（仅内存，重启失效）。
 */

export interface AgentConfirmRequest {
  id: string;
  /** 工具名（writeFile / runCommand / httpRequest …） */
  toolName: string;
  /** 一句话标题，如"写入工作区外文件"、"执行命令" */
  title: string;
  /** 全文展示：目标路径 / 命令全文 / 请求方法与 URL */
  detail: string;
  /** "本次会话不再询问"的去重 key（工具名:路径或命令） */
  dontAskKey: string;
  resolve: (approved: boolean) => void;
}

interface AgentConfirmState {
  queue: AgentConfirmRequest[];
  sessionAllowlist: Set<string>;
  /** 命中会话免打扰则立即放行；否则入队挂起等待用户点击 */
  requestConfirmation: (req: Omit<AgentConfirmRequest, "id" | "resolve">) => Promise<boolean>;
  /** 确认卡点击：处理队首一张，后续自动顶上来 */
  resolvePending: (approved: boolean, dontAsk: boolean) => void;
  /** 流被中止时按 key 撤下未处理的确认卡（其 Promise 由调用方自行了结） */
  dropByKey: (dontAskKey: string) => void;
}

let seq = 0;

export const useAgentConfirmStore = create<AgentConfirmState>()((set, get) => ({
  queue: [],
  sessionAllowlist: new Set<string>(),

  requestConfirmation: (req) => {
    if (get().sessionAllowlist.has(req.dontAskKey)) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      set((s) => ({
        queue: [...s.queue, { ...req, id: `agent-confirm-${++seq}`, resolve }],
      }));
    });
  },

  resolvePending: (approved, dontAsk) => {
    const { queue, sessionAllowlist } = get();
    const [head, ...rest] = queue;
    if (!head) return;
    if (approved && dontAsk) {
      const next = new Set(sessionAllowlist);
      next.add(head.dontAskKey);
      set({ sessionAllowlist: next });
    }
    set({ queue: rest });
    head.resolve(approved);
  },

  dropByKey: (dontAskKey) => {
    set((s) => ({ queue: s.queue.filter((r) => r.dontAskKey !== dontAskKey) }));
  },
}));
