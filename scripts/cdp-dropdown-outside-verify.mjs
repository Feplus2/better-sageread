// 阅读器顶栏下拉「点空白不收起」CDP 实证 + 修复验证（dev 1420 + CDP 9223）。
// 用法：
//   node scripts/cdp-dropdown-outside-verify.mjs           # 事实采集（修复前取证）
//   ASSERT=1 node scripts/cdp-dropdown-outside-verify.mjs  # 断言模式（修复后验证，任一失败 exit 1）
// 每个用例记录：下拉是否打开、外点后宿主 document pointerdown 增量、iframe 中继消息、外点后是否仍开。
const LIST_URL = "http://127.0.0.1:9223/json/list";
const ASSERT = process.env.ASSERT === "1";
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
const pollUntil = async (fn, timeout = 4000, step = 200) => {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await fn();
    if (last) return last;
    await sleep(step);
  }
  return null;
};
const results = [];
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  const line = `${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`;
  results.push(line);
  console.log(line);
};

// store 调用走 async IIFE；模块 URL 从 resource 条目解析（vite HMR 版本串陷阱）
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
      activeTabId: s.activeTabId, slept: s.sleptTabIds });`),
  );

// 宿主探针：capture+bubble 双阶段统计 document pointerdown + 记录 iframe 中继消息类型
const installProbes = () =>
  evalJs(`(() => {
    if (window.__dp) return "already";
    window.__dp = { pd: 0, pdBub: 0, msgs: [] };
    document.addEventListener("pointerdown", () => window.__dp.pd++, true);
    document.addEventListener("pointerdown", () => window.__dp.pdBub++, false);
    window.addEventListener("message", (e) => {
      if (typeof e.data?.type === "string" && e.data.type.startsWith("iframe-")) window.__dp.msgs.push(e.data.type);
    });
    return "installed";
  })()`);
const resetProbes = () => evalJs(`(() => { window.__dp.pd = 0; window.__dp.pdBub = 0; window.__dp.msgs = []; return "reset"; })()`);
const readProbes = () => evalJs(`JSON.stringify({ pd: window.__dp.pd, pdBub: window.__dp.pdBub, msgs: window.__dp.msgs })`).then(JSON.parse);

const clickAt = async (x, y) => {
  await call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
};
const pressEsc = async () => {
  await call("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
};

// 活动 tab 层内的下拉触发器（radix DropdownMenuTrigger 带 aria-haspopup="menu"）
const triggerRect = async (index) =>
  evalJs(`(() => {
    const layer = document.querySelector("main.overflow-clip > .tab-layer[data-active='true']");
    if (!layer) return null;
    const btns = [...layer.querySelectorAll(".header-bar button[aria-haspopup='menu']")];
    const b = btns[${index}];
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2, count: btns.length });
  })()`).then((v) => (v ? JSON.parse(v) : null));
// 正文点击点：书籍 = foliate 视图（iframe 在 closed shadow root 内，只能按坐标点）；
// 论文 = .paper-content 所在滚动容器。菜单从顶栏下垂，toc 左对齐、其余右对齐（align=end），
// 故 toc 用例点右侧、其余点左侧，y 取中部，避开打开中的菜单。
const contentPoint = async (side) => {
  const xExpr = side === "right" ? "r.right - 40" : "r.left + 40";
  return evalJs(`(() => {
    const layer = document.querySelector("main.overflow-clip > .tab-layer[data-active='true']");
    if (!layer) return null;
    const fv = layer.querySelector("foliate-view");
    if (fv) {
      const r = fv.getBoundingClientRect();
      return JSON.stringify({ x: ${xExpr}, y: r.y + r.height / 2, kind: "iframe" });
    }
    const el = layer.querySelector(".paper-content")?.parentElement ?? layer.querySelector(".paper-content");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: ${xExpr}, y: r.y + r.height / 2, kind: "dom" });
  })()`).then((v) => (v ? JSON.parse(v) : null));
};
// 下拉检测用 role="menu"（radix DropdownMenuContent）；不能用 popper wrapper——TooltipContent 也是 popper
const dropdownOpen = async () => evalJs(`!!document.querySelector('[role="menu"]')`).then((v) => v === true);

// ---------- 前置：书 / 论文 tab ----------
const initial = await storeState();
console.log("INITIAL", JSON.stringify(initial));
for (const sleptId of initial.slept ?? []) {
  await storeCall(`S.getState().activateTab("${sleptId}")`);
  await sleep(1200);
}
await installProbes();

let bookTabId = initial.tabs.find((t) => t.type === "book")?.id ?? null;
if (!bookTabId) {
  await storeCall(`S.getState().navigateToHome()`);
  await evalJs(`location.hash = "#/"`);
  await pollUntil(() => evalJs(`!!document.querySelector('[data-region="book-card"]')`).then((v) => (v ? "y" : null)), 6000, 300);
  await evalJs(`(() => { document.querySelector('[data-region="book-card"]')?.click(); return "click"; })()`);
  bookTabId = await pollUntil(async () => {
    const st = await storeState();
    return st.tabs.find((x) => x.type === "book" && !initial.tabs.some((y) => y.id === x.id))?.id ?? null;
  }, 5000, 300);
}
let paperTabId = initial.tabs.find((t) => t.type === "paper")?.id ?? null;
if (!paperTabId) {
  // 无论文 tab 则开一篇（listPapers 取首篇，openPaper 建 tab）
  const paper = JSON.parse(
    await evalJs(`(async () => {
      const url = performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("/src/services/paper-service.ts")) ?? "/src/services/paper-service.ts";
      const P = await import(url);
      const list = await P.listPapers();
      const p = list?.[0];
      return JSON.stringify(p ? { id: p.id, title: (p.title ?? "paper").slice(0, 60) } : null);
    })()`),
  );
  if (paper) {
    await storeCall(`S.getState().openPaper("${paper.id}", ${JSON.stringify(paper.title)})`);
    paperTabId = await pollUntil(async () => {
      const st = await storeState();
      return st.tabs.find((x) => x.type === "paper")?.id ?? null;
    }, 5000, 300);
  }
  console.log("opened paper:", JSON.stringify(paper), "tabId=", paperTabId);
}
console.log("TABS book=", bookTabId, "paper=", paperTabId);

// ---------- 用例驱动 ----------
const BOOK_DROPDOWNS = ["toc", "search", "translate", "settings"];
const runDropdownCase = async (label, triggerIndex, { expectCloseOnOutside }) => {
  const trig = await triggerRect(triggerIndex);
  if (!trig) {
    check(`${label}: trigger 存在`, false, "not found");
    return;
  }
  await resetProbes();
  await clickAt(trig.x, trig.y);
  const opened = await pollUntil(() => dropdownOpen().then((v) => (v ? "open" : null)), 3000, 150);
  check(`${label}: 点 icon 打开`, !!opened);

  // 外点（书籍 = iframe 内；论文 = 正文 DOM）；toc 左对齐菜单→点右侧，其余右对齐→点左侧
  const pt = await contentPoint(triggerIndex === 0 ? "right" : "left");
  await resetProbes();
  await clickAt(pt.x, pt.y);
  await sleep(900); // 覆盖双击阈值延迟（iframe-single-click 延迟中继）
  const probes = await readProbes();
  const stillOpen = await dropdownOpen();
  const closed = !stillOpen;
  console.log(
    `  [fact] ${label}: kind=${pt.kind} 宿主pd(cap/bub)=${probes.pd}/${probes.pdBub} 中继=${probes.msgs.join(",") || "(无)"} 外点后仍开=${stillOpen}`,
  );
  if (expectCloseOnOutside) {
    check(`${label}: 点正文空白收起`, closed, `宿主pd(cap/bub)=${probes.pd}/${probes.pdBub}`);
  }
  return { closed, probes, ptKind: pt.kind };
};

const runSuite = async (tabId, names, { expectCloseOnOutside }) => {
  await storeCall(`S.getState().activateTab("${tabId}")`);
  const ready = await pollUntil(
    () => contentPoint("right").then((v) => (v ? "y" : null)),
    15000,
    500,
  );
  if (!ready) {
    check(`${names[0]}: 内容区就绪`, false);
    return;
  }
  // 清场：关掉上轮可能残留的菜单（Esc + 等待），避免初始状态污染
  await pressEsc();
  await sleep(400);
  if (await dropdownOpen()) {
    const t = await triggerRect(0);
    if (t) await clickAt(t.x, t.y);
    await sleep(400);
  }
  await sleep(300);
  for (let i = 0; i < names.length; i++) {
    await runDropdownCase(names[i], i, { expectCloseOnOutside });
  }
  // icon 互斥：开第 1 个再点第 2 个 → 旧收新起
  const t0 = await triggerRect(0);
  const t1 = await triggerRect(1);
  if (t0 && t1) {
    await clickAt(t0.x, t0.y);
    await pollUntil(() => dropdownOpen().then((v) => (v ? "o" : null)), 2000, 150);
    await clickAt(t1.x, t1.y);
    await sleep(400);
    const openNow = await dropdownOpen();
    check(`${names[0]}→${names[1]}: 点另一 icon 旧收新起`, openNow);
    // Esc 收起
    await pressEsc();
    const escClosed = await pollUntil(() => dropdownOpen().then((v) => (!v ? "closed" : null)), 2000, 150);
    check(`${names[1]}: Esc 收起`, !!escClosed);
  }
};

if (bookTabId) {
  await runSuite(bookTabId, BOOK_DROPDOWNS.map((n) => `书-${n}`), { expectCloseOnOutside: ASSERT });
}
if (paperTabId) {
  await runSuite(paperTabId, ["论文-toc", "论文-search", "论文-translate", "论文-settings"], {
    expectCloseOnOutside: ASSERT,
  });
} else {
  console.log("SKIP 论文侧：无可用论文");
}

console.log(`\n===== ${ASSERT ? "ASSERT" : "FACT"} 模式结果 =====`);
console.log(results.join("\n"));
if (ASSERT && failures > 0) process.exit(1);
process.exit(0);
