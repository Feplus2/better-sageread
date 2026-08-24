/**
 * 统一任务中心（P2 地基，docs/task-queue-p2-plan.md）。
 *
 * 五通道（图书解析/图书向量化/论文解析/论文向量化/论文翻译）共用一张任务表 + 一套队列泵：
 * 通道内串行（P3 才放开有界并发）、UI 与 AI 入口统一 enqueue、卡片按通道聚合订阅。
 *
 * 本模块是叶子：不 import 任何其它 store/service（冲突判定经 setConflictChecker 注入，
 * 保持与 paper-task-registry 的无环约束同款）。
 */

import { create } from "zustand";
import {
  __resetTaskExecutorRegistryForTests,
  getChannelDef,
  getTaskConflictChecker,
  registerTaskChannel,
  setTaskConflictChecker,
} from "./task-executor-registry";

// 注册表住独立叶子模块（task-executor-registry.ts，永不编辑 → HMR 不重估）：
// 执行器模块加载自注册的通道在 store HMR 后不丢。此处 re-export 保持既有调用方 API 不变。
export { registerTaskChannel, setTaskConflictChecker };

export type TaskChannel = "paper-parse" | "paper-vectorize" | "paper-translate" | "book-convert" | "book-vectorize";
export type TaskStatus = "queued" | "running" | "success" | "error" | "cancelled";

export interface TaskItem {
  taskId: string;
  channel: TaskChannel;
  /** 归属键（paperId / bookId / pdfPath），冲突判定与去重共用 */
  targetId: string;
  title: string;
  /** 通道私有载荷（reparse 的 paperId、translate 的 force、convert 的引擎/翻译标志…） */
  payload?: unknown;
  enqueuedAt: number;
  /** 进入 running 的时间戳：区分「跑过」与「排队中被撤」（卡片计数口径只算跑过的） */
  startedAt?: number;
  status: TaskStatus;
  /** 0-100 */
  percent: number;
  /** 进度行文案 */
  detail: string;
  error?: string;
  /** 执行器结算产物（如图书转换的 epubPath/imported；enqueueAndWait 调用方取用） */
  result?: unknown;
  /** 通道私有的实时进度附件（paper-parse 的四阶段行），执行器经 ctx.reportExtra 更新 */
  extra?: Record<string, unknown>;
  /** 外部自持链路的进度镜像（Zotero 批量导入解析段）：不进泵/去重/冲突/聚合卡，仅投数据 */
  mirror?: true;
  /** 归属批次（一次 enqueue 调用携带的 item 集合） */
  runId: string;
}

/** 一次入队调用产生的批次（卡片"index/total"口径的数据源） */
export interface TaskRun {
  runId: string;
  channel: TaskChannel;
  taskIds: string[];
  startedAt: number;
}

export interface TaskContext {
  /** 执行器报进度（percent 0-100；detail 缺省不变） */
  report: (percent: number, detail?: string) => void;
  /** 执行器更新通道私有的实时附件（合并进 TaskItem.extra；paper-parse 的阶段行用） */
  reportExtra: (patch: Record<string, unknown>) => void;
  /** 执行器写结算产物（enqueueAndWait 的调用方在 resolve 的 TaskItem.result 上取到） */
  setResult: (result: unknown) => void;
  /** 取消信号：执行器应在检查点响应（或把自己的 AbortController 接上来） */
  signal: AbortSignal;
}

export type TaskExecutor = (task: TaskItem, ctx: TaskContext) => Promise<void>;

export interface EnqueueInput {
  channel: TaskChannel;
  targetId: string;
  title: string;
  payload?: unknown;
}

export type EnqueueResult =
  | { ok: true; taskId: string }
  | { ok: false; reason: "duplicate" | "conflict" | "no-executor"; detail?: string };

interface TaskCenterState {
  tasks: Record<string, TaskItem>;
  /** 全局入队顺序（展示用；运行/排队判定走 channel 过滤） */
  order: string[];
  runs: Record<string, TaskRun>;
  /** 通道取消中标志（cancelChannel 置位，泵收尾清除——卡片"正在取消…"按钮态用） */
  cancelling: Partial<Record<TaskChannel, boolean>>;
  enqueue: (input: EnqueueInput) => EnqueueResult;
  /** 入队并等待结算（AI 工具保持阻塞语义用）：成功 resolve 任务，失败/取消 reject */
  enqueueAndWait: (input: EnqueueInput) => Promise<TaskItem>;
  /** 等待既有任务结算（先入队拿 taskId、后挂等待的拆分路径用，如 importPaperPdf 的超时取消） */
  waitTask: (taskId: string) => Promise<TaskItem>;
  /** 取消单个任务（queued 直接撤，running 发 abort 信号） */
  cancelTask: (taskId: string) => void;
  /** 取消通道全部排队 + 运行中任务 */
  cancelChannel: (channel: TaskChannel) => void;
  /** 清掉通道的已结算任务（卡片关闭/下次入队前的视觉复位） */
  dismissSettled: (channel: TaskChannel) => void;
  /** 刷新恢复占用（P2-4 paper-parse）：以 running 态注入任务并占住通道泵位（旧 paperDraining
   *  占位等价物）——恢复期间新 enqueue 排队不并发，settleRecoveredTask 释放后自动接续。
   *  返回绑定到该任务的 report/reportExtra/setResult 与取消 signal；通道已被占用时返回 null */
  occupyForRecovery: (input: EnqueueInput) => {
    taskId: string;
    signal: AbortSignal;
    report: TaskContext["report"];
    reportExtra: TaskContext["reportExtra"];
    setResult: TaskContext["setResult"];
  } | null;
  /** 恢复任务结算：落终态、释放泵位、接续排队任务（对齐旧 settleRecovered 收尾语义） */
  settleRecoveredTask: (taskId: string, finalStatus: "success" | "error" | "cancelled", error?: string) => void;
  /** 外部自持链路（Zotero 批量导入解析段）的进度镜像：仅投到任务表供卡片读统一数据源，
   *  不进泵/聚合/冲突/去重（聚合选择器按 mirror 标志排除）；endMirrorTask 直接移除不留残影 */
  beginMirrorTask: (input: { channel: TaskChannel; targetId: string; title: string }) => string;
  updateMirrorTask: (
    taskId: string,
    patch: { percent?: number; detail?: string; extra?: Record<string, unknown> },
  ) => void;
  endMirrorTask: (taskId: string) => void;
}

// ─── 模块级执行态（不进 zustand：句柄/泵位不可序列化，对齐既有 store 惯例） ───
// （通道注册表与冲突检查器住 task-executor-registry.ts——独立叶子模块，HMR 不丢注册）

const draining: Partial<Record<TaskChannel, boolean>> = {};
const abortControllers = new Map<string, AbortController>();
const waiters = new Map<string, { resolve: (task: TaskItem) => void; reject: (error: Error) => void }>();

const patchTask = (taskId: string, patch: Partial<TaskItem>): void =>
  useTaskCenterStore.setState((s) => {
    const task = s.tasks[taskId];
    if (!task) return s;
    return { tasks: { ...s.tasks, [taskId]: { ...task, ...patch } } };
  });

/** 合并任务的 extra 附件（reportExtra / 镜像更新共用；模块级 helper，避免在 creator 闭包里自引用 store） */
const mergeTaskExtra = (taskId: string, patch: Record<string, unknown>): void =>
  useTaskCenterStore.setState((s) => {
    const task = s.tasks[taskId];
    if (!task) return s;
    return { tasks: { ...s.tasks, [taskId]: { ...task, extra: { ...task.extra, ...patch } } } };
  });

function nextQueued(channel: TaskChannel): TaskItem | null {
  const { tasks, order } = useTaskCenterStore.getState();
  for (const id of order) {
    const task = tasks[id];
    if (task && task.channel === channel && task.status === "queued") return task;
  }
  return null;
}

function settleWaiter(taskId: string, finalStatus: TaskStatus, error?: string): void {
  const waiter = waiters.get(taskId);
  if (!waiter) return;
  waiters.delete(taskId);
  const task = useTaskCenterStore.getState().tasks[taskId];
  if (finalStatus === "success" && task) waiter.resolve(task);
  else waiter.reject(new Error(error ?? (finalStatus === "cancelled" ? "任务已取消" : "任务失败")));
}

/** 通道泵：串行逐任务执行；收尾后复查接续（运行期新入队不丢） */
async function drainChannel(channel: TaskChannel): Promise<void> {
  if (draining[channel]) return;
  const def = getChannelDef(channel);
  if (!def) return;
  draining[channel] = true;
  try {
    for (;;) {
      const task = nextQueued(channel);
      if (!task) break;
      const ac = new AbortController();
      abortControllers.set(task.taskId, ac);
      patchTask(task.taskId, { status: "running", startedAt: Date.now() });
      try {
        await def.executor(task, {
          report: (percent, detail) => patchTask(task.taskId, detail === undefined ? { percent } : { percent, detail }),
          reportExtra: (patch) => mergeTaskExtra(task.taskId, patch),
          setResult: (result) => patchTask(task.taskId, { result }),
          signal: ac.signal,
        });
        patchTask(task.taskId, { status: "success", percent: 100 });
        settleWaiter(task.taskId, "success");
      } catch (error) {
        const cancelled = ac.signal.aborted;
        const message = error instanceof Error ? error.message : String(error);
        patchTask(task.taskId, {
          status: cancelled ? "cancelled" : "error",
          error: cancelled ? undefined : message,
        });
        settleWaiter(task.taskId, cancelled ? "cancelled" : "error", message);
      } finally {
        abortControllers.delete(task.taskId);
      }
    }
  } finally {
    draining[channel] = false;
    if (useTaskCenterStore.getState().cancelling[channel]) {
      useTaskCenterStore.setState((s) => ({ cancelling: { ...s.cancelling, [channel]: false } }));
    }
    // 收尾窗口内新入队的接续（对齐既有 drain 语义）
    if (nextQueued(channel)) void drainChannel(channel);
  }
}

export const useTaskCenterStore = create<TaskCenterState>()((set, get) => ({
  tasks: {},
  order: [],
  runs: {},
  cancelling: {},

  enqueue: (input) => {
    const def = getChannelDef(input.channel);
    if (!def) return { ok: false, reason: "no-executor" };
    const { tasks } = get();
    // 幂等去重：同通道同归属已在排队/运行中 → 拒入队（对齐既有队列口径；镜像任务不算占用）
    const dup = Object.values(tasks).find(
      (t) =>
        t.channel === input.channel &&
        !t.mirror &&
        t.targetId === input.targetId &&
        (t.status === "queued" || t.status === "running"),
    );
    if (dup) return { ok: false, reason: "duplicate", detail: `《${input.title}》已在该队列中` };
    const conflict = getTaskConflictChecker()?.(input.channel, input.targetId) ?? null;
    if (conflict) return { ok: false, reason: "conflict", detail: conflict };

    const taskId = crypto.randomUUID();
    const item: TaskItem = {
      taskId,
      channel: input.channel,
      targetId: input.targetId,
      title: input.title,
      payload: input.payload,
      enqueuedAt: Date.now(),
      status: "queued",
      percent: 0,
      detail: "",
      runId: crypto.randomUUID(),
    };
    set((s) => ({
      tasks: { ...s.tasks, [taskId]: item },
      order: [...s.order, taskId],
      runs: {
        ...s.runs,
        [item.runId]: { runId: item.runId, channel: input.channel, taskIds: [taskId], startedAt: item.enqueuedAt },
      },
    }));
    void drainChannel(input.channel);
    return { ok: true, taskId };
  },

  enqueueAndWait: (input) => {
    const result = get().enqueue(input);
    if (!result.ok) return Promise.reject(new Error(result.detail ?? `入队失败（${result.reason}）`));
    return new Promise<TaskItem>((resolve, reject) => {
      waiters.set(result.taskId, { resolve, reject });
    });
  },

  waitTask: (taskId) => {
    const task = get().tasks[taskId];
    if (!task) return Promise.reject(new Error("任务不存在"));
    if (task.status === "success") return Promise.resolve(task);
    if (task.status === "error") return Promise.reject(new Error(task.error ?? "任务失败"));
    if (task.status === "cancelled") return Promise.reject(new Error("任务已取消"));
    return new Promise<TaskItem>((resolve, reject) => {
      waiters.set(taskId, { resolve, reject });
    });
  },

  cancelTask: (taskId) => {
    const task = get().tasks[taskId];
    if (!task || task.mirror) return;
    if (task.status === "queued") {
      patchTask(taskId, { status: "cancelled" });
      settleWaiter(taskId, "cancelled");
      return;
    }
    if (task.status === "running") abortControllers.get(taskId)?.abort();
  },

  cancelChannel: (channel) => {
    let any = false;
    for (const task of Object.values(get().tasks)) {
      if (task.channel !== channel || task.mirror) continue;
      if (task.status === "queued" || task.status === "running") {
        get().cancelTask(task.taskId);
        any = true;
      }
    }
    // 取消中标志：运行中任务收尾期间卡片按钮置灰（泵收尾时清除）；无可撤任务不置位
    if (any) set((s) => ({ cancelling: { ...s.cancelling, [channel]: true } }));
  },

  dismissSettled: (channel) =>
    set((s) => {
      const tasks = { ...s.tasks };
      const removed: string[] = [];
      for (const [id, task] of Object.entries(tasks)) {
        if (task.channel === channel && task.status !== "queued" && task.status !== "running") {
          delete tasks[id];
          removed.push(id);
        }
      }
      if (removed.length === 0) return s;
      const dropped = new Set(removed);
      return { tasks, order: s.order.filter((id) => !dropped.has(id)) };
    }),

  occupyForRecovery: (input) => {
    // 通道已被占（泵在跑/已有恢复占用）→ 拒绝，调用方按「实时通道健在」处理
    if (draining[input.channel]) return null;
    const taskId = crypto.randomUUID();
    const item: TaskItem = {
      taskId,
      channel: input.channel,
      targetId: input.targetId,
      title: input.title,
      payload: input.payload,
      enqueuedAt: Date.now(),
      startedAt: Date.now(),
      status: "running",
      percent: 0,
      detail: "",
      runId: crypto.randomUUID(),
    };
    set((s) => ({
      tasks: { ...s.tasks, [taskId]: item },
      order: [...s.order, taskId],
      runs: {
        ...s.runs,
        [item.runId]: { runId: item.runId, channel: input.channel, taskIds: [taskId], startedAt: item.enqueuedAt },
      },
    }));
    draining[input.channel] = true;
    const ac = new AbortController();
    abortControllers.set(taskId, ac);
    return {
      taskId,
      signal: ac.signal,
      report: (percent, detail) => patchTask(taskId, detail === undefined ? { percent } : { percent, detail }),
      reportExtra: (patch) => mergeTaskExtra(taskId, patch),
      setResult: (result) => patchTask(taskId, { result }),
    };
  },

  settleRecoveredTask: (taskId, finalStatus, error) => {
    const task = get().tasks[taskId];
    if (!task) return;
    patchTask(taskId, {
      status: finalStatus,
      ...(finalStatus === "success" ? { percent: 100 } : {}),
      ...(error !== undefined ? { error } : {}),
    });
    abortControllers.delete(taskId);
    draining[task.channel] = false;
    // 恢复期间新提交的排队任务接续（对齐旧 settleRecovered → drainPaperQueue 收尾语义）
    if (nextQueued(task.channel)) void drainChannel(task.channel);
  },

  beginMirrorTask: (input) => {
    const taskId = crypto.randomUUID();
    const item: TaskItem = {
      taskId,
      channel: input.channel,
      targetId: input.targetId,
      title: input.title,
      enqueuedAt: Date.now(),
      startedAt: Date.now(),
      status: "running",
      percent: 0,
      detail: "",
      mirror: true,
      runId: crypto.randomUUID(),
    };
    set((s) => ({
      tasks: { ...s.tasks, [taskId]: item },
      order: [...s.order, taskId],
      runs: {
        ...s.runs,
        [item.runId]: { runId: item.runId, channel: input.channel, taskIds: [taskId], startedAt: item.enqueuedAt },
      },
    }));
    return taskId;
  },

  updateMirrorTask: (taskId, patch) => {
    const task = get().tasks[taskId];
    if (!task?.mirror) return;
    patchTask(taskId, {
      ...(patch.percent !== undefined ? { percent: patch.percent } : {}),
      ...(patch.detail !== undefined ? { detail: patch.detail } : {}),
      ...(patch.extra !== undefined ? { extra: { ...task.extra, ...patch.extra } } : {}),
    });
  },

  endMirrorTask: (taskId) =>
    set((s) => {
      if (!s.tasks[taskId]?.mirror) return s;
      const tasks = { ...s.tasks };
      delete tasks[taskId];
      return { tasks, order: s.order.filter((id) => id !== taskId) };
    }),
}));

// ─── 卡片聚合选择器（通道级视图：对齐既有卡片的 index/total + 当前项口径） ───

export interface ChannelAggregate {
  channel: TaskChannel;
  /** 运行中任务（无则 null） */
  current: TaskItem | null;
  /** 排队数 */
  queuedCount: number;
  /** 最近一次批次的已结算任务（卡片收尾展示；dismissSettled 后清空） */
  settled: TaskItem[];
}

export function selectChannelAggregate(
  state: Pick<TaskCenterState, "tasks" | "order">,
  channel: TaskChannel,
): ChannelAggregate {
  let current: TaskItem | null = null;
  let queuedCount = 0;
  const settled: TaskItem[] = [];
  for (const id of state.order) {
    const task = state.tasks[id];
    if (!task || task.channel !== channel || task.mirror) continue;
    if (task.status === "running") current = task;
    else if (task.status === "queued") queuedCount += 1;
    else settled.push(task);
  }
  return { channel, current, queuedCount, settled };
}

/** 测试专用：清空全部状态与模块级执行态（勿在生产路径调用） */
export function __resetTaskCenterForTests(): void {
  __resetTaskExecutorRegistryForTests();
  waiters.clear();
  abortControllers.clear();
  for (const key of Object.keys(draining)) delete draining[key as TaskChannel];
  useTaskCenterStore.setState({ tasks: {}, order: [], runs: {}, cancelling: {} });
}
