// 审计探针 P2b：
// (1) 向量化+翻译双通道并行时 PapersPage 卡渲染几张（代码 466-470 疑似互斥）
// (2) 强制显示栈容器测几何堆叠（不切换视图，不打扰当前阅读 tab）
// (3) 刷新恢复链路：updateBookVectorizationMeta(processing) → PapersPage 重挂载（hash 往返）→ 恢复卡+注册表打点 → 还原 idle → 30s 轮询解除
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
const call = (m, p) => { let r; const pr = new Promise((res) => { r = res; }); pending.set(++mid, { pr, r }); ws.send(JSON.stringify({ id: mid, method: m, params: p })); return pr; };
ws.onmessage = (e) => { const msg = JSON.parse(e.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id).r(msg); pending.delete(msg.id); } };
await new Promise((r) => (ws.onopen = r));
const evalJS = async (expr) => {
  const msg = await call("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (msg.error) throw new Error(JSON.stringify(msg.error));
  if (msg.result?.exceptionDetails) throw new Error(msg.result.exceptionDetails.exception?.description ?? "exc");
  return msg.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await evalJS(`Promise.all([
  import("/src/store/convert-progress-store.ts"),
  import("/src/store/paper-task-registry.ts"),
  import("/src/store/paper-task-store.ts?t=1787476302968"),
  import("/src/services/book-service.ts"),
]).then(([cps, reg, pts, bs]) => { window.__audit = { cps, reg, pts, bs }; return "ok"; })`);
console.log("模块已加载");

// ─── (1) 双通道并行进度的卡渲染数 ───
await evalJS(`(() => {
  const { cps, pts } = window.__audit;
  cps.useConvertProgressStore.setState({
    paperImport: {
      status: "running", fileName: "audit-probe.pdf", percent: 42, detail: "OCR 解析",
      stages: [{n:1,name:"OCR 解析",status:"active"}],
      index: 1, total: 2, queuedCount: 1, importedCount: 0, skippedCount: 0, failedCount: 0, failedNames: [],
    },
  });
  pts.usePaperTaskStore.setState({
    progress: {
      vectorize: { status: "running", index: 0, total: 3, title: "probe-vec", detail: "向量化中…", percent: 10, doneCount: 0, failedCount: 0, skippedCount: 0, failedNames: [] },
      translate: { status: "running", index: 1, total: 5, title: "probe-tr", detail: "翻译块 2/10", percent: 30, doneCount: 1, failedCount: 0, skippedCount: 0, failedNames: [] },
    },
  });
  return "ok";
})()`);
await sleep(1000);
const cards1 = await evalJS(`Array.from(document.getElementById("bottom-right-stack").children).map((el) => (el.textContent ?? "").replace(/\\s+/g, " ").slice(0, 45))`);
console.log("(1) 三任务同现时栈内卡片:", JSON.stringify(cards1, null, 1));

// ─── (2) 强制显示测几何 ───
const geom = await evalJS(`(() => {
  const host = document.getElementById("bottom-right-stack");
  const prev = host.style.display;
  host.style.display = "flex";  // 覆盖禁区隐藏，纯为测量（React 重渲染时才还原，先手动还）
  const cards = Array.from(host.children).map((el) => {
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) };
  });
  const hostRect = host.getBoundingClientRect();
  host.style.display = prev;
  const ordered = [...cards].sort((a, b) => a.top - b.top);
  const overlapPairs = [];
  for (let i = 0; i + 1 < ordered.length; i++) {
    if (ordered[i].bottom > ordered[i + 1].top) overlapPairs.push([i, i + 1]);
  }
  return { count: cards.length, cards: ordered, overlapPairs, hostRight: Math.round(hostRect.right), hostBottom: Math.round(hostRect.bottom), vw: innerWidth, vh: innerHeight };
})()`);
console.log("(2) 几何:", JSON.stringify(geom, null, 1));

await evalJS(`(() => {
  const { cps, pts } = window.__audit;
  cps.useConvertProgressStore.setState({ paperImport: null });
  pts.usePaperTaskStore.setState({ progress: {} });
  return "cleared";
})()`);
console.log("模拟卡已清理");

// ─── (3) 刷新恢复链路 ───
const PAPER = "5e9225b3eca98fbc"; // Sodium-ion batteries（未向量化，processing→idle 语义安全）
// 3a. 打 processing 标
await evalJS(`window.__audit.bs.updateBookVectorizationMeta("${PAPER}", { status: "processing", startedAt: Date.now() }).then(() => "marked")`);
console.log("(3) 已打 processing 标:", PAPER);
// 3b. PapersPage 重挂载（hash 往返；home 层当前隐藏，用户无感知）
await evalJS(`window.location.hash = "#/"; "nav"`);
await sleep(800);
await evalJS(`window.location.hash = "#/papers"; "nav"`);
await sleep(2500);
const restored = await evalJS(`(() => {
  const { reg, pts } = window.__audit;
  const st = pts.usePaperTaskStore.getState();
  return {
    registryMarked: reg.registryActiveKinds("${PAPER}"),
    card: st.progress.vectorize ? { detail: st.progress.vectorize.detail, total: st.progress.vectorize.total } : null,
  };
})()`);
console.log("(3) 重挂载后恢复态:", JSON.stringify(restored, null, 1));
// 3c. 还原 metadata → 等 30s 轮询解除
await evalJS(`window.__audit.bs.updateBookVectorizationMeta("${PAPER}", { status: "idle" }).then(() => "restored")`);
console.log("(3) metadata 已还原 idle，等待 30s 轮询解除…");
let cleared = null;
for (let i = 0; i < 14; i++) {
  await sleep(5000);
  cleared = await evalJS(`(() => {
    const { reg, pts } = window.__audit;
    const st = pts.usePaperTaskStore.getState();
    return { registry: reg.registryActiveKinds("${PAPER}"), card: st.progress.vectorize ? st.progress.vectorize.detail : null };
  })()`);
  if (cleared.registry.length === 0 && cleared.card === null) break;
}
console.log("(3) 轮询解除后:", JSON.stringify(cleared));

ws.close();
process.exit(0);
