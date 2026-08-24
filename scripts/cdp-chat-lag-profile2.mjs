// 纯 Profiler 采样：不依赖 Runtime.evaluate（页面主线程卡死也能采）
setTimeout(() => { console.error("WATCHDOG"); process.exit(2); }, 60000).unref();
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
const call = (m, p) => { let r; const pr = new Promise((res) => (r = res)); pending.set(++mid, { r }); ws.send(JSON.stringify({ id: mid, method: m, params: p })); return pr; };
ws.onmessage = (e) => { const msg = JSON.parse(e.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id).r(msg.result); pending.delete(msg.id); } };
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

await call("Profiler.enable", {});
await call("Profiler.setSamplingInterval", { interval: 500 });
await call("Profiler.start", {});
console.log("profiling 25s（这期间请正常操作/保持现状）…");
await new Promise((r) => setTimeout(r, 25000));
const { profile } = await call("Profiler.stop", {});

const nodes = profile.nodes;
const byId = new Map(nodes.map((n) => [n.id, n]));
const samples = profile.samples ?? [];
const deltas = profile.timeDeltas ?? [];
const selfTime = new Map();
for (let i = 0; i < samples.length; i++) {
  const node = byId.get(samples[i]);
  if (!node) continue;
  const cf = node.callFrame;
  const key = `${cf.functionName || "(anon)"} @ ${(cf.url || "").replace(/^.*\//, "")}:${cf.lineNumber}`;
  selfTime.set(key, (selfTime.get(key) ?? 0) + (deltas[i] ?? 0));
}
const totalMs = Math.round(deltas.reduce((a, b) => a + b, 0) / 1000);
console.log("采样点:", samples.length, "覆盖时长 ms:", totalMs);
const top = [...selfTime.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
for (const [k, us] of top) console.log(String(Math.round(us / 1000)).padStart(7), "ms  ", k);
// 也存全量供回溯
(await import("node:fs")).writeFileSync("F:/MyProjects/SageRead/scripts/.chat-lag-profile.json", JSON.stringify(profile));
ws.close();
process.exit(0);
