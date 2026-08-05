// CDP：重载页面（让 vite 最新代码生效）并等待论文阅读区渲染
const LIST_URL = "http://127.0.0.1:9222/json/list";
const page = (await (await fetch(LIST_URL)).json()).find((t) => t.type === "page" && t.url.includes("localhost:1420"));
if (!page) { console.log("NO_PAGE"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const call = (m, p = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
};
await new Promise((r) => (ws.onopen = r));
await call("Runtime.enable");
await call("Page.enable");
await call("Page.reload", { ignoreCache: false });
// 等译文 div 渲染出来
const start = Date.now();
let ready = false;
while (Date.now() - start < 90000) {
  await new Promise((r) => setTimeout(r, 3000));
  const res = await call("Runtime.evaluate", {
    expression: `document.querySelectorAll('[data-translation]').length`,
    returnByValue: true,
  });
  if ((res?.result?.value ?? 0) > 100) { ready = true; console.log("页面就绪，译文 div:", res.result.value); break; }
}
ws.close();
process.exit(ready ? 0 : 1);
