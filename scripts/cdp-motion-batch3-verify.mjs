// 动效批次 3 CDP 实盘验证 v2（dev 1420 + CDP 9223，HMR 已应用改动）：
//  0) 预唤醒休眠 tab + 开一本书（供书籍场景）   B) reader tab 交叉淡入：单次/快速连切/保活标记/休眠唤醒
//  C) 主页路由交叉淡入（批次 5 keepalive 化：visited 层常驻只增不减）：单活跃不变式、/chat 常驻层、几何等价、帧探针
//  D) Tabs 滑动 pill：首帧无飞入、滑动中途、触发器样式解耦（embedding-dialog / 书籍笔记 / 论文笔记三使用方）
//  E) 三档退化：fade-only 位移归零、reduced 硬切   F) 大 DOM 压力：论文 tab 切换帧探针
// 隐藏模型双轨感知（index.css data-tab-hide）：visibility 相关断言按启动时读到的模型自动适配（TAB_HIDE）。
// 高负载机器友好：所有终态断言走轮询（pollUntil），不用固定 sleep 拍脑袋。
// 用法：node scripts/cdp-motion-batch3-verify.mjs
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
// 轮询断言：fn 返回真值即胜；超时返回 null（高负载下 React 渲染/定时器可能延迟）
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

// 隐藏模型感知（index.css 批次 3 双轨 data-tab-hide）：
// visibility 模型非活跃终态 = visibility:hidden；opacity 模型恒 visible，终态判据 = opacity 0 + 位移态。
// 采样串格式 `${active}:${opacity(4字符)}:${visibility}:${transform}`，下同。
const TAB_HIDE = await evalJs(`document.documentElement.dataset.tabHide ?? "opacity"`);
console.log("TAB-HIDE-MODEL", TAB_HIDE);
const layerOpacity = (s) => Number.parseFloat(s.split(":")[1]);
// 非活跃层是否到终态（visibility: :hidden:tf；opacity: 0:visible:tf）
const isInactiveSettled = (s) =>
  TAB_HIDE === "visibility" ? s.endsWith(":hidden:tf") : layerOpacity(s) === 0 && s.endsWith(":visible:tf");
// 「可见」语义统一为 opacity > 0.05（opacity 模型下 visibility 恒 visible，不能当判据）
const isVisuallyOn = (s) => layerOpacity(s) > 0.05;

// ---------- 通用探针 ----------
// store 调用统一走 async IIFE（Runtime.evaluate 经典脚本不支持顶层 await）；
// 模块 URL 从 resource 条目解析——vite HMR 给改过的模块挂 ?t= 版本串，裸路径会静默命中旧实例
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

// reader tab 层采样（main.overflow-clip 直属 .tab-layer）
const READER_LAYER_EXPR = `[...document.querySelectorAll("main.overflow-clip > .tab-layer")].map((l) => { const c = getComputedStyle(l); return \`\${l.dataset.active}:\${c.opacity.slice(0, 4)}:\${c.visibility}:\${c.transform === "none" ? "notf" : "tf"}\`; })`;
const readerLayers = async () => JSON.parse(await evalJs(`JSON.stringify(${READER_LAYER_EXPR})`));
// 路由/chat 层采样（app-main 直属 .tab-layer；chat 常驻层以 data-region="chat-layer" 标识——
// 路由页根卡片也带 shadow-around，不能按类名区分）
const ROUTE_LAYER_EXPR = `(() => { const am = document.querySelector('[data-region="app-main"]'); if (!am) return ["no-am"]; return [...am.children].filter((c) => c.classList?.contains("tab-layer")).map((l) => { const c = getComputedStyle(l); return \`\${l.dataset.region === "chat-layer" ? "chat" : "route"}:\${l.dataset.active}:\${c.opacity.slice(0, 4)}:\${c.visibility}\`; }); })()`;
const routeLayers = async () => JSON.parse(await evalJs(`JSON.stringify(${ROUTE_LAYER_EXPR})`));

// rAF 采样器：注入后 windowMs 内每帧记录 expr 值与时间戳（帧间隔即卡顿证据）
const startSampler = async (expr, windowMs = 900) =>
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

// ---------- A) 前置 ----------
const initial = await storeState();
const initialHash = await evalJs(`location.hash`);
const initialMotion = await evalJs(`document.documentElement.dataset.motion ?? "full"`);
console.log("INITIAL", JSON.stringify({ ...initial, hash: initialHash, motion: initialMotion }));
await shot("b3-00-initial");
const openedByMe = [];

// A2 预唤醒所有休眠 tab（避免切换测量被唤醒重渲染阻塞；巡逻 10 分钟后会自然再休眠）
for (const sleptId of initial.slept) {
  await storeCall(`S.getState().activateTab("${sleptId}")`);
  await sleep(1400);
}
if (initial.activeTabId) await storeCall(`S.getState().activateTab("${initial.activeTabId}")`);
await sleep(600);
console.log("A2 awake", JSON.stringify((await storeState()).slept));

// A3 无书 tab 则开一本（书籍笔记 pill / 书籍休眠唤醒 / 大 DOM 对照都需要）
let bookTabId = initial.tabs.find((t) => t.type === "book")?.id ?? null;
if (!bookTabId) {
  await storeCall(`S.getState().navigateToHome()`);
  await evalJs(`location.hash = "#/"`);
  // 等图书馆卡片渲染（LibraryPage 重挂载 + 数据加载，负载下可能秒级）
  const cardReady = await pollUntil(
    () => evalJs(`!!document.querySelector('[data-region="book-card"]')`).then((v) => (v === true ? "yes" : null)),
    6000,
    300,
  );
  console.log("A3 library-cards", cardReady ?? "timeout");
  await evalJs(`(() => { document.querySelector('[data-region="book-card"]')?.click(); return "click"; })()`);
  const newTab = await pollUntil(
    async () => {
      const st = await storeState();
      const t = st.tabs.find((x) => x.type === "book" && !initial.tabs.some((y) => y.id === x.id));
      return t ? t.id : null;
    },
    5000,
    300,
  );
  bookTabId = newTab;
  if (bookTabId) {
    openedByMe.push(bookTabId);
    // 等 foliate 视图挂上
    await pollUntil(
      () =>
        evalJs(`!!document.querySelector("main.overflow-clip > .tab-layer[data-active='true'] foliate-view")`).then(
          (v) => (v === true ? "yes" : null),
        ),
      9000,
      400,
    );
  }
  console.log("A3 bookTabId", bookTabId);
}

// ---------- B) reader tab 交叉淡入 ----------
{
  const st = await storeState();
  if (st.tabs.length >= 2) {
    // B1 单次切换（真实 DOM 点击垂直 tab 条；目标选书籍 tab——入场层轻量，
    //    避开重论文 unhide 强制重算墙（index.css:697 记载的历史前科，与动效无关），才能采到淡入中间帧）
    if (st.activeTabId === bookTabId) {
      const nonBook = st.tabs.find((t) => t.id !== bookTabId);
      await storeCall(`S.getState().activateTab("${nonBook.id}")`);
      await sleep(1200);
    }
    const st1 = await storeState();
    const target =
      st1.tabs.find((t) => t.id === bookTabId && t.id !== st1.activeTabId) ??
      st1.tabs.find((t) => t.id !== st1.activeTabId && !st1.slept.includes(t.id)) ??
      st1.tabs.find((t) => t.id !== st1.activeTabId);
    const fromId = st1.activeTabId;
    // 负载下 React 提交可能 >1s（F 节实测 tCommit≈1.4s）：采样窗放宽到 3.2s 覆盖「提交卡顿 + 淡入」全程
    await startSampler(READER_LAYER_EXPR, 3200);
    await evalJs(`(() => {
      const strip = document.querySelector('[data-region="vertical-tabs"]');
      const items = [...(strip?.querySelectorAll(".size-8.cursor-pointer") ?? [])];
      const idx = ${JSON.stringify(st1.tabs.map((t) => t.id))}.indexOf("${target.id}");
      (items[idx] ?? items[0])?.click();
      return "clicked";
    })()`);
    // 轮询捕获双层同帧（计算值为权威证据；截图紧随，负载下可能落在尾帧）
    const midEvidence = await pollUntil(
      async () => {
        const ls = await readerLayers();
        const visCount = ls.filter(isVisuallyOn).length;
        const midFade = ls.some((s) => {
          const o = layerOpacity(s);
          return o > 0.05 && o < 0.95;
        });
        return visCount >= 2 && midFade ? ls.join(" ") : null;
      },
      3200,
      60,
    );
    await shot("b3-01-tab-mid");
    await sleep(800);
    await shot("b3-02-tab-settled");
    const samples = await readSampler();
    const fs = frameStats(samples);
    const bothVisible = !!midEvidence || samples.some((x) => x.s.filter(isVisuallyOn).length >= 2);
    const anyMidFade =
      !!midEvidence ||
      samples.some((x) =>
        x.s.some((s) => {
          const o = layerOpacity(s);
          return o > 0.05 && o < 0.95;
        }),
      );
    const noBlank = samples.length > 0 && samples.every((x) => x.s.some(isVisuallyOn));
    check("B1 交叉淡入双层同帧", bothVisible && anyMidFade, midEvidence ?? `frames=${fs.frames} maxGap=${fs.maxGap}ms`);
    check("B1 全程无空白帧", noBlank, `frames=${fs.frames} span=${fs.spanMs}ms`);
    // 终态轮询：单层 active opacity1 transform-none，余层到隐藏终态（按模型）
    const settled = await pollUntil(async () => {
      const ls = await readerLayers();
      const ok =
        ls.filter((s) => s.startsWith("true:1:visible:notf")).length === 1 &&
        ls.filter((s) => !s.startsWith("true")).every(isInactiveSettled);
      return ok ? ls.join(" ") : null;
    }, 2500);
    check(
      `B1 终态：单层 active opacity1 transform-none，余层隐藏终态（${TAB_HIDE} 模型）`,
      !!settled,
      settled ?? (await readerLayers()).join(" "),
    );
    // 隐藏隔离（批次 opacity 实验新增）：非活跃层 inert + aria-hidden，活跃层皆无
    const isoOk = await evalJs(`(() => {
      const ls = [...document.querySelectorAll("main.overflow-clip > .tab-layer")];
      return ls.every((l) => (l.dataset.active === "true" ? !l.inert && !l.getAttribute("aria-hidden") : l.inert && l.getAttribute("aria-hidden") === "true"));
    })()`);
    check("B1 隐藏隔离：非活跃层 inert + aria-hidden，活跃层无", isoOk === true, String(isoOk));

    // B2 快速连切 target→from→target（间隔 80ms）
    await startSampler(READER_LAYER_EXPR);
    await storeCall(`S.getState().activateTab("${fromId}")`);
    await sleep(80);
    await storeCall(`S.getState().activateTab("${target.id}")`);
    await sleep(60);
    await shot("b3-03-tab-rapid-mid");
    await sleep(600);
    await readSampler();
    const rapidSettled = await pollUntil(async () => {
      const ls = await readerLayers();
      const activeN = ls.filter((s) => s.startsWith("true")).length;
      const stuck = ls.some((s) => {
        const o = Number.parseFloat(s.split(":")[1]);
        return o > 0.02 && o < 0.98;
      });
      return activeN === 1 && !stuck ? ls.join(" ") : null;
    }, 2500);
    check(
      "B2 快速连切终态恰好一个 active 层且无中间态卡住",
      !!rapidSettled,
      rapidSettled ?? (await readerLayers()).join(" "),
    );

    // B3 保活：给当前活动层打 expando 标记，切走切回验证同节点未 remount（阅读位置代理：foliate 视图同一节点）
    await evalJs(`(() => {
      const l = [...document.querySelectorAll("main.overflow-clip > .tab-layer")].find((x) => x.dataset.active === "true");
      l.__b3marker = "keepalive";
      const v = l.querySelector("foliate-view, iframe, [data-region='reader-view']") ?? l.firstElementChild;
      if (v) v.__b3inner = "same-node";
      return "marked";
    })()`);
    await storeCall(`S.getState().activateTab("${fromId}")`);
    await sleep(500);
    await storeCall(`S.getState().activateTab("${target.id}")`);
    await sleep(500);
    const keep = await evalJs(`(() => {
      const l = [...document.querySelectorAll("main.overflow-clip > .tab-layer")].find((x) => x.dataset.active === "true");
      const innerSame = [...l.querySelectorAll("*")].some((e) => e.__b3inner === "same-node");
      return JSON.stringify({ marker: l.__b3marker ?? null, innerSame });
    })()`);
    const keepObj = JSON.parse(keep);
    check("B3 切走切回层未 remount（保活/阅读位置）", keepObj.marker === "keepalive" && keepObj.innerSame, keep);

    // B4 休眠唤醒：手动休眠非活动 tab（优先书籍——foliate 重挂载是最险路径）→ 激活 → 唤醒重挂载
    const st4 = await storeState();
    const sleepVictim =
      st4.tabs.find((t) => t.type === "book" && t.id !== st4.activeTabId) ??
      st4.tabs.find((t) => t.id !== st4.activeTabId);
    if (sleepVictim) {
      await storeCall(`S.getState().setSleptTabIds(["${sleepVictim.id}"])`);
      await sleep(300);
      console.log("B4 slept-before-wake", await storeCall(`return JSON.stringify(S.getState().sleptTabIds)`));
      await startSampler(READER_LAYER_EXPR);
      await storeCall(`S.getState().activateTab("${sleepVictim.id}")`);
      await sleep(130);
      await shot("b3-04-sleep-wake-mid");
      // 按 tab 类型等重挂载：书 = foliate-view 重现；论文 = 文本内容恢复
      const isBookVictim = sleepVictim.type !== "paper";
      const woken = await pollUntil(
        async () => {
          const w = JSON.parse(
            await evalJs(`(() => {
          const l = [...document.querySelectorAll("main.overflow-clip > .tab-layer")].find((x) => x.dataset.active === "true");
          return JSON.stringify({
            layerActive: l?.dataset.active ?? null,
            remounted: ${isBookVictim ? '!!(l && l.querySelector("foliate-view, iframe"))' : "!!(l && l.textContent.trim().length > 50)"},
          });
        })()`),
          );
          const meta = JSON.parse(
            await storeCall(
              `return JSON.stringify({ slept: S.getState().sleptTabIds, active: S.getState().activeTabId })`,
            ),
          );
          const merged = { ...w, ...meta };
          return !merged.slept.includes(sleepVictim.id) && merged.active === sleepVictim.id && merged.remounted
            ? JSON.stringify(merged)
            : null;
        },
        8000,
        500,
      );
      await shot("b3-05-sleep-woken");
      check("B4 休眠 tab 激活后唤醒（slept 清单清空 + 视图重挂载 + 层淡入）", !!woken, woken ?? "timeout");
    } else {
      console.log("B4 SKIP: 无可用休眠候选 tab");
    }
  } else {
    console.log("B SKIP: tab 不足两个");
  }
}

// ---------- C) 主页路由转场 ----------
await storeCall(`S.getState().navigateToHome()`);
await evalJs(`location.hash = "#/"`);
await sleep(800);
await shot("b3-10-route-library");

// C1 几何等价：app-main 矩形 == 层矩形；内层 wrapper == app-main 内缩 4px（p-1 容器→层 视觉等价）
const geo = JSON.parse(
  await evalJs(`(() => {
  const am = document.querySelector('[data-region="app-main"]');
  const layer = [...am.children].find((c) => c.classList.contains("tab-layer") && !c.classList.contains("shadow-around") && c.dataset.active === "true");
  const inner = layer?.firstElementChild;
  const r = (e) => { const b = e.getBoundingClientRect(); return [b.x, b.y, b.width, b.height].map(Math.round); };
  return JSON.stringify({ am: r(am), layer: r(layer), inner: r(inner) });
})()`),
);
const geoOk =
  geo.am &&
  geo.layer &&
  geo.inner &&
  geo.am.every((v, i) => v === geo.layer[i]) &&
  Math.abs(geo.inner[0] - (geo.am[0] + 4)) <= 1 &&
  Math.abs(geo.inner[1] - (geo.am[1] + 4)) <= 1 &&
  Math.abs(geo.inner[2] - (geo.am[2] - 8)) <= 1 &&
  Math.abs(geo.inner[3] - (geo.am[3] - 8)) <= 1;
check("C1 路由层几何与改动前逐像素等价（层=inset-0，内容=p-1 内缩）", geoOk, JSON.stringify(geo));

// C2 快速连切 #/ → #/papers → #/converter（100ms 间隔）——批次 5 keepalive 化后断言语义反转：
// 访问过的路由层常驻挂载（只增不减），离场层不再卸载；不变式 = 每帧恰好一个 active 层
// + 终态单活跃其余隐藏终态 + 既有层节点零重挂载（expando 标记实证，重跑脚本亦成立）
const routeMark = async () =>
  evalJs(`(() => {
    const am = document.querySelector('[data-region="app-main"]');
    [...am.children].filter((c) => c.classList?.contains("tab-layer") && c.dataset.region !== "chat-layer")
      .forEach((l, i) => { if (!l.__b5mark) l.__b5mark = \`m\${i}\`; });
    return [...am.children].filter((c) => c.__b5mark).map((l) => l.__b5mark).join(",");
  })()`);
const marksBefore = await routeMark();
const routeCountBefore = marksBefore ? marksBefore.split(",").length : 0;
await startSampler(ROUTE_LAYER_EXPR);
await evalJs(`location.hash = "#/papers"`);
await sleep(100);
await evalJs(`location.hash = "#/converter"`);
await sleep(70);
await shot("b3-11-route-mid");
await sleep(600);
await shot("b3-12-route-converter");
const routeSamples = await readSampler();
const activeCounts = routeSamples.map((x) => x.s.filter((s) => s.startsWith("route:true")).length);
check(
  "C2 快速连切每帧恰好一个 active 路由层（无双活跃/零活跃卡帧）",
  routeSamples.length > 0 && activeCounts.every((n) => n === 1),
  `frames=${routeSamples.length} activeCounts=${[...new Set(activeCounts)].join(",")}`,
);
// 终态轮询：常驻层全部到达隐藏终态（opacity 0 + 模型对应隐藏态）
//（route 采样串格式 type:active:opacity:visibility，与 reader 层不同）
const routeVisualSettled = await pollUntil(async () => {
  const ls = await routeLayers();
  const routes = ls.filter((s) => s.startsWith("route"));
  const active = routes.filter((s) => s.startsWith("route:true:1:visible")).length === 1;
  const restHidden = routes
    .filter((s) => !s.startsWith("route:true"))
    .every((s) => (TAB_HIDE === "visibility" ? s.includes(":0:hidden") : s.includes(":0:visible")));
  return active && restHidden ? ls.join(" ") : null;
}, 3000);
check(
  `C2 视觉终态：单层 active，余层已隐藏（${TAB_HIDE} 模型）`,
  !!routeVisualSettled,
  routeVisualSettled ?? (await routeLayers()).join(" "),
);
const routeKeptAlive = await evalJs(`(() => {
  const am = document.querySelector('[data-region="app-main"]');
  const routes = [...am.children].filter((c) => c.classList?.contains("tab-layer") && c.dataset.region !== "chat-layer");
  const kept = routes.filter((l) => l.__b5mark);
  return JSON.stringify({ total: routes.length, keptMarks: kept.length });
})()`);
const rk = JSON.parse(routeKeptAlive);
check(
  "C2 离场层保持挂载（keepalive 常驻：数量只增不减 + 既有层节点未重挂载）",
  rk.total >= routeCountBefore && rk.keptMarks === routeCountBefore && rk.total >= 3,
  `before=${routeCountBefore} after=${JSON.stringify(rk)}（/, papers, converter 至少三层常驻）`,
);

// C3 /chat 常驻层：切进交叉淡入，切出后仍挂载。
// 重叠证据走轮询（6s 窗口）：/chat 首进提交在负载机可慢至秒级，900ms rAF 采样窗会落在真重叠之前（2026-08-26 复跑实证）
await evalJs(`location.hash = "#/chat"`);
const chatBothVisible = await pollUntil(async () => {
  const ls = await routeLayers();
  const vis = ls.filter((s) => Number.parseFloat(s.split(":")[2]) > 0.05);
  return vis.some((s) => s.startsWith("chat:true")) && vis.some((s) => s.startsWith("route:")) ? ls.join(" ") : null;
}, 6000, 60);
await shot("b3-13-chat-mid");
check("C3 切进 /chat 交叉淡入（chat 淡入 + 路由层播离场同帧）", !!chatBothVisible, chatBothVisible ?? "timeout");
await sleep(600);
await shot("b3-14-chat-settled");
const chatSettled = await pollUntil(async () => {
  const ls = await routeLayers();
  const chatOk = ls.some((s) => s.startsWith("chat:true:1:visible"));
  // 批次 5 keepalive：路由层常驻不卸载，断言改为全部到达隐藏终态
  const routesHidden = ls
    .filter((s) => s.startsWith("route"))
    .every((s) => (TAB_HIDE === "visibility" ? s.includes(":0:hidden") : s.includes(":0:visible")));
  return chatOk && routesHidden ? ls.join(" ") : null;
}, 3000);
check("C3 /chat 终态：chat active、路由层全部隐藏终态（keepalive 常驻不可见）", !!chatSettled, chatSettled ?? (await routeLayers()).join(" "));
await evalJs(`location.hash = "#/"`);
const chatKept = await pollUntil(async () => {
  const v = await evalJs(`(() => {
    const chat = document.querySelector('[data-region="app-main"] > [data-region="chat-layer"]');
    const c = chat ? getComputedStyle(chat) : null;
    return JSON.stringify({ present: !!chat, active: chat?.dataset.active ?? null, visibility: c?.visibility ?? null, opacity: c?.opacity ?? null, inert: chat?.inert ?? null, mountedChildren: chat?.childElementCount ?? 0 });
  })()`);
  const o = JSON.parse(v);
  // 隐藏终态按模型：visibility 模型 = hidden；opacity 模型 = opacity 0 + inert
  const hiddenOk = TAB_HIDE === "visibility" ? o.visibility === "hidden" : o.opacity === "0" && o.inert === true;
  return o.present && o.active === "false" && hiddenOk && o.mountedChildren > 0 ? v : null;
  // 超时放宽 6s：回 #/ 时 LibraryPage 重挂载 + 数据加载可能堵主线程 2s+，叠 visibility 0.3s 延迟链
}, 6000);
await shot("b3-15-back-library");
check(`C3 切出 /chat 后常驻挂载语义未破（隐藏但子树在，${TAB_HIDE} 模型）`, !!chatKept, chatKept ?? "timeout");

// C4 路由切换帧探针（#/ → #/papers）
await startSampler(ROUTE_LAYER_EXPR);
await evalJs(`location.hash = "#/papers"`);
await sleep(950);
const c4 = frameStats(await readSampler());
console.log(`C4 路由切换帧探针: frames=${c4.frames} span=${c4.spanMs}ms maxGap=${c4.maxGap}ms`);

// ---------- D) Tabs 滑动 pill ----------
// D1 embedding dialog（图书馆右键书卡 → 向量化测试）：首帧无飞入 + 滑动 + 解耦
await evalJs(`location.hash = "#/"`);
const cardReady = await pollUntil(
  () => evalJs(`!!document.querySelector('[data-region="book-card"]')`).then((v) => (v === true ? "yes" : null)),
  6000,
  300,
);
console.log("D1 library-cards", cardReady ?? "timeout");
await startSampler(`(() => {
  const list = document.querySelector('[role="dialog"] [role="tablist"]');
  const pill = list?.querySelector(':scope > span[aria-hidden="true"]');
  return pill ? [pill.style.transform, pill.style.width] : ["no-pill"];
})()`);
await evalJs(`(() => {
  const card = document.querySelector('[data-region="book-card"]');
  if (!card) return "no-card";
  const r = card.getBoundingClientRect();
  card.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
  return "ctx-sent";
})()`);
await sleep(500);
// 「向量化测试」在二级子菜单：先点顶层「向量化」子菜单触发器
const subOpened = await evalJs(`(() => {
  const items = [...document.querySelectorAll('[role="menuitem"]')];
  const sub = items.find((i) => i.textContent.trim() === "向量化" || i.textContent.trim() === "✓ 向量化");
  if (!sub) return "no-sub:" + items.map((i) => i.textContent.trim()).join("|").slice(0, 120);
  sub.click();
  return "sub-clicked";
})()`);
console.log("D1 sub", subOpened);
await sleep(500);
const menuClicked = await evalJs(`(() => {
  const items = [...document.querySelectorAll('[role="menuitem"]')];
  const it = items.find((i) => i.textContent.trim() === "向量化测试");
  if (!it) return "no-item:" + items.map((i) => i.textContent.trim()).join("|").slice(0, 160);
  it.click();
  return "clicked";
})()`);
console.log("D1 menu", menuClicked);
const dialogReady = await pollUntil(
  () => evalJs(`!!document.querySelector('[role="dialog"] [role="tablist"]')`).then((v) => (v === true ? "yes" : null)),
  4000,
  200,
);
await sleep(500); // 让采样器覆盖首帧窗口
const firstSamples = await readSampler();
if (dialogReady) {
  const pillGeo = JSON.parse(
    await evalJs(`(() => {
    const list = document.querySelector('[role="dialog"] [role="tablist"]');
    if (!list) return JSON.stringify({ err: "no-tablist" });
    const pill = list.querySelector(':scope > span[aria-hidden="true"]');
    const active = list.querySelector('[data-state="active"]');
    if (!pill || !active) return JSON.stringify({ err: "no-pill-or-active" });
    return JSON.stringify({
      pillTransform: pill.style.transform, pillWidth: pill.style.width, pillRadius: pill.style.borderRadius,
      activeOffset: [active.offsetLeft, active.offsetTop, active.offsetWidth, active.offsetHeight],
      activeRadius: getComputedStyle(active).borderRadius,
      activeBg: getComputedStyle(active).backgroundColor,
      activeZ: getComputedStyle(active).zIndex,
    });
  })()`),
  );
  console.log("D1 pill-geo", JSON.stringify(pillGeo));
  await shot("b3-20-pill-first-frame");
  const firstOk =
    !pillGeo.err &&
    pillGeo.pillTransform === `translate(${pillGeo.activeOffset[0]}px, ${pillGeo.activeOffset[1]}px)` &&
    Number.parseInt(pillGeo.pillWidth, 10) === pillGeo.activeOffset[2] &&
    pillGeo.pillRadius === pillGeo.activeRadius;
  check(
    "D1 首帧 pill 即落在活跃触发器上（无 0,0 飞入）",
    firstOk && !firstSamples.some((x) => x.s[0]?.includes("translate(0px, 0px)")),
    JSON.stringify(pillGeo.pillTransform),
  );
  check(
    "D1 触发器样式解耦（active 背景透明 + z-10 浮于 pill 上）",
    pillGeo.activeBg === "rgba(0, 0, 0, 0)" && pillGeo.activeZ === "10",
    `bg=${pillGeo.activeBg} z=${pillGeo.activeZ}`,
  );
  await evalJs(`(() => {
    const list = document.querySelector('[role="dialog"] [role="tablist"]');
    const triggers = [...list.querySelectorAll('[role="tab"]')];
    const el = triggers[1];
    if (!el) return "no-tab2";
    // radix Tabs 在 mousedown 激活（非 click）：补全 pointer 序列
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
    el.click();
    return "tab2";
  })()`);
  await sleep(50);
  await shot("b3-21-pill-mid");
  await sleep(300);
  await shot("b3-22-pill-settled");
  const slideGeo = JSON.parse(
    await evalJs(`(() => {
    const list = document.querySelector('[role="dialog"] [role="tablist"]');
    const pill = list.querySelector(':scope > span[aria-hidden="true"]');
    const active = list.querySelector('[data-state="active"]');
    return JSON.stringify({ pillTransform: pill?.style.transform ?? null, activeOffset: active ? [active.offsetLeft, active.offsetTop] : null });
  })()`),
  );
  check(
    "D1 pill 滑动后落位新活跃触发器",
    slideGeo.pillTransform === `translate(${slideGeo.activeOffset?.[0]}px, ${slideGeo.activeOffset?.[1]}px)`,
    JSON.stringify(slideGeo),
  );
} else {
  check("D1 embedding dialog 打开", false, `menu=${menuClicked} cards=${cardReady}`);
}
// 关闭 dialog（Esc 兜底 + X 按钮）
await evalJs(`(() => {
  const dlg = document.querySelector('[role="dialog"]');
  const b = dlg && [...dlg.querySelectorAll("button")].find((x) => x.querySelector("svg.lucide-x"));
  b?.click();
  return "x";
})()`);
await sleep(400);

// D2/D3 共用：展开指定 tab 的笔记面板并验证 pill 滑动
const ACTIVE_TABLIST = 'main.overflow-clip > .tab-layer[data-active="true"] [role="tablist"]';
const verifyNotepadPill = async (tabId, label, shotName) => {
  await storeCall(`S.getState().activateTab("${tabId}")`);
  await sleep(1000);
  let hasList = await evalJs(`!!document.querySelector('${ACTIVE_TABLIST}')`);
  if (!hasList) {
    // 展开笔记面板：书籍/论文 header-bar 左侧首个 cursor-pointer 图标按钮（同一模式）
    console.log(
      `${label} expand`,
      await evalJs(`(() => {
      const btn = document.querySelector('main.overflow-clip > .tab-layer[data-active="true"] .header-bar div.cursor-pointer');
      if (!btn) return "no-btn";
      btn.click();
      return "clicked";
    })()`),
    );
    hasList = await pollUntil(
      () => evalJs(`!!document.querySelector('${ACTIVE_TABLIST}')`).then((v) => (v === true ? "yes" : null)),
      3000,
      200,
    );
  }
  if (!hasList) {
    console.log(`${label} SKIP: 无 tablist`);
    return;
  }
  const geo0 = JSON.parse(
    await evalJs(`(() => {
    const list = document.querySelector('${ACTIVE_TABLIST}');
    const pill = list.querySelector(':scope > span[aria-hidden="true"]');
    const active = list.querySelector('[data-state="active"]');
    return JSON.stringify({ hasPill: !!pill, transform: pill?.style.transform ?? null, activeOffset: active ? [active.offsetLeft, active.offsetTop] : null, radius: pill?.style.borderRadius ?? null, activeRadius: active ? getComputedStyle(active).borderRadius : null });
  })()`),
  );
  console.log(`${label} geo0`, JSON.stringify(geo0));
  if (!geo0.hasPill) {
    check(`${label} pill 存在`, false, JSON.stringify(geo0));
    return;
  }
  await startSampler(`(() => {
    const list = document.querySelector('${ACTIVE_TABLIST}');
    const pill = list?.querySelector(':scope > span[aria-hidden="true"]');
    return pill ? [pill.style.transform] : ["no-pill"];
  })()`);
  await evalJs(`(() => {
    const triggers = [...document.querySelectorAll('${ACTIVE_TABLIST} [role="tab"]')];
    const next = triggers.find((t) => t.dataset.state !== "active") ?? triggers[1];
    if (!next) return "no-next";
    // radix Tabs 在 mousedown 激活（非 click）
    next.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    next.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
    next.click();
    return "switch";
  })()`);
  await sleep(50);
  await shot(shotName);
  await sleep(400);
  const midSamples = await readSampler();
  const moved = new Set(midSamples.map((x) => x.s[0])).size > 1;
  const settled = await pollUntil(async () => {
    const g = JSON.parse(
      await evalJs(`(() => {
      const list = document.querySelector('${ACTIVE_TABLIST}');
      const pill = list.querySelector(':scope > span[aria-hidden="true"]');
      const active = list.querySelector('[data-state="active"]');
      return JSON.stringify({ transform: pill.style.transform, activeOffset: [active.offsetLeft, active.offsetTop] });
    })()`),
    );
    return g.transform === `translate(${g.activeOffset[0]}px, ${g.activeOffset[1]}px)` ? JSON.stringify(g) : null;
  }, 2000);
  check(
    `${label} pill 滑动并落位（圆角同源）`,
    moved && !!settled && geo0.radius === geo0.activeRadius,
    `moved=${moved} settled=${settled} radius=${geo0.radius}`,
  );
};

// D2 书籍笔记面板（notepad-header）
if (bookTabId) await verifyNotepadPill(bookTabId, "D2 书籍笔记面板", "b3-23-notepad-pill-mid");
else console.log("D2 SKIP: 无书 tab");

// D3 论文笔记面板（paper-notepad-panel）
const stD3 = await storeState();
const paperTabId = stD3.tabs.find((t) => t.type === "paper")?.id;
if (paperTabId) await verifyNotepadPill(paperTabId, "D3 论文笔记面板", "b3-24-paper-pill-mid");
else console.log("D3 SKIP: 无论文 tab");

// ---------- E) 三档退化 ----------
await evalJs(`document.documentElement.dataset.motion = "fade-only"`);
const fadeTokens = await evalJs(
  `(() => { const cs = getComputedStyle(document.documentElement); return JSON.stringify({ slide: cs.getPropertyValue("--motion-slide").trim(), slow: cs.getPropertyValue("--motion-dur-slow").trim() }); })()`,
);
console.log("E fade-tokens", fadeTokens);
{
  const st = await storeState();
  const other =
    st.tabs.find((t) => t.id === bookTabId && t.id !== st.activeTabId) ?? st.tabs.find((t) => t.id !== st.activeTabId);
  if (other) {
    // 构造级证据（确定性）：探针层直接读规则计算值。不用存量层实测——运行期翻 token
    // 时 transform 过渡不保证重启（opacity/visibility 两模型下均有陈旧态伪象，2026-08-27
    // 实测），新鲜元素无过渡历史，gCS 即终值。fade-only 下非活跃层 0.12s + ty=0，
    // 对照 full 档 0.3s + ty=8 → 纯 fade + 时长压短由 token 引用保证
    const probeLayer = () =>
      evalJs(`(() => {
        const main = document.querySelector("main.overflow-clip") ?? document.body;
        const d = document.createElement("div");
        d.className = "tab-layer";
        main.appendChild(d);
        const c = getComputedStyle(d);
        const m = /matrix\\(([^)]+)\\)/.exec(c.transform);
        const ty = m ? Number.parseFloat(m[1].split(",")[5]) : 0;
        const out = JSON.stringify({ dur: c.transitionDuration, ty, op: c.opacity });
        d.remove();
        return out;
      })()`);
    await evalJs(`document.documentElement.dataset.motion = "fade-only"`);
    await sleep(300);
    const proofFade = JSON.parse(await probeLayer());
    await evalJs(`document.documentElement.dataset.motion = "full"`);
    await sleep(300);
    const proofFull = JSON.parse(await probeLayer());
    await evalJs(`document.documentElement.dataset.motion = "fade-only"`);
    check(
      "E fade-only：时长压短 0.12s + 位移归零（对照 full 0.3s + ty=8）",
      proofFade.dur.includes("0.12s") && proofFade.ty === 0 && proofFull.dur.includes("0.3s") && proofFull.ty === 8,
      `fade=${JSON.stringify(proofFade)} full=${JSON.stringify(proofFull)}`,
    );
    // 实证补采（尽力而为）：切书籍 tab，轮询捕 opacity 中间态
    await storeCall(`S.getState().activateTab("${other.id}")`);
    const fadeEvidence = await pollUntil(
      async () => {
        const ls = await readerLayers();
        const midFade = ls.some((s) => {
          const o = Number.parseFloat(s.split(":")[1]);
          return o > 0.05 && o < 0.95;
        });
        return midFade ? ls.join(" ") : null;
      },
      3200,
      40,
    );
    await shot("b3-30-fade-only-tab");
    console.log("E fade-only 实证采样:", fadeEvidence ?? "（负载下 120ms 窗口未捕到，以构造级证据为准）");
    await sleep(400);
  }
}
await evalJs(`document.documentElement.dataset.motion = "reduced"`);
const reducedTokens = await evalJs(
  `(() => { const cs = getComputedStyle(document.documentElement); return JSON.stringify({ slow: cs.getPropertyValue("--motion-dur-slow").trim(), fast: cs.getPropertyValue("--motion-dur-fast").trim() }); })()`,
);
{
  const st = await storeState();
  const other = st.tabs.find((t) => t.id !== st.activeTabId);
  if (other) {
    await storeCall(`S.getState().activateTab("${other.id}")`);
    const reduced = await pollUntil(
      async () => {
        const ls = await readerLayers();
        return ls.filter((s) => !s.startsWith("true")).every(isInactiveSettled) ? ls.join(" ") : null;
      },
      4000,
      100,
    );
    await shot("b3-31-reduced-tab");
    check(
      `E reduced：0.01ms 硬切（离场层立即到隐藏终态，${TAB_HIDE} 模型）`,
      !!reduced,
      `${reducedTokens} ${reduced ?? (await readerLayers()).join(" ")}`,
    );
  }
}
await evalJs(`document.documentElement.dataset.motion = ${JSON.stringify(initialMotion)}`);

// ---------- F) 大 DOM 压力（对照探针） ----------
// 切换卡顿墙会饿死 rAF，帧采样在此无意义；
// 改为定量对照：同一切换在 full / reduced 两档各跑一次，比较「提交耗时 / 强制重算 / 下一绘制帧」，
// 若两档同量级 → 卡顿是 pre-existing，动效（合成器属性）未添主线程成本。
//（2026-08-25 opacity A/B 实验修正归因：墙 = activateTab 后 React 同步 render 单个 long task
// ——PaperReaderView 未 memo，全保活树 ~11 万元素重 reconcile；翻转后强制样式重算两隐藏模型均 ≈0ms，
// content-visibility:auto 已护住屏外块。）
const probeSwitch = async (targetId) =>
  JSON.parse(
    await evalJs(`(async () => {
    const url = performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("/src/store/layout-store.ts")) ?? "/src/store/layout-store.ts";
    const S = (await import(url)).useLayoutStore;
    const main = document.querySelector("main.overflow-clip");
    let tFlip = 0;
    const mo = new MutationObserver(() => { if (!tFlip) tFlip = performance.now(); });
    mo.observe(main, { attributes: true, subtree: true, attributeFilter: ["data-active"] });
    const t0 = performance.now();
    S.getState().activateTab("${targetId}");
    while (!tFlip && performance.now() - t0 < 4000) await new Promise((r) => setTimeout(r, 5));
    mo.disconnect();
    const tCommit = Math.round(performance.now() - t0);
    void document.body.offsetWidth; // 强制同步重算（unhide 成本在此结算）
    const tReflow = Math.round(performance.now() - t0 - tCommit);
    const tNext = await new Promise((res) => {
      const t1 = performance.now();
      requestAnimationFrame(() => requestAnimationFrame(() => res(Math.round(performance.now() - t1))));
    });
    return JSON.stringify({ tCommit, tReflow, tNext });
  })()`),
  );
{
  const st = await storeState();
  const heavyPaper = st.tabs.find((t) => t.type === "paper")?.id;
  const lightBook = st.tabs.find((t) => t.type === "book")?.id ?? st.tabs.find((t) => t.id !== heavyPaper)?.id;
  if (heavyPaper && lightBook) {
    await storeCall(`S.getState().activateTab("${heavyPaper}")`);
    await sleep(1500);
    const domCount = await evalJs(`document.querySelectorAll("*").length`);
    await shot("b3-40-bigdom-paper");
    // full 档：paper→book（轻入场）→ book→paper（重入场，撞 unhide 墙）
    const fullOut = await probeSwitch(lightBook);
    await sleep(400);
    await shot("b3-41-bigdom-switch-mid");
    const fullIn = await probeSwitch(heavyPaper);
    await sleep(400);
    // reduced 档（动效全部 0.01ms，等同改动前硬切世界）：同路径对照
    await evalJs(`document.documentElement.dataset.motion = "reduced"`);
    const reducedOut = await probeSwitch(lightBook);
    await sleep(300);
    const reducedIn = await probeSwitch(heavyPaper);
    await evalJs(`document.documentElement.dataset.motion = ${JSON.stringify(initialMotion)}`);
    console.log(
      `F 大 DOM(${domCount} 元素) 切换对照: full(out/in)=${JSON.stringify(fullOut)}/${JSON.stringify(fullIn)} reduced(out/in)=${JSON.stringify(reducedOut)}/${JSON.stringify(reducedIn)}`,
    );
    // 动效开销 = full - reduced（同向）。unhide 墙体现在 tCommit（React 提交 + 强制样式重算）；
    // 两档 tCommit 同量级 → 墙是 pre-existing，动效（合成器属性）未添主线程成本
    const overheadOut = fullOut.tNext - reducedOut.tNext;
    const overheadCommitIn = fullIn.tCommit - reducedIn.tCommit;
    check(
      "F 轻入场（paper→book）动效开销 < 300ms",
      overheadOut < 300,
      `overhead=${overheadOut}ms full.tNext=${fullOut.tNext} reduced.tNext=${reducedOut.tNext}`,
    );
    check(
      "F 重入场（book→paper）unhide 墙两档同量级（动效未添主线程成本）",
      Math.abs(overheadCommitIn) < Math.max(500, reducedIn.tCommit * 0.5),
      `tCommit full=${fullIn.tCommit}ms reduced=${reducedIn.tCommit}ms（墙≈${reducedIn.tCommit}ms，pre-existing，负载机放大）；tNext full=${fullIn.tNext}ms reduced=${reducedIn.tNext}ms`,
    );
  } else {
    console.log("F SKIP: tab 不足");
  }
}

// ---------- G) 还原现场 ----------
await evalJs(`document.documentElement.dataset.motion = ${JSON.stringify(initialMotion)}`);
for (const tid of openedByMe) {
  await storeCall(`S.getState().removeTab("${tid}")`);
  await sleep(300);
}
if (initial.isHomeActive) {
  await storeCall(`S.getState().navigateToHome()`);
} else if (initial.activeTabId) {
  await storeCall(`S.getState().activateTab("${initial.activeTabId}")`);
}
await evalJs(`location.hash = ${JSON.stringify(initialHash || "#/")}`);
await sleep(600);
await shot("b3-99-restored");

console.log("\n===== SUMMARY =====");
for (const r of results) console.log(r);
ws.close();
process.exit(0);
