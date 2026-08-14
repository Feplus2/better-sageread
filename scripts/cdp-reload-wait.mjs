// 独立刷新页面并等待 React 挂载就绪（用完即弃的连接，避免 reload 竞态）
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
if (!page) throw new Error("未找到主实例页面");
let ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
const connect = (w) => {
  w.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
};
connect(ws);
await new Promise((r) => (ws.onopen = r));
const call = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++mid;
    const timer = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 15000);
    pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    ws.send(JSON.stringify({ id, method, params }));
  });

await call("Page.enable").catch(() => {});
console.log("reloading...");
try {
  await call("Page.reload", { ignoreCache: true });
} catch (e) {
  console.log("reload response:", e.message);
}
await new Promise((r) => setTimeout(r, 5000));

// 就绪轮询：React 顶栏出现为止（重开连接规避导航期丢包）
for (let i = 0; i < 20; i++) {
  try {
    ws.close();
  } catch {}
  ws = new WebSocket(page.webSocketDebuggerUrl);
  connect(ws);
  await new Promise((r) => (ws.onopen = r));
  const r = await call("Runtime.evaluate", {
    expression: '!!document.querySelector(\'[data-region="reader-tabs"]\')',
    returnByValue: true,
  }).catch(() => null);
  if (r?.result?.value === true) {
    console.log("ready after", i + 1, "probes");
    ws.close();
    process.exit(0);
  }
  await new Promise((res) => setTimeout(res, 1000));
}
console.log("TIMEOUT waiting for app mount");
ws.close();
process.exit(1);
