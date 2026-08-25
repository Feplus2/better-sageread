// P3 §1 实盘：解析通道有界并发 2——三篇重解析入队，观测同刻最多 2 个 running、
// 第三篇排队等槽、全部成功结算、产物落库（paper.md mtime 变）。
// 用法：node scripts/cdp-e2e-parse-concurrency.mjs
import { statSync } from "node:fs";

const PAPERS = ["2f64e2c4a1b836ab", "6f0c2fcfc3e03b17", "e689398addf95e72"]; // dev 库最小三篇
const BOOKS_DIR = "C:/Users/20995/AppData/Roaming/com.bettersageread.dev/books";

const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
if (!page) throw new Error("未找到 dev 页面");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
};
await new Promise((r) => (ws.onopen = r));
const evalJS = async (expression) => {
  const r = await new Promise((res) => {
    const id = ++mid;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description ?? "eval 失败").slice(0, 300));
  return r.result.value;
};

// store 实例对齐（HMR ?t= 陷阱）：从消费方转换源码抠版本 URL
const tcUrl = await evalJS(`(async () => {
  const src = await (await fetch("/src/services/task-executors/paper-parse.ts")).text();
  const i = src.indexOf("/src/store/task-center-store");
  if (i < 0) return null;
  const end = src.indexOf(".ts", i);
  let url = src.slice(i, end + 3);
  const m = src.slice(end + 3).match(/^\\?t=\\d+/);
  if (m) url += m[0];
  return url;
})()`);
if (!tcUrl) throw new Error("未探到 task-center-store 版本 URL");
console.log("store URL:", tcUrl);

// convert-progress-store 的薄壳入口经 papers/index.tsx 转换源码探版本
const cpsUrl = await evalJS(`(async () => {
  const src = await (await fetch("/src/pages/papers/index.tsx")).text();
  const i = src.indexOf("/src/store/convert-progress-store");
  if (i < 0) return null;
  const end = src.indexOf(".ts", i);
  let url = src.slice(i, end + 3);
  const m = src.slice(end + 3).match(/^\\?t=\\d+/);
  if (m) url += m[0];
  return url;
})()`);
if (!cpsUrl) throw new Error("未探到 convert-progress-store 版本 URL");
console.log("convert-progress-store URL:", cpsUrl);

await evalJS(`Promise.all([
  import(${JSON.stringify(tcUrl)}),
  import(${JSON.stringify(cpsUrl)}),
]).then(([tc, cps]) => { window.__tc = tc; window.__cps = cps; return 1; })`);

const mtimeBefore = Object.fromEntries(
  PAPERS.map((id) => [id, statSync(`${BOOKS_DIR}/${id}/paper.md`).mtimeMs]),
);

// 观测器：记录每 500ms 的通道在跑集合快照
const enq = await evalJS(`(() => {
  window.__samples = [];
  window.__timer = setInterval(() => {
    const s = window.__tc.useTaskCenterStore.getState();
    const running = Object.values(s.tasks)
      .filter((t) => t.channel === "paper-parse" && t.status === "running")
      .map((t) => t.targetId)
      .sort();
    const queued = Object.values(s.tasks).filter((t) => t.channel === "paper-parse" && t.status === "queued").length;
    window.__samples.push({ running, queued, ts: Date.now() });
  }, 500);
  const results = ${JSON.stringify(PAPERS)}.map((id) =>
    window.__cps.startPaperReparse({ id, title: id }, { silent: true }));
  return results;
})()`);
console.log("入队:", JSON.stringify(enq));
if (!enq.every((r) => r?.ok)) throw new Error("有入队被拒");

// 等全部结算（最长 10 分钟）
const deadline = Date.now() + 10 * 60 * 1000;
let finalAgg = null;
for (;;) {
  const agg = await evalJS(`(() => {
    const s = window.__tc.useTaskCenterStore.getState();
    const tasks = Object.values(s.tasks).filter((t) => t.channel === "paper-parse");
    return {
      running: tasks.filter((t) => t.status === "running").length,
      queued: tasks.filter((t) => t.status === "queued").length,
      settled: tasks.filter((t) => ["success", "error", "cancelled"].includes(t.status)).map((t) => t.status),
    };
  })()`);
  finalAgg = agg;
  if (agg.running + agg.queued === 0) break;
  if (Date.now() > deadline) throw new Error("超时未结算: " + JSON.stringify(agg));
  await new Promise((r) => setTimeout(r, 3000));
}
const samples = await evalJS(`(() => { clearInterval(window.__timer); return window.__samples.map((s) => s.running.length + "r" + s.queued + "q"); })()`);
console.log("采样序列（每 500ms running/queued）:", samples.join(" "));
console.log("终态:", JSON.stringify(finalAgg));

let failed = 0;
const assert = (cond, msg) => {
  if (!cond) { failed++; console.error(`FAIL - ${msg}`); } else { console.log(`ok - ${msg}`); }
};
assert(finalAgg.settled.filter((s) => s === "success").length === 3, `三篇全部成功（got ${JSON.stringify(finalAgg.settled)}）`);
const maxConcurrent = Math.max(...samples.map((s) => Number.parseInt(s, 10)));
assert(maxConcurrent === 2, `并发槽上限 2（观测最大并发 ${maxConcurrent}）`);
const sawQueued = samples.some((s) => Number.parseInt(s.split("r")[1], 10) > 0);
assert(sawQueued, "第三篇曾处于 queued（槽满排队）");
const mtimesChanged = PAPERS.filter((id) => statSync(`${BOOKS_DIR}/${id}/paper.md`).mtimeMs > mtimeBefore[id]);
assert(mtimesChanged.length === 3, `三篇产物均落库更新（变了 ${mtimesChanged.length}）`);

ws.close();
console.log(failed === 0 ? "\nPASS" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
