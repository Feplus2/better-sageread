// 统一任务中心（task-center-store）队列语义单测：
// 串行泵序、进度上报、排队/运行取消、幂等去重、冲突拒绝、enqueueAndWait 结算、收尾接续；
// P3 并发槽：concurrency=2 并行起跑/槽满排队/取消隔离/恢复占用按槽计。
// 运行：node scripts/test-task-center.mjs
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pnpmDir = join(root, "node_modules", ".pnpm");
const esbuildPkg = readdirSync(pnpmDir).find((d) => d.startsWith("esbuild@"));
if (!esbuildPkg) throw new Error("node_modules/.pnpm 下未找到 esbuild，请先 pnpm install");
const esbuild = await import(
  pathToFileURL(join(pnpmDir, esbuildPkg, "node_modules", "esbuild", "lib", "main.js")).href
);

const outDir = mkdtempSync(join(tmpdir(), "task-center-"));
const outfile = join(outDir, "task-center-store.mjs");
await esbuild.build({
  entryPoints: [join(root, "packages/app/src/store/task-center-store.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile,
});
const store = await import(pathToFileURL(outfile).href);
const {
  useTaskCenterStore,
  registerTaskChannel,
  setTaskConflictChecker,
  selectChannelAggregate,
  __resetTaskCenterForTests,
} = store;

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    __resetTaskCenterForTests();
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL - ${name}: ${error.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 可控执行器：记录执行序列；holdMs 模拟任务时长；可按 signal 中断 */
function makeExecutor(log, holdMs = 10) {
  return async (task, ctx) => {
    log.push(`start:${task.title}`);
    for (let i = 0; i < 3; i++) {
      if (ctx.signal.aborted) throw new Error("aborted-by-signal");
      await sleep(holdMs);
      ctx.report(((i + 1) / 3) * 100, `阶段${i + 1}`);
    }
    log.push(`done:${task.title}`);
  };
}

await check("串行泵序：同通道三任务严格按入队顺序执行，不并发", async () => {
  const log = [];
  registerTaskChannel("paper-parse", { executor: makeExecutor(log), concurrency: 1 });
  const { enqueue } = useTaskCenterStore.getState();
  const waits = ["A", "B", "C"].map((t) =>
    useTaskCenterStore.getState().enqueueAndWait({ channel: "paper-parse", targetId: t, title: t }),
  );
  await Promise.all(waits);
  assert(log.join(",") === "start:A,done:A,start:B,done:B,start:C,done:C", `执行序列错乱: ${log.join(",")}`);
  const agg = selectChannelAggregate(useTaskCenterStore.getState(), "paper-parse");
  assert(agg.settled.length === 3 && agg.settled.every((t) => t.status === "success"), "聚合视图应为 3 个 success");
});

await check("进度上报：report 更新 percent/detail 到任务", async () => {
  registerTaskChannel("paper-vectorize", { executor: makeExecutor([], 5), concurrency: 1 });
  const done = useTaskCenterStore
    .getState()
    .enqueueAndWait({ channel: "paper-vectorize", targetId: "p1", title: "p1" });
  await sleep(8); // 跑到中段
  const mid = Object.values(useTaskCenterStore.getState().tasks)[0];
  assert(
    mid.status === "running" && mid.percent > 0 && mid.detail.startsWith("阶段"),
    `中段状态异常: ${JSON.stringify(mid)}`,
  );
  const settled = await done;
  assert(settled.percent === 100 && settled.status === "success", "结算后应 100/success");
});

await check("排队取消：queued 任务直接撤销、执行器不启动、waiter 拒绝", async () => {
  const log = [];
  registerTaskChannel("paper-translate", { executor: makeExecutor(log, 30), concurrency: 1 });
  const s = useTaskCenterStore.getState();
  const first = s.enqueueAndWait({ channel: "paper-translate", targetId: "t1", title: "t1" });
  const second = s.enqueue({ channel: "paper-translate", targetId: "t2", title: "t2" });
  assert(second.ok, "第二篇应入队成功");
  const waited = useTaskCenterStore.getState().enqueueAndWait; // 占位防误用
  void waited;
  // 手动给 second 挂 waiter（enqueueAndWait 等价路径）
  const secondSettled = new Promise((res, rej) => {
    const id = second.taskId;
    const poll = () => {
      const t = useTaskCenterStore.getState().tasks[id];
      if (!t) return rej(new Error("任务消失"));
      if (t.status === "cancelled") return rej(new Error("任务已取消"));
      if (t.status === "success") return res(t);
      setTimeout(poll, 5);
    };
    poll();
  });
  useTaskCenterStore.getState().cancelTask(second.taskId);
  await secondSettled.then(
    () => {
      throw new Error("取消的任务不应成功");
    },
    (e) => assert(e.message === "任务已取消", `拒绝原因异常: ${e.message}`),
  );
  await first;
  assert(!log.includes("start:t2"), `被取消任务不应启动: ${log.join(",")}`);
});

await check("运行中取消：signal 中断执行器，状态 cancelled", async () => {
  registerTaskChannel("book-vectorize", { executor: makeExecutor([], 40), concurrency: 1 });
  const task = useTaskCenterStore.getState().enqueueAndWait({ channel: "book-vectorize", targetId: "b1", title: "b1" });
  await sleep(10);
  const id = Object.keys(useTaskCenterStore.getState().tasks)[0];
  useTaskCenterStore.getState().cancelTask(id);
  await task.then(
    () => {
      throw new Error("应 reject");
    },
    () => {},
  );
  const settled = useTaskCenterStore.getState().tasks[id];
  assert(settled.status === "cancelled", `应为 cancelled，got ${settled.status}`);
});

await check("幂等去重：同通道同 targetId 排队中拒入队；结算后可再入队", async () => {
  registerTaskChannel("book-convert", { executor: makeExecutor([], 20), concurrency: 1 });
  const s = useTaskCenterStore.getState();
  const a = s.enqueue({ channel: "book-convert", targetId: "same.pdf", title: "甲" });
  const b = s.enqueue({ channel: "book-convert", targetId: "same.pdf", title: "乙" });
  assert(a.ok && !b.ok && b.reason === "duplicate", `去重失败: ${JSON.stringify(b)}`);
  await useTaskCenterStore.getState().enqueueAndWait({ channel: "book-convert", targetId: "other.pdf", title: "丙" });
  // 等甲也彻底结算（串行泵：丙完成即甲完成），再把同 targetId 重新入队并等它结算——不留活泵到下一用例
  await useTaskCenterStore
    .getState()
    .enqueueAndWait({ channel: "book-convert", targetId: "same.pdf", title: "乙(重试)" });
});

await check("冲突检查器：注入后按返回文案拒绝", async () => {
  registerTaskChannel("paper-parse", { executor: makeExecutor([]), concurrency: 1 });
  setTaskConflictChecker((channel, targetId) => (targetId === "blocked" ? "该篇正在翻译，解析被阻塞" : null));
  const s = useTaskCenterStore.getState();
  const denied = s.enqueue({ channel: "paper-parse", targetId: "blocked", title: "被阻塞" });
  assert(
    !denied.ok && denied.reason === "conflict" && denied.detail.includes("翻译"),
    `冲突拒绝异常: ${JSON.stringify(denied)}`,
  );
  const allowed = useTaskCenterStore
    .getState()
    .enqueueAndWait({ channel: "paper-parse", targetId: "free", title: "自由" });
  assert((await allowed).status === "success", "无冲突应入队并执行成功");
});

await check("enqueueAndWait：执行器抛错 → reject 并带错误文案", async () => {
  registerTaskChannel("paper-vectorize", {
    executor: async () => {
      throw new Error("embed 服务 429");
    },
    concurrency: 1,
  });
  let caught = null;
  await useTaskCenterStore
    .getState()
    .enqueueAndWait({ channel: "paper-vectorize", targetId: "x", title: "x" })
    .catch((e) => {
      caught = e;
    });
  assert(caught?.message === "embed 服务 429", `应透出执行器错误，got ${caught?.message}`);
  const task = Object.values(useTaskCenterStore.getState().tasks)[0];
  assert(task.status === "error" && task.error === "embed 服务 429", "任务应记 error 态与文案");
});

await check("收尾接续：执行期间入队的新任务在泵收尾后接续执行", async () => {
  const log = [];
  registerTaskChannel("paper-parse", { executor: makeExecutor(log, 20), concurrency: 1 });
  const first = useTaskCenterStore.getState().enqueueAndWait({ channel: "paper-parse", targetId: "f", title: "F" });
  await sleep(5); // 泵已启动
  const second = useTaskCenterStore.getState().enqueueAndWait({ channel: "paper-parse", targetId: "s", title: "S" });
  await Promise.all([first, second]);
  assert(log.join(",") === "start:F,done:F,start:S,done:S", `接续失败: ${log.join(",")}`);
});

// ─── P3 有界并发槽语义（docs/task-concurrency-p3-plan.md §1） ───

await check("并发槽：concurrency=2 同通道最多两个 running，第三个排队等槽释放", async () => {
  const log = [];
  registerTaskChannel("paper-parse", { executor: makeExecutor(log, 30), concurrency: 2 });
  const waits = ["A", "B", "C"].map((t) =>
    useTaskCenterStore.getState().enqueueAndWait({ channel: "paper-parse", targetId: t, title: t }),
  );
  await sleep(5);
  // A/B 并行起跑（launch 同步落 running），C 因槽满排队
  assert(log.includes("start:A") && log.includes("start:B"), `A/B 应并行起跑: ${log.join(",")}`);
  assert(!log.includes("start:C"), `C 应等槽位: ${log.join(",")}`);
  const agg = selectChannelAggregate(useTaskCenterStore.getState(), "paper-parse");
  assert(
    agg.running.length === 2 && agg.queuedCount === 1,
    `并发槽占用异常: running=${agg.running.length} queued=${agg.queuedCount}`,
  );
  await Promise.all(waits);
  const idxFirstDone = Math.min(log.indexOf("done:A"), log.indexOf("done:B"));
  assert(log.indexOf("start:C") > idxFirstDone, `C 应在首个槽位释放后启动: ${log.join(",")}`);
});

await check("并发下取消其一：另一个继续到 success，waiter 语义不变", async () => {
  const log = [];
  registerTaskChannel("paper-parse", { executor: makeExecutor(log, 30), concurrency: 2 });
  const a = useTaskCenterStore.getState().enqueueAndWait({ channel: "paper-parse", targetId: "A", title: "A" });
  const b = useTaskCenterStore.getState().enqueueAndWait({ channel: "paper-parse", targetId: "B", title: "B" });
  await sleep(5);
  const idA = Object.values(useTaskCenterStore.getState().tasks).find((t) => t.title === "A").taskId;
  useTaskCenterStore.getState().cancelTask(idA);
  await a.then(
    () => {
      throw new Error("A 应 reject");
    },
    () => {}, // 拒绝文案随执行器抛错透传（真实执行器为「任务已取消」），此处只断 reject 发生
  );
  const bTask = await b;
  assert(bTask.status === "success", "B 应不受 A 取消影响跑到 success");
  assert(useTaskCenterStore.getState().tasks[idA].status === "cancelled", "A 应为 cancelled");
  assert(log.includes("done:B") && !log.includes("done:A"), `执行序列异常: ${log.join(",")}`);
});

await check("恢复占用按并发槽计：占满拒占、释放后排队任务接续", async () => {
  const log = [];
  registerTaskChannel("paper-parse", { executor: makeExecutor(log, 20), concurrency: 2 });
  const s = useTaskCenterStore.getState();
  const occ1 = s.occupyForRecovery({ channel: "paper-parse", targetId: "r1.pdf", title: "恢复1" });
  assert(occ1, "空通道 occupy 应成功");
  const occ2 = s.occupyForRecovery({ channel: "paper-parse", targetId: "r2.pdf", title: "恢复2" });
  assert(occ2, "第二槽 occupy 应成功");
  assert(
    s.occupyForRecovery({ channel: "paper-parse", targetId: "r3.pdf", title: "恢复3" }) === null,
    "槽满 occupy 应拒绝",
  );
  // 槽满时新入队只排队不启动
  const queued = s.enqueue({ channel: "paper-parse", targetId: "Q", title: "Q" });
  assert(queued.ok, "Q 应入队成功");
  assert(!log.includes("start:Q"), "槽满时 Q 不应启动");
  // 释放一个恢复槽 → Q 同步接续启动
  s.settleRecoveredTask(occ1.taskId, "success");
  const q = useTaskCenterStore.getState().tasks[queued.taskId];
  assert(q.status === "running", `Q 应在槽位释放后启动，got ${q.status}`);
  s.settleRecoveredTask(occ2.taskId, "success");
  await useTaskCenterStore.getState().waitTask(queued.taskId);
  assert(log.includes("done:Q"), `Q 应执行完成: ${log.join(",")}`);
});

await check("单任务移除：已结算任务 removeTask 从聚合消失，同通道其他任务不受影响", async () => {
  registerTaskChannel("book-convert", { executor: makeExecutor([]), concurrency: 1 });
  const s = useTaskCenterStore.getState();
  const a = await s.enqueueAndWait({ channel: "book-convert", targetId: "a.pdf", title: "甲" });
  const b = await s.enqueueAndWait({ channel: "book-convert", targetId: "b.pdf", title: "乙" });
  assert(useTaskCenterStore.getState().removeTask(a.taskId) === true, "已结算任务应可移除");
  const agg = selectChannelAggregate(useTaskCenterStore.getState(), "book-convert");
  assert(agg.settled.length === 1 && agg.settled[0].taskId === b.taskId, "应只剩乙");
  assert(useTaskCenterStore.getState().order.includes(a.taskId) === false, "order 应同步移除");
});

await check("排队移除：queued 任务 removeTask 拒 waiter；运行中拒删", async () => {
  const log = [];
  registerTaskChannel("book-convert", { executor: makeExecutor(log, 40), concurrency: 1 });
  const s = useTaskCenterStore.getState();
  const first = s.enqueueAndWait({ channel: "book-convert", targetId: "r.pdf", title: "跑" });
  const second = s.enqueue({ channel: "book-convert", targetId: "q.pdf", title: "排" });
  assert(second.ok, "第二个应入队成功");
  const waiter = useTaskCenterStore.getState().waitTask(second.taskId);
  assert(useTaskCenterStore.getState().removeTask(second.taskId) === true, "排队任务应可移除");
  await waiter.then(
    () => {
      throw new Error("被移除的排队任务不应成功");
    },
    (e) => assert(e.message === "任务已取消", `拒绝原因异常: ${e.message}`),
  );
  assert(!log.includes("start:排"), `被移除任务不应启动: ${log.join(",")}`);
  const runningId = Object.values(useTaskCenterStore.getState().tasks).find((t) => t.status === "running").taskId;
  assert(useTaskCenterStore.getState().removeTask(runningId) === false, "运行中应拒删");
  await first;
});

await check("排队 payload 热更新：queued 浅合并生效且执行器读到新值；running/已结算/镜像拒改", async () => {
  let seenPayload = null;
  registerTaskChannel("book-convert", {
    executor: async (task, ctx) => {
      seenPayload = task.payload;
      await sleep(5);
      ctx.report(100, "完");
    },
    concurrency: 1,
  });
  const s = useTaskCenterStore.getState();
  // 占位任务先把唯一并发槽占成 running，后续入队保持 queued
  const running = s.enqueueAndWait({
    channel: "book-convert",
    targetId: "run.pdf",
    title: "跑",
    payload: { ocr: false, translate: "none" },
  });
  const queued = s.enqueue({
    channel: "book-convert",
    targetId: "q2.pdf",
    title: "排",
    payload: { pdfPath: "q2.pdf", ocr: false, translate: "none", autoImport: true },
  });
  assert(queued.ok, "排队任务应入队成功");
  // queued 可改：浅合并只动 patch 字段，其余保留
  assert(s.updateQueuedTaskPayload(queued.taskId, { ocr: true, translate: "zh" }) === true, "queued 应可更新 payload");
  const patched = useTaskCenterStore.getState().tasks[queued.taskId];
  assert(
    patched.payload.ocr === true && patched.payload.translate === "zh" && patched.payload.autoImport === true,
    `payload 合并异常: ${JSON.stringify(patched.payload)}`,
  );
  // running 拒改
  const runningTask = Object.values(useTaskCenterStore.getState().tasks).find((t) => t.status === "running");
  assert(s.updateQueuedTaskPayload(runningTask.taskId, { ocr: true }) === false, "running 应拒改");
  // 镜像任务拒改
  const mirrorId = s.beginMirrorTask({ channel: "book-convert", targetId: "m.pdf", title: "镜像" });
  assert(s.updateQueuedTaskPayload(mirrorId, { ocr: true }) === false, "镜像应拒改");
  s.endMirrorTask(mirrorId);
  await running;
  // 执行器在槽位释放后起跑，读到的应是热更新后的 payload
  await useTaskCenterStore.getState().waitTask(queued.taskId);
  assert(
    seenPayload?.ocr === true && seenPayload?.translate === "zh",
    `执行器应读到更新后 payload，got ${JSON.stringify(seenPayload)}`,
  );
  // 已结算拒改
  assert(s.updateQueuedTaskPayload(queued.taskId, { ocr: false }) === false, "已结算应拒改");
});

console.log(`\n${passed} passed, ${failures.length} failed`);
rmSync(outDir, { recursive: true, force: true });
process.exit(failures.length > 0 ? 1 : 0);
