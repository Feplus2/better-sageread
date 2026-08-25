// 僵尸卡查实与清理：列出任务中心全部非活跃任务，对 cancelled/error/success 逐项 dismiss
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

// store 真实版本 URL（HMR ?t= 陷阱）
const tcUrl = await evalJS(`(async () => {
  const src = await (await fetch("/src/services/task-executors/paper-vectorize.ts")).text();
  const i = src.indexOf("/src/store/task-center-store");
  if (i < 0) return null;
  const end = src.indexOf(".ts", i);
  let url = src.slice(i, end + 3);
  const m = src.slice(end + 3).match(/^\\?t=\\d+/);
  if (m) url += m[0];
  return url;
})()`);
if (!tcUrl) throw new Error("未能探到 task-center-store 版本 URL");
console.log("store URL:", tcUrl);

const snapshot = await evalJS(`import(${JSON.stringify(tcUrl)}).then((tc) => {
  const s = tc.useTaskCenterStore.getState();
  const all = s.order.map((id) => s.tasks[id]).filter(Boolean).map((t) => ({
    taskId: t.taskId, channel: t.channel, targetId: t.targetId, title: t.title,
    status: t.status, percent: t.percent, error: t.error ?? null, mirror: !!t.mirror,
  }));
  return all;
})`);
console.log(`任务总数 ${snapshot.length}`);
for (const t of snapshot) {
  console.log(`- [${t.channel}] ${t.status} ${t.percent}% target=${t.targetId} title=${t.title}${t.error ? ` err=${t.error}` : ""}`);
}

const zombies = snapshot.filter((t) => t.status === "cancelled" || t.status === "error" || t.status === "success");
if (zombies.length === 0) {
  console.log("无已结算残留任务——僵尸卡已不在（重启后内存态已清）。");
} else {
  const channels = [...new Set(zombies.map((t) => t.channel))];
  const cleaned = await evalJS(`import(${JSON.stringify(tcUrl)}).then((tc) => {
    const st = tc.useTaskCenterStore.getState();
    const before = Object.keys(st.tasks).length;
    for (const ch of ${JSON.stringify(channels)}) st.dismissSettled(ch);
    const after = Object.keys(tc.useTaskCenterStore.getState().tasks).length;
    return { before, after };
  })`);
  console.log(`已清理通道 ${channels.join(", ")} 的已结算任务：${cleaned.before} -> ${cleaned.after}`);
}
ws.close();
