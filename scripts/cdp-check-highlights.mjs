// CDP 检查：CSS Highlight 注册表内容 + 侧栏标注列表
const LIST_URL = "http://127.0.0.1:9222/json/list";
const page = (await (await fetch(LIST_URL)).json()).find((t) => t.type === "page" && t.url.includes("localhost:1420"));
if (!page) process.exit(1);
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const call = (method, params = {}) =>
  new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result);
    pending.delete(msg.id);
  }
  if (msg.method === "Runtime.exceptionThrown") {
    const d = msg.params.exceptionDetails;
    console.log("EXCEPTION:", (d.exception?.description || d.text || "").slice(0, 500));
  }
};
await new Promise((r) => (ws.onopen = r));
await call("Runtime.enable");
await new Promise((r) => setTimeout(r, 1000));

const res = await call("Runtime.evaluate", {
  expression: `(() => {
    const reg = CSS.highlights;
    const entries = [];
    if (reg && reg.forEach) {
      reg.forEach((h, name) => entries.push({ name, size: h.size }));
    }
    // 打开左侧标注面板（点顶栏左侧第一个按钮）
    return JSON.stringify(entries);
  })()`,
  returnByValue: true,
});
console.log("highlights registry:", res?.result?.value);
ws.close();
process.exit(0);
