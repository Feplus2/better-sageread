// 打字 + Profiler 同步采样：捕捉击键长任务的热点函数
setTimeout(() => { console.error("WATCHDOG"); process.exit(2); }, 120000).unref();
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
const call = (m, p) => { let r; const pr = new Promise((res) => (r = res)); pending.set(++mid, { r }); ws.send(JSON.stringify({ id: mid, method: m, params: p })); return pr; };
ws.onmessage = (e) => { const msg = JSON.parse(e.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id).r(msg.result); pending.delete(msg.id); } };
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

// 先确认输入框在（带超时，页面卡就直接报告）
const hashCheck = await call("Runtime.evaluate", { expression: "({hash: location.hash, ta: !!document.querySelector('textarea')})", returnByValue: true, timeout: 8000 });
console.log("页面状态:", JSON.stringify(hashCheck.result?.value));

await call("Profiler.enable", {});
await call("Profiler.setSamplingInterval", { interval: 500 });
await call("Profiler.start", {});
// 打 20 个字符，每个 120ms（留出主线程喘息）
for (let i = 0; i < 20; i++) {
  const r = await call("Runtime.evaluate", {
    expression: `(() => { const ta = document.querySelector('textarea'); if (!ta) return false; ta.focus(); const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(ta, ta.value + '测'); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
    timeout: 8000,
  });
  if (r.exceptionDetails) console.log("击键异常:", r.exceptionDetails.text);
  await sleep(120);
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
await sleep(2000);
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
console.log("采样点:", samples.length, "覆盖 ms:", Math.round(deltas.reduce((a, b) => a + b, 0) / 1000));
for (const [k, us] of [...selfTime.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
  console.log(String(Math.round(us / 1000)).padStart(7), "ms  ", k);
}
(await import("node:fs")).writeFileSync("F:/MyProjects/SageRead/scripts/.chat-lag-profile-typing.json", JSON.stringify(profile));
ws.close();
process.exit(0);
