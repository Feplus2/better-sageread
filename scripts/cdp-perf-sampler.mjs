// 性能持续采样器：JS Heap / DOM 节点数 / 公式数 / longtask 监听
// 用途：基线监测——运行期间用户正常操作（打开对话、打开设置弹窗等），
//      采样器每 2 秒输出一行指标，longtask（>50ms 主线程阻塞）实时捕获，
//      用于对比优化前后效果。
// 用法：node scripts/cdp-perf-sampler.mjs [采样秒数，默认 120]
// 前提：应用已以 --remote-debugging-port=9222 启动
const LIST_URL = "http://127.0.0.1:9222/json/list";
const DURATION_S = Number.parseInt(process.argv[2] ?? "120", 10);
const INTERVAL_MS = 2000;

async function waitForPage(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(LIST_URL);
      const targets = await res.json();
      const page = targets.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
      if (page) return page;
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

const page = await waitForPage(30000);
if (!page) {
  console.log("NO_PAGE_FOUND（请确认应用以 --remote-debugging-port=9222 启动）");
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
const send = (method, params = {}) => {
  const mid = ++seq;
  ws.send(JSON.stringify({ id: mid, method, params }));
  return new Promise((resolve) => pending.set(mid, resolve));
};
const evaluate = async (expression) => {
  const resp = await send("Runtime.evaluate", { expression, returnByValue: true });
  return resp.result?.result?.value;
};

await send("Runtime.enable");

// 安装 longtask 观察器（幂等；页面刷新后需重新安装）
await evaluate(`window.__perfProbe ??= (() => {
  const s = { longtasks: [] };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) s.longtasks.push({ dur: Math.round(e.duration), at: Date.now() });
    }).observe({ type: "longtask", buffered: true });
  } catch (e) { s.error = String(e); }
  return s;
})()`);

console.log(`采样 ${DURATION_S}s，间隔 ${INTERVAL_MS / 1000}s；期间请正常操作应用（打开对话/设置弹窗等）`);
console.log("t(s)  heap(MB)  nodes   katex  msgs  longtask(自上次采样)");

const start = Date.now();
let samples = 0;
const allLongtasks = [];

while (Date.now() - start < DURATION_S * 1000) {
  const snap = await evaluate(`(() => ({
    heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
    nodes: document.querySelectorAll("*").length,
    katex: document.querySelectorAll(".katex").length,
    msgs: document.querySelectorAll("[data-message-id]").length,
    longtasks: (window.__perfProbe?.longtasks ?? []).splice(0),
    probeError: window.__perfProbe?.error ?? null,
  }))()`);
  if (snap) {
    const t = Math.round((Date.now() - start) / 1000);
    const lt = snap.longtasks;
    allLongtasks.push(...lt);
    const ltDesc = lt.length
      ? `${lt.length} 个，max ${Math.max(...lt.map((x) => x.dur))}ms`
      : "-";
    console.log(
      `${String(t).padStart(4)}  ${String(snap.heapMB ?? "?").padStart(8)}  ${String(snap.nodes).padStart(6)}  ${String(snap.katex).padStart(5)}  ${String(snap.msgs).padStart(4)}  ${ltDesc}`,
    );
    if (snap.probeError && samples === 0) console.log(`longtask 观察器安装失败: ${snap.probeError}`);
    samples++;
  }
  await new Promise((r) => setTimeout(r, INTERVAL_MS));
}

console.log("");
console.log(`=== 采样结束：${samples} 个样本，共捕获 longtask ${allLongtasks.length} 个 ===`);
if (allLongtasks.length) {
  const worst = [...allLongtasks].sort((a, b) => b.dur - a.dur).slice(0, 5);
  console.log("最长 5 个 longtask:");
  for (const l of worst) console.log(`  ${l.dur}ms  at ${new Date(l.at).toLocaleTimeString()}`);
}
ws.close();
process.exit(0);
