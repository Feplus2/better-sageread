// 抽查 forecast ref-3 卡片元数据展示（S2 补全后）
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
const call = (m, p) => { let r; const pr = new Promise((res) => (r = res)); pending.set(++mid, { r }); ws.send(JSON.stringify({ id: mid, method: m, params: p })); return pr; };
ws.onmessage = (e) => { const msg = JSON.parse(e.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id).r(msg.result); pending.delete(msg.id); } };
await new Promise((r) => (ws.onopen = r));
const evalJS = async (expression) => {
  const r = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await call("Page.reload", { ignoreCache: true });
await sleep(4000);
await evalJS(`import("/src/store/layout-store.ts").then((m) => { window.__layout = m; }); "loading"`);
for (let i = 0; i < 20; i++) { await sleep(500); if (await evalJS(`!!window.__layout`).catch(() => false)) break; }
await evalJS(`window.__layout.useLayoutStore.getState().openPaper("57ae0a5f29feecb6", "forecast"); true`);
for (let i = 0; i < 60; i++) { await sleep(500); if (await evalJS(`!!document.getElementById("ref-3")`).catch(() => false)) break; }
await sleep(2500);
await evalJS(`(() => {
  const VIS = (el) => { let n = el; while (n) { if (n.style && n.style.visibility) return n.style.visibility === 'visible'; n = n.parentElement; } return true; };
  const anchor = Array.from(document.querySelectorAll('a[id="ref-3"]')).find(VIS);
  const scroller = anchor.closest('.overflow-y-auto');
  scroller.scrollTo({ top: anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 200, behavior: 'instant' });
  const r = anchor.closest('li, p').getBoundingClientRect();
  document.elementFromPoint(r.left + 60, r.top + r.height / 2).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  true;
})()`);
await sleep(4000);
console.log("卡片:", await evalJS(`(() => {
  const wrap = document.querySelector('[data-radix-popper-content-wrapper]');
  return wrap ? (wrap.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 400) : null;
})()`));
ws.close();
console.log("done");
