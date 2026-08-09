// 性能 CSS 手段 A/B 评估探针（无侵入：注入 → 实测开设置耗时 → 撤销）
// 评估对象：
//   A. scrollbar-gutter: stable       —— 滚动锁定不再改变视口宽度，掐最大失效源
//   B. content-visibility: auto        —— 论文块屏幕外跳过样式/布局计算
//   C. contain: layout paint           —— 论文容器与外界失效互相隔离
//   D. A+B+C 组合
// 用法：node scripts/cdp-perf-css-ab.mjs
// 前提：应用以 --remote-debugging-port=9222 启动，论文阅读器页面处于挂载状态
const LIST_URL = "http://127.0.0.1:9222/json/list";
const TRIALS = 2;

const res = await fetch(LIST_URL);
const targets = await res.json();
const page = targets.find((t) => t.type === "page" && t.url.includes("1420"));
if (!page) {
  console.log("NO_PAGE");
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl, [], { maxPayload: 256 * 1024 * 1024 });
await new Promise((r) => (ws.onopen = r));

let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result);
    pending.delete(m.id);
  }
};
const send = (method, params = {}) => {
  const mid = ++seq;
  ws.send(JSON.stringify({ id: mid, method, params }));
  return new Promise((r) => pending.set(mid, r));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evalJs = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true }))?.result?.value;

// ---- 页面内执行的工具片段 ----
const JS_CLOSE_DIALOGS = `(() => { [...document.querySelectorAll('[data-slot="dialog-content"] button[data-slot="dialog-close"]')].forEach((b) => b.click()); return 'ok'; })()`;
const JS_ARM_LONGTASK = `(() => { window.__lt = []; try { window.__po && window.__po.disconnect(); } catch {} const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)); }); window.__po = po; po.observe({ type: 'longtask', buffered: false }); return 'ok'; })()`;
const JS_CLICK_SETTINGS = `(() => { const btns = [...document.querySelectorAll('button')]; const b = btns.find((x) => x.querySelector('svg path[d^="M12.22 2h-.44"]')); if (!b) return 'NOT_FOUND'; b.click(); return 'clicked'; })()`;
const JS_DIALOG_VISIBLE = `(() => { const d = document.querySelector('[data-slot="dialog-content"]'); return !!(d && d.offsetWidth > 0); })()`;

// 组合式 setup：css（注入样式表）/ tagContainers / tagBlocks 三个开关
const buildSetup = ({ css = "", tagContainers = false, tagBlocks = false }) => `(() => {
  let s = document.getElementById('__ab_style');
  if (!s) { s = document.createElement('style'); s.id = '__ab_style'; document.head.appendChild(s); }
  s.textContent = ${JSON.stringify(css)};
  const pros = [...document.querySelectorAll('.prose')].filter((p) => p.getElementsByTagName('span').length > 1000);
  let blocks = 0;
  for (const p of pros) {
    if (${tagContainers}) p.classList.add('__ab-contain');
    if (${tagBlocks}) for (const child of p.children) { child.classList.add('__ab-cv'); blocks++; }
  }
  return JSON.stringify({ containers: pros.length, blocks });
})()`;

const JS_CLEAR_ALL = `(() => {
  document.getElementById('__ab_style')?.remove();
  document.querySelectorAll('.__ab-cv').forEach((e) => e.classList.remove('__ab-cv'));
  document.querySelectorAll('.__ab-contain').forEach((e) => e.classList.remove('__ab-contain'));
  return 'ok';
})()`;

async function measureOnce() {
  await evalJs(JS_CLOSE_DIALOGS);
  await sleep(1500);
  await evalJs(JS_ARM_LONGTASK);
  const t0 = Date.now();
  const click = await evalJs(JS_CLICK_SETTINGS);
  if (click === "NOT_FOUND") return { ms: -1, longtasks: [] };
  let visibleAt = -1;
  for (let i = 0; i < 150; i++) {
    await sleep(100);
    if (await evalJs(JS_DIALOG_VISIBLE)) {
      visibleAt = Date.now() - t0;
      break;
    }
  }
  await sleep(3000);
  const lt = JSON.parse(await evalJs(`JSON.stringify(window.__lt)`));
  await evalJs(JS_CLOSE_DIALOGS);
  await sleep(1500);
  return { ms: visibleAt, longtasks: lt };
}

async function runGroup(name, setup) {
  await evalJs(JS_CLEAR_ALL);
  if (setup) {
    const info = await evalJs(setup);
    console.log(`  [${name}] setup: ${info}`);
  }
  await sleep(1500); // 等注入引发的样式失效结算完，避免污染测量
  const trials = [];
  for (let i = 0; i < TRIALS; i++) trials.push(await measureOnce());
  await evalJs(JS_CLEAR_ALL);
  const msList = trials.map((t) => t.ms);
  const maxLt = Math.max(0, ...trials.flatMap((t) => t.longtasks));
  console.log(`  [${name}] 开设置耗时: ${msList.join(" / ")} ms   最长longtask: ${maxLt}ms\n`);
  return { name, msList, maxLt };
}

const CV_CSS = ".__ab-cv { content-visibility: auto; contain-intrinsic-size: auto 120px; }";
const CONTAIN_CSS = ".__ab-contain { contain: layout paint; }";
const GUTTER_CSS = "html, body { scrollbar-gutter: stable; }";

await send("Performance.enable");
const dom0 = await evalJs(`document.querySelectorAll('*').length`);
console.log(`初始 DOM=${dom0}，每组 ${TRIALS} 次试验\n`);

const results = [];
results.push(await runGroup("基线"));
results.push(await runGroup("A: scrollbar-gutter", buildSetup({ css: GUTTER_CSS })));
results.push(await runGroup("B: content-visibility 块", buildSetup({ css: CV_CSS, tagBlocks: true })));
results.push(await runGroup("C: contain 容器", buildSetup({ css: CONTAIN_CSS, tagContainers: true })));
results.push(
  await runGroup(
    "D: A+B+C 组合",
    buildSetup({ css: `${GUTTER_CSS} ${CV_CSS} ${CONTAIN_CSS}`, tagBlocks: true, tagContainers: true }),
  ),
);
results.push(await runGroup("基线(漂移检查)"));

console.log("=== 汇总 ===");
for (const r of results) console.log(`${r.name.padEnd(30)} ${r.msList.join(" / ")} ms   maxLongtask=${r.maxLt}ms`);
ws.close();
process.exit(0);
