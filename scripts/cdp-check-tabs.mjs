// 查活动 tab（内联转义不可靠，一律走文件）
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
const call = (method, params) => {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  const id = ++mid;
  pending.set(id, { promise, resolve });
  ws.send(JSON.stringify({ id, method, params }));
  return promise;
};
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    p.resolve(msg.result);
  }
};
await new Promise((r) => (ws.onopen = r));
const evalJS = async (expr) => {
  const r = await call("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
await evalJS(`import("/src/store/layout-store.ts").then((m) => { window.__layout = m; }); "loading"`);
for (let i = 0; i < 10; i++) {
  await new Promise((r) => setTimeout(r, 500));
  if (await evalJS(`!!window.__layout`).catch(() => false)) break;
}
const out = await evalJS(`(() => {
  const st = window.__layout.useLayoutStore.getState();
  const active = st.tabs.find((t) => t.id === st.activeTabId);
  return {
    activeTab: active ? { id: active.id, type: active.type ?? "book", title: active.title } : null,
    bookTabs: st.tabs.filter((t) => (t.type ?? "book") === "book").map((t) => t.id.replace("reader-", "") + " " + t.title.slice(0, 14)),
  };
})()`);
console.log(JSON.stringify(out, null, 1));
ws.close();
