// 打字卡顿 CPU 剖析：Profiler 域采样，找热点函数
setTimeout(() => { console.error("WATCHDOG"); process.exit(2); }, 90000).unref();
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

// 确认在 /chat 且输入框在场
console.log("hash:", await evalJS(`location.hash`));
console.log("textarea:", await evalJS(`!!document.querySelector('textarea')`));

await call("Profiler.enable", {});
await call("Profiler.start", {});
// 打 25 个字符，每个 80ms 间隔（真实打字节奏）
for (let i = 0; i < 25; i++) {
  await evalJS(`(() => { const ta = document.querySelector('textarea'); if (!ta) return false; ta.focus(); const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(ta, ta.value + '测'); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await sleep(80);
}
await sleep(2000);
const { profile } = await call("Profiler.stop", {});

// 聚合：按函数/URL 统计自耗时
const nodes = profile.nodes;
const byId = new Map(nodes.map((n) => [n.id, n]));
const selfTime = new Map(); // key: fnName@url:line → microsec
// timeDeltas 与 samples 对齐
const samples = profile.samples ?? [];
const deltas = profile.timeDeltas ?? [];
for (let i = 0; i < samples.length; i++) {
  const node = byId.get(samples[i]);
  if (!node) continue;
  const cf = node.callFrame;
  const key = `${cf.functionName || "(anon)"} @ ${(cf.url || "").replace(/^.*\//, "")}:${cf.lineNumber}`;
  selfTime.set(key, (selfTime.get(key) ?? 0) + (deltas[i] ?? 0));
}
const top = [...selfTime.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
console.log("采样点:", samples.length, "总时长ms:", Math.round(deltas.reduce((a, b) => a + b, 0) / 1000));
for (const [k, us] of top) console.log(String(Math.round(us / 1000)).padStart(6), "ms  ", k);
ws.close();
process.exit(0);
