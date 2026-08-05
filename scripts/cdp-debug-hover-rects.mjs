// 调试：dump hover 覆盖层每个 rect 命中的元素 + .prose 分布
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
const evalJs = async (expr) => {
  const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) return "EVAL_ERROR: " + (r.exceptionDetails.exception?.description || "").slice(0, 300);
  return r?.result?.value;
};
console.log(await evalJs(`(() => {
  const overlay = [...document.querySelectorAll('.paper-sentence-hover-rect')].map(el => {
    const b = el.getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + 2, b.top + 2);
    return {
      y: Math.round(b.top), h: Math.round(b.height), x: Math.round(b.left), w: Math.round(b.width),
      hit: hit ? (hit.tagName + '.' + (hit.className || '').toString().slice(0, 30)) : 'null',
      hitText: (hit?.textContent || '').slice(0, 40),
      inTr: !!hit?.closest?.('[data-translation]'),
    };
  });
  const proses = [...document.querySelectorAll('.prose')].map((p, i) => ({
    i, hasTr: !!p.querySelector('[data-translation]'),
    hasDemo: (p.textContent || '').includes('This demonstrates how'),
  }));
  return JSON.stringify({ overlay, proses }, null, 1);
})()`));
ws.close();
process.exit(0);
