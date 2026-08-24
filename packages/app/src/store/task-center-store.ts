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
  status: TaskStatus;
  /** 0-100 */
  percent: number;
  /** 进度行文案 */
  detail: string;
  error?: string;
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
  /** 取消信号：执行器应在检查点响应（或把自己的 AbortController 接上来） */
  signal: AbortSignal;
}

export type TaskExecutor = (task: TaskItem, ctx: TaskContext) => Promise<void>;

interface ChannelDef {
  executor: TaskExecutor;
  /** P2 恒 1；P3 解析通道可调 2（泵按并发槽调度） */
  concurrency: number;
}

/** 冲突检查器：返回拒绝原因文案（null = 无冲突）。由 paper-conflict 适配层注入。 */
type ConflictChecker = (channel: TaskChannel, targetId: string) => string | null;

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
  enqueue: (input: EnqueueInput) => EnqueueResult;
  /** 入队并等待结算（AI 工具保持阻塞语义用）：成功 resolve 任务，失败/取消 reject */
  enqueueAndWait: (input: EnqueueInput) => Promise<TaskItem>;
  /** 取消单个任务（queued 直接撤，running 发 abort 信号） */
  cancelTask: (taskId: string) => void;
  /** 取消通道全部排队 + 运行中任务 */
  cancelChannel: (channel: TaskChannel) => void;
  /** 清掉通道的已结算任务（卡片关闭/下次入队前的视觉复位） */
  dismissSettled: (channel: TaskChannel) => void;
}

// ─── 模块级执行态（不进 zustand：句柄/泵位不可序列化，对齐既有 store 惯例） ───

const channelDefs = new Map<TaskChannel, ChannelDef>();
const draining: Partial<Record<TaskChannel, boolean>> = {};
const abortControllers = new Map<string, AbortController>();
const waiters = new Map<string, { resolve: (task: TaskItem) => void; reject: (error: Error) => void }>();
let conflictChecker: ConflictChecker | null = null;

/** 通道注册（执行器模块初始化时调用；重复注册后者覆盖，便于 HMR/测试重置） */
export function registerTaskChannel(channel: TaskChannel, def: ChannelDef): void {
  channelDefs.set(channel, def);
}

/** 冲突检查器注入（paper-conflict 适配层在 P2-3 接入；图书通道可不注入） */
export function setTaskConflictChecker(checker: ConflictChecker | null): void {
  conflictChecker = checker;
}

const patchTask = (taskId: string, patch: Partial<TaskItem>) =>
  useTaskCenterStore.setState((s) => {
    const task = s.tasks[taskId];
    if (!task) return s;
    return { tasks: { ...s.tasks, [taskId]: { ...task, ...patch } } };
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
  const def = channelDefs.get(channel);
  if (!def) return;
  draining[channel] = true;
  try {
    for (;;) {
      const task = nextQueued(channel);
      if (!task) break;
      const ac = new AbortController();
      abortControllers.set(task.taskId, ac);
      patchTask(task.taskId, { status: "running" });
      try {
        await def.executor(task, {
          report: (percent, detail) => patchTask(task.taskId, detail === undefined ? { percent } : { percent, detail }),
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
    // 收尾窗口内新入队的接续（对齐既有 drain 语义）
    if (nextQueued(channel)) void drainChannel(channel);
  }
}

export const useTaskCenterStore = create<TaskCenterState>()((set, get) => ({
  tasks: {},
  order: [],
  runs: {},

  enqueue: (input) => {
    const def = channelDefs.get(input.channel);
    if (!def) return { ok: false, reason: "no-executor" };
    const { tasks } = get();
    // 幂等去重：同通道同归属已在排队/运行中 → 拒入队（对齐既有队列口径）
    const dup = Object.values(tasks).find(
      (t) =>
        t.channel === input.channel &&
        t.targetId === input.targetId &&
        (t.status === "queued" || t.status === "running"),
    );
    if (dup) return { ok: false, reason: "duplicate", detail: `《${input.title}》已在该队列中` };
    const conflict = conflictChecker?.(input.channel, input.targetId) ?? null;
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

  cancelTask: (taskId) => {
    const task = get().tasks[taskId];
    if (!task) return;
    if (task.status === "queued") {
      patchTask(taskId, { status: "cancelled" });
      settleWaiter(taskId, "cancelled");
      return;
    }
    if (task.status === "running") abortControllers.get(taskId)?.abort();
  },

  cancelChannel: (channel) => {
    for (const task of Object.values(get().tasks)) {
      if (task.channel !== channel) continue;
      if (task.status === "queued" || task.status === "running") get().cancelTask(task.taskId);
    }
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

export function selectChannelAggregate(state: TaskCenterState, channel: TaskChannel): ChannelAggregate {
  let current: TaskItem | null = null;
  let queuedCount = 0;
  const settled: TaskItem[] = [];
  for (const id of state.order) {
    const task = state.tasks[id];
    if (!task || task.channel !== channel) continue;
    if (task.status === "running") current = task;
    else if (task.status === "queued") queuedCount += 1;
    else settled.push(task);
  }
  return { channel, current, queuedCount, settled };
}

/** 测试专用：清空全部状态与模块级执行态（勿在生产路径调用） */
export function __resetTaskCenterForTests(): void {
  channelDefs.clear();
  waiters.clear();
  abortControllers.clear();
  conflictChecker = null;
  for (const key of Object.keys(draining)) delete draining[key as TaskChannel];
  useTaskCenterStore.setState({ tasks: {}, order: [], runs: {} });
}
