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
  /** 文件预览只使用精确的 previewGrants，不读写通用会话免打扰。 */
  skipSessionAllowlist?: boolean;
  resolve: (approved: boolean) => void;
}

interface PreviewGrantIdentity {
  modifiedMs?: number;
  size?: number;
}

interface AgentConfirmState {
  queue: AgentConfirmRequest[];
  sessionAllowlist: Set<string>;
  /** 命中会话免打扰则立即放行；否则入队挂起等待用户点击 */
  requestConfirmation: (req: Omit<AgentConfirmRequest, "id" | "resolve">) => Promise<boolean>;
  requestConfirmationWithId: (req: Omit<AgentConfirmRequest, "id" | "resolve">) => {
    requestId?: string;
    promise: Promise<boolean>;
  };
  /** 确认卡点击：处理队首一张，后续自动顶上来 */
  resolvePending: (approved: boolean, dontAsk: boolean) => void;
  /** 流被中止时按唯一请求 id 撤卡，不影响同 key 的其他并发请求。 */
  dropById: (requestId: string) => void;
  previewGrants: Record<string, PreviewGrantIdentity>;
  getPreviewGrant: (scope: string, canonicalRoot: string, canonicalTarget: string) => PreviewGrantIdentity | undefined;
  hasPreviewGrant: (scope: string, canonicalRoot: string, canonicalTarget: string) => boolean;
  recordPreviewGrant: (
    scope: string,
    canonicalRoot: string,
    canonicalTarget: string,
    identity?: PreviewGrantIdentity,
  ) => void;
  revokePreviewGrant: (scope: string, canonicalRoot: string, canonicalTarget: string) => void;
}

function previewGrantKey(scope: string, canonicalRoot: string, canonicalTarget: string): string {
  return JSON.stringify([scope, canonicalRoot, canonicalTarget]);
}

let seq = 0;

export const useAgentConfirmStore = create<AgentConfirmState>()((set, get) => ({
  queue: [],
  sessionAllowlist: new Set<string>(),
  previewGrants: {},
  getPreviewGrant: (scope, canonicalRoot, canonicalTarget) =>
    get().previewGrants[previewGrantKey(scope, canonicalRoot, canonicalTarget)],
  hasPreviewGrant: (scope, canonicalRoot, canonicalTarget) =>
    Boolean(get().previewGrants[previewGrantKey(scope, canonicalRoot, canonicalTarget)]),
  recordPreviewGrant: (scope, canonicalRoot, canonicalTarget, identity = {}) =>
    set((state) => ({
      previewGrants: {
        ...state.previewGrants,
        [previewGrantKey(scope, canonicalRoot, canonicalTarget)]: identity,
      },
    })),
  revokePreviewGrant: (scope, canonicalRoot, canonicalTarget) =>
    set((state) => {
      const previewGrants = { ...state.previewGrants };
      delete previewGrants[previewGrantKey(scope, canonicalRoot, canonicalTarget)];
      return { previewGrants };
    }),

  requestConfirmationWithId: (req) => {
    if (!req.skipSessionAllowlist && get().sessionAllowlist.has(req.dontAskKey)) {
      return { promise: Promise.resolve(true) };
    }
    const requestId = `agent-confirm-${++seq}`;
    return {
      requestId,
      promise: new Promise<boolean>((resolve) => {
        set((s) => ({
          queue: [...s.queue, { ...req, id: requestId, resolve }],
        }));
      }),
    };
  },
  requestConfirmation: (req) => get().requestConfirmationWithId(req).promise,

  resolvePending: (approved, dontAsk) => {
    const { queue, sessionAllowlist } = get();
    const [head, ...rest] = queue;
    if (!head) return;
    if (approved && dontAsk && !head.skipSessionAllowlist) {
      const next = new Set(sessionAllowlist);
      next.add(head.dontAskKey);
      set({ sessionAllowlist: next });
    }
    set({ queue: rest });
    head.resolve(approved);
  },

  dropById: (requestId) => {
    set((s) => ({ queue: s.queue.filter((r) => r.id !== requestId) }));
  },
}));
