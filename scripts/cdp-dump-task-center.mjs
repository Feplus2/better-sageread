// task-center 实况：paper-parse 通道是否有卡死的 running 任务（batchLocked 嫌疑源）
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let mid = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
};
const evalJS = async (expression) => {
  const r = await new Promise((res) => {
    const id = ++mid;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description ?? "").slice(0, 250));
  return r.result.value;
};

const tcUrl = await evalJS(`(async () => {
  const src = await (await fetch("/src/services/task-executors/paper-parse.ts")).text();
  const i = src.indexOf("/src/store/task-center-store");
  const end = src.indexOf(".ts", i);
  let url = src.slice(i, end + 3);
  const m = src.slice(end + 3).match(/^\\?t=\\d+/);
  if (m) url += m[0];
  return url;
})()`);
console.log("store URL:", tcUrl);

const out = await evalJS(`(async () => {
  const tc = await import(${JSON.stringify(tcUrl)});
  const s = tc.useTaskCenterStore.getState();
  const tasks = Object.values(s.tasks).map((t) => ({
    ch: t.channel, target: t.targetId.slice(0, 24), status: t.status,
    pct: t.percent, detail: (t.detail ?? "").slice(0, 40), mirror: !!t.mirror,
    age: Math.round((Date.now() - t.enqueuedAt) / 60000) + "min",
  }));
  const agg = tc.selectChannelAggregate(s, "paper-parse");
  return { tasks, current: agg.current?.targetId ?? null, queued: agg.queuedCount, settled: agg.settled.map((t) => t.status) };
})()`);
console.log(JSON.stringify(out, null, 1));
ws.close();
process.exit(0);
