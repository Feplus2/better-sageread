// 修复验证探针（progress-fix-verify）：
// (a) trackSoloVectorize + emit 模拟 Rust 进度事件 → 卡片 percent 随事件增长（非恒 0）→ 成功卡 → 6s 自动消失
// (b) meta processing→success + notifyPaperStatusChanged → 页面局部刷新该篇 status（get_book_status 被调）→ 圆点转绿不重挂载
// (c) notifyPaperListChanged → 400ms 去抖后 loadAll（get_books_with_status 被调）
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

const PTS = "/src/store/paper-task-store.ts?t=1787563788237";

await evalJS(`Promise.all([
  import("${PTS}"),
  import("/src/services/paper-events.ts"),
  import("/src/services/book-service.ts"),
  import("/node_modules/.vite/deps/@tauri-apps_api_event.js?v=829f33bb"),
]).then(([pts, pe, bs, ev]) => { window.__fx = { pts, pe, bs, ev }; return "ok"; })`);
console.log("模块已加载");

// ─── (a) AI 路径单篇向量化卡片：percent 随事件增长 ───
const a = await evalJS(`(async () => {
  const { pts, ev } = window.__fx;
  const samples = [];
  const unsub = pts.usePaperTaskStore.subscribe((s) => {
    const v = s.progress.vectorize;
    if (v) samples.push(v.percent);
  });
  const run = async () => {
    for (const pct of [12, 38, 66, 100]) {
      await ev.emit("paper://index-progress", { paper_id: "__fx_solo__", percent: pct });
      await new Promise((r) => setTimeout(r, 120));
    }
    return { report: { total_chunks: 42 } };
  };
  const res = await pts.trackSoloVectorize({ id: "__fx_solo__", title: "fx-solo探针" }, run);
  unsub();
  const st = pts.usePaperTaskStore.getState();
  const card = st.progress.vectorize;
  const ringLeft = st.vectorizePercent["__fx_solo__"];
  return {
    samples: [...new Set(samples)],
    final: card ? { status: card.status, percent: card.percent, summary: card.summary } : null,
    ringCleaned: ringLeft === undefined,
    chunks: res.report.total_chunks,
  };
})()`);
console.log("(a) 卡片进度采样:", JSON.stringify(a));

// 6s 自动消失（PapersPage 挂载中，干净成功卡）
await sleep(7000);
const aGone = await evalJS(`(() => {
  const st = window.__fx.pts.usePaperTaskStore.getState();
  return { card: st.progress.vectorize ? st.progress.vectorize.status : null };
})()`);
console.log("(a) 6s 后卡片自动消失:", JSON.stringify(aGone));

// ─── (b) 完成即转绿（不重挂载） ───
const REAL = "5e9225b3eca98fbc";
const b = await evalJS(`(async () => {
  const { pe, bs } = window.__fx;
  const R = { steps: [] };
  // 监控页面是否调用 get_book_status（证明订阅链触发局部刷新）
  const internals = window.__TAURI_INTERNALS__;
  const orig = internals.invoke;
  let statusCalls = 0;
  internals.invoke = function (cmd, ...args) { if (cmd === "get_book_status") statusCalls++; return orig.call(this, cmd, ...args); };
  const dotColor = () => {
    // 找标题所在卡片内的圆点 class
    const nodes = Array.from(document.querySelectorAll("div"));
    const titleEl = nodes.find((d) => d.textContent?.trim() === "Sodium-ion batteries" && d.className.includes("truncate"));
    if (!titleEl) return "no-title";
    const card = titleEl.closest("div.rounded-xl") ?? titleEl.parentElement?.parentElement?.parentElement;
    if (!card) return "no-card";
    const dot = card.querySelector(".rounded-full.border-2");
    if (!dot) return "no-dot";
    return /green/.test(dot.className) ? "green" : /red/.test(dot.className) ? "red" : "neutral";
  };
  R.before = dotColor();
  // 模拟 vectorizePaper 的 processing 落盘 + 通知
  await bs.updateBookVectorizationMeta("${REAL}", { status: "processing", startedAt: Date.now() });
  pe.notifyPaperStatusChanged("${REAL}");
  await new Promise((r) => setTimeout(r, 900));
  R.steps.push(dotColor());
  // success + 通知 → 应转绿
  await bs.updateBookVectorizationMeta("${REAL}", { status: "success", chunkCount: 42, finishedAt: Date.now() });
  pe.notifyPaperStatusChanged("${REAL}");
  await new Promise((r) => setTimeout(r, 900));
  R.after = dotColor();
  R.statusCalls = statusCalls;
  internals.invoke = orig;
  return R;
})()`);
console.log("(b) 转绿链路:", JSON.stringify(b));

// 还原 idle + 通知（该篇原本无 vectorization 记录；idle 语义等同未向量化）
await evalJS(`(async () => {
  const { pe, bs } = window.__fx;
  await bs.updateBookVectorizationMeta("${REAL}", { status: "idle" });
  pe.notifyPaperStatusChanged("${REAL}");
  await new Promise((r) => setTimeout(r, 700));
  const nodes = Array.from(document.querySelectorAll("div"));
  const titleEl = nodes.find((d) => d.textContent?.trim() === "Sodium-ion batteries" && d.className.includes("truncate"));
  const card = titleEl?.closest("div.rounded-xl") ?? titleEl?.parentElement?.parentElement?.parentElement;
  const dot = card?.querySelector(".rounded-full.border-2");
  return { restored: dot ? (/green/.test(dot.className) ? "green(异常!)" : "neutral") : "no-dot" };
})()`).then((r) => console.log("(b) 还原后圆点:", JSON.stringify(r)));

// ─── (c) 列表变更通知 → 去抖 loadAll ───
const c = await evalJS(`(async () => {
  const { pe } = window.__fx;
  const internals = window.__TAURI_INTERNALS__;
  const orig = internals.invoke;
  let listCalls = 0;
  internals.invoke = function (cmd, ...args) { if (cmd === "get_books_with_status") listCalls++; return orig.call(this, cmd, ...args); };
  pe.notifyPaperListChanged();
  await new Promise((r) => setTimeout(r, 300));
  const tooEarly = listCalls; // 去抖 400ms：300ms 时不应已调
  await new Promise((r) => setTimeout(r, 1200));
  internals.invoke = orig;
  return { tooEarly, afterDebounce: listCalls };
})()`);
console.log("(c) 列表刷新:", JSON.stringify(c));

ws.close();
process.exit(0);
