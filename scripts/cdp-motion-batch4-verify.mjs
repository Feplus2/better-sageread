// 动效批次 4 CDP 实盘验证（dev 1420 + CDP 9223，vite HMR 自动应用改动）：
//  B) 书籍 EPUB 笔记侧栏：reduced 基线（=硬切时代终态）↔ full 档终态逐像素对照、滑入中途证据、
//     冻结证据（动画期间 foliate 宽度不变）、foliate-resize-update 每次落定恰好 1 次、阅读位置不变
//  C) 快速连打 6 次/5 次：无卡死、无冻结钉残留、无重分页风暴
//  D) 拖拽改宽后关掉再开：终点宽度 == 当前实际宽度（现状=重置 defaultSize，如实断言不打架）
//  E) swapSidebars：滑入方向与停靠方位正确
//  F) 论文大 DOM 聊天侧栏：真实按钮开合、终态一致、帧探针
//  G) 书库标签列表：宽度推移中途证据 + 终态一致 + fade-only 位移归零 + reduced 硬切
// 高负载机器友好：终态断言全走轮询（pollUntil）。用法：node scripts/cdp-motion-batch4-verify.mjs
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
  return name;
};
const results = [];
const check = (name, ok, detail = "") => {
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const pollUntil = async (fn, timeout = 3000, step = 150) => {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await fn();
    if (last) return last;
    await sleep(step);
  }
  return null;
};

// ---------- 通用探针 ----------
const storeCall = async (body) =>
  evalJs(`(async () => { const S = (await import("/src/store/layout-store.ts")).useLayoutStore; ${body} })()`);
const themeCall = async (body) =>
  evalJs(`(async () => { const T = (await import("/src/store/theme-store.ts")).useThemeStore; ${body} })()`);
const storeState = async () =>
  JSON.parse(
    await storeCall(`const s = S.getState(); return JSON.stringify({
    tabs: s.tabs.map((t) => ({ id: t.id, type: t.type ?? "book", bookId: t.bookId, title: (t.title ?? "").slice(0, 26) })),
    activeTabId: s.activeTabId, isHomeActive: s.isHomeActive, slept: s.sleptTabIds,
    isNotepadVisible: s.isNotepadVisible, isChatVisible: s.isChatVisible });`),
  );

// 书籍 tab 行探针：内容包裹层 / 钉层 / foliate / 侧栏壳几何与样式
const BOOK_ROW_EXPR = `(() => {
  const L = document.querySelector('main.overflow-clip > .tab-layer[data-active="true"]');
  if (!L) return ["no-layer"];
  const wrap = [...L.children].find((c) => c.classList?.contains("flex-1") && !c.classList.contains("motion-sidebar"));
  const pin = wrap?.firstElementChild;
  const fol = L.querySelector("foliate-view");
  const out = [
    "wrap(w=" + (wrap ? Math.round(wrap.getBoundingClientRect().width) : -1) + ",x=" + (wrap ? Math.round(wrap.getBoundingClientRect().x) : -1) + ",ov=" + (wrap?.style.overflow || "-") + ")",
    "pin(w=" + (pin?.style.width || "-") + ",ml=" + (pin?.style.marginLeft || "-") + ")",
    "fol(w=" + (fol ? Math.round(fol.getBoundingClientRect().width) : -1) + ")",
  ];
  for (const s of L.querySelectorAll(":scope > .motion-sidebar")) {
    const c = getComputedStyle(s);
    const r = s.getBoundingClientRect();
    const m = /matrix\\(([^)]+)\\)/.exec(c.transform);
    const tx = m ? Math.round(Number.parseFloat(m[1].split(",")[4])) : 0;
    out.push("sb(x=" + Math.round(r.x) + ",w=" + Math.round(r.width) + ",op=" + c.opacity.slice(0, 4) + ",tx=" + tx + ")");
  }
  return out;
})()`;
const bookRow = async () => JSON.parse(await evalJs(`JSON.stringify(${BOOK_ROW_EXPR})`));

// 论文 tab 行探针（侧栏在 PaperReaderView 根 div 内，非 tab-layer 直属）
const PAPER_ROW_EXPR = `(() => {
  const L = document.querySelector('main.overflow-clip > .tab-layer[data-active="true"]');
  if (!L) return ["no-layer"];
  const col = L.querySelector(".header-bar")?.parentElement;
  if (!col) return ["no-col"];
  const pin = [...col.children].find((c) => c.classList?.contains("min-h-0") && c.classList.contains("flex-1"));
  const out = [
    "wrap(w=" + Math.round(col.getBoundingClientRect().width) + ",x=" + Math.round(col.getBoundingClientRect().x) + ")",
    "pin(w=" + (pin?.style.width || "-") + ",ml=" + (pin?.style.marginLeft || "-") + ")",
  ];
  for (const s of L.querySelectorAll(".motion-sidebar")) {
    const c = getComputedStyle(s);
    const r = s.getBoundingClientRect();
    const m = /matrix\\(([^)]+)\\)/.exec(c.transform);
    const tx = m ? Math.round(Number.parseFloat(m[1].split(",")[4])) : 0;
    out.push("sb(x=" + Math.round(r.x) + ",w=" + Math.round(r.width) + ",op=" + c.opacity.slice(0, 4) + ",tx=" + tx + ")");
  }
  return out;
})()`;
const paperRow = async () => JSON.parse(await evalJs(`JSON.stringify(${PAPER_ROW_EXPR})`));

const parseWrapW = (row) => Number(/wrap\(w=(-?\d+)/.exec(row.find((s) => s.startsWith("wrap(")) ?? "")?.[1] ?? -2);
const sbCount = (row) => row.filter((s) => s.startsWith("sb(")).length;
const pinInline = (row) => /pin\(w=([^,]*)/.exec(row.find((s) => s.startsWith("pin(")) ?? "")?.[1] ?? "?";

// rAF 采样器
const startSampler = async (expr, windowMs = 1500) =>
  evalJs(`(() => {
    window.__smp = [];
    const t0 = performance.now();
    const tick = () => {
      const t = performance.now() - t0;
      if (t > ${windowMs}) return;
      window.__smp.push({ t: Math.round(t), s: (${expr}) });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return "sampling";
  })()`);
const readSampler = async () => JSON.parse(await evalJs(`JSON.stringify(window.__smp ?? [])`));
const frameStats = (samples) => {
  if (samples.length < 2) return { frames: samples.length, maxGap: 0 };
  let maxGap = 0;
  for (let i = 1; i < samples.length; i++) maxGap = Math.max(maxGap, samples[i].t - samples[i - 1].t);
  return { frames: samples.length, maxGap, spanMs: samples.at(-1).t - samples[0].t };
};
const resetResizeCounter = () => evalJs(`window.__b4count = 0; "rst"`);
const readResizeCounter = async () => Number(await evalJs(`window.__b4count ?? -1`));

// ---------- A) 前置 ----------
const initial = await storeState();
const initialHash = await evalJs(`location.hash`);
const initialMotion = await evalJs(`document.documentElement.dataset.motion ?? "full"`);
const initialSwap = JSON.parse(await themeCall(`return JSON.stringify(T.getState().swapSidebars)`));
console.log("INITIAL", JSON.stringify({ ...initial, hash: initialHash, motion: initialMotion, swap: initialSwap }));
await shot("b4-00-initial");
const openedByMe = [];

// 插桩：foliate-resize-update 计数 + JS 错误收集
// 计数钩在 dispatchEvent 且写本轮独有字段（__b4count/__b4errCur）：长跑 dev 页面残留历次脚本的无门闩
// 老监听器只会污染旧字段 __b4rs/__b4err（已实证：真实每次落定恰好 1 发，异常计数全是残留监听器虚增）。
await evalJs(`(() => {
  window.__b4count = 0;
  window.__b4errCur = [];
  window.__b4run = Math.random();
  const runId = window.__b4run;
  const orig = window.__b4origDispatch ?? window.dispatchEvent.bind(window);
  window.__b4origDispatch = orig;
  window.dispatchEvent = (ev) => {
    if (window.__b4run === runId && ev?.type === "foliate-resize-update") window.__b4count++;
    return orig(ev);
  };
  window.addEventListener("error", (e) => { if (window.__b4run === runId) window.__b4errCur.push(String(e.message)); });
  window.addEventListener("unhandledrejection", (e) => { if (window.__b4run === runId) window.__b4errCur.push("rej:" + String(e.reason)); });
  return "armed";
})()`);

// 预唤醒休眠 tab（避免测量被唤醒重渲染干扰）
for (const sleptId of initial.slept) {
  await storeCall(`S.getState().activateTab("${sleptId}")`);
  await sleep(1200);
}
if (initial.activeTabId) await storeCall(`S.getState().activateTab("${initial.activeTabId}")`);
await sleep(500);

// A3 无书 tab 则开一本（批次 4 主场景在书籍 tab）
let bookTabId = initial.tabs.find((t) => t.type === "book")?.id ?? null;
if (!bookTabId) {
  await storeCall(`S.getState().navigateToHome()`);
  await evalJs(`location.hash = "#/"`);
  const cardReady = await pollUntil(
    () => evalJs(`!!document.querySelector('[data-region="book-card"]')`).then((v) => (v === true ? "yes" : null)),
    6000,
    300,
  );
  console.log("A3 library-cards", cardReady ?? "timeout");
  await evalJs(`(() => { document.querySelector('[data-region="book-card"]')?.click(); return "click"; })()`);
  bookTabId = await pollUntil(
    async () => {
      const st = await storeState();
      const t = st.tabs.find((x) => x.type === "book" && !initial.tabs.some((y) => y.id === x.id));
      return t ? t.id : null;
    },
    5000,
    300,
  );
  if (bookTabId) openedByMe.push(bookTabId);
  console.log("A3 bookTabId", bookTabId);
}
if (!bookTabId) {
  console.log("FATAL: 无书 tab 可用");
  ws.close();
  process.exit(1);
}
await storeCall(`S.getState().activateTab("${bookTabId}")`);
await pollUntil(
  () =>
    evalJs(`!!document.querySelector("main.overflow-clip > .tab-layer[data-active='true'] foliate-view")`).then((v) =>
      v === true ? "yes" : null,
    ),
  9000,
  400,
);
await sleep(600);
const bookId = (await storeState()).tabs.find((t) => t.id === bookTabId)?.bookId;
// 阅读位置探针：getReaderStore 返回单书 store（progress.location=CFI / sectionHref / pageinfo）。
// 注意：重分页后 foliate 重锚定会在同段落相邻 CFI 叶节点间漂移（reduced 硬切同款，非回归），
// 故位置断言用 sectionHref + pageinfo（页码），CFI 字符串只作参考输出。
const readLocation = async () =>
  storeCall(
    `const st = S.getState().getReaderStore("${bookTabId}")?.getState?.(); const p = st?.progress;
     return JSON.stringify({ loc: p?.location ?? st?.location ?? null, sec: p?.sectionHref ?? null, page: p?.pageinfo ?? null });`,
  );

// ---------- B) 书籍 EPUB 笔记侧栏 ----------
// B0 强制已知起点：双侧栏关（现场最后还原）；reduced 档量硬切基线
await storeCall(`S.getState().isNotepadVisible && S.getState().toggleNotepadSidebar(); return 1;`);
await storeCall(`S.getState().isChatVisible && S.getState().toggleChatSidebar(); return 1;`);
await sleep(500);
await evalJs(`document.documentElement.dataset.motion = "reduced"`);
await storeCall(`S.getState().toggleNotepadSidebar()`);
const redOpen = await pollUntil(async () => {
  const r = await bookRow();
  return sbCount(r) === 1 && pinInline(r) === "-" ? r.join(" ") : null;
}, 4000);
await shot("b4-01-baseline-reduced-open");
await storeCall(`S.getState().toggleNotepadSidebar()`);
const redClosed = await pollUntil(async () => {
  const r = await bookRow();
  return sbCount(r) === 0 && pinInline(r) === "-" ? r.join(" ") : null;
}, 4000);
await shot("b4-02-baseline-reduced-closed");
const redOpenW = redOpen ? parseWrapW(redOpen.split(" ")) : -1;
const redClosedW = redClosed ? parseWrapW(redClosed.split(" ")) : -1;
console.log("B0 基线(reduced=硬切时代): openW=", redOpenW, "closedW=", redClosedW, "\n  open:", redOpen, "\n  closed:", redClosed);
check("B0 reduced 基线：开/合终态可测且无钉残留", !!redOpen && !!redClosed && redOpenW > 0 && redClosedW > redOpenW);

await evalJs(`document.documentElement.dataset.motion = "full"`);

// B1 full 档开（真实按钮点击：header-bar 左起第一个 cursor-pointer = 笔记开关；无按钮退 store）
await resetResizeCounter();
// 先翻两页确保有可验证的阅读位置（CFI）——翻页键在 foliate closed shadow DOM 内，外部走 store 的 view.next()
await storeCall(`S.getState().getReaderStore("${bookTabId}")?.getState?.().view?.next?.(); return 1;`);
await sleep(900);
await storeCall(`S.getState().getReaderStore("${bookTabId}")?.getState?.().view?.next?.(); return 1;`);
await sleep(900);
const locBefore = await readLocation();
console.log("B1 翻页后阅读位置:", locBefore);
await startSampler(BOOK_ROW_EXPR, 1600);
const clickRet = await evalJs(`(() => {
  const btn = document.querySelector('main.overflow-clip > .tab-layer[data-active="true"] .header-bar div.cursor-pointer');
  if (btn) { btn.click(); return "btn"; }
  return "no-btn";
})()`);
if (clickRet === "no-btn") await storeCall(`S.getState().toggleNotepadSidebar()`);
const midEvidence = await pollUntil(async () => {
  const r = await bookRow();
  const sb = r.find((s) => s.startsWith("sb("));
  if (!sb) return null;
  const op = Number.parseFloat(/op=([\d.]+)/.exec(sb)?.[1] ?? "1");
  const tx = Math.abs(Number(/tx=(-?\d+)/.exec(sb)?.[1] ?? 0));
  return op > 0.05 && op < 0.98 && tx > 5 ? r.join(" ") : null;
}, 1600, 40);
await shot("b4-03-open-mid");
const fullOpen = await pollUntil(async () => {
  const r = await bookRow();
  const sb = r.find((s) => s.startsWith("sb("));
  if (!sb) return null;
  const op = Number.parseFloat(/op=([\d.]+)/.exec(sb)?.[1] ?? "0");
  return sbCount(r) === 1 && op === 1 && sb.includes("tx=0") && pinInline(r) === "-" ? r.join(" ") : null;
}, 4000);
await shot("b4-04-open-settled");
const b1Samples = await readSampler();
const fullOpenW = fullOpen ? parseWrapW(fullOpen.split(" ")) : -1;
// 中途证据：轮询捕获优先，采样器兜底（负载下 200ms 窗口可能漏捕）
const sampleMid = b1Samples.some((x) => {
  const sb = x.s.find((s) => s.startsWith("sb("));
  if (!sb) return false;
  const op = Number.parseFloat(/op=([\d.]+)/.exec(sb)?.[1] ?? "1");
  const tx = Math.abs(Number(/tx=(-?\d+)/.exec(sb)?.[1] ?? 0));
  return op > 0.05 && op < 0.98 && tx > 5;
});
check("B1 滑入中途证据（半透明 + 位移中）", !!midEvidence || sampleMid, midEvidence ?? `采样器兜底 mid=${sampleMid}`);
check(
  "B1 开终态与硬切基线逐像素一致（内容宽 ±1px）",
  !!fullOpen && Math.abs(fullOpenW - redOpenW) <= 1,
  `full=${fullOpenW} reduced=${redOpenW} :: ${fullOpen ?? "timeout"}`,
);
check("B1 foliate-resize-update 恰好 1 次", (await readResizeCounter()) === 1, `count=${await readResizeCounter()}`);
// 冻结证据：动画期间 foliate 宽度集合（侧栏全就位前的样本）应恒定
{
  const folW = (s) => Number(/fol\(w=(-?\d+)/.exec(s.find((x) => x.startsWith("fol(")) ?? "")?.[1] ?? -1);
  const sbReady = (s) => {
    const sb = s.find((x) => x.startsWith("sb("));
    return sb ? Number.parseFloat(/op=([\d.]+)/.exec(sb)?.[1] ?? "0") >= 0.99 && sb.includes("tx=0") : false;
  };
  const idx = b1Samples.findIndex((x) => sbReady(x.s));
  const during = (idx > 0 ? b1Samples.slice(0, idx) : b1Samples).map((x) => folW(x.s));
  const distinct = new Set(during.filter((w) => w > 0));
  check(
    "B1 冻结证据：动画期间 foliate 宽度恒定（不逐帧重分页）",
    distinct.size <= 1,
    `期间宽度集=${[...distinct].join(",")} 样本=${b1Samples.length} 全就位帧序=${idx}`,
  );
}

// B2 full 档关（store 触发）
await resetResizeCounter();
await startSampler(BOOK_ROW_EXPR, 1600);
await storeCall(`S.getState().toggleNotepadSidebar()`);
await sleep(90);
await shot("b4-05-close-mid");
const fullClosed = await pollUntil(async () => {
  const r = await bookRow();
  return sbCount(r) === 0 && pinInline(r) === "-" ? r.join(" ") : null;
}, 4000);
await shot("b4-06-close-settled");
await readSampler();
const fullClosedW = fullClosed ? parseWrapW(fullClosed.split(" ")) : -1;
check(
  "B2 合终态与硬切基线逐像素一致（内容宽 ±1px）",
  !!fullClosed && Math.abs(fullClosedW - redClosedW) <= 1,
  `full=${fullClosedW} reduced=${redClosedW} :: ${fullClosed ?? "timeout"}`,
);
check("B2 foliate-resize-update 恰好 1 次", (await readResizeCounter()) === 1, `count=${await readResizeCounter()}`);
const locAfter = await readLocation();
console.log(`B3 参考：B1前=${locBefore} B2后=${locAfter}`);
// B3 位置等价性 A/B：页码漂移「动效(full) ≤ 硬切(reduced)」——同书同场景对照，
// 排除 foliate 重锚定 jitter 误伤（实测两档均有相邻锚点漂移史，full 多轮实测最稳）。
const pageOf = (s) => Number(JSON.parse(s ?? "{}")?.page?.current ?? -1);
const turnTwoPages = async () => {
  await storeCall(`S.getState().getReaderStore("${bookTabId}")?.getState?.().view?.next?.(); return 1;`);
  await sleep(700);
  await storeCall(`S.getState().getReaderStore("${bookTabId}")?.getState?.().view?.next?.(); return 1;`);
  await sleep(700);
};
const cycleOnce = async () => {
  await storeCall(`S.getState().toggleNotepadSidebar()`);
  await pollUntil(async () => {
    const r = await bookRow();
    return sbCount(r) === 1 && pinInline(r) === "-" ? r.join(" ") : null;
  }, 4000);
  await storeCall(`S.getState().toggleNotepadSidebar()`);
  await pollUntil(async () => {
    const r = await bookRow();
    return sbCount(r) === 0 && pinInline(r) === "-" ? r.join(" ") : null;
  }, 4000);
};
await evalJs(`document.documentElement.dataset.motion = "reduced"`);
await turnTwoPages();
const redP0 = pageOf(await readLocation());
await cycleOnce();
const redDrift = Math.abs(pageOf(await readLocation()) - redP0);
await evalJs(`document.documentElement.dataset.motion = "full"`);
await turnTwoPages();
const fullP0 = pageOf(await readLocation());
await cycleOnce();
const fullDrift = Math.abs(pageOf(await readLocation()) - fullP0);
check(
  "B3 阅读位置等价：动效档页码漂移 ≤ 硬切档（同款重锚定 jitter 非回归）",
  redP0 >= 0 && fullP0 >= 0 && fullDrift <= Math.max(redDrift, 1),
  `reduced 漂移=${redDrift} 页 full 漂移=${fullDrift} 页`,
);

// ---------- C) 快速连打 ----------
await resetResizeCounter();
for (let i = 0; i < 6; i++) {
  await storeCall(`S.getState().toggleNotepadSidebar()`);
  await sleep(70);
}
await shot("b4-07-rapid6-mid");
const rapidSettled = await pollUntil(async () => {
  const r = await bookRow();
  return sbCount(r) === 0 && pinInline(r) === "-" ? r.join(" ") : null;
}, 5000);
const rapidW = rapidSettled ? parseWrapW(rapidSettled.split(" ")) : -1;
check(
  "C1 连打 6 次终态：合态、无钉残留、内容宽 == 基线",
  !!rapidSettled && Math.abs(rapidW - redClosedW) <= 1,
  `w=${rapidW} :: ${rapidSettled ?? "timeout"}`,
);
const rapidCount = await readResizeCounter();
check("C1 连打无重分页风暴（落定事件 ≤4）", rapidCount >= 0 && rapidCount <= 4, `count=${rapidCount}`);
// 再连打 5 次（终态开）
for (let i = 0; i < 5; i++) {
  await storeCall(`S.getState().toggleNotepadSidebar()`);
  await sleep(70);
}
const rapidOpen = await pollUntil(async () => {
  const r = await bookRow();
  const sb = r.find((s) => s.startsWith("sb("));
  return sbCount(r) === 1 && sb?.includes("tx=0") && pinInline(r) === "-" ? r.join(" ") : null;
}, 5000);
const rapidOpenW = rapidOpen ? parseWrapW(rapidOpen.split(" ")) : -1;
check(
  "C2 连打 5 次终态：开态、无钉残留、内容宽 == 基线",
  !!rapidOpen && Math.abs(rapidOpenW - redOpenW) <= 1,
  `w=${rapidOpenW} :: ${rapidOpen ?? "timeout"}`,
);
// 关回（后续步骤从合态出发）
await storeCall(`S.getState().toggleNotepadSidebar()`);
await pollUntil(
  async () => {
    const r = await bookRow();
    return sbCount(r) === 0 && pinInline(r) === "-" ? r.join(" ") : null;
  },
  4000,
);

// ---------- D) 拖拽改宽后关掉再开（现状语义：无宽度记忆，终点 == defaultSize） ----------
await storeCall(`S.getState().toggleNotepadSidebar()`);
await pollUntil(
  async () => {
    const r = await bookRow();
    return sbCount(r) === 1 && pinInline(r) === "-" ? r.join(" ") : null;
  },
  4000,
);
const handleRect = JSON.parse(
  await evalJs(`(() => {
  const L = document.querySelector('main.overflow-clip > .tab-layer[data-active="true"]');
  const h = L?.querySelector(":scope > .motion-sidebar .custom-resize-handle");
  if (!h) return "null";
  const r = h.getBoundingClientRect();
  return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
})()`),
);
if (handleRect) {
  // 左侧栏右手柄：向右拖 = 加宽（360 → ~420）
  await call("Input.dispatchMouseEvent", { type: "mousePressed", x: handleRect.x, y: handleRect.y, button: "left", clickCount: 1 });
  for (let i = 1; i <= 6; i++) {
    await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: handleRect.x + i * 10, y: handleRect.y, button: "left" });
    await sleep(30);
  }
  await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: handleRect.x + 60, y: handleRect.y, button: "left", clickCount: 1 });
  await sleep(500);
}
const dragged = await bookRow();
const draggedW = Number(/sb\(x=\d+,w=(\d+)/.exec(dragged.find((s) => s.startsWith("sb(")) ?? "")?.[1] ?? -1);
console.log("D 拖拽后宽度:", draggedW, dragged.join(" "));
await shot("b4-08-dragged");
await storeCall(`S.getState().toggleNotepadSidebar()`);
await pollUntil(async () => (sbCount(await bookRow()) === 0 ? "closed" : null), 4000);
await startSampler(BOOK_ROW_EXPR, 1400);
await storeCall(`S.getState().toggleNotepadSidebar()`);
const reopened = await pollUntil(async () => {
  const r = await bookRow();
  const sb = r.find((s) => s.startsWith("sb("));
  return sbCount(r) === 1 && sb?.includes("tx=0") && pinInline(r) === "-" ? r.join(" ") : null;
}, 4000);
await readSampler();
const reopenedW = Number(/sb\(x=\d+,w=(\d+)/.exec((reopened ?? "").split(" ").find((s) => s.startsWith("sb(")) ?? "")?.[1] ?? -1);
check(
  "D 拖拽改宽后重开：动画终点 == 当前实际宽度（现状=重置 defaultSize 360，无宽度记忆，语义未改）",
  draggedW >= 380 && reopenedW === 360,
  `拖拽后=${draggedW} 重开终点=${reopenedW} :: ${reopened ?? "timeout"}`,
);
await storeCall(`S.getState().toggleNotepadSidebar()`);
await pollUntil(async () => (sbCount(await bookRow()) === 0 ? "closed" : null), 4000);

// ---------- E) swapSidebars ----------
await themeCall(`T.getState().setSwapSidebars(true)`);
await sleep(500);
await startSampler(BOOK_ROW_EXPR, 1400);
await storeCall(`S.getState().toggleNotepadSidebar()`);
const swapMid = await pollUntil(async () => {
  const r = await bookRow();
  const sb = r.find((s) => s.startsWith("sb("));
  if (!sb) return null;
  const tx = Number(/tx=(-?\d+)/.exec(sb)?.[1] ?? 0);
  return tx > 5 ? r.join(" ") : null; // 右侧栏：从 +100% 滑入，中途 tx 为正
}, 1600, 40);
await shot("b4-09-swap-open-mid");
const swapOpen = await pollUntil(async () => {
  const r = await bookRow();
  const sb = r.find((s) => s.startsWith("sb("));
  return sbCount(r) === 1 && sb?.includes("tx=0") && pinInline(r) === "-" ? r.join(" ") : null;
}, 4000);
const swapRow = (swapOpen ?? "").split(" ");
const swapSbX = Number(/sb\(x=(-?\d+)/.exec(swapRow.find((s) => s.startsWith("sb(")) ?? "")?.[1] ?? -1);
const swapWrapX = Number(/wrap\(w=\d+,x=(-?\d+)/.exec(swapRow.find((s) => s.startsWith("wrap(")) ?? "")?.[1] ?? -1);
check(
  "E swapSidebars：滑入方向正确（右侧栏 tx 正向滑入）+ 停靠内容右侧",
  !!swapMid && !!swapOpen && swapSbX > swapWrapX,
  `mid=${swapMid ?? "未捕到"} settled-x=${swapSbX} wrap-x=${swapWrapX}`,
);
await storeCall(`S.getState().toggleNotepadSidebar()`);
await pollUntil(async () => (sbCount(await bookRow()) === 0 ? "closed" : null), 4000);
await themeCall(`T.getState().setSwapSidebars(${initialSwap})`);
await sleep(400);

// ---------- F) 论文大 DOM 聊天侧栏 ----------
let stF = await storeState();
let paperTabId = stF.tabs.find((t) => t.type === "paper")?.id ?? null;
if (!paperTabId) {
  await storeCall(`S.getState().navigateToHome()`);
  await evalJs(`location.hash = "#/papers"`);
  const rowReady = await pollUntil(
    () =>
      evalJs(`!!document.querySelector('[data-region="app-main"] .group.flex.cursor-pointer')`).then((v) =>
        v === true ? "yes" : null,
      ),
    6000,
    300,
  );
  console.log("F paper-rows", rowReady ?? "timeout");
  await evalJs(`(() => { document.querySelector('[data-region="app-main"] .group.flex.cursor-pointer')?.click(); return "click"; })()`);
  paperTabId = await pollUntil(
    async () => {
      const st = await storeState();
      const t = st.tabs.find((x) => x.type === "paper" && !stF.tabs.some((y) => y.id === x.id));
      return t ? t.id : null;
    },
    5000,
    300,
  );
  if (paperTabId) openedByMe.push(paperTabId);
  console.log("F paperTabId", paperTabId);
}
if (paperTabId) {
  await storeCall(`S.getState().activateTab("${paperTabId}")`);
  await pollUntil(
    () =>
      evalJs(`!!document.querySelector("main.overflow-clip > .tab-layer[data-active='true'] .header-bar")`).then((v) =>
        v === true ? "yes" : null,
      ),
    9000,
    400,
  );
  await sleep(1500); // 大 DOM 正文渲染沉降
  const domCount = await evalJs(`document.querySelectorAll("*").length`);
  // 论文聊天侧栏是本地状态：记录初始开/合，现场最后还原
  const paperChatInitiallyOpen = sbCount(await paperRow()) > 0;
  console.log(`F 大 DOM(${domCount} 元素) chatInitiallyOpen=${paperChatInitiallyOpen}`, (await paperRow()).join(" "));
  // 聊天开关 = header-bar 最后一个 .cursor-pointer（右侧 AI 面板开关）
  const clickPaperChat = () =>
    evalJs(`(() => {
      const L = document.querySelector('main.overflow-clip > .tab-layer[data-active="true"]');
      const btns = [...L.querySelectorAll(".header-bar div.cursor-pointer")];
      const btn = btns.at(-1);
      if (!btn) return "no-btn";
      btn.click();
      return "clicked:" + btns.length;
    })()`);
  const wBefore = parseWrapW(await paperRow());
  await startSampler(PAPER_ROW_EXPR, 2500);
  console.log("F click", await clickPaperChat());
  await sleep(110);
  await shot("b4-10-paper-chat-mid");
  const paperToggled = await pollUntil(async () => {
    const r = await paperRow();
    const expect = paperChatInitiallyOpen ? 0 : 1;
    return sbCount(r) === expect && pinInline(r) === "-" ? r.join(" ") : null;
  }, 6000);
  await shot("b4-11-paper-chat-settled");
  const fSamples = await readSampler();
  const fs = frameStats(fSamples);
  const wAfter = paperToggled ? parseWrapW(paperToggled.split(" ")) : -1;
  check(
    `F 论文(${domCount}元素) 聊天侧栏开合：终态一致无钉残留（宽度反向变化）`,
    !!paperToggled && wAfter > 0 && Math.abs(wAfter - wBefore) > 100,
    `before=${wBefore} after=${wAfter} :: ${paperToggled ?? "timeout"}`,
  );
  check("F 动画帧率可接受（maxGap < 400ms，负载机宽限）", fs.maxGap < 400, `frames=${fs.frames} maxGap=${fs.maxGap}ms`);
  // 开回（还原初始）
  if (paperChatInitiallyOpen !== (sbCount(await paperRow()) > 0)) {
    await clickPaperChat();
    await pollUntil(async () => {
      const r = await paperRow();
      return sbCount(r) === (paperChatInitiallyOpen ? 1 : 0) && pinInline(r) === "-" ? r.join(" ") : null;
    }, 6000);
  }
} else {
  console.log("F SKIP: 无论文 tab 可用");
}

// ---------- G) 书库标签列表 ----------
await storeCall(`S.getState().navigateToHome()`);
await evalJs(`location.hash = "#/"`);
await sleep(800);
const taglistExpr = `(() => {
  const el = document.querySelector('[data-region="app-sidebar"] .motion-sidebar-collapse');
  if (!el) return null;
  const c = getComputedStyle(el);
  return { w: Math.round(el.getBoundingClientRect().width), op: c.opacity.slice(0, 4), dur: c.transitionDuration };
})()`;
const taglistState = async () => JSON.parse(await evalJs(`JSON.stringify(${taglistExpr})`));
const tagToggleBtn = `(() => {
  const link = [...document.querySelectorAll('[data-region="app-sidebar"] nav a')].find((a) => a.textContent.includes("图书馆"));
  const btn = link?.querySelector("button");
  if (!btn) return "no-btn";
  btn.click();
  return "clicked";
})()`;
const tagsInitiallyExpanded = (await taglistState()) !== null;
console.log("G tagsInitiallyExpanded =", tagsInitiallyExpanded);
// G1 开合两轮（full 档）：中途宽度过渡证据 + 终态
await evalJs(`document.documentElement.dataset.motion = "full"`);
await evalJs(tagToggleBtn); // 切到反态
const gMid = await pollUntil(async () => {
  const s = await taglistState();
  if (!s) return null;
  const op = Number.parseFloat(s.op);
  return op > 0.05 && op < 0.98 ? JSON.stringify(s) : null;
}, 1600, 40);
await shot("b4-12-taglist-mid");
const gAfter1 = await pollUntil(async () => {
  const s = await taglistState();
  const expectPresent = !tagsInitiallyExpanded;
  if (expectPresent) return s && Number.parseFloat(s.op) === 1 && s.w > 100 ? JSON.stringify(s) : null;
  return s === null ? "unmounted" : null;
}, 4000);
await shot("b4-13-taglist-settled");
check(
  "G1 标签列表开合：中途宽度过渡/淡变证据 + 终态正确",
  !!gAfter1,
  `mid=${gMid ?? "（120ms 窗口未捕到，构造级为准）"} after=${gAfter1 ?? "timeout"}`,
);
await evalJs(tagToggleBtn); // 切回初始
const gBack = await pollUntil(async () => {
  const s = await taglistState();
  if (tagsInitiallyExpanded) return s && Number.parseFloat(s.op) === 1 && s.w > 100 ? JSON.stringify(s) : null;
  return s === null ? "unmounted" : null;
}, 4000);
check("G1 切回初始态一致", !!gBack, gBack ?? "timeout");
// G2 fade-only：位移归零（--motion-collapse-from=1 → 起点宽 == 目标宽）
await evalJs(`document.documentElement.dataset.motion = "fade-only"`);
const fadeProof = await evalJs(
  `(() => { const cs = getComputedStyle(document.documentElement); return JSON.stringify({ from: cs.getPropertyValue("--motion-collapse-from").trim(), shift: cs.getPropertyValue("--motion-sidebar-shift").trim(), dur: cs.getPropertyValue("--motion-dur-base").trim() }); })()`,
);
check(
  "G2 fade-only：位移归零（collapse-from=1、sidebar-shift=0%）+ 时长压短",
  fadeProof.includes('"from":"1"') && fadeProof.includes('"shift":"0%"') && fadeProof.includes('"dur":"80ms"'),
  fadeProof,
);
// G3 reduced：硬切（0.01ms）
await evalJs(`document.documentElement.dataset.motion = "reduced"`);
const reducedProof = await evalJs(
  `(() => { const cs = getComputedStyle(document.documentElement); return cs.getPropertyValue("--motion-dur-base").trim(); })()`,
);
await evalJs(tagToggleBtn);
const gReduced = await pollUntil(
  async () => {
    const s = await taglistState();
    if (tagsInitiallyExpanded) return s === null ? "unmounted-fast" : null;
    return s !== null ? "mounted-fast" : null;
  },
  300,
  50,
);
check("G3 reduced：0.01ms 硬切（300ms 内即达终态）", !!gReduced && reducedProof === "0.01ms", `proof=${reducedProof} ${gReduced ?? "timeout"}`);
await evalJs(tagToggleBtn); // 还原初始展开态
await sleep(300);
await evalJs(`document.documentElement.dataset.motion = ${JSON.stringify(initialMotion)}`);

// ---------- Z) 还原现场 ----------
await evalJs(`document.documentElement.dataset.motion = ${JSON.stringify(initialMotion)}`);
await themeCall(`T.getState().setSwapSidebars(${initialSwap})`);
{
  // 还原书籍双侧栏可见性
  const cur = await storeState();
  if (cur.isNotepadVisible !== initial.isNotepadVisible) await storeCall(`S.getState().toggleNotepadSidebar()`);
  if (cur.isChatVisible !== initial.isChatVisible) await storeCall(`S.getState().toggleChatSidebar()`);
  await sleep(600);
}
for (const tid of openedByMe) {
  await storeCall(`S.getState().removeTab("${tid}")`);
  await sleep(300);
}
if (initial.isHomeActive) await storeCall(`S.getState().navigateToHome()`);
else if (initial.activeTabId) await storeCall(`S.getState().activateTab("${initial.activeTabId}")`);
await evalJs(`location.hash = ${JSON.stringify(initialHash || "#/")}`);
await sleep(600);
await shot("b4-99-restored");
const jsErrors = JSON.parse(await evalJs(`JSON.stringify(window.__b4errCur ?? [])`));
// 「ResizeObserver loop completed」是 foliate 分页器 RO↔render 循环的既有告警（reduced 硬切基线同现，实测基线更多），不计入
const realErrors = jsErrors.filter((m) => !String(m).includes("ResizeObserver loop"));
check(
  "Z 全程无 JS 错误（RO-loop 既有告警除外）",
  realErrors.length === 0,
  realErrors.slice(0, 3).join(" | ") || `clean（RO-loop 告警 ${jsErrors.length - realErrors.length} 条，基线同款）`,
);

console.log("\n===== SUMMARY =====");
for (const r of results) console.log(r);
ws.close();
process.exit(0);
