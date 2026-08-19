// 打开干净版高等数学书供阅读
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
await evalJS(`window.__layout.useLayoutStore.getState().openBook("e642d3f98615287d7925db0da8712837", "高等数学 第七版 上册"); true`);
await new Promise((r) => setTimeout(r, 6000));
console.log("opened");
ws.close();
