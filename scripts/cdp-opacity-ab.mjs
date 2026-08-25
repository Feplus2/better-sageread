// 保活层隐藏模型 A/B 实盘实验（dev 1420 + CDP 9223，HMR 已应用双轨改动）：
//   对照组 data-tab-hide="visibility"（opacity 淡 + visibility 延迟链，批次 3 原状）
//   实验组 data-tab-hide="opacity"（纯 opacity + pointer-events + inert，无 visibility）
// 裁决假设：切向重论文 tab 的 unhide 强制样式重算墙来自 visibility 继承传播；opacity 模型应拆墙。
//  A) 墙对比（核心）：最重论文 tab ↔ 轻 tab，两模型各 10 轮（交错采，每侧先热身 1 轮），
//     指标 = tCommit（activate→data-active 翻转）/ tReflow（翻转后立即强制同步 flush）/
//     tWall=tCommit+tReflow / LoAF（long animation frame）总时长与峰值 / 下一绘制帧 tNext。
//  B) 终态干净（lianyan 半透明磨砂 + 动态壁纸，opacity 模型）：
//     ① 隐藏层终态 computed opacity 恰为 0；② elementFromPoint 网格探针全命中活跃层；
//     ③ 淡入完成截图 vs「display:none 只有活跃 tab」基线逐像素 diff（视频先暂停排噪）；双向各一轮 + 中途截图留档。
//  C) 焦点隔离（opacity 模型）：CDP 连打 40 次 Tab + 10 次 Shift+Tab，activeElement 永不落入隐藏层。
// 结果落盘 .tmp-motion-verify/ab-results.json + 截图；退出前还原主题/模型/活跃 tab。
// 用法：node scripts/cdp-opacity-ab.mjs
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
  mkdirSync(".tmp-motion-verify", { recursive: true });
  writeFileSync(`.tmp-motion-verify/${name}.png`, Buffer.from(res.data, "base64"));
  return res.data; // base64 供像素 diff 复用
};
const results = [];
const check = (name, ok, detail = "") => {
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const pollUntil = async (fn, timeout = 3000, step = 200) => {
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
  evalJs(`(async () => { const S = (await import("/src/store/layout-store.ts")).useLayoutStore; ${body} })()`);
const storeState = async () =>
  JSON.parse(
    await storeCall(`const s = S.getState(); return JSON.stringify({
    tabs: s.tabs.map((t) => ({ id: t.id, type: t.type ?? "book", title: (t.title ?? "").slice(0, 30) })),
    activeTabId: s.activeTabId, isHomeActive: s.isHomeActive, slept: s.sleptTabIds });`),
  );
const setModel = async (m) => evalJs(`document.documentElement.dataset.tabHide = "${m}"`);
const getModel = async () => evalJs(`document.documentElement.dataset.tabHide ?? "opacity"`);

// ---------- 统计工具 ----------
const stats = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return {
    n: s.length,
    mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length),
    median: q(0.5),
    p90: q(0.9),
    max: s[s.length - 1],
    min: s[0],
  };
};

// ---------- 0) 前置：唤醒休眠 tab，找最重论文层 ----------
const initial = await storeState();
const initialHash = await evalJs(`location.hash`);
const initialTheme = await evalJs(
  `(async () => { const T = (await import("/src/store/theme-store.ts")).useThemeStore; return T.getState().globalTheme ?? ""; })()`,
);
const initialMotion = await evalJs(`document.documentElement.dataset.motion ?? "full"`);
console.log("INITIAL", JSON.stringify({ ...initial, hash: initialHash, theme: initialTheme, motion: initialMotion }));

// 唤醒全部休眠 tab（逐个激活等待，避免唤醒重渲染污染采样）
for (const sleptId of initial.slept) {
  await storeCall(`S.getState().activateTab("${sleptId}")`);
  await sleep(1500);
}
// 每个 tab 激活一轮量 DOM：找元素最多的论文层（重墙靶子）与最轻 tab（切换对手）
const domCounts = [];
for (const t of initial.tabs) {
  await storeCall(`S.getState().activateTab("${t.id}")`);
  await sleep(1200);
  const n = await evalJs(`(() => {
    const l = [...document.querySelectorAll("main.overflow-clip > .tab-layer")].find((x) => x.dataset.active === "true");
    return l ? l.querySelectorAll("*").length : 0;
  })()`);
  domCounts.push({ id: t.id, type: t.type, title: t.title, n });
  console.log("DOM", t.id, t.type, n);
}
domCounts.sort((a, b) => b.n - a.n);
const heavy = domCounts[0];
const light = domCounts[domCounts.length - 1].id !== heavy.id ? domCounts[domCounts.length - 1] : domCounts[1];
console.log(`TARGET heavy=${heavy.id}(${heavy.n}元素 ${heavy.title}) light=${light.id}(${light.n}元素)`);
check("0 前置：最重论文层 ≥ 5 万元素（墙才有分辨度）", heavy.n >= 50000, `${heavy.n} 元素`);

// ---------- A) 墙对比 ----------
// 单次测量：从当前 tab 切到 targetId，回 {tCommit,tReflow,tNext,loafTotal,loafMax,loafN}
const probeSwitch = async (targetId) =>
  JSON.parse(
    await evalJs(`(async () => {
    const S = (await import("/src/store/layout-store.ts")).useLayoutStore;
    const main = document.querySelector("main.overflow-clip");
    const loafs = [];
    let po = null;
    try {
      po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) if (e.duration >= 50) loafs.push(Math.round(e.duration));
      });
      po.observe({ type: "long-animation-frame", buffered: false });
    } catch {}
    let tFlip = 0;
    const mo = new MutationObserver(() => { if (!tFlip) tFlip = performance.now(); });
    mo.observe(main, { attributes: true, subtree: true, attributeFilter: ["data-active"] });
    const t0 = performance.now();
    S.getState().activateTab("${targetId}");
    while (!tFlip && performance.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 4));
    mo.disconnect();
    const tCommit = Math.round((tFlip || performance.now()) - t0);
    // 翻转后立即强制同步 flush：unhide 样式重算若存在，在此结算（读新激活层内容盒几何）
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
    if (po) po.disconnect();
    return JSON.stringify({
      tCommit, tReflow, tNext,
      loafTotal: loafs.reduce((a, b) => a + b, 0),
      loafMax: loafs.reduce((a, b) => Math.max(a, b), 0),
      loafN: loafs.length,
    });
  })()`),
  );

const ROUNDS = 10;
const wallData = { visibility: [], opacity: [] };
// 热身：两模型各走一遍完整往返（不采样，排冷缓存）
for (const m of ["visibility", "opacity"]) {
  await setModel(m);
  await storeCall(`S.getState().activateTab("${light.id}")`);
  await sleep(900);
  await probeSwitch(heavy.id);
  await sleep(900);
}
// 交错采样：每轮 visibility → opacity，平衡机器状态漂移
for (let i = 1; i <= ROUNDS; i++) {
  for (const m of ["visibility", "opacity"]) {
    await setModel(m);
    await storeCall(`S.getState().activateTab("${light.id}")`);
    await sleep(900); // 等淡出沉降 + 隐藏层静止
    const r = await probeSwitch(heavy.id);
    wallData[m].push(r);
    console.log(`A round${i} ${m}: tCommit=${r.tCommit} tReflow=${r.tReflow} tWall=${r.tCommit + r.tReflow} loafTotal=${r.loafTotal} loafMax=${r.loafMax} tNext=${r.tNext}`);
    await sleep(500);
  }
}
const wallStats = {};
for (const m of ["visibility", "opacity"]) {
  wallStats[m] = {
    tWall: stats(wallData[m].map((r) => r.tCommit + r.tReflow)),
    tReflow: stats(wallData[m].map((r) => r.tReflow)),
    tCommit: stats(wallData[m].map((r) => r.tCommit)),
    loafTotal: stats(wallData[m].map((r) => r.loafTotal)),
    loafMax: stats(wallData[m].map((r) => r.loafMax)),
    tNext: stats(wallData[m].map((r) => r.tNext)),
  };
}
console.log("A STATS", JSON.stringify(wallStats, null, 1));
const wallMedianVis = wallStats.visibility.tWall.median;
const wallMedianOp = wallStats.opacity.tWall.median;
const wallReduction = wallMedianVis > 0 ? Math.round((1 - wallMedianOp / wallMedianVis) * 100) : 0;
const loafReduction =
  wallStats.visibility.loafTotal.median > 0
    ? Math.round((1 - wallStats.opacity.loafTotal.median / wallStats.visibility.loafTotal.median) * 100)
    : 0;
check(
  "A 墙缩小 ≥50%（tWall 中位数，裁决主指标）",
  wallReduction >= 50,
  `visibility=${wallMedianVis}ms opacity=${wallMedianOp}ms 缩小=${wallReduction}%（LoAF 总时长中位缩小=${loafReduction}%）`,
);

// ---------- B) 终态干净（lianyan 主题，opacity 模型） ----------
await setModel("opacity");
await evalJs(`(async () => { const T = (await import("/src/store/theme-store.ts")).useThemeStore; await T.getState().setGlobalTheme("lianyan"); return "ok"; })()`);
await sleep(1500); // 主题 CSS 注入 + 壁纸视频起播
// 暂停动态壁纸排噪（磨砂半透明是确定性的；视频帧不确定）
const videosPaused = await evalJs(`(() => {
  const vs = [...document.querySelectorAll("video")];
  vs.forEach((v) => v.pause());
  return vs.length;
})()`);
console.log("B lianyan applied, videos paused:", videosPaused);
await sleep(400);
await shot("ab-10-lianyan-theme");

// 页内像素 diff：两张 CDP PNG（base64 经 window.__shotA/B 传入，避免超长表达式）→ 逐像素对比
const pixelDiff = async (b64a, b64b) => {
  await evalJs(`window.__shotA = ${JSON.stringify(b64a)}; window.__shotB = ${JSON.stringify(b64b)}; "ok"`);
  return JSON.parse(
    await evalJs(`(async () => {
      const load = (b64) => new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => res(img);
        img.onerror = () => rej(new Error("img load fail"));
        img.src = "data:image/png;base64," + b64;
      });
      const [ia, ib] = await Promise.all([load(window.__shotA), load(window.__shotB)]);
      if (ia.width !== ib.width || ia.height !== ib.height)
        return JSON.stringify({ err: \`size mismatch \${ia.width}x\${ia.height} vs \${ib.width}x\${ib.height}\` });
      const cv = document.createElement("canvas");
      cv.width = ia.width; cv.height = ia.height;
      const cx = cv.getContext("2d", { willReadFrequently: true });
      cx.drawImage(ia, 0, 0);
      const da = cx.getImageData(0, 0, cv.width, cv.height).data;
      cx.clearRect(0, 0, cv.width, cv.height);
      cx.drawImage(ib, 0, 0);
      const db = cx.getImageData(0, 0, cv.width, cv.height).data;
      let diffPx = 0, maxDelta = 0;
      const total = cv.width * cv.height;
      for (let i = 0; i < da.length; i += 4) {
        const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]));
        if (d > 8) diffPx++; // 8/255 阈值排合成器亚像素噪声
        if (d > maxDelta) maxDelta = d;
      }
      return JSON.stringify({ total, diffPx, pct: Math.round((diffPx / total) * 10000) / 100, maxDelta });
    })()`),
  );
};

// B 单向测试：activeId 活跃（null=主页层），对隐藏层做 ①②③
const testTerminalClean = async (activeId, label, shotPrefix) => {
  if (activeId) await storeCall(`S.getState().activateTab("${activeId}")`);
  else await storeCall(`S.getState().navigateToHome()`);
  await sleep(1400); // 等淡入彻底沉降
  // ① 隐藏层终态 computed opacity 恰为 0
  const term = JSON.parse(
    await evalJs(`JSON.stringify([...document.querySelectorAll("main.overflow-clip > .tab-layer")].map((l) => {
      const c = getComputedStyle(l);
      return { a: l.dataset.active, op: c.opacity, pe: c.pointerEvents, inert: l.inert, ah: l.getAttribute("aria-hidden") };
    }))`),
  );
  const hidden = term.filter((t) => t.a !== "true");
  const opOk = hidden.length > 0 && hidden.every((t) => t.op === "0" && t.pe === "none" && t.inert === true && t.ah === "true");
  check(`B① ${label}：隐藏层终态 opacity 恰为 0 + pointer-events:none + inert/aria-hidden`, opOk, JSON.stringify(term));
  // ② elementFromPoint 网格探针（5x3，缩进 8% 避边）全命中活跃层
  const probes = JSON.parse(
    await evalJs(`(() => {
      const main = document.querySelector("main.overflow-clip");
      const active = [...main.children].find((c) => c.dataset?.active === "true");
      const r = main.getBoundingClientRect();
      const out = [];
      for (let ix = 1; ix <= 5; ix++) for (let iy = 1; iy <= 3; iy++) {
        const x = r.x + (r.width * ix) / 6, y = r.y + (r.height * iy) / 4;
        const hit = document.elementFromPoint(x, y);
        out.push({ x: Math.round(x), y: Math.round(y), inActive: !!(hit && active.contains(hit)), tag: hit ? hit.tagName + "." + (hit.className?.toString().slice(0, 30) ?? "") : "null" });
      }
      return JSON.stringify(out);
    })()`),
  );
  const misses = probes.filter((p) => !p.inActive);
  check(`B② ${label}：15 点 elementFromPoint 全命中活跃层（隐藏层不吃指针）`, misses.length === 0, misses.length ? JSON.stringify(misses) : "15/15");
  // ③ 终态截图 vs「只有活跃 tab」基线（隐藏层临时 display:none）逐像素 diff
  const shotA = await shot(`${shotPrefix}-settled`);
  await evalJs(`(() => {
    window.__hiddenLs = [...document.querySelectorAll("main.overflow-clip > .tab-layer")].filter((l) => l.dataset.active !== "true");
    window.__hiddenLs.forEach((l) => (l.style.display = "none"));
    return "none";
  })()`);
  await sleep(300);
  const shotB = await shot(`${shotPrefix}-baseline`);
  await evalJs(`window.__hiddenLs.forEach((l) => (l.style.display = "")); "restored"`);
  await sleep(300);
  const diff = await pixelDiff(shotA, shotB);
  check(
    `B③ ${label}：终态帧与「只有活跃 tab」基线逐像素一致（无组件半透明浮出）`,
    !diff.err && diff.pct < 0.05,
    JSON.stringify(diff),
  );
  return diff;
};

// 方向 1：重论文活跃 / 主页隐藏
await testTerminalClean(heavy.id, "论文活跃·主页隐藏", "ab-11-paper-active");
// 中途截图留档（交叉淡化行为，预期内）：切往主页 120ms 抓一帧
await storeCall(`S.getState().navigateToHome()`);
await sleep(120);
await shot("ab-12-mid-fade-to-home");
await sleep(1200);
// 方向 2：主页活跃 / 重论文隐藏
await testTerminalClean(null, "主页活跃·论文隐藏", "ab-13-home-active");

// ---------- C) 焦点隔离（opacity 模型） ----------
await storeCall(`S.getState().activateTab("${heavy.id}")`);
await sleep(1200);
await call("Page.bringToFront");
// 先点进活跃层确保焦点在文档内
const rect = JSON.parse(
  await evalJs(`(() => { const r = document.querySelector("main.overflow-clip").getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }); })()`),
);
await call("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
await sleep(200);
const focusProbe = async () =>
  JSON.parse(
    await evalJs(`(() => {
      const ae = document.activeElement;
      const layers = [...document.querySelectorAll("main.overflow-clip > .tab-layer")];
      const hiddenLs = layers.filter((l) => l.dataset.active !== "true");
      const inHidden = hiddenLs.some((l) => ae && l.contains(ae));
      const path = [];
      let n = ae;
      while (n && path.length < 5) { path.push(n.tagName + (n.className?.toString() ? "." + n.className.toString().slice(0, 24) : "")); n = n.parentElement; }
      return JSON.stringify({ inHidden, hasFocus: document.hasFocus(), path: path.join("<") });
    })()`),
  );
const pressTab = async (shift = false) => {
  const modifiers = shift ? 8 : 0; // 8 = Shift
  if (shift) await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 8 });
  await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, modifiers });
  await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, modifiers });
  if (shift) await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 0 });
};
let focusViolations = [];
const focusTrail = [];
for (let i = 0; i < 40; i++) {
  await pressTab(false);
  await sleep(30);
  const p = await focusProbe();
  if (i % 10 === 0 || p.inHidden) focusTrail.push(`tab${i + 1}:${p.path.slice(0, 80)}`);
  if (p.inHidden) focusViolations.push({ i: i + 1, ...p });
}
for (let i = 0; i < 10; i++) {
  await pressTab(true);
  await sleep(30);
  const p = await focusProbe();
  if (p.inHidden) focusViolations.push({ i: `shift-${i + 1}`, ...p });
}
check(
  "C Tab×40 + Shift+Tab×10 焦点永不落入隐藏层（inert 实证）",
  focusViolations.length === 0,
  focusViolations.length ? JSON.stringify(focusViolations).slice(0, 300) : focusTrail.join(" | "),
);

// ---------- 结果落盘 + 还原 ----------
const { writeFileSync, mkdirSync } = await import("node:fs");
mkdirSync(".tmp-motion-verify", { recursive: true });
writeFileSync(
  ".tmp-motion-verify/ab-results.json",
  JSON.stringify({ heavy, light, rounds: ROUNDS, wallData, wallStats, wallReduction, loafReduction, focusViolations }, null, 2),
);
// 还原：主题 / 模型（回默认 opacity）/ 活跃 tab / 视频
await evalJs(`(async () => { const T = (await import("/src/store/theme-store.ts")).useThemeStore; await T.getState().setGlobalTheme(${JSON.stringify(initialTheme || null)}); return "ok"; })()`);
await evalJs(`[...document.querySelectorAll("video")].forEach((v) => v.play().catch(() => {})); "play"`);
await setModel("opacity");
await evalJs(`document.documentElement.dataset.motion = ${JSON.stringify(initialMotion)}`);
if (initial.isHomeActive) await storeCall(`S.getState().navigateToHome()`);
else if (initial.activeTabId) await storeCall(`S.getState().activateTab("${initial.activeTabId}")`);
await evalJs(`location.hash = ${JSON.stringify(initialHash || "#/")}`);
await sleep(800);
await shot("ab-99-restored");

console.log("\n===== SUMMARY =====");
for (const r of results) console.log(r);
console.log(`\nVERDICT-DATA wallReduction=${wallReduction}% (tWall median ${wallMedianVis}→${wallMedianOp}ms) loafReduction=${loafReduction}%`);
ws.close();
process.exit(0);
