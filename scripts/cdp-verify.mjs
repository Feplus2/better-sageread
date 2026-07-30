// 验证：重载页面后收集异常 + 检查 React 是否成功挂载渲染
const LIST_URL = "http://127.0.0.1:9222/json/list";

async function getPage(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(LIST_URL);
      const page = (await res.json()).find((t) => t.type === "page" && t.url.includes("localhost:1420"));
      if (page) return page;
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

const page = await getPage(60000);
if (!page) {
  console.log("NO_PAGE_FOUND");
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
    errors.push((d.exception?.description || d.text || "").slice(0, 300));
  }
};

await new Promise((r) => (ws.onopen = r));
await call("Runtime.enable");
await call("Page.enable");
await call("Page.reload", { ignoreCache: true });
await new Promise((r) => setTimeout(r, 12000));

const evalRes = await call("Runtime.evaluate", {
  expression: `JSON.stringify({
    rootChildren: document.getElementById('root')?.children.length ?? -1,
    bodyText: (document.body?.innerText || '').slice(0, 200),
    hasTabBar: !!document.querySelector('[data-region="reader-tabs"]'),
    hasSidebar: !!document.querySelector('nav, [data-region], main'),
  })`,
  returnByValue: true,
});
console.log("DOM:", evalRes?.result?.value);
console.log("EXCEPTIONS:", errors.length === 0 ? "none" : "");
for (const e of [...new Set(errors)]) console.log(" -", e);
ws.close();
process.exit(0);
