// 小项 3 CDP 实证：垂直标签栏栏末「关闭所有标签页」（dev 1420 + CDP 9223）
//  1) 窄条栏末图标按钮（aria-label）+ 悬停浮层页脚行存在
//  2) 点击 → 轻确认框（AlertDialog）；取消 → 无副作用
//  3) 确认 → 关闭全部阅读 tab（书+论文）回主页：tabs/activeTabId/slept/readerStores 全清，DOM 层尽卸
//  4) 现场还原：按快照重开原 tab 集合并恢复活跃 tab（openBook/openPaper 幂等同 id）
// 用法：node scripts/cdp-close-all-verify.mjs
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
  mkdirSync(".tmp-close-all", { recursive: true });
  writeFileSync(`.tmp-close-all/${name}.png`, Buffer.from(res.data, "base64"));
  return name;
};
const results = [];
const check = (name, ok, detail = "") => {
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
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
const storeCall = async (body) =>
  evalJs(`(async () => {
    const url = performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("/src/store/layout-store.ts")) ?? "/src/store/layout-store.ts";
    const S = (await import(url)).useLayoutStore;
    ${body}
  })()`);

// ---------- 0) 快照现场（含方向，须为垂直） ----------
const snap = JSON.parse(
  await storeCall(`const s = S.getState(); return JSON.stringify({
  tabs: s.tabs.map((t) => ({ bookId: t.bookId, title: t.title, type: t.type ?? "book" })),
  activeTabId: s.activeTabId, isHomeActive: s.isHomeActive, orientation: s.tabOrientation });`),
);
console.log("SNAPSHOT", JSON.stringify(snap));
if (snap.tabs.length === 0) {
  console.error("SKIP: 无 tab");
  process.exit(1);
}
if (snap.orientation !== "vertical") {
  await storeCall(`S.getState().toggleTabOrientation()`);
  await sleep(400);
}

// ---------- 1) 按钮存在性：窄条栏末图标 + 浮层页脚行 ----------
const stripBtn = await evalJs(
  `!!document.querySelector('[data-region="vertical-tabs"] button[aria-label="关闭所有标签页"]')`,
);
check("窄条栏末图标按钮存在（aria-label + SquareX 图标）", stripBtn === true, String(stripBtn));
// 悬停展开浮层（React onMouseEnter 由 mouseover 合成）
await evalJs(`(() => {
  const strip = document.querySelector('[data-region="vertical-tabs"]');
  strip.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  return "hover";
})()`);
const overlayFooter = await pollUntil(
  async () => {
    const v = await evalJs(`(() => {
    const strip = document.querySelector('[data-region="vertical-tabs"]');
    const rows = [...strip.querySelectorAll("button")].filter((b) => b.textContent.trim() === "关闭所有标签页");
    return rows.length > 0 ? "found" : null;
  })()`);
    return v;
  },
  3000,
  150,
);
check("悬停浮层页脚「关闭所有标签页」行存在", !!overlayFooter, overlayFooter ?? "timeout");
await shot("closeall-01-bar-footer");

// ---------- 2) 点击 → 轻确认框；取消无副作用 ----------
await evalJs(`(() => {
  const strip = document.querySelector('[data-region="vertical-tabs"]');
  const row = [...strip.querySelectorAll("button")].find((b) => b.textContent.trim() === "关闭所有标签页");
  row?.click();
  return "clicked";
})()`);
const dialogUp = await pollUntil(
  () => evalJs(`!!document.querySelector('[role="alertdialog"]')`).then((v) => (v === true ? "yes" : null)),
  3000,
  150,
);
check("点击后弹出轻确认框（AlertDialog）", !!dialogUp, dialogUp ?? "timeout");
const dialogText = await evalJs(`document.querySelector('[role="alertdialog"]')?.textContent ?? ""`);
check(
  "确认框文案含 tab 数量与进度保留说明",
  dialogText.includes(`${snap.tabs.length} 个阅读标签页`) && dialogText.includes("不会丢失"),
  dialogText.slice(0, 90),
);
await shot("closeall-02-confirm");
// 取消
await evalJs(`(() => {
  const dlg = document.querySelector('[role="alertdialog"]');
  [...dlg.querySelectorAll("button")].find((b) => b.textContent.trim() === "取消")?.click();
  return "cancel";
})()`);
await sleep(400);
const afterCancel = JSON.parse(
  await storeCall(`const s = S.getState(); return JSON.stringify({ n: s.tabs.length, active: s.activeTabId })`),
);
check(
  "取消后 tab 集合不变",
  afterCancel.n === snap.tabs.length && afterCancel.active === snap.activeTabId,
  JSON.stringify(afterCancel),
);

// ---------- 3) 确认 → 全部关闭回主页 ----------
await evalJs(`(() => {
  const strip = document.querySelector('[data-region="vertical-tabs"]');
  strip.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  const row = [...strip.querySelectorAll("button")].find((b) => b.textContent.trim() === "关闭所有标签页");
  row?.click();
  return "clicked";
})()`);
await pollUntil(
  () => evalJs(`!!document.querySelector('[role="alertdialog"]')`).then((v) => (v === true ? "yes" : null)),
  3000,
  150,
);
await evalJs(`(() => {
  const dlg = document.querySelector('[role="alertdialog"]');
  [...dlg.querySelectorAll("button")].find((b) => b.textContent.trim() === "全部关闭")?.click();
  return "confirmed";
})()`);
const closed = await pollUntil(
  async () => {
    const st = JSON.parse(
      await storeCall(`const s = S.getState(); return JSON.stringify({
      tabs: s.tabs.length, active: s.activeTabId, home: s.isHomeActive, slept: s.sleptTabIds.length, stores: s.readerStores.size });`),
    );
    return st.tabs === 0 && st.active === null && st.home === true && st.slept === 0 && st.stores === 0 ? st : null;
  },
  4000,
  200,
);
check("确认后 tabs/activeTabId/slept/readerStores 全清且回主页", !!closed, JSON.stringify(closed));
const domLayers = await evalJs(`(() => {
  const layers = [...document.querySelectorAll("main.overflow-clip > .tab-layer")];
  return JSON.stringify({ total: layers.length, activeHome: layers.filter((l) => l.dataset.active === "true").length });
})()`);
const dl = JSON.parse(domLayers);
check("DOM 只剩主页层且为活跃（阅读层尽卸）", dl.total === 1 && dl.activeHome === 1, domLayers);
await shot("closeall-03-all-closed");

// ---------- 4) 还原现场 ----------
for (const t of snap.tabs) {
  await storeCall(
    `S.getState().${t.type === "paper" ? "openPaper" : "openBook"}(${JSON.stringify(t.bookId)}, ${JSON.stringify(t.title)})`,
  );
  await sleep(120);
}
if (snap.activeTabId) await storeCall(`S.getState().activateTab("${snap.activeTabId}")`);
else await storeCall(`S.getState().navigateToHome()`);
const restored = await pollUntil(
  async () => {
    const st = JSON.parse(
      await storeCall(
        `const s = S.getState(); return JSON.stringify({ ids: s.tabs.map((t) => t.id), active: s.activeTabId })`,
      ),
    );
    const expectIds = snap.tabs.map((t) => `${t.type === "paper" ? "paper" : "reader"}-${t.bookId}`);
    return st.ids.length === snap.tabs.length && expectIds.every((id) => st.ids.includes(id)) ? st : null;
  },
  5000,
  250,
);
check("现场还原：原 tab 集合按同 id 重开", !!restored, restored ? `tabs=${restored.ids.length}` : "timeout");
await shot("closeall-04-restored");

console.log("\n===== SUMMARY =====");
for (const r of results) console.log(r);
ws.close();
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
