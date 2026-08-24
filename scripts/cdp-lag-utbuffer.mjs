// UserTiming 缓冲规模核查 + 清空后击键延迟复测
setTimeout(() => { console.error("WATCHDOG"); process.exit(2); }, 90000).unref();
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
const call = (m, p) => { let r; const pr = new Promise((res) => (r = res)); pending.set(++mid, { r }); ws.send(JSON.stringify({ id: mid, method: m, params: p })); return pr; };
ws.onmessage = (e) => { const msg = JSON.parse(e.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id).r(msg.result); pending.delete(msg.id); } };
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
const evalJS = async (expression) => {
  const r = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout: 15000 });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("缓冲规模:", await evalJS(`(() => {
  const byType = {};
  for (const t of ['measure', 'mark', 'resource', 'navigation', 'paint', 'longtask', 'element', 'event']) {
    try { byType[t] = performance.getEntriesByType(t).length; } catch { byType[t] = -1; }
  }
  return byType;
})()`));

// 清空 + 复测击键
await evalJS(`(() => { performance.clearMeasures(); performance.clearMarks(); performance.clearResourceTimings(); window.__lat = [];
  document.addEventListener('input', () => { const t0 = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => window.__lat.push(Math.round(performance.now() - t0)))); }, true); 'ok'; })()`);
for (let i = 0; i < 10; i++) {
  await evalJS(`(() => { const ta = document.querySelector('textarea'); ta.focus(); const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(ta, ta.value + '测'); ta.dispatchEvent(new Event('input', { bubbles: true })); true; })()`);
  await sleep(150);
}
await sleep(800);
console.log("清空后击键:", await evalJS(`(() => { const l = window.__lat.slice(); if (!l.length) return null; l.sort((a,b)=>a-b); return { n: l.length, p50: l[Math.floor(l.length/2)], max: l[l.length-1] }; })()`));
console.log("清空后 measure 数:", await evalJS(`performance.getEntriesByType('measure').length`));
ws.close();
process.exit(0);
