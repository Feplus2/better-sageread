// (c) 列表变更通知 → 页面去抖 loadAll 的 DOM 证据（in-page 快轮询工具栏隐现）
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

const c = await evalJS(`(async () => {
  const pe = (await import("/src/services/paper-events.ts"));
  // 工具栏标志：「管理」按钮（loading=true 时整块内容区不渲染）
  const hasToolbar = () => !!Array.from(document.querySelectorAll("button")).find((b) => (b.textContent ?? "").trim() === "管理");
  if (!hasToolbar()) return { error: "toolbar 不在（PapersPage 未挂载或无论文）" };
  // 对照：1s 稳态不应隐现
  let steadyFlicker = 0;
  for (let i = 0; i < 40; i++) { if (!hasToolbar()) steadyFlicker++; await new Promise((r) => setTimeout(r, 25)); }
  // 触发列表变更通知 → 400ms 去抖 → loadAll（loading 隐现窗口）
  pe.notifyPaperListChanged();
  let sawHidden = false;
  let hiddenAtMs = -1;
  const t0 = Date.now();
  for (let i = 0; i < 120; i++) {
    if (!hasToolbar()) { sawHidden = true; hiddenAtMs = Date.now() - t0; break; }
    await new Promise((r) => setTimeout(r, 25));
  }
  // 等恢复
  await new Promise((r) => setTimeout(r, 800));
  return { steadyFlicker, sawHidden, hiddenAtMs, toolbarBack: hasToolbar() };
})()`);
console.log("(c) 列表刷新:", JSON.stringify(c));
ws.close();
process.exit(0);
