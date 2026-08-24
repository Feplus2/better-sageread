// P2-1 实盘 E2E：book-convert 通道真转换（fixture 论文 PDF → EPUB 自动入库）
// 验证点：入队 → 任务卡 running/进度 → done 自动导入书库 → 聚合态 success + result 透出。
const FIXTURE = "F:/MyProjects/SageRead/fixtures/papers/akter2026atscale/source.pdf";

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

await evalJS(`Promise.all([
  import("/src/services/task-executors/book-convert.ts"),
  import("/src/store/task-center-store.ts"),
]).then(([ex, tc]) => { window.__ex = ex; window.__tc = tc; return 1; })`);

// 入队（autoImport=true：done 后自动入库，免人工点导入）
const enq = await evalJS(`window.__ex.enqueueBookConvert({ pdfPath: ${JSON.stringify(FIXTURE)}, ocr: false, translate: "none", autoImport: true })`);
console.log("入队:", JSON.stringify(enq));
if (!enq?.ok) throw new Error("入队失败");

// 轮询任务状态直到结算（最长 6 分钟）
let last = "";
const deadline = Date.now() + 6 * 60 * 1000;
for (;;) {
  const agg = await evalJS(`(() => {
    const s = window.__tc.useTaskCenterStore.getState();
    const t = Object.values(s.tasks).find((t) => t.channel === "book-convert");
    return t ? { status: t.status, percent: t.percent, detail: t.detail, error: t.error ?? null, result: t.result ?? null } : null;
  })()`);
  const line = JSON.stringify(agg);
  if (line !== last) { console.log("状态:", line); last = line; }
  if (!agg || agg.status === "success" || agg.status === "error" || agg.status === "cancelled") {
    if (agg?.status === "success") break;
    if (agg && agg.status !== "running" && agg.status !== "queued") throw new Error(`任务未成功: ${line}`);
  }
  if (Date.now() > deadline) throw new Error("超时未结算");
  await new Promise((r) => setTimeout(r, 3000));
}

// 入库校验：图书馆应有刚导入的书（EPUB）
const imported = await evalJS(`(async () => {
  const m = await import("/src/services/book-service.ts");
  const books = await m.getBooks();
  const hit = books.find((b) => (b.title ?? "").includes("At-Scale") || (b.title ?? "").includes("High-Voltage Cathode"));
  return hit ? { id: hit.id, title: hit.title, format: hit.format } : null;
})()`);
console.log("入库:", JSON.stringify(imported));

ws.close();
if (!imported) {
  console.error("FAIL - 未在书库找到导入的书");
  process.exit(1);
}
console.log("\nPASS");
process.exit(0);
