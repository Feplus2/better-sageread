// Tracing 归因：devtools.timeline 类目，打字 10 键，统计各渲染阶段耗时
setTimeout(() => { console.error("WATCHDOG"); process.exit(2); }, 90000).unref();
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
const events = [];
const call = (m, p) => { let r; const pr = new Promise((res) => (r = res)); pending.set(++mid, { r }); ws.send(JSON.stringify({ id: mid, method: m, params: p })); return pr; };
let traceDone; const traceDoneP = new Promise((r) => (traceDone = r));
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id).r(msg.result); pending.delete(msg.id); }
  if (msg.method === "Tracing.dataCollected") events.push(...msg.params.value);
  if (msg.method === "Tracing.tracingComplete") traceDone();
};
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
const evalJS = async (expression) => {
  const r = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout: 15000 });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await call("Tracing.start", { categories: "devtools.timeline,disabled-by-default-v8.cpu_profiler", transferMode: "ReturnEvents", options: "sampling-frequency-10000" });
for (let i = 0; i < 10; i++) {
  await evalJS(`(() => { const ta = document.querySelector('textarea'); ta.focus(); const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(ta, ta.value + '测'); ta.dispatchEvent(new Event('input', { bubbles: true })); true; })()`);
  await sleep(200);
}
await sleep(2000);
await call("Tracing.end", {});
await traceDoneP;
// 聚合按 name
const agg = new Map();
for (const ev of events) {
  if (ev.ph !== "X") continue;
  agg.set(ev.name, (agg.get(ev.name) ?? 0) + (ev.dur ?? 0) / 1000);
}
const top = [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
console.log("事件数:", events.length);
for (const [name, ms] of top) console.log(String(Math.round(ms)).padStart(7), "ms  ", name);
ws.close();
process.exit(0);
