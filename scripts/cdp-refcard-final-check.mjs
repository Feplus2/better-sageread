// 合并实测：ref-1（bibliographic 兜底）+ ref-5（S2 arXiv 直查）卡片元数据
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
for (let i = 0; i < 60; i++) { await sleep(500); if (await evalJS(`!!document.getElementById("ref-1")`).catch(() => false)) break; }
await sleep(2500);

const openCard = (n) => `(() => {
  const VIS = (el) => { let n2 = el; while (n2) { if (n2.style && n2.style.visibility) return n2.style.visibility === 'visible'; n2 = n2.parentElement; } return true; };
  const anchor = Array.from(document.querySelectorAll('a[id="ref-${n}"]')).find(VIS);
  if (!anchor) return 'no-anchor';
  const scroller = anchor.closest('.overflow-y-auto');
  scroller.scrollTo({ top: anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 200, behavior: 'instant' });
  const r = anchor.closest('li, p').getBoundingClientRect();
  document.elementFromPoint(r.left + 60, r.top + r.height / 2).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  return 'clicked';
})()`;
const cardText = `(() => {
  const wrap = document.querySelector('[data-radix-popper-content-wrapper]');
  return wrap ? (wrap.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 220) : null;
})()`;

for (const n of [1, 5]) {
  console.log(`ref-${n} 开卡:`, await evalJS(openCard(n)));
  await sleep(6000); // 等补全（含可能的退避）
  console.log(`ref-${n} 卡片:`, await evalJS(cardText));
  await evalJS(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); document.body.click(); true`);
  await sleep(800);
}
ws.close();
console.log("done");
