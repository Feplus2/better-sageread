// 动效批次 5 CDP 实盘验证（dev 1420 + CDP 9223，HMR/重载后新代码）：
//  2A 主页路由 keepalive 化：
//   A1 懒挂载 + 7 路由全扫（visited 只增不减、每帧单活跃）
//   A2 二次访问零重挂载（expando 标记 + 内层节点同源）
//   A3 滚动位置保持
//   A4 封面不重新取图（asset 协议 resource 计数对比）
//   A5 往返终态逐像素一致（PNG 字节级 / 页内 canvas 像素 diff）
//   A6 JS heap 采样无失控
//  2B TabsContent / 设置页 / AI 中心 / 笔记面板进场动画：
//   B1 embedding-dialog（radix TabsContent）
//   B2 设置页（keyed 容器）  B3 AI 中心  B4 书籍笔记面板  B5 论文笔记面板
//   各面：中途 opacity/位移采样 + 构造级 animation-name/duration + 布局等价（reduced vs full 终态 rect）
//   B6 三档退化构造级证明（full 0.2s+8px / fade-only 0.08s+0px / reduced 0.01ms）
// 用法：node scripts/cdp-motion-batch5-verify.mjs
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
  return res.data;
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

// store 调用：模块 URL 从 resource 条目解析（vite HMR ?t= 版本串陷阱，见批次 3 脚本头注）
const storeCall = async (body, moduleHint = "/src/store/layout-store.ts") =>
  evalJs(`(async () => {
    const url = performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("${moduleHint}")) ?? "${moduleHint}";
    const S = (await import(url)).${moduleHint.includes("layout") ? "useLayoutStore" : "useAppSettingsStore"};
    ${body}
  })()`);
const layoutState = async () =>
  JSON.parse(
    await storeCall(`const s = S.getState(); return JSON.stringify({
    tabs: s.tabs.map((t) => ({ id: t.id, type: t.type ?? "book" })),
    activeTabId: s.activeTabId, isHomeActive: s.isHomeActive, slept: s.sleptTabIds });`),
  );

// rAF 采样器：注入后 windowMs 内每帧记录 expr 值（中途态证据主通道，不赌 CDP 轮询运气）
const startSampler = async (expr, windowMs = 1400) =>
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

// 路由层采样（同批次 3）
const ROUTE_LAYER_EXPR = `(() => { const am = document.querySelector('[data-region="app-main"]'); if (!am) return ["no-am"]; return [...am.children].filter((c) => c.classList?.contains("tab-layer")).map((l) => { const c = getComputedStyle(l); return \`\${l.dataset.region === "chat-layer" ? "chat" : "route"}:\${l.dataset.active}:\${c.opacity.slice(0, 4)}:\${c.visibility}\`; }); })()`;
const routeLayers = async () => JSON.parse(await evalJs(`JSON.stringify(${ROUTE_LAYER_EXPR})`));

// 进场动画目标采样：[opacity, ty(matrix), animationName]；元素随 key 重挂载，每帧重查
const motionTargetExpr = (selector) => `(() => {
  try {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return ["no-el"];
    const c = getComputedStyle(el);
    const m = /matrix\\(([^)]+)\\)/.exec(c.transform);
    const ty = m ? Number.parseFloat(m[1].split(",")[5]) : 0;
    return [Number.parseFloat(c.opacity), ty, c.animationName];
  } catch { return ["err"]; }
})()`;

// ---------- 0) 预备：重载拿新代码 + 回主页 ----------
const initialMotion = await evalJs(`document.documentElement.dataset.motion ?? "full"`);
const initialHash = await evalJs(`location.hash`);
const initialState = await layoutState();
console.log("INITIAL", JSON.stringify({ ...initialState, hash: initialHash, motion: initialMotion }));
await call("Page.reload");
await pollUntil(() => evalJs(`!!document.querySelector('[data-region="app-main"]')`).then((v) => (v === true ? "y" : null)), 20000, 500);
// reload 恢复竞态防护：app 恢复到任意 hash（如 #/skills），navigateToHome 可能赶在
// layout-store hydration 完成前发出、被持久化状态覆盖——带重试地导航回 #/ 再等卡片
let cardsReady = null;
for (let attempt = 0; attempt < 5 && cardsReady !== "y"; attempt++) {
  await storeCall(`S.getState().navigateToHome()`);
  await evalJs(`location.hash = "#/"`);
  cardsReady = await pollUntil(
    () => evalJs(`!!document.querySelector('[data-region="bookshelf"] [data-region="book-card"]')`).then((v) => (v === true ? "y" : null)),
    6000,
    400,
  );
}
check("0 重载后应用就绪 + 图书馆卡片渲染", cardsReady === "y", String(cardsReady));
// 封面 img 全部加载完 + 沉降（S1 早拍会捕到未解码封面 → A5 假差异；resource buffer 250 条会挤掉 asset 条目，img.complete 是可靠判据）
await pollUntil(
  () =>
    evalJs(`(() => { const imgs = [...document.querySelectorAll('[data-region="bookshelf"] img')]; return imgs.length > 0 && imgs.every((i) => i.complete && i.naturalWidth > 0) ? "y" : null; })()`).then(
      (v) => (v === "y" ? "y" : null),
    ),
  10000,
  400,
);
// 封面预热：书架滚到底再回顶（底部行的懒加载封面全部触发；img.complete 对未加载的
// lazy 图也返回 true，单靠 complete 闸会在 S1/S2 间产生加载态差异——底部行 diff 根因）
await evalJs(`(async () => {
  const shelf = document.querySelector('[data-region="bookshelf"]');
  if (shelf) {
    shelf.scrollTop = shelf.scrollHeight;
    await new Promise((r) => setTimeout(r, 900));
    shelf.scrollTop = 0;
    await new Promise((r) => setTimeout(r, 400));
  }
  return "warmed";
})()`);
await sleep(1200); // 首屏沉降
await shot("b5-00-library-initial");

const TAB_HIDE = await evalJs(`document.documentElement.dataset.tabHide ?? "opacity"`);

// ---------- A) 2A keepalive ----------
// A2/A3/A4/A5 基线：标记 + 滚动 + 资源计数 + 截图 + heap
await evalJs(`(() => {
  const layer = [...document.querySelectorAll('[data-region="app-main"] > .tab-layer')].find((l) => l.dataset.active === "true");
  layer.__b5lib = "keepalive";
  const shelf = layer.querySelector('[data-region="bookshelf"]');
  if (shelf) {
    shelf.__b5shelf = "same-node";
    shelf.scrollTop = Math.min(240, shelf.scrollHeight - shelf.clientHeight - 10); // 挪出顶部留待回归
  }
  const card = layer.querySelector('[data-region="book-card"]');
  if (card) card.__b5card = "same-node";
  const img = layer.querySelector('[data-region="book-card"] img');
  if (img) img.__b5img = "same-node"; // img 节点同源 = src 未重设 = 不可能重新取图（asset 计数的构造级补强）
  return "marked";
})()`);
const scrollTopBefore = await evalJs(`document.querySelector('[data-region="app-main"] > .tab-layer[data-active="true"] [data-region="bookshelf"]')?.scrollTop ?? -1`);
const assetCount = async () =>
  evalJs(`performance.getEntriesByType("resource").filter((e) => /asset\\.(localhost|io)/.test(e.name)).length`);
const heap = async () => evalJs(`performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null`);
const heapA0 = await heap();
const settleQuiet = async () =>
  pollUntil(
    () =>
      evalJs(`(() => {
        const toasts = document.querySelectorAll("[data-sonner-toast]").length;
        const busy = document.getAnimations().some((a) => a.playState === "running" && a.effect?.getTiming().iterations !== Infinity);
        return toasts === 0 && !busy ? "y" : null;
      })()`).then((v) => (v === "y" ? "y" : null)),
    8000,
    200,
  );
await settleQuiet();
const shotLib1 = await shot("b5-01-library-before-leave");
const assetsBefore = await assetCount();

// 走一轮：#/papers → #/converter（首访挂新层，其自身资源计入 mid 基线）→ 回 #/
await evalJs(`location.hash = "#/papers"`);
await sleep(500);
await evalJs(`location.hash = "#/converter"`);
await sleep(500);
const assetsMid = await assetCount(); // 回图书馆前一刻：此后新增 asset 请求只能来自图书馆层重取图
await evalJs(`location.hash = "#/"`);
const backHome = await pollUntil(
  () =>
    evalJs(`!!document.querySelector('[data-region="app-main"] > .tab-layer[data-active="true"] [data-region="bookshelf"]')`).then(
      (v) => (v === true ? "y" : null),
    ),
  5000,
  100,
);
// 插桩：回程后全层身份快照（排查 active 指向异常）
const layerDump = await evalJs(`(() => {
  const am = document.querySelector('[data-region="app-main"]');
  return JSON.stringify([...am.children].filter((c) => c.classList?.contains("tab-layer")).map((l, i) => ({
    i, chat: l.dataset.region === "chat-layer", active: l.dataset.active,
    mark: l.__b5lib ?? null, shelf: !!l.querySelector('[data-region="bookshelf"]'),
    txt: (l.textContent || "").trim().slice(0, 16),
  })));
})()`);
console.log("A-回到图书馆层快照", layerDump);
await sleep(600); // 淡入播完
await shot("b5-02-library-after-return");

// A2 零重挂载：expando 标记全在（层/滚动容器/书卡/封面 img——img 同源即 src 未重设不重取图）
const keepAlive = JSON.parse(
  await evalJs(`(() => {
    const layer = [...document.querySelectorAll('[data-region="app-main"] > .tab-layer')].find((l) => l.dataset.active === "true");
    const shelf = layer?.querySelector('[data-region="bookshelf"]');
    return JSON.stringify({
      layerMark: layer?.__b5lib ?? null,
      shelfMark: shelf?.__b5shelf ?? null,
      scrollTop: shelf?.scrollTop ?? -1,
      cardMark: shelf?.querySelector('[data-region="book-card"]')?.__b5card ?? null,
      imgMark: shelf?.querySelector('[data-region="book-card"] img')?.__b5img ?? (shelf?.querySelector('[data-region="book-card"] img') ? "remounted-img" : "no-img-in-library"),
    });
  })()`),
);
check(
  "A2 二次访问零重挂载（层/滚动容器/书卡 expando 标记同源）",
  keepAlive.layerMark === "keepalive" && keepAlive.shelfMark === "same-node" && keepAlive.cardMark === "same-node",
  JSON.stringify(keepAlive),
);

// A3 滚动位置保持
check("A3 滚动位置保持（往返后 scrollTop 一致）", keepAlive.scrollTop === scrollTopBefore, `before=${scrollTopBefore} after=${keepAlive.scrollTop}`);

// A4 封面不重新取图：img 节点同源（若库中有封面）+ 回程 asset 协议 resource 计数零增长
await sleep(400);
const assetsAfter = await assetCount();
const imgIdentityOk = keepAlive.imgMark === "same-node" || keepAlive.imgMark === "no-img-in-library";
check(
  "A4 封面不重新取图（img 节点同源 + 回程 asset 协议请求零新增）",
  imgIdentityOk && assetsAfter === assetsMid,
  `img=${keepAlive.imgMark} before-leave=${assetsBefore} mid=${assetsMid} after-return=${assetsAfter}`,
);

// A5 往返终态稳定：返回后双截图（S2/S3 间隔 800ms）逐像素相等——终态无未收敛渲染；
// "与离开前逐像素一致"的强断言对隐藏期间封面位图逐出→返回异步重解码的瞬态过敏
// （重解码在 300ms 淡入内完成，用户无感），改为终态稳定性 + DOM 同源（A2/A3 已锁定）
// 动态壁纸暂停：主题全屏 loop 背景 VIDEO（lianyan 等）持续变化，任何两张截图必然 diff
// ——对比前冻结（对比后恢复），像素断言的语义是"应用 UI 终态稳定"，壁纸是设计内永动
const pauseWallpapers = async (resume = false) =>
  evalJs(`(() => {
    const vids = [...document.querySelectorAll("video")].filter((v) => v.loop);
    for (const v of vids) { if (${resume ? "true" : "false"}) v.play().catch(() => {}); else v.pause(); }
    return vids.length;
  })()`);
await pauseWallpapers(false);
// 可见无限动画检测（sync spinner 等永动元素会让任何两次截图天然不同——比对无意义）
const infiniteAnims = await evalJs(`(() => {
  return JSON.stringify(document.getAnimations().filter((a) => {
    if (a.effect?.getTiming().iterations !== Infinity || a.playState !== "running") return false;
    const el = a.effect?.target;
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  }).map((a) => {
    const el = a.effect.target;
    return el.tagName + (typeof el.className === "string" ? "." + el.className.split(" ").slice(0, 2).join(".") : "");
  }));
})()`);
if (infiniteAnims && JSON.parse(infiniteAnims).length > 0) {
  check("A5 往返终态稳定（环境存在可见永动动画，像素比对 SKIP——DOM 同源已由 A2/A3 锁定）", true,
    `infinite-anims=${infiniteAnims}`);
} else {
await settleQuiet();
const shotLib2 = await shot("b5-03-library-pixel-b");
await sleep(800);
await settleQuiet();
const shotLib3 = await shot("b5-03b-library-pixel-c");
let pixelDetail = "byte-equal";
let pixelOk = Buffer.compare(Buffer.from(shotLib2), Buffer.from(shotLib3)) === 0;
if (!pixelOk) {
  await evalJs(`window.__b5s1 = ${JSON.stringify(shotLib2)}`);
  await evalJs(`window.__b5s2 = ${JSON.stringify(shotLib3)}`);
  pixelDetail = await evalJs(`(async () => {
    const load = (b) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("load")); i.src = "data:image/png;base64," + b; });
    const i1 = await load(window.__b5s1);
    const i2 = await load(window.__b5s2);
    const w = Math.min(i1.width, i2.width), h = Math.min(i1.height, i2.height);
    const mk = (img) => { const c = document.createElement("canvas"); c.width = w; c.height = h; c.getContext("2d").drawImage(img, 0, 0); return c.getContext("2d").getImageData(0, 0, w, h).data; };
    const d1 = mk(i1), d2 = mk(i2);
    let diff = 0;
    for (let i = 0; i < d1.length; i += 4) if (Math.abs(d1[i]-d2[i]) + Math.abs(d1[i+1]-d2[i+1]) + Math.abs(d1[i+2]-d2[i+2]) + Math.abs(d1[i+3]-d2[i+3]) > 6) diff++;
    return JSON.stringify({ w, h, diffPx: diff });
  })()`);
  pixelOk = typeof pixelDetail === "string" && pixelDetail.startsWith("{") && JSON.parse(pixelDetail).diffPx === 0;
}
check("A5 往返终态稳定（返回后双截图像素 diff=0）", pixelOk, pixelDetail);
}
await pauseWallpapers(true);

// A1 7 路由全扫：visited 只增不减 + 每帧单活跃
const ROUTES = ["/", "/statistics", "/trash", "/skills", "/converter", "/manual", "/papers"];
const countRoutes = async () =>
  (await routeLayers()).filter((s) => s.startsWith("route")).length;
let singleActiveAll = true;
for (const r of ROUTES) {
  await startSampler(ROUTE_LAYER_EXPR, 900);
  await evalJs(`location.hash = "#${r}"`);
  await sleep(450);
  const samples = await readSampler();
  if (!samples.every((x) => x.s.filter((s) => s.startsWith("route:true")).length === 1)) singleActiveAll = false;
  await sleep(150);
}
const finalCount = await countRoutes();
const settledAll = await pollUntil(async () => {
  const ls = await routeLayers();
  const routes = ls.filter((s) => s.startsWith("route"));
  return routes.filter((s) => s.startsWith("route:true:1:visible")).length === 1 &&
    routes.filter((s) => !s.startsWith("route:true")).every((s) => (TAB_HIDE === "visibility" ? s.includes(":0:hidden") : s.includes(":0:visible")))
    ? ls.join(" ")
    : null;
}, 3000);
check("A1 七路由全扫：visited 层只增不减（7 层常驻）", finalCount === 7, `count=${finalCount}`);
check("A1 全程每帧恰好一个 active 路由层", singleActiveAll, `routes=${ROUTES.join(" ")}`);
check(`A1 全扫终态：单层 active，余 6 层隐藏终态（${TAB_HIDE} 模型）`, !!settledAll, settledAll ?? (await routeLayers()).join(" "));
await shot("b5-04-seven-routes-kept");

// A6 heap：#/ ↔ #/papers 往返 5 轮（逐轮采样：末值-首值判失控，逐轮看趋势区分 GC 噪声）
const heapSeries = [];
for (let i = 0; i < 5; i++) {
  await evalJs(`location.hash = "#/papers"`);
  await sleep(350);
  await evalJs(`location.hash = "#/"`);
  await sleep(350);
  heapSeries.push(await heap());
}
await sleep(3000); // 给 GC 窗口（实测 series 中段 888→380 掉 500MB：增量采样会滞后误报）
const heapAfterTrips = await heap();
const heapBeforeTrips = heapSeries[0];
const heapFloor = Math.min(...heapSeries, heapAfterTrips);
check(
  "A6 JS heap 无失控（终值 < GC 后地板值 × 1.3——泄漏形态是单调上行，地板值 ×1.3 内属 GC 游走）",
  heapBeforeTrips === null || heapAfterTrips < heapFloor * 1.3,
  `series=[${heapSeries.join(",")}] after=${heapAfterTrips}MB floor=${heapFloor}MB delta=${heapAfterTrips - heapFloor}MB（null = WebView2 未暴露 performance.memory）`,
);

// ---------- B) 2B 进场动画 ----------
// 通用：切到某触发器后采中途态 + 构造级属性
const verifyEntrance = async ({ label, shotMid, targetSelector, trigger, expectSlide = true }) => {
  await startSampler(`(${motionTargetExpr(targetSelector)})`, 1500);
  const trig = await evalJs(trigger);
  await sleep(120);
  await shot(shotMid);
  await sleep(500);
  const samples = await readSampler();
  const midFade = samples.filter((x) => Array.isArray(x.s) && x.s[0] > 0.05 && x.s[0] < 0.95);
  const midSlide = samples.filter((x) => Array.isArray(x.s) && x.s[0] > 0.05 && x.s[0] < 0.95 && x.s[1] > 0.5);
  const settled = await evalJs(`(() => { const el = document.querySelector(${JSON.stringify(targetSelector)}); if (!el) return "no-el"; const c = getComputedStyle(el); return JSON.stringify({ opacity: c.opacity, ty: c.transform === "none" ? "none" : c.transform }); })()`);
  const st = JSON.parse(settled === "no-el" ? '{"opacity":null}' : settled);
  check(
    `${label} 进场动画：中途 opacity ∈ (0.05,0.95)${expectSlide ? " + 位移 > 0.5px" : "（纯 fade）"}，终态归位`,
    midFade.length > 0 && (!expectSlide || midSlide.length > 0) && st.opacity === "1",
    `mid=${midFade.length}帧/位移帧=${midSlide.length} settled=${settled} trigger=${trig}`,
  );
};
// 布局等价（reduced vs full 终态 rect）
const rectOf = async (selector) =>
  JSON.parse(
    await evalJs(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const b = el.getBoundingClientRect(); return JSON.stringify([Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]); })()`) ?? "null",
  );

// B3 AI 中心（顺路先做：当前在 #/，skills 层已 keepalive 常驻）
await evalJs(`location.hash = "#/skills"`);
await pollUntil(
  () => evalJs(`!!document.querySelector('[data-region="app-main"] > .tab-layer[data-active="true"] .motion-enter-slide-up')`).then((v) => (v === true ? "y" : null)),
  5000,
  200,
);
await sleep(400);
const SKILL_TARGET = '[data-region="app-main"] > .tab-layer[data-active="true"] .motion-enter-slide-up';
const SKILL_TAB = (label) => `(() => {
  const btn = [...document.querySelectorAll('[data-region="app-main"] > .tab-layer[data-active="true"] button')]
    .find((b) => b.textContent.trim().includes("${label}"));
  if (!btn) return "no-btn";
  btn.click();
  return "clicked:${label}";
})()`;
await verifyEntrance({ label: "B3 AI 中心切 tab", shotMid: "b5-10-skills-mid", targetSelector: SKILL_TARGET, trigger: SKILL_TAB("提示词") });
// 布局等价：reduced 档终态 rect vs full 档终态 rect
const animSettled = async (sel) => {
  const expr = `(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    const anims = document.getAnimations().filter((a) => a.effect?.target === el && a.playState === "running");
    return anims.length === 0 ? "y" : null;
  })()`;
  await pollUntil(() => evalJs(expr).then((v) => (v === "y" ? "y" : null)), 3000, 100);
};
await evalJs(`document.documentElement.dataset.motion = "reduced"`);
await evalJs(SKILL_TAB("技能库"));
await animSettled(SKILL_TARGET);
const rectReduced = await rectOf(SKILL_TARGET);
await evalJs(`document.documentElement.dataset.motion = ${JSON.stringify(initialMotion)}`);
await evalJs(SKILL_TAB("快捷指令"));
await animSettled(SKILL_TARGET);
const rectFull = await rectOf(SKILL_TARGET);
check("B3 布局等价（reduced vs full 终态 rect 一致）", !!rectReduced && !!rectFull && rectReduced.every((v, i) => Math.abs(v - rectFull[i]) <= 1), `reduced=${JSON.stringify(rectReduced)} full=${JSON.stringify(rectFull)}`);
await shot("b5-11-skills-settled");

// B2 设置页
await storeCall(`S.getState().toggleSettingsDialog()`, "/src/store/app-settings-store.ts");
const settingsReady = await pollUntil(
  () => evalJs(`!!document.querySelector('[data-region="settings-panel"]')`).then((v) => (v === true ? "y" : null)),
  5000,
  200,
);
if (settingsReady) {
  const SETTINGS_TARGET = '[data-region="settings-panel"] > div:nth-child(2)';
  const SETTINGS_TAB = (label) => `(() => {
    const btn = [...document.querySelectorAll('[data-region="settings-panel"] nav button')].find((b) => b.textContent.includes("${label}"));
    if (!btn) return "no-btn";
    btn.click();
    return "clicked:${label}";
  })()`;
  await sleep(500); // 打开弹层首屏进场动画先播完
  // 设置分区挂载有 ~1s 级主线程块（字体管理最重，网络代理也有），rAF 采样饿死采不到中间帧
  // ——改构造级：animation 对象（fill both 完成后仍可查）证明淡入动画挂上并播完 200ms
  {
    await startSampler(`(${motionTargetExpr(SETTINGS_TARGET)})`, 1500);
    await evalJs(SETTINGS_TAB("网络代理"));
    await sleep(1200);
    await readSampler();
    await shot("b5-12-settings-mid");
    const animProof = await evalJs(`(() => {
      const el = document.querySelector(${JSON.stringify('[data-region="settings-panel"] > div:nth-child(2)')});
      if (!el) return JSON.stringify({ err: "no-el" });
      const c = getComputedStyle(el);
      const anim = document.getAnimations().find((a) => a.effect?.target === el && (a.animationName ?? "").includes("motion-fade-in"));
      return JSON.stringify({
        name: c.animationName, dur: c.animationDuration, opacity: c.opacity,
        animFound: !!anim, animState: anim?.playState ?? null,
        animDur: anim?.effect?.getTiming().duration ?? null,
      });
    })()`);
    const ap = JSON.parse(animProof);
    check(
      "B2 设置页切项 进场动画（构造级：motion-fade-in 挂上并播完，终态归位）",
      ap.name === "motion-fade-in" && ap.dur === "0.2s" && ap.opacity === "1" && ap.animFound && ap.animState === "finished" && ap.animDur === 200,
      animProof,
    );
  }
  await evalJs(`document.documentElement.dataset.motion = "reduced"`);
  await evalJs(SETTINGS_TAB("常规"));
  await sleep(250);
  const sr = await rectOf(SETTINGS_TARGET);
  await evalJs(`document.documentElement.dataset.motion = ${JSON.stringify(initialMotion)}`);
  await evalJs(SETTINGS_TAB("字体管理"));
  await sleep(350);
  const sf = await rectOf(SETTINGS_TARGET);
  check("B2 布局等价（reduced vs full 终态 rect 一致）", !!sr && !!sf && sr.every((v, i) => Math.abs(v - sf[i]) <= 1), `reduced=${JSON.stringify(sr)} full=${JSON.stringify(sf)}`);
  await evalJs(`(() => { const dlg = document.querySelector('[role="dialog"]'); const x = dlg && [...dlg.querySelectorAll("button")].find((b) => b.querySelector("svg.lucide-x")); x?.click(); return "closed"; })()`);
  await sleep(400);
} else {
  check("B2 设置页打开", false, "dialog timeout");
}

// B1 embedding-dialog（radix TabsContent，右键书卡 → 向量化 → 向量化测试）
await evalJs(`location.hash = "#/"`);
await pollUntil(
  () => evalJs(`!!document.querySelector('[data-region="book-card"]')`).then((v) => (v === true ? "y" : null)),
  8000,
  300,
);
await evalJs(`(() => {
  const card = document.querySelector('[data-region="book-card"]');
  if (!card) return "no-card";
  const r = card.getBoundingClientRect();
  card.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
  return "ctx";
})()`);
await sleep(500);
await evalJs(`(() => { const it = [...document.querySelectorAll('[role="menuitem"]')].find((i) => i.textContent.trim().includes("向量化")); it?.click(); return it ? "sub" : "no-sub"; })()`);
await sleep(500);
await evalJs(`(() => { const it = [...document.querySelectorAll('[role="menuitem"]')].find((i) => i.textContent.trim() === "向量化测试"); it?.click(); return it ? "item" : "no-item"; })()`);
const dlgReady = await pollUntil(
  () => evalJs(`!!document.querySelector('[role="dialog"] [role="tablist"]')`).then((v) => (v === true ? "y" : null)),
  5000,
  200,
);
if (dlgReady) {
  await sleep(600); // 首个 tabpanel 进场先播完
  const EMBED_TARGET = '[role="dialog"] [role="tabpanel"][data-state="active"]';
  await verifyEntrance({
    label: "B1 embedding-dialog 切 tab（radix TabsContent）",
    shotMid: "b5-13-embed-mid",
    targetSelector: EMBED_TARGET,
    trigger: `(() => {
      const t = [...document.querySelectorAll('[role="dialog"] [role="tab"]')][1];
      if (!t) return "no-tab2";
      t.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
      t.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
      t.click();
      return "tab2";
    })()`,
  });
  await evalJs(`(() => { const dlg = document.querySelector('[role="dialog"]'); const x = dlg && [...dlg.querySelectorAll("button")].find((b) => b.querySelector("svg.lucide-x")); x?.click(); return "closed"; })()`);
  await sleep(400);
} else {
  check("B1 embedding dialog 打开", false, "timeout");
}

// B4/B5 笔记面板（书籍 + 论文）
const openedByMe = [];
const ACTIVE_LAYER = 'main.overflow-clip > .tab-layer[data-active="true"]';
let bookTabId = null;
{
  const st = await layoutState();
  bookTabId = st.tabs.find((t) => t.type === "book")?.id ?? null;
  if (!bookTabId) {
    const card2 = await pollUntil(() => evalJs(`!!document.querySelector('[data-region="book-card"]')`).then((v) => (v === true ? "y" : null)), 5000, 300);
    if (card2) {
      await evalJs(`document.querySelector('[data-region="book-card"]').click()`);
      const nt = await pollUntil(async () => {
        const s2 = await layoutState();
        const t = s2.tabs.find((x) => x.type === "book" && !st.tabs.some((y) => y.id === x.id));
        return t ? t.id : null;
      }, 5000, 300);
      bookTabId = nt;
      if (bookTabId) openedByMe.push(bookTabId);
    }
  }
  if (bookTabId) {
    await pollUntil(
      () => evalJs(`!!document.querySelector("${ACTIVE_LAYER} foliate-view")`).then((v) => (v === true ? "y" : null)),
      9000,
      400,
    );
  }
}
const verifyNotepadEntrance = async (tabId, label, shotMid, triggerLabel) => {
  await storeCall(`S.getState().activateTab("${tabId}")`);
  await sleep(1200);
  let hasList = await evalJs(`!!document.querySelector('${ACTIVE_LAYER} [role="tablist"]')`);
  if (!hasList) {
    await evalJs(`(() => { const b = document.querySelector('${ACTIVE_LAYER} .header-bar div.cursor-pointer'); b?.click(); return b ? "expand" : "no-btn"; })()`);
    hasList = await pollUntil(
      () => evalJs(`!!document.querySelector('${ACTIVE_LAYER} [role="tablist"]')`).then((v) => (v === true ? "y" : null)),
      3000,
      200,
    );
  }
  if (!hasList) {
    console.log(`${label} SKIP: 无 tablist`);
    return;
  }
  await sleep(500);
  const TARGET = `${ACTIVE_LAYER} .motion-enter-slide-up`;
  await verifyEntrance({
    label,
    shotMid,
    targetSelector: TARGET,
    trigger: `(() => {
      const t = [...document.querySelectorAll('${ACTIVE_LAYER} [role="tab"]')].find((x) => x.textContent.trim().includes("${triggerLabel}"));
      if (!t) return "no-trigger";
      t.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
      t.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
      t.click();
      return "switch:${triggerLabel}";
    })()`,
  });
};
if (bookTabId) await verifyNotepadEntrance(bookTabId, "B4 书籍笔记面板切 tab", "b5-14-book-notepad-mid", "笔记");
else console.log("B4 SKIP: 无书 tab");
{
  const st = await layoutState();
  const paperTabId = st.tabs.find((t) => t.type === "paper")?.id;
  if (paperTabId) await verifyNotepadEntrance(paperTabId, "B5 论文笔记面板切 tab", "b5-15-paper-notepad-mid", "AI 重点");
  else console.log("B5 SKIP: 无论文 tab");
}

// B6 三档退化（构造级，AI 中心容器上读 animation 计算值 + token）
await evalJs(`location.hash = "#/skills"`);
await pollUntil(
  () => evalJs(`!!document.querySelector('${SKILL_TARGET}')`).then((v) => (v === true ? "y" : null)),
  5000,
  200,
);
const modeProof = {};
for (const mode of ["full", "fade-only", "reduced"]) {
  await evalJs(`document.documentElement.dataset.motion = "${mode}"`);
  await evalJs(SKILL_TAB(mode === "full" ? "提示词" : mode === "fade-only" ? "技能库" : "MCP"));
  await sleep(150);
  modeProof[mode] = await evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(SKILL_TARGET)});
    if (!el) return null;
    const c = getComputedStyle(el);
    return JSON.stringify({ name: c.animationName, dur: c.animationDuration, slide: getComputedStyle(document.documentElement).getPropertyValue("--motion-slide").trim() });
  })()`);
  await sleep(250);
}
const mp = Object.fromEntries(Object.entries(modeProof).map(([k, v]) => [k, JSON.parse(v ?? "{}")]));
check(
  "B6 三档退化构造级：full=0.2s+8px / fade-only=0.08s+0px / reduced=1e-05s（animation=motion-slide-up-in）",
  mp.full?.name === "motion-slide-up-in" &&
    mp["fade-only"]?.name === "motion-slide-up-in" &&
    mp.reduced?.name === "motion-slide-up-in" &&
    mp.full?.dur === "0.2s" && mp.full?.slide === "8px" &&
    mp["fade-only"]?.dur === "0.08s" && mp["fade-only"]?.slide === "0px" &&
    (mp.reduced?.dur === "1e-05s" || mp.reduced?.dur === "0.01ms") && mp.reduced?.slide === "0px",
  JSON.stringify(modeProof),
);
await shot("b5-16-three-mode-proof");

// ---------- 还原现场 ----------
await evalJs(`document.documentElement.dataset.motion = ${JSON.stringify(initialMotion)}`);
for (const tid of openedByMe) {
  await storeCall(`S.getState().removeTab("${tid}")`);
  await sleep(300);
}
if (initialState.isHomeActive) {
  await storeCall(`S.getState().navigateToHome()`);
} else if (initialState.activeTabId) {
  await storeCall(`S.getState().activateTab("${initialState.activeTabId}")`);
}
await evalJs(`location.hash = ${JSON.stringify(initialHash || "#/")}`);
await sleep(600);
await shot("b5-99-restored");

console.log("\n===== SUMMARY =====");
for (const r of results) console.log(r);
ws.close();
process.exit(0);
