// 小项 1 CDP 实证：论文 TOC 元数据标题转跳修复（dev 1420 + CDP 9223）
//  1) 元数据区 h1 带稳定 id（paper-metadata-title）进 TOC
//  2) TOC 下拉里标题出现两遍（元数据 + 正文），两条都可转跳
//  3) 点元数据标题条目 → 平滑滚动回文档顶（scrollTop → 0）；点正文标题条目 → 落在正文标题处
// 用法：node scripts/cdp-toc-metadata-verify.mjs
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
  mkdirSync(".tmp-toc-verify", { recursive: true });
  writeFileSync(`.tmp-toc-verify/${name}.png`, Buffer.from(res.data, "base64"));
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
// store 调用统一走 async IIFE；模块 URL 从 resource 条目解析（HMR ?t= 版本串陷阱）
const storeCall = async (body) =>
  evalJs(`(async () => {
    const url = performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("/src/store/layout-store.ts")) ?? "/src/store/layout-store.ts";
    const S = (await import(url)).useLayoutStore;
    ${body}
  })()`);

// ---------- 前置：激活一个论文 tab 并等正文渲染 ----------
const initial = JSON.parse(
  await storeCall(`const s = S.getState(); return JSON.stringify({
  tabs: s.tabs.map((t) => ({ id: t.id, type: t.type ?? "book" })),
  activeTabId: s.activeTabId, slept: s.sleptTabIds });`),
);
console.log("INITIAL", JSON.stringify(initial));
const paperTab = initial.tabs.find((t) => t.type === "paper");
if (!paperTab) {
  console.error("SKIP: 无论文 tab");
  process.exit(1);
}
await storeCall(`S.getState().activateTab("${paperTab.id}")`);
// 等 PaperReader 正文挂出（休眠唤醒重挂载，重论文秒级）
const ready = await pollUntil(
  () =>
    evalJs(
      `!!document.querySelector('main.overflow-clip > .tab-layer[data-active="true"] #paper-metadata-title')`,
    ).then((v) => (v === true ? "yes" : null)),
  20000,
  500,
);
check("前置：论文正文渲染且元数据标题带稳定 id #paper-metadata-title", !!ready, ready ?? "timeout");

// 滚动容器与标题几何（容器内定位，多 tab 并存不串）
const GEO_EXPR = `(() => {
  const layer = document.querySelector('main.overflow-clip > .tab-layer[data-active="true"]');
  const meta = layer?.querySelector("#paper-metadata-title");
  const root = meta?.closest(".overflow-y-auto");
  if (!meta || !root) return null;
  const metaH1Text = meta.textContent.trim();
  const bodyH1 = [...layer.querySelectorAll(".paper-content h1")].find((h) => !h.closest("[data-paper-metadata]") && h.id);
  const rel = (el) => el.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
  return JSON.stringify({
    metaText: metaH1Text, metaTop: Math.round(rel(meta)),
    bodyId: bodyH1?.id ?? null, bodyText: bodyH1?.textContent.trim() ?? null, bodyTop: bodyH1 ? Math.round(rel(bodyH1)) : null,
    scrollTop: Math.round(root.scrollTop), scrollHeight: root.scrollHeight,
  });
})()`;
const geo0 = JSON.parse(await evalJs(GEO_EXPR));
console.log("GEO", JSON.stringify(geo0));
check(
  "正文另有同名标题 heading（TOC 双标题前提）",
  !!geo0?.bodyId && geo0.bodyText === geo0.metaText,
  JSON.stringify({ bodyId: geo0?.bodyId, bodyText: geo0?.bodyText }),
);

// ---------- 打开 TOC 下拉，枚举条目 ----------
const openToc = async () => {
  await evalJs(`(() => {
    const layer = document.querySelector('main.overflow-clip > .tab-layer[data-active="true"]');
    // header-bar 里有多个 dropdown（toc/搜索/设置/翻译），按 TableOfContents 图标锁定 TOC 触发器
    // （Tooltip asChild 包裹后按钮落到的 data-slot 是 tooltip-trigger，故按 aria-haspopup 圈菜单按钮）
    const triggers = [...(layer?.querySelectorAll('.header-bar button[aria-haspopup="menu"]') ?? [])];
    const trigger = triggers.find((t) => t.querySelector("svg.lucide-table-of-contents")) ?? triggers[0];
    if (!trigger) return "no-trigger";
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    trigger.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    return "sent";
  })()`);
  return pollUntil(
    () =>
      evalJs(`!!document.querySelector('[data-slot="dropdown-menu-content"]')`).then((v) =>
        v === true ? "yes" : null,
      ),
    3000,
    150,
  );
};
const listTocItems = async () =>
  JSON.parse(
    await evalJs(
      `JSON.stringify([...document.querySelectorAll('[data-slot="dropdown-menu-content"] button')].map((b) => b.textContent.trim()))`,
    ),
  );
const closeToc = async () => {
  await evalJs(`document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  await sleep(250);
};

check("TOC 下拉打开", !!(await openToc()));
const items = await listTocItems();
console.log("TOC items", JSON.stringify(items));
const titleHits = items.map((t, i) => (t === geo0.metaText ? i : -1)).filter((i) => i >= 0);
check("TOC 中标题出现两遍（元数据 + 正文）", titleHits.length >= 2, `hits=${JSON.stringify(titleHits)}`);
await shot("toc-01-dropdown");

// ---------- 跳到中部，点「元数据标题」条目（首个同名条目），断言回顶 ----------
await evalJs(`(() => {
  const layer = document.querySelector('main.overflow-clip > .tab-layer[data-active="true"]');
  const root = layer.querySelector("#paper-metadata-title").closest(".overflow-y-auto");
  root.scrollTop = root.scrollHeight * 0.6;
  return "scrolled";
})()`);
await sleep(300);
const mid = JSON.parse(await evalJs(GEO_EXPR));
check("已滚到中部（起始 scrollTop 远离顶部）", mid.scrollTop > 500, `scrollTop=${mid.scrollTop}`);
await shot("toc-02-mid");

// 点首个条目（文档序第一 = 元数据标题）
await evalJs(`(() => {
  const btns = [...document.querySelectorAll('[data-slot="dropdown-menu-content"] button')];
  btns[${titleHits[0] ?? 0}]?.click();
  return "clicked";
})()`);
const backTop = await pollUntil(
  async () => {
    const g = JSON.parse(await evalJs(GEO_EXPR));
    // 既有路径落点 = 目标元素相对顶 - 16px 偏移（scrollElementInContainer 默认 offset）；
    // 元数据区在文档顶，故回顶语义 = scrollTop ≈ metaTop - 16（几十 px 内）
    return Math.abs(g.scrollTop - (g.metaTop - 16)) <= 24 && g.scrollTop < 120 ? g : null;
  },
  5000,
  200,
);
check(
  "点元数据标题条目 → 平滑滚动回文档顶（元数据区）",
  !!backTop,
  backTop ? `scrollTop=${backTop.scrollTop} expect≈${backTop.metaTop - 16}` : "timeout",
);
await shot("toc-03-back-to-top");

// ---------- 点「正文标题」条目（第二个同名条目），断言落在正文标题处 ----------
check("TOC 下拉重开", !!(await openToc()));
await evalJs(`(() => {
  const btns = [...document.querySelectorAll('[data-slot="dropdown-menu-content"] button')];
  btns[${titleHits[1] ?? 1}]?.click();
  return "clicked";
})()`);
const toBody = await pollUntil(
  async () => {
    const g = JSON.parse(await evalJs(GEO_EXPR));
    return Math.abs(g.scrollTop - (g.bodyTop - 16)) <= 24 ? g : null;
  },
  5000,
  200,
);
check(
  "点正文标题条目 → 落在正文标题处（既有路径未受牵连）",
  !!toBody,
  toBody ? `scrollTop=${toBody.scrollTop} expect≈${toBody.bodyTop - 16}` : "timeout",
);
await shot("toc-04-body-title");

console.log("\n===== SUMMARY =====");
for (const r of results) console.log(r);
ws.close();
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
