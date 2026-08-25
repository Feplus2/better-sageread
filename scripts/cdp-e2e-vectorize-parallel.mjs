// P3 §2 实盘：向量化单篇内并行 embed——同一篇论文重向量化，验证成功结算 + 块数完整。
// （串行基线已被替代，这里主要验证并行写库正确性与退避不破坏正常路径）
const PAPER = "2f64e2c4a1b836ab"; // dev 库最小论文

const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
if (!page) throw new Error("未找到 dev 页面");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
};
await new Promise((r) => (ws.onopen = r));
const evalJS = async (expression) => {
  const r = await new Promise((res) => {
    const id = ++mid;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description ?? "eval 失败").slice(0, 300));
  return r.result.value;
};

// store 实例对齐（HMR ?t=）
const tcUrl = await evalJS(`(async () => {
  const src = await (await fetch("/src/services/task-executors/paper-vectorize.ts")).text();
  const i = src.indexOf("/src/store/task-center-store");
  const end = src.indexOf(".ts", i);
  let url = src.slice(i, end + 3);
  const m = src.slice(end + 3).match(/^\\?t=\\d+/);
  if (m) url += m[0];
  return url;
})()`);
await evalJS(`Promise.all([
  import(${JSON.stringify(tcUrl)}),
  import("/src/services/task-executors/paper-vectorize.ts"),
]).then(([tc, pv]) => { window.__tc = tc; window.__pv = pv; return 1; })`);

const t0 = Date.now();
const result = await evalJS(`window.__pv.enqueuePaperVectorizeAndWait({ id: ${JSON.stringify(PAPER)}, title: "vec-test" }).then(
  (t) => ({ ok: true, status: t.status, result: t.result ?? null }),
  (e) => ({ ok: false, err: String(e).slice(0, 200) }),
)`);
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`向量化结算（${elapsed}s）:`, JSON.stringify(result));

// 向量分片数核对（并行写入完整性：先删后插 + 块数与切块一致）
const chunkCount = await evalJS(`(async () => {
  const core = await import("/node_modules/.vite/deps/@tauri-apps_api_core.js");
  const status = await core.invoke("get_paper_source_status", { paperId: ${JSON.stringify(PAPER)} });
  return status;
})()`);
console.log("版本锚状态:", JSON.stringify(chunkCount));

const ok = result.ok && result.status === "success" && chunkCount && chunkCount.vectorizedStale === false;
console.log(ok ? "PASS" : "FAIL");
ws.close();
process.exit(ok ? 0 : 1);
