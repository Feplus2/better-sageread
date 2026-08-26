// 切 tab React render 墙探针（dev 1420 + CDP 9223）：memo(PaperReaderView/HomeLayout) 根修后的验收测量。
// 与 2026-08-25 A/B（scripts/cdp-opacity-ab.mjs）同靶子同口径：最重论文层 ↔ 最轻 tab 各切 10 轮，
// 指标 tCommit（activateTab→data-active 翻转）/ tReflow（翻转后强制同步 flush）/ tWall / longtask / tNext。
// 验收口径：tWall 中位 < 200ms（根修前基线：中位 1726ms，longtask 单个 ~2s）。
// 附加取证：CPU Profiler 采一轮切换，统计 PaperReaderView/HomeLayout 函数命中数（memo 生效应为 0）。
// 用法：node scripts/cdp-tab-switch-wall.mjs
const LIST_URL = "http://127.0.0.1:9223/json/list";
const page = (await (await fetch(LIST_URL)).json()).find((t) => t.type === "page" && t.url.includes("localhost:1420"));
if (!page) {
  console.error("no page");
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const call = (m, p = {}) =>
  new Promise((r) => {
    const i = ++id;
    pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method: m, params: p }));
  });
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result);
    pending.delete(msg.id);
  }
};
await new Promise((r) => (ws.onopen = r));
await call("Runtime.enable");
await call("Page.enable");
await call("Profiler.enable");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evalJs = async (expression) => {
  const res = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (res?.exceptionDetails)
    return `EXC: ${JSON.stringify(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text)}`;
  return res?.result?.value;
};
// 探针-应用同实例保障：vite HMR 会给改过的模块挂 ?t= 版本串（资源条目可见），
// 裸路径 import 会静默命中旧实例（store 更新但 UI 不动）；从 resource 条目解析当前生效 URL
const storeCall = async (body) =>
  evalJs(`(async () => {
    const url = performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("/src/store/layout-store.ts")) ?? "/src/store/layout-store.ts";
    const S = (await import(url)).useLayoutStore;
    ${body}
  })()`);
const storeState = async () =>
  JSON.parse(
    await storeCall(`const s = S.getState(); return JSON.stringify({
    tabs: s.tabs.map((t) => ({ id: t.id, type: t.type ?? "book", title: (t.title ?? "").slice(0, 30) })),
    activeTabId: s.activeTabId, isHomeActive: s.isHomeActive, slept: s.sleptTabIds });`),
  );
const stats = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length), median: q(0.5), p90: q(0.9), max: s[s.length - 1], min: s[0] };
};

// ---------- 前置：唤醒 + 找最重/最轻层 ----------
const initial = await storeState();
const initialHash = await evalJs(`location.hash`);
console.log("INITIAL", JSON.stringify({ ...initial, hash: initialHash }));
for (const sleptId of initial.slept) {
  await storeCall(`S.getState().activateTab("${sleptId}")`);
  await sleep(1500);
}
const domCounts = [];
for (const t of initial.tabs) {
  await storeCall(`S.getState().activateTab("${t.id}")`);
  await sleep(1400);
  const n = await evalJs(`(() => {
    const l = [...document.querySelectorAll("main.overflow-clip > .tab-layer")].find((x) => x.dataset.active === "true");
    return l ? l.querySelectorAll("*").length : 0;
  })()`);
  domCounts.push({ id: t.id, type: t.type, n });
  console.log("DOM", t.id, t.type, n);
}
domCounts.sort((a, b) => b.n - a.n);
const heavy = domCounts[0];
const light = domCounts[domCounts.length - 1].id !== heavy.id ? domCounts[domCounts.length - 1] : domCounts[1];
const totalDom = await evalJs(`document.querySelectorAll("*").length`);
console.log(`TARGET heavy=${heavy.id}(${heavy.n}) light=${light.id}(${light.n}) total=${totalDom}`);

// ---------- 墙探针（同 A/B 口径 + longtask） ----------
const probeSwitch = async (targetId) =>
  JSON.parse(
    await evalJs(`(async () => {
    const url = performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("/src/store/layout-store.ts")) ?? "/src/store/layout-store.ts";
    const S = (await import(url)).useLayoutStore;
    const main = document.querySelector("main.overflow-clip");
    const longtasks = [];
    let pt = null;
    try {
      pt = new PerformanceObserver((l) => { for (const e of l.getEntries()) longtasks.push(Math.round(e.duration)); });
      pt.observe({ type: "longtask", buffered: false });
    } catch {}
    let tFlip = 0;
    const mo = new MutationObserver(() => { if (!tFlip) tFlip = performance.now(); });
    mo.observe(main, { attributes: true, subtree: true, attributeFilter: ["data-active"] });
    const t0 = performance.now();
    S.getState().activateTab("${targetId}");
    while (!tFlip && performance.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 2));
    mo.disconnect();
    const tCommit = Math.round((tFlip || performance.now()) - t0);
    const layer = [...main.children].find((c) => c.dataset?.active === "true");
    const probe = layer?.querySelector(".paper-content") ?? layer?.firstElementChild ?? layer;
    const r0 = performance.now();
    if (probe) void probe.getBoundingClientRect();
    if (layer) void layer.offsetHeight;
    const tReflow = Math.round(performance.now() - r0);
    const tNext = await new Promise((res) => {
      const t1 = performance.now();
      requestAnimationFrame(() => requestAnimationFrame(() => res(Math.round(performance.now() - t1))));
    });
    if (pt) pt.disconnect();
    return JSON.stringify({ tCommit, tReflow, tNext, longtasks, ltTotal: longtasks.reduce((a, b) => a + b, 0) });
  })()`),
  );

const ROUNDS = 10;
const rows = [];
// 热身往返（不采样）
await storeCall(`S.getState().activateTab("${light.id}")`);
await sleep(900);
await probeSwitch(heavy.id);
await sleep(900);
for (let i = 1; i <= ROUNDS; i++) {
  await storeCall(`S.getState().activateTab("${light.id}")`);
  await sleep(900);
  const r = await probeSwitch(heavy.id);
  rows.push(r);
  console.log(`WALL round${i}: tCommit=${r.tCommit} tReflow=${r.tReflow} tWall=${r.tCommit + r.tReflow} longtasks=[${r.longtasks}] tNext=${r.tNext}`);
  await sleep(400);
}
const wallStats = {
  tWall: stats(rows.map((r) => r.tCommit + r.tReflow)),
  tCommit: stats(rows.map((r) => r.tCommit)),
  tReflow: stats(rows.map((r) => r.tReflow)),
  ltTotal: stats(rows.map((r) => r.ltTotal)),
  tNext: stats(rows.map((r) => r.tNext)),
};
console.log("WALL STATS", JSON.stringify(wallStats));
const median = wallStats.tWall.median;
console.log(`VERDICT tWall median=${median}ms（基线 1726ms）${median < 200 ? "PASS <200ms" : "FAIL ≥200ms"}`);

// ---------- CPU Profiler 取证：一轮切换的组件函数命中数 ----------
await storeCall(`S.getState().activateTab("${light.id}")`);
await sleep(1000);
await call("Profiler.start");
await storeCall(`S.getState().activateTab("${heavy.id}")`);
await sleep(2000);
const { profile } = await call("Profiler.stop");
const hits = {};
for (const n of profile.nodes) {
  const fn = n.callFrame.functionName;
  if (!fn || !n.hitCount) continue;
  if (/PaperReaderView|HomeLayout|PaperReader|SideChat|PreviewPanel|ReaderLayout|AnimatedRouteLayers/.test(fn)) {
    hits[fn] = (hits[fn] ?? 0) + n.hitCount;
  }
}
console.log("PROFILE hits（memo 生效则 PaperReaderView/HomeLayout=0）:", JSON.stringify(hits));

// ---------- 还原 ----------
const { writeFileSync, mkdirSync } = await import("node:fs");
mkdirSync(".tmp-motion-verify", { recursive: true });
writeFileSync(
  ".tmp-motion-verify/wall-after-memo.json",
  JSON.stringify({ heavy, light, totalDom, rows, wallStats, profileHits: hits }, null, 2),
);
if (initial.isHomeActive) await storeCall(`S.getState().navigateToHome()`);
else if (initial.activeTabId) await storeCall(`S.getState().activateTab("${initial.activeTabId}")`);
await evalJs(`location.hash = ${JSON.stringify(initialHash || "#/")}`);
await sleep(600);
ws.close();
process.exit(0);
