// 解析刷新恢复 E2E v2：friction 篇重解析 → 跑起来后刷新页面 → 验证恢复监控 → 等产物落库
const PAPER_ID = "6c533ac14d2b48e4";
const TITLE = "Gravitational waves from cosmic strings with friction: analytical approximations and parameter space";
const list0 = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page0 = list0.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
if (!page0) { console.error("实例未就绪"); process.exit(1); }
let ws = new WebSocket(page0.webSocketDebuggerUrl);
let seq = 0; const pending = new Map();
const bind = () => {
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
};
bind();
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
const call = (method, params) => new Promise((resolve, reject) => {
  const id = ++seq; const timer = setTimeout(() => { pending.delete(id); reject(new Error("timeout")); }, 30000);
  pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
  ws.send(JSON.stringify({ id, method, params }));
});
const evalp = async (expression) => {
  const r = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600));
  return r.result?.result?.value;
};
// store 实例对齐（HMR ?t=）：从消费方转换源码抠真实 URL
const probeCode = `(async (file, key) => {
  const src = await (await fetch(file)).text();
  const i = src.indexOf(key);
  if (i < 0) return key + '.ts';
  const end = src.indexOf('.ts', i);
  let url = src.slice(i, end + 3);
  const m = src.slice(end + 3).match(/^\\?t=\\d+/);
  if (m) url += m[0];
  return url;
})`;
const CPS = await evalp(`(${probeCode})('/src/pages/papers/index.tsx', '/src/store/convert-progress-store')`);
console.log("convert-progress-store:", CPS);
if (!CPS.startsWith("/src/")) { console.error("探 URL 失败"); process.exit(2); }

const baseline = await evalp(`(async () => {
  const ps = await import('/src/services/paper-service.ts');
  return (await ps.getPaperSourceStatus('${PAPER_ID}')).sourceHash;
})()`);
console.log("基线 hash:", baseline);

const enq = await evalp(`(async () => {
  const m = await import(${JSON.stringify(CPS)});
  return m.startPaperReparse({ id: '${PAPER_ID}', title: ${JSON.stringify(TITLE)} }, { silent: true });
})()`);
console.log("入队:", JSON.stringify(enq));
if (!enq?.ok) { console.error("入队被拒"); process.exit(2); }

await new Promise((r) => setTimeout(r, 12000));
const pre = await evalp(`(async () => {
  const m = await import(${JSON.stringify(CPS)});
  return m.useConvertProgressStore.getState().paperImport?.status;
})()`);
console.log("刷新前状态:", pre);
if (pre !== "running") { console.error("未跑起来，终止"); process.exit(3); }

await call("Page.reload", {});
console.log("已刷新，等重启 + 恢复…");
await new Promise((r) => setTimeout(r, 9000));

let after = null;
try {
  after = await evalp(`(async () => {
    const m = await import(${JSON.stringify(CPS)});
    const pi = m.useConvertProgressStore.getState().paperImport;
    return pi ? { status: pi.status, fileName: pi.fileName, detail: pi.detail ?? null } : null;
  })()`);
} catch {
  console.log("ws 断开，重连重试…");
  ws = new WebSocket(page0.webSocketDebuggerUrl); bind();
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  await new Promise((r) => setTimeout(r, 3000));
  after = await evalp(`(async () => {
    const m = await import(${JSON.stringify(CPS)});
    const pi = m.useConvertProgressStore.getState().paperImport;
    return pi ? { status: pi.status, fileName: pi.fileName, detail: pi.detail ?? null } : null;
  })()`);
}
console.log("刷新后恢复卡:", JSON.stringify(after));
if (after?.status !== "running") { console.error("恢复失败：未见 running 卡"); process.exit(4); }

const t0 = Date.now();
let finalHash = baseline;
while (Date.now() - t0 < 6 * 60 * 1000) {
  await new Promise((r) => setTimeout(r, 10000));
  try {
    const cur = await evalp(`(async () => {
      const ps = await import('/src/services/paper-service.ts');
      const m = await import(${JSON.stringify(CPS)});
      return { hash: (await ps.getPaperSourceStatus('${PAPER_ID}')).sourceHash, q: m.useConvertProgressStore.getState().paperImport?.status ?? null };
    })()`);
    console.log(`[${Math.round((Date.now()-t0)/1000)}s] hash=${cur.hash} q=${cur.q}`);
    if (cur.hash && cur.hash !== baseline) { finalHash = cur.hash; break; }
  } catch { /* 忽略瞬时错误 */ }
}
console.log(finalHash !== baseline ? "RECOVERY E2E PASS" : "RECOVERY E2E FAIL（落库未完成）");
process.exit(finalHash !== baseline ? 0 : 5);
