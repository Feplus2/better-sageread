// CDP：取 app 的 listBlocks 序列与离线 cutPaperBlocks 对齐，找出多出的 3 个块
const page = (await (await fetch("http://127.0.0.1:9222/json/list")).json()).find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const call = (m, p = {}) =>
  new Promise((r) => {
    const i = ++id;
    pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method: m, params: p }));
  });
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result);
    pending.delete(m.id);
  }
};
await new Promise((r) => (ws.onopen = r));
await call("Runtime.enable");
const res = await call("Runtime.evaluate", {
  expression: `(async () => {
    const pa = await import('/src/pages/paper-reader/paper-anchors.ts');
    const container = [...document.querySelectorAll('.prose')].find(el => el.querySelector('[data-translation]'));
    const blocks = pa.listBlocks(container);
    return JSON.stringify(blocks.map((b, i) => [i, b.tagName, (b.textContent||'').replace(/\\s+/g,' ').slice(0, 36)]));
  })()`,
  returnByValue: true,
  awaitPromise: true,
});
const { writeFileSync } = await import("node:fs");
writeFileSync("app-blocks.json", res?.result?.value ?? "[]");
console.log("saved", (res?.result?.value ?? "").length);
ws.close();
process.exit(0);
