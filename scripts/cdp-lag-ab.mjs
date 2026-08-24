// A/B：开着巨大隐藏 tab（wang 综述）vs 关掉后，击键绘制延迟对比
setTimeout(() => { console.error("WATCHDOG"); process.exit(2); }, 120000).unref();
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

// 注入击键延迟测量
await evalJS(`(() => {
  window.__lat = [];
  document.addEventListener('input', () => { const t0 = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => window.__lat.push(Math.round(performance.now() - t0)))); }, true);
  'ok';
})()`);

const type10 = async () => {
  await evalJS(`window.__lat = []; 'reset'`);
  for (let i = 0; i < 10; i++) {
    await evalJS(`(() => { const ta = document.querySelector('textarea'); ta.focus(); const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(ta, ta.value + '测'); ta.dispatchEvent(new Event('input', { bubbles: true })); true; })()`);
    await sleep(150);
  }
  await sleep(800);
  return evalJS(`(() => { const l = window.__lat.slice(); if (!l.length) return null; l.sort((a,b)=>a-b); return { n: l.length, p50: l[Math.floor(l.length/2)], max: l[l.length-1] }; })()`);
};

console.log("tabs:", await evalJS(`(async () => { const m = await import('/src/store/layout-store.ts'); return m.useLayoutStore.getState().tabs.map((t) => t.id); })()`));
console.log("A 组（wang tab 开）:", JSON.stringify(await type10()));
// 关掉论文 tab
await evalJS(`(async () => { const m = await import('/src/store/layout-store.ts'); const s = m.useLayoutStore.getState(); for (const t of s.tabs.filter((x) => x.id.startsWith('paper-'))) s.removeTab(t.id); return true; })()`);
await sleep(1500);
console.log("tabs 后:", await evalJS(`(async () => { const m = await import('/src/store/layout-store.ts'); return m.useLayoutStore.getState().tabs.map((t) => t.id); })()`));
console.log("B 组（paper tab 全关）:", JSON.stringify(await type10()));
ws.close();
process.exit(0);
