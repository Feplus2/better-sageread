// 修复验证探针（fix-verify）：S1 双轨合一 / S2 AI 翻译打点 / A1 双卡 / A2 死标清理 / A3 取消窗口
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

const T_CPS = "/src/store/convert-progress-store.ts?t=1787559132784";
const T_PTS = "/src/store/paper-task-store.ts?t=1787559133073";
const T_PC = "/src/utils/paper-conflict.ts?t=1787559132784";

await evalJS(`Promise.all([
  import("${T_CPS}"),
  import("/src/store/paper-task-registry.ts"),
  import("${T_PTS}"),
  import("${T_PC}"),
]).then(([cps, reg, pts, pc]) => { window.__fx = { cps, reg, pts, pc }; return "ok"; })`);
console.log("模块已加载（新鲜 ?t=）");

// ─── S1：双轨合一 ───
const s1 = await evalJS(`(() => {
  const { cps, reg, pc } = window.__fx;
  const R = {};
  const ID_A = "__fx_ui_vec__", ID_B = "__fx_oldapi_vec__";
  // 新轨标记 → 旧判据（startPaperReparse 用）必须能见到
  reg.usePaperTaskRegistry.getState().mark(ID_A, "vectorize", true);
  R.A_isPaperVectorizing = cps.isPaperVectorizing(ID_A);          // 期望 true（修复前 false）
  R.A_conflictsParse = pc.paperConflicts(ID_A, "parse");
  // 旧 API 标记 → 新注册表必须能见到
  cps.markPaperVectorizing(ID_B, true);
  R.B_registrySees = reg.registryActiveKinds(ID_B);               // 期望 ["vectorize"]（修复前 []）
  R.B_conflictsVectorize = pc.paperConflicts(ID_B, "vectorize");  // 期望 ["vectorize"]
  R.B_isPaperVectorizing = cps.isPaperVectorizing(ID_B);
  reg.usePaperTaskRegistry.getState().mark(ID_A, "vectorize", false);
  cps.markPaperVectorizing(ID_B, false);
  return R;
})()`);
console.log("S1 状态层:", JSON.stringify(s1));

// startPaperReparse 实拒（真实论文 + 标记期间，拒于入队前，零副作用）
const s1b = await evalJS(`(() => {
  const { cps, reg } = window.__fx;
  const REAL = { id: "5e9225b3eca98fbc", title: "Sodium-ion batteries" };
  reg.usePaperTaskRegistry.getState().mark(REAL.id, "vectorize", true);
  const r1 = cps.startPaperReparse(REAL, { silent: true });
  reg.usePaperTaskRegistry.getState().mark(REAL.id, "vectorize", false);
  reg.usePaperTaskRegistry.getState().mark(REAL.id, "translate", true);
  const r2 = cps.startPaperReparse(REAL, { silent: true });
  reg.usePaperTaskRegistry.getState().mark(REAL.id, "translate", false);
  return { vecBlocked: r1, translateBlocked: r2 };
})()`);
console.log("S1 startPaperReparse 拦截:", JSON.stringify(s1b));

// ─── S2：process-paper translate 打点（预中止 signal，零 LLM 调用） ───
const s2 = await evalJS(`(async () => {
  const { reg } = window.__fx;
  const pp = await import("/src/ai/tools/central/process-paper.ts");
  const REAL = "5e9225b3eca98fbc";
  const marks = [];
  const unsub = reg.usePaperTaskRegistry.subscribe((s) => {
    if (s.activeTranslate[REAL]) marks.push("on"); else marks.push("off");
  });
  const ac = new AbortController();
  ac.abort(); // 预中止：translatePaper 在任何 LLM 调用前即抛/返 cancelled
  const tool = pp.processPaperTool ?? pp.default ?? Object.values(pp).find((v) => v && typeof v === "object" && "execute" in v);
  let result;
  try {
    result = await tool.execute({ reasoning: "fix-verify", action: "translate", paperId: REAL }, { abortSignal: ac.signal });
  } catch (e) {
    result = { threw: String(e).slice(0, 120) };
  }
  unsub();
  return { marks: marks.join(","), success: result?.results?.success, msg: (result?.results?.message ?? result?.threw ?? "").slice(0, 80) };
})()`);
console.log("S2 打点闪迹:", JSON.stringify(s2));

// ─── A1：双卡共存 ───
await evalJS(`(() => {
  const { pts } = window.__fx;
  pts.usePaperTaskStore.setState({
    progress: {
      vectorize: { status: "running", index: 0, total: 3, title: "fx-vec", detail: "向量化中…", percent: 10, doneCount: 0, failedCount: 0, skippedCount: 0, failedNames: [] },
      translate: { status: "running", index: 1, total: 5, title: "fx-tr", detail: "翻译块 2/10", percent: 30, doneCount: 1, failedCount: 0, skippedCount: 0, failedNames: [] },
    },
  });
  return "ok";
})()`);
await sleep(1000);
const a1 = await evalJS(`Array.from(document.getElementById("bottom-right-stack").children).map((el) => (el.textContent ?? "").replace(/\\s+/g, " ").slice(0, 40))`);
console.log("A1 双通道同现栈内卡片:", JSON.stringify(a1));
await evalJS(`window.__fx.pts.usePaperTaskStore.setState({ progress: {} }); "cleared"`);

// ─── A2：57ae 死标状态 + 重挂载触发清理 ───
const a2before = await evalJS(`(async () => {
  const ps = await import("/src/services/paper-service.ts");
  const p = (await ps.listPapers()).find((x) => x.id === "57ae0a5f29feecb6");
  return p?.status?.metadata?.vectorization ?? null;
})()`);
console.log("A2 重挂载前 57ae vectorization:", JSON.stringify(a2before));
await evalJS(`window.location.hash = "#/"; "nav"`);
await sleep(700);
await evalJS(`window.location.hash = "#/papers"; "nav"`);
await sleep(2600);
const a2after = await evalJS(`(async () => {
  const ps = await import("/src/services/paper-service.ts");
  const { reg, pts } = window.__fx;
  const p = (await ps.listPapers()).find((x) => x.id === "57ae0a5f29feecb6");
  return {
    vec: p?.status?.metadata?.vectorization ?? null,
    registryMarked: reg.registryActiveKinds("57ae0a5f29feecb6"),
    restoreCard: pts.usePaperTaskStore.getState().progress.vectorize?.detail ?? null,
  };
})()`);
console.log("A2 重挂载后:", JSON.stringify(a2after));

// ─── A3：取消窗口吞任务（in-page 同步时序） ───
const a3 = await evalJS(`(async () => {
  const { pts } = window.__fx;
  const A = { id: "__fx_fake_a__", title: "fx探针A" };
  const B = { id: "__fx_fake_b__", title: "fx探针B" };
  const st0 = pts.usePaperTaskStore.getState();
  st0.enqueue("translate", [A]);
  // 等 A 进入执行位（title 上卡 = 已过 loop-top，readTextFile 在飞）
  for (let i = 0; i < 400; i++) {
    if (pts.usePaperTaskStore.getState().progress.translate?.title === A.title) break;
    await new Promise((r) => setTimeout(r, 2));
  }
  const enteredA = pts.usePaperTaskStore.getState().progress.translate?.title === A.title;
  // 同一 tick 内：取消（清队+abort 当前）+ 新意图 B 入队
  pts.usePaperTaskStore.getState().cancel("translate");
  pts.usePaperTaskStore.getState().enqueue("translate", [B]);
  // 等全部泵停
  for (let i = 0; i < 600; i++) {
    const s = pts.usePaperTaskStore.getState();
    if (!s.translateDraining && s.translateQueue.length === 0) break;
    await new Promise((r) => setTimeout(r, 5));
  }
  const s = pts.usePaperTaskStore.getState();
  const out = {
    enteredA,
    failedNames: s.progress.translate?.failedNames ?? [],
    queueLen: s.translateQueue.length,
    draining: s.translateDraining,
    summary: s.progress.translate?.summary ?? null,
  };
  // 清卡
  pts.usePaperTaskStore.setState((prev) => ({ progress: { ...prev.progress, translate: undefined } }));
  return out;
})()`);
console.log("A3 取消窗口:", JSON.stringify(a3));

ws.close();
process.exit(0);
