// 切换到书籍 tab，验证书籍阅读器是否恢复渲染
const LIST_URL = "http://127.0.0.1:9222/json/list";
const res = await fetch(LIST_URL);
const page = (await res.json()).find((t) => t.type === "page" && t.url.includes("localhost:1420"));
if (!page) {
  console.log("NO_PAGE");
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const call = (method, params = {}) =>
  new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
const errors = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result);
    pending.delete(msg.id);
  }
  if (msg.method === "Runtime.exceptionThrown") {
    const d = msg.params.exceptionDetails;
    errors.push((d.exception?.description || d.text || "").slice(0, 200));
  }
};
await new Promise((r) => (ws.onopen = r));
await call("Runtime.enable");

// 点击垂直窄条里的书籍 tab 图标（第一个 BookOpen 图标所在的可点 div）
await call("Runtime.evaluate", {
  expression: `(() => {
    const strip = document.querySelector('[data-region="vertical-tabs"]');
    if (!strip) return 'no-strip';
    const items = strip.querySelectorAll('.size-8.cursor-pointer');
    if (items.length === 0) return 'no-items';
    items[0].click();
    return 'clicked';
  })()`,
  returnByValue: true,
}).then((r) => console.log("click:", r?.result?.value));

await new Promise((r) => setTimeout(r, 8000));
const dom = await call("Runtime.evaluate", {
  expression: `JSON.stringify({
    bodyTextSample: (document.body?.innerText || '').slice(0, 300),
    foliateIframe: !!document.querySelector('foliate-view, iframe'),
    visibleReader: !!document.querySelector('[data-region="reader-view"], .foliate-viewer'),
  })`,
  returnByValue: true,
});
console.log("DOM:", dom?.result?.value);
console.log("NEW_EXCEPTIONS:", errors.length === 0 ? "none" : [...new Set(errors)].join(" | "));
ws.close();
process.exit(0);
