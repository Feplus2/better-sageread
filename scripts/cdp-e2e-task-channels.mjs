// P2-2/P2-3 实盘验证：三通道队列语义
// ① 批量向量化 2 篇（最小两篇论文）按序结算；② 同书双入队幂等拒入；
// ③ 论文翻译通道 enqueueAndWait 续翻（forecast 已全翻，零模型调用快结算）；
// ④ 聚合选择器三通道状态正确。
const PAPERS = ["2f64e2c4a1b836ab", "6f0c2fcfc3e03b17"]; // dev 库最小两篇
const FORECAST = "57ae0a5f29feecb6";

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const assert = (cond, msg) => {
  if (!cond) { failed++; console.error(`FAIL - ${msg}`); } else { console.log(`ok - ${msg}`); }
};

// store 实例对齐（HMR ?t= 陷阱）：从执行方转换源码抠真实带版本 URL，否则拿到平行实例
const tcUrl = await evalJS(`(async () => {
  const src = await (await fetch("/src/services/task-executors/paper-vectorize.ts")).text();
  const i = src.indexOf("/src/store/task-center-store");
  if (i < 0) return null;
  const end = src.indexOf(".ts", i);
  let url = src.slice(i, end + 3);
  const m = src.slice(end + 3).match(/^\\?t=\\d+/);
  if (m) url += m[0];
  return url;
})()`);
console.log("task-center-store 真实 URL:", tcUrl);
if (!tcUrl) throw new Error("未能探到 task-center-store 的版本 URL");

// 注意：task-executor-registry.ts 拆分前，本次 store HMR 已把旧注册清空——
// 用缓存破除查询强制四执行器重跑自注册一次（此后注册住持久注册表，store HMR 不再丢）。
const cb = Date.now();
await evalJS(`Promise.all([
  import(${JSON.stringify(tcUrl)}),
  import("/src/services/task-executors/paper-vectorize.ts?cb=${cb}"),
  import("/src/services/task-executors/paper-translate.ts?cb=${cb}"),
  import("/src/services/task-executors/book-vectorize.ts?cb=${cb}"),
  import("/src/services/task-executors/book-convert.ts?cb=${cb}"),
]).then(([tc, pv, pt, bv]) => { window.__tc = tc; window.__pv = pv; window.__pt = pt; window.__bv = bv; return 1; })`);

// ② 同书双入队幂等拒入（在做批量向量化前先测，通道空闲时第二发入队也因 running 被拒）
const dup = await evalJS(`(() => {
  const a = window.__bv.enqueueBookVectorize({ bookId: "__no_such_book__", title: "不存在的书" });
  const b = window.__bv.enqueueBookVectorize({ bookId: "__no_such_book__", title: "不存在的书" });
  return { a, b };
})()`);
assert(dup.a?.ok === true && dup.b?.ok === false && dup.b?.reason === "duplicate", `同书双入队去重（got ${JSON.stringify(dup.b)})`);

// 等上面那个假书任务失败结算（不存在 → error），不影响后续
await sleep(3000);
await evalJS(`window.__tc.useTaskCenterStore.getState().dismissSettled("book-vectorize"); true`);

// ① 批量向量化 2 篇（串行泵：第二篇等第一篇结算）
console.log("批量向量化 2 篇…");
const vecResult = await evalJS(`(async () => {
  const seen = { running: 0, queuedSeen: 0 };
  const un = window.__tc.useTaskCenterStore.subscribe((s) => {
    const agg = window.__tc.selectChannelAggregate(s, "paper-vectorize");
    if (agg.current) seen.running += 1;
    if (agg.queuedCount > 0) seen.queuedSeen += 1;
  });
  try {
    const results = await Promise.all(${JSON.stringify(PAPERS)}.map((id) =>
      window.__pv.enqueuePaperVectorizeAndWait({ id, title: id }).then(
        (t) => ({ id, ok: true, status: t.status }),
        (e) => ({ id, ok: false, err: String(e).slice(0, 120) }),
      )));
    return { results, seen };
  } finally { un(); }
})()`);
console.log("向量化结果:", JSON.stringify(vecResult.results), "观测:", JSON.stringify(vecResult.seen));
assert(vecResult.results.every((r) => r.ok && r.status === "success"), "两篇向量化全部成功");
assert(vecResult.seen.running > 0, "聚合选择器在运行期观测到 current（卡片数据源活着）");
assert(vecResult.seen.queuedSeen > 0, "串行泵：第一篇在跑时第二篇处于 queued");

// ③ 翻译通道 enqueueAndWait（forecast 续翻，应快速结算）
console.log("翻译通道续翻 forecast…");
const trResult = await evalJS(`window.__pt.enqueuePaperTranslateAndWait({ id: ${JSON.stringify(FORECAST)}, title: "forecast", force: false }).then(
  (t) => ({ ok: true, status: t.status, percent: t.percent, detail: t.detail }),
  (e) => ({ ok: false, err: String(e).slice(0, 200) }),
)`);
console.log("翻译结算:", JSON.stringify(trResult));
assert(trResult.ok && trResult.status === "success", `续翻成功结算（got ${JSON.stringify(trResult)}）`);

// ④ 聚合选择器：结算后 settled 被卡片 6s 自动消失/dismissSettled 清掉属预期；
// 这里只核对其存在期语义——结算即刻读取（不被 dismiss 的话 settled 应有记录）。
// 注意：enqueue* 入口自带 dismissIfIdle，批量入队会清掉上一批的 settled——属卡片视觉复位口径。
const aggs = await evalJS(`(() => {
  const s = window.__tc.useTaskCenterStore.getState();
  const pick = (ch) => { const a = window.__tc.selectChannelAggregate(s, ch); return { current: !!a.current, queued: a.queuedCount, settled: a.settled.map((t) => t.status) }; };
  return { vectorize: pick("paper-vectorize"), translate: pick("paper-translate") };
})()`);
console.log("聚合（结算后）:", JSON.stringify(aggs));
assert(aggs.vectorize.current === false && aggs.translate.current === false, "全部结算后无残留 running");

ws.close();
console.log(failed === 0 ? "\nPASS" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
