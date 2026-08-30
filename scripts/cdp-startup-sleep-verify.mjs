// 小项 2 CDP 实证：刷新/启动后只醒当前 tab（dev 1420 + CDP 9223）
//  A) 前置：唤醒全部 tab，量「刷新前全开」DOM 元素量
//  B) location.reload() → 断言 sleptTabIds = 除 activeTabId 外全部；
//     仅活跃层挂载重视图（书=foliate-view / 论文=正文 DOM），余为休眠壳；量「刷新后单醒」DOM 量对比
//  C) 切到休眠 tab → 既有唤醒路径自动恢复（slept 清单收缩 + 重视图重挂载）
// 用法：node scripts/cdp-startup-sleep-verify.mjs
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evalJs = async (expression) => {
  const res = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (res?.exceptionDetails)
    return `EXC: ${JSON.stringify(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text)}`;
  return res?.result?.value;
};
const shot = async (name) => {
  const res = await call("Page.captureScreenshot", { format: "png" });
  const { writeFileSync, mkdirSync } = await import("node:fs");
  mkdirSync(".tmp-startup-sleep", { recursive: true });
  writeFileSync(`.tmp-startup-sleep/${name}.png`, Buffer.from(res.data, "base64"));
  return name;
};
const results = [];
const check = (name, ok, detail = "") => {
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const pollUntil = async (fn, timeout = 5000, step = 250) => {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await fn();
    if (last) return last;
    await sleep(step);
  }
  return null;
};
const storeCall = async (body) =>
  evalJs(`(async () => {
    const url = performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("/src/store/layout-store.ts")) ?? "/src/store/layout-store.ts";
    const S = (await import(url)).useLayoutStore;
    ${body}
  })()`);
const storeState = async () =>
  JSON.parse(
    await storeCall(`const s = S.getState(); return JSON.stringify({
    tabs: s.tabs.map((t) => ({ id: t.id, type: t.type ?? "book" })),
    activeTabId: s.activeTabId, isHomeActive: s.isHomeActive, slept: s.sleptTabIds });`),
  );
// 每层挂载形态：book=foliate-view 有无；paper=正文 DOM / 休眠壳文案
const LAYERS_EXPR = `(() => {
  const layers = [...document.querySelectorAll("main.overflow-clip > .tab-layer")];
  return JSON.stringify(layers.map((l) => ({
    active: l.dataset.active === "true",
    foliate: !!l.querySelector("foliate-view"),
    paperBody: !!l.querySelector(".paper-content"),
    sleepShell: (l.textContent ?? "").includes("视图已休眠"),
  })));
})()`;

// ---------- A) 唤醒全部 tab，量「刷新前全开」基线 ----------
const initial = await storeState();
console.log("INITIAL", JSON.stringify(initial));
if (initial.tabs.length < 5) {
  console.error("SKIP: tab 数不足 5");
  process.exit(1);
}
for (const t of initial.tabs) {
  await storeCall(`S.getState().activateTab("${t.id}")`);
  await pollUntil(
    async () => {
      const layers = JSON.parse(await evalJs(LAYERS_EXPR));
      const active = layers.find((l) => l.active);
      return active && (active.foliate || active.paperBody) ? "mounted" : null;
    },
    25000,
    500,
  );
}
await storeCall(`S.getState().activateTab("${initial.activeTabId ?? initial.tabs[0].id}")`);
await sleep(800);
const domBefore = await evalJs(`document.querySelectorAll("*").length`);
const layersBefore = JSON.parse(await evalJs(LAYERS_EXPR));
console.log("A 全开基线 domCount=", domBefore, "layers=", JSON.stringify(layersBefore));
await shot("sleep-01-all-awake");

// ---------- B) 刷新 → 只醒当前 ----------
await evalJs(`location.reload()`);
await sleep(1500);
// 等 vite 重载 + tauri storage 再水合（tabs 还原为原集合即视为完成）
const rehydrated = await pollUntil(
  async () => {
    try {
      const st = await storeState();
      return st.tabs.length === initial.tabs.length ? st : null;
    } catch {
      return null;
    }
  },
  45000,
  800,
);
check("B 刷新后再水合完成（tab 集合还原）", !!rehydrated, rehydrated ? `tabs=${rehydrated.tabs.length}` : "timeout");
if (!rehydrated) {
  console.log("\n===== SUMMARY =====");
  for (const r of results) console.log(r);
  process.exit(1);
}
// 等活跃 tab 重视图挂载
const activeMounted = await pollUntil(
  async () => {
    const layers = JSON.parse(await evalJs(LAYERS_EXPR));
    const active = layers.find((l) => l.active);
    return active && (active.foliate || active.paperBody) ? "mounted" : null;
  },
  25000,
  500,
);
const expectSlept = initial.tabs.map((t) => t.id).filter((tid) => tid !== rehydrated.activeTabId);
const sleptOk =
  rehydrated.slept.length === expectSlept.length && expectSlept.every((tid) => rehydrated.slept.includes(tid));
check(
  "B 刷新后 sleptTabIds = 除活跃外全部 tab",
  sleptOk,
  `slept=${rehydrated.slept.length}/${initial.tabs.length - 1} active=${rehydrated.activeTabId}`,
);
check("B 活跃 tab 刷新后正常挂载", !!activeMounted, activeMounted ?? "timeout");
const layersAfter = JSON.parse(await evalJs(LAYERS_EXPR));
const mountedCount = layersAfter.filter((l) => l.foliate || l.paperBody).length;
const shellCount = layersAfter.filter((l) => !l.foliate && !l.paperBody).length;
check(
  "B 仅活跃层挂载重视图，其余为休眠壳",
  mountedCount === 1 && shellCount === layersAfter.length - 1,
  `mounted=${mountedCount} shells=${shellCount} total=${layersAfter.length}`,
);
const domAfter = await evalJs(`document.querySelectorAll("*").length`);
check(
  "B DOM 元素量：刷新后单醒 ≪ 刷新前全开",
  domAfter < domBefore * 0.6,
  `before=${domBefore} after=${domAfter} (${Math.round((domAfter / domBefore) * 100)}%)`,
);
await shot("sleep-02-after-reload");

// ---------- C) 休眠 tab 切回自动恢复 ----------
const bookVictim = initial.tabs.find((t) => t.type === "book" && t.id !== rehydrated.activeTabId);
const paperVictim = initial.tabs.find((t) => t.type === "paper" && t.id !== rehydrated.activeTabId);
for (const victim of [bookVictim, paperVictim].filter(Boolean)) {
  await storeCall(`S.getState().activateTab("${victim.id}")`);
  const woken = await pollUntil(
    async () => {
      const st = await storeState();
      const layers = JSON.parse(await evalJs(LAYERS_EXPR));
      const active = layers.find((l) => l.active);
      const mounted = victim.type === "book" ? active?.foliate : active?.paperBody;
      return !st.slept.includes(victim.id) && st.activeTabId === victim.id && mounted ? "woken" : null;
    },
    25000,
    500,
  );
  check(`C 休眠 ${victim.type} tab 切回自动唤醒（视图重挂载 + slept 收缩）`, !!woken, woken ?? "timeout");
}
await shot("sleep-03-woken");

// 还原活跃 tab
if (initial.activeTabId) await storeCall(`S.getState().activateTab("${initial.activeTabId}")`);
await sleep(500);

console.log("\n===== SUMMARY =====");
for (const r of results) console.log(r);
ws.close();
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
