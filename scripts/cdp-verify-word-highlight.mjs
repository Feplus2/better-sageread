// CDP 验证：重载后 well-known 标注的中英文映射高亮是否词级精确
const LIST_URL = "http://127.0.0.1:9222/json/list";

async function getPage(timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const page = (await (await fetch(LIST_URL)).json()).find((t) => t.type === "page" && t.url.includes("localhost:1420"));
      if (page) return page;
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}
const page = await getPage();
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
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result);
    pending.delete(msg.id);
  }
};
await new Promise((r) => (ws.onopen = r));
await call("Runtime.enable");
await call("Page.enable");
await call("Page.reload", { ignoreCache: true });
await new Promise((r) => setTimeout(r, 20000));

const res = await call("Runtime.evaluate", {
  expression: `(() => {
    const out = {};
    if (CSS.highlights && CSS.highlights.forEach) {
      CSS.highlights.forEach((h, name) => {
        if (!name.startsWith('paper-anno')) return;
        out[name] = [...h].map(r => ({ len: r.toString().length, text: r.toString().slice(0, 40) }));
      });
    }
    return JSON.stringify(out);
  })()`,
  returnByValue: true,
});
const data = JSON.parse(res?.result?.value ?? "{}");
for (const [name, ranges] of Object.entries(data)) {
  console.log(name);
  for (const r of ranges) console.log(`   len=${r.len}  "${r.text}"`);
}
ws.close();
process.exit(0);
