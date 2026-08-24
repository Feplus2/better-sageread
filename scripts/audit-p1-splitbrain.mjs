// 审计探针（零副作用，假 paperId）：验证 6131195 后向量化状态双轨制是否分裂
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
const call = (method, params) => {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  pending.set(++mid, { promise, resolve });
  ws.send(JSON.stringify({ id: mid, method, params }));
  return promise;
};
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id).resolve(msg); pending.delete(msg.id); }
};
await new Promise((r) => (ws.onopen = r));
const evalJS = async (expr) => {
  const msg = await call("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (msg.error) throw new Error(`CDP error: ${JSON.stringify(msg.error)}`);
  const r = msg.result;
  if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r?.result?.value;
};

// 步骤1：模块引用挂上 window（分次 import 避免 Promise was collected）
await evalJS(`Promise.all([
  import("/src/store/convert-progress-store.ts"),
  import("/src/store/paper-task-registry.ts"),
  import("/src/utils/paper-conflict.ts?t=1787476302968"),
]).then(([cps, reg, pc]) => { window.__audit = { cps, reg, pc }; return "ok"; })`);
console.log("模块已加载");

const out = await evalJS(`(() => {
  const { cps, reg, pc } = window.__audit;
  const R = {};
  const ID_A = "__probe_ui_vec__";
  const ID_B = "__probe_ai_vec__";

  // 场景1：UI 队列向量化进行中（drainVectorize 只打新注册表）
  reg.usePaperTaskRegistry.getState().mark(ID_A, "vectorize", true);
  R.A_newRegistrySees = reg.registryActiveKinds(ID_A);
  R.A_conflictsParse = pc.paperConflicts(ID_A, "parse");
  R.A_oldSetSees = cps.isPaperVectorizing(ID_A);   // startPaperReparse:517 的判据

  // 场景2：AI 工具向量化进行中（vectorizePaperSingle 只打旧 Set）
  cps.markPaperVectorizing(ID_B, true);
  R.B_oldSetSees = cps.isPaperVectorizing(ID_B);
  R.B_newRegistrySees = reg.registryActiveKinds(ID_B);
  R.B_conflictsVectorize = pc.paperConflicts(ID_B, "vectorize"); // UI 入队口判据

  // 清理
  reg.usePaperTaskRegistry.getState().mark(ID_A, "vectorize", false);
  cps.markPaperVectorizing(ID_B, false);
  return R;
})()`);
console.log(JSON.stringify(out, null, 2));

// 解读
const split1 = out.A_oldSetSees === false && out.A_conflictsParse.length > 0;
const split2 = out.B_oldSetSees === true && out.B_conflictsVectorize.length === 0;
console.log("\n判定：");
console.log(`  UI 向量化中 → startPaperReparse 的旧 Set 判据是否盲: ${out.A_oldSetSees === false ? "盲（BUG 实证）" : "能见到"}`);
console.log(`  AI 向量化中 → UI 入队口 paperConflicts 是否盲: ${out.B_conflictsVectorize.length === 0 ? "盲（BUG 实证）" : "能见到"}`);
ws.close();
process.exit(0);
