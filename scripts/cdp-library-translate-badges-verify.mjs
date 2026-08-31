// 图书馆右键「翻译」入口 + 转换队列选项徽标 CDP 实盘验证（2026-08-31 两小项）。
//
// Part A（转换窗口，零 token）：
//   A1 占位占住 book-convert 唯一并发槽（occupyForRecovery）→ 三份 PDF 全部停在 queued
//   A2 入队时选项快照成行上徽标（强制 OCR / 译为中文）；queued 行徽标可点（popover 触发器在）
//   A3 改顶部「新入队默认选项」后新入队行徽标变、旧行不变（快照语义）
//   A4 queued 行点徽标 → 弹小编辑 → 改 OCR/翻译 → 保存 → store payload 断言 + 行徽标更新
//   A5 释放占位 → 首本转 running → 其行徽标只读（无 popover 触发器）；随即取消（杀掉真实转换进程）
//   A6 顶部「新入队默认选项」说明文案在
// Part B（图书馆右键翻译，真实小书翻译 = 少量 token，沿用 btq 极小 EPUB）：
//   B1 导入极小英文 EPUB + 中文 EPUB（temp 路径绕 plugin-fs 作用域）
//   B2 右键英文书 → 菜单含「翻译」且可用 → 点击 → toast「已加入翻译队列」+ book-translate 任务在跑
//      + 右下角「图书翻译」通道卡出现（截图）
//   B3 翻译在跑时右键同书 → 向量化子菜单点「开始向量化」→ toast 冲突文案、无 book-vectorize 任务
//   B4 右键中文书 →「翻译」置灰（data-disabled）+ 悬停 tooltip「中文书籍无需对照翻译」（截图）
//   B5 等小书翻译完成（solo 结算刷新图书馆列表，meta.status=complete 在 store 可见）
//   B6 再右键 → 「重新翻译」；ask 确认框用 fetch 桩（Tauri IPC 走 window.fetch → ipc.localhost，
//      __TAURI_INTERNALS__ 全员只读不可桩）：先答 false → 载荷断言（标题/全量重翻文案）+ 不入队；
//      再答 true → 入队且 payload.force=true、solo=true
// 收尾：取消/清理全部测试任务，彻底删除测试书籍，还原转换默认选项与 invoke。
//
// 运行：node scripts/cdp-library-translate-badges-verify.mjs（需 dev 实例 1420/9223 在跑；
// 中文书资产缺则先跑 node .tmp-bt-verify/make-zh-asset.mjs）
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const assetDir = join(repoRoot, ".tmp-bt-verify");
for (const f of ["btq-tiny.epub", "btq-zh.epub", "BTQ Alpha.pdf", "BTQ Beta.pdf", "BTQ Gamma.pdf"]) {
  if (!existsSync(join(assetDir, f))) throw new Error(`缺测试资产 ${f}（epub 缺跑 make-assets/make-zh-asset）`);
}
const tempAssetDir = join(tmpdir(), "btq-menu-verify");
mkdirSync(tempAssetDir, { recursive: true });
const tempTiny = join(tempAssetDir, "btq-tiny.epub");
const tempZh = join(tempAssetDir, "btq-zh.epub");
copyFileSync(join(assetDir, "btq-tiny.epub"), tempTiny);
copyFileSync(join(assetDir, "btq-zh.epub"), tempZh);

const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
if (!page) throw new Error("未找到 dev 页面（1420/9223）");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result);
    pending.delete(msg.id);
  }
};
await new Promise((r) => {
  ws.onopen = r;
});
const call = (method, params = {}) =>
  new Promise((r) => {
    mid += 1;
    const id = mid;
    pending.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
await call("Runtime.enable");
await call("Page.enable");

const evalJS = async (expression) => {
  const r = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description ?? "eval 失败").slice(0, 800));
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pollUntil = async (fn, timeout, step = 500) => {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await fn();
    if (last) return last;
    await sleep(step);
  }
  return null;
};
const shot = async (name) => {
  const res = await call("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(assetDir, `${name}.png`), Buffer.from(res.data, "base64"));
  return name;
};
const modUrl = async (frag) => {
  const u = await evalJS(
    `(performance.getEntriesByType("resource").map((e) => e.name).filter((n) => n.includes(${JSON.stringify(frag)})).pop() ?? null)`,
  );
  return u ?? `/src/${frag}`;
};

let passed = 0;
const failures = [];
const check = (name, cond, info = "") => {
  if (cond) {
    passed++;
    console.log(`ok - ${name}`);
  } else {
    failures.push(name);
    console.error(`FAIL - ${name} ${info}`);
  }
};

// 刷新页面拿全新模块实例（本次改动含 store/页面组件，必须整页重载避免 HMR 双实例）
await call("Page.reload", { ignoreCache: true });
await sleep(1000);
const ready = await pollUntil(
  async () => {
    try {
      const regUrl = await modUrl("store/task-executor-registry.ts");
      return await evalJS(`(async () => {
        const reg = await import(${JSON.stringify(regUrl)});
        const channels = !!reg.getChannelDef("book-translate") && !!reg.getChannelDef("book-convert");
        if (!channels) return false;
        // 标签页持久化可能把应用恢复进阅读器视图（尤其测试书被删后的空白 tab）——不在书架则回主页
        if (!document.querySelector('[data-region="bookshelf"]')) {
          const layout = await import(${JSON.stringify(await modUrl("store/layout-store.ts"))});
          layout.useLayoutStore.getState().navigateToHome();
          return false;
        }
        return true;
      })()`);
    } catch {
      return false;
    }
  },
  40000,
  800,
);
if (!ready) throw new Error("页面刷新后 40s 未就绪");
console.log("· 页面已刷新并就绪（图书馆视图 + 通道注册）");

const urls = {
  tc: await modUrl("store/task-center-store.ts"),
  cps: await modUrl("store/convert-progress-store.ts"),
  bc: await modUrl("services/task-executors/book-convert.ts"),
  bt: await modUrl("services/task-executors/book-translate.ts"),
  bv: await modUrl("services/task-executors/book-vectorize.ts"),
  lib: await modUrl("store/library-store.ts"),
  bs: await modUrl("services/book-service.ts"),
  importBook: await modUrl("ai/tools/central/import-book.ts"),
};
await evalJS(`(async () => {
  const [tc, cps, bc, bt, bv, lib, bs, importMod] = await Promise.all([
    import(${JSON.stringify(urls.tc)}),
    import(${JSON.stringify(urls.cps)}),
    import(${JSON.stringify(urls.bc)}),
    import(${JSON.stringify(urls.bt)}),
    import(${JSON.stringify(urls.bv)}),
    import(${JSON.stringify(urls.lib)}),
    import(${JSON.stringify(urls.bs)}),
    import(${JSON.stringify(urls.importBook)}),
  ]);
  window.__v = { tc, cps, bc, bt, bv, lib, bs, importMod };
  window.__v.agg = (channel) => tc.selectChannelAggregate(tc.useTaskCenterStore.getState(), channel);
  return true;
})()`);

const TOASTS = `Array.from(document.querySelectorAll('[data-sonner-toast]')).map((t) => (t.textContent ?? '').replace(/\\s+/g, ' ').trim()).join(' | ')`;
// Radix 菜单/工具提示都走 DismissableLayer 栈：单次 Escape 只关栈顶（tooltip），菜单可能残留。
// 关闭 = 挪开鼠标 + 连发 Escape + 轮询到菜单清空（B4 残留菜单曾让 B6 读到中文书的旧菜单）
const closeAnyMenu = async () => {
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 });
  for (let i = 0; i < 8; i++) {
    const open = await evalJS(`document.querySelectorAll('[role="menu"]').length`);
    if (open === 0) return;
    await evalJS(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
    await sleep(250);
  }
};

// ─── Part A：转换队列选项徽标 ───
console.log("\n—— Part A：转换队列选项徽标 ——");
// 记录默认选项现场，收尾还原（store 不持久化，重载即复位，此处仅会话内礼貌还原）
const a0 = await evalJS(`(() => {
  const { ocr, translate } = window.__v.cps.useConvertProgressStore.getState().bookConvert;
  return { ocr, translate };
})()`);
await evalJS("window.__v.cps.useConvertProgressStore.getState().openBookConvertDialog(); true");
const dialogUp = await pollUntil(
  async () => await evalJS(`!!document.querySelector('[role="dialog"] [data-region="converter-page"]')`),
  8000,
);
check("A0 转换窗口弹层打开", dialogUp === true);

// A1：占住唯一并发槽 → 入队全部停 queued
const a1 = await evalJS(`(() => {
  const st = window.__v.tc.useTaskCenterStore.getState();
  const occ = st.occupyForRecovery({ channel: "book-convert", targetId: "btq-menu-hold.pdf", title: "占位任务" });
  if (!occ) return { occ: false };
  window.__vOcc = occ;
  const r = window.__v.bc.enqueueBookConvertBatch(
    ${JSON.stringify([join(assetDir, "BTQ Alpha.pdf"), join(assetDir, "BTQ Beta.pdf")])},
    { ocr: true, translate: "zh" },
  );
  const tasks = Object.values(window.__v.tc.useTaskCenterStore.getState().tasks)
    .filter((t) => t.channel === "book-convert" && !t.mirror)
    .map((t) => ({ title: t.title, status: t.status, payload: t.payload }));
  return { occ: true, queued: r.queued, tasks };
})()`);
check(
  "A1 占位占槽后两份 PDF 入队且全部 queued",
  a1.occ && a1.queued === 2 && a1.tasks.filter((t) => t.status === "queued").length === 2,
  JSON.stringify(a1),
);

// A2：行上徽标 = 入队时选项快照
const a2 = await pollUntil(async () => {
  return await evalJS(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return null;
    const rows = [...dialog.querySelectorAll("li")];
    const rowOf = (name) => rows.find((li) => li.textContent.includes(name));
    const alpha = rowOf("BTQ Alpha");
    const beta = rowOf("BTQ Beta");
    if (!alpha || !beta) return null;
    const badgesOf = (li) => [...li.querySelectorAll('[data-slot="badge"]')].map((b) => b.textContent.trim());
    const triggerOf = (li) => !!li.querySelector('[data-slot="popover-trigger"]');
    return { alpha: badgesOf(alpha), beta: badgesOf(beta), alphaTrigger: triggerOf(alpha), betaTrigger: triggerOf(beta) };
  })()`);
}, 8000);
check(
  "A2 两行徽标显示入队时选项（强制 OCR + 译为中文）",
  !!a2 && a2.alpha.join() === "强制 OCR,译为中文" && a2.beta.join() === "强制 OCR,译为中文",
  JSON.stringify(a2),
);
check("A2b queued 行徽标可点（popover 触发器在）", !!a2 && a2.alphaTrigger && a2.betaTrigger);

// A3：改顶部默认选项 → 新入队行徽标变、旧行不变（快照语义）
await evalJS(`(() => {
  window.__v.cps.useConvertProgressStore.getState().setBookConvertConfig({ ocr: false, translate: "none" });
  const r = window.__v.bc.enqueueBookConvertBatch(${JSON.stringify([join(assetDir, "BTQ Gamma.pdf")])}, { ocr: false, translate: "none" });
  return r;
})()`);
const a3 = await pollUntil(async () => {
  return await evalJS(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return null;
    const rows = [...dialog.querySelectorAll("li")];
    const rowOf = (name) => rows.find((li) => li.textContent.includes(name));
    const gamma = rowOf("BTQ Gamma");
    const alpha = rowOf("BTQ Alpha");
    if (!gamma || !alpha) return null;
    const badgesOf = (li) => [...li.querySelectorAll('[data-slot="badge"]')].map((b) => b.textContent.trim());
    return { gamma: badgesOf(gamma), alpha: badgesOf(alpha) };
  })()`);
}, 8000);
check(
  "A3 改默认选项后新行徽标变（OCR 关 + 不翻译）",
  !!a3 && a3.gamma.join() === "OCR 关,不翻译",
  JSON.stringify(a3),
);
check("A3b 旧行徽标保持入队时快照不变", !!a3 && a3.alpha.join() === "强制 OCR,译为中文", JSON.stringify(a3));
await shot("menu-a3-badges-snapshot");

// A4：queued 行点徽标 → 弹小编辑 → 改选项 → 保存 → store payload 断言
const a4open = await evalJS(`(() => {
  const dialog = document.querySelector('[role="dialog"]');
  const beta = [...dialog.querySelectorAll("li")].find((li) => li.textContent.includes("BTQ Beta"));
  const trigger = beta?.querySelector('[data-slot="popover-trigger"]');
  if (!trigger) return false;
  trigger.click();
  return true;
})()`);
await sleep(700);
const a4pop = await evalJS(`(() => {
  const pop = document.querySelector('[data-slot="popover-content"]');
  if (!pop) return null;
  return { text: pop.textContent.slice(0, 80), hasSwitch: !!pop.querySelector('[role="switch"]'), hasSelect: !!pop.querySelector('[role="combobox"]') };
})()`);
check("A4 点徽标弹出小编辑（含 OCR 开关与翻译下拉）", a4open && !!a4pop && a4pop.hasSwitch && a4pop.hasSelect, JSON.stringify(a4pop));
await shot("menu-a4-popover");
// OCR：开 → 关
await evalJS(`document.querySelector('[data-slot="popover-content"] [role="switch"]').click(); true`);
await sleep(300);
// 翻译：zh → en（Radix Select：开 listbox 点 option）
await evalJS(`document.querySelector('[data-slot="popover-content"] [role="combobox"]').click(); true`);
const a4opt = await pollUntil(async () => {
  return await evalJS(`(() => {
    const opt = [...document.querySelectorAll('[role="option"]')].find((o) => o.textContent.trim() === "译为英文");
    if (!opt) return null;
    opt.click();
    return true;
  })()`);
}, 5000, 300);
await sleep(300);
const a4save = await evalJS(`(() => {
  const pop = document.querySelector('[data-slot="popover-content"]');
  const save = pop && [...pop.querySelectorAll("button")].find((b) => b.textContent.trim() === "保存");
  if (!save) return false;
  save.click();
  return true;
})()`);
await sleep(600);
const a4store = await evalJS(`(() => {
  const t = Object.values(window.__v.tc.useTaskCenterStore.getState().tasks)
    .find((x) => x.channel === "book-convert" && x.title.includes("BTQ Beta"));
  const dialog = document.querySelector('[role="dialog"]');
  const beta = dialog && [...dialog.querySelectorAll("li")].find((li) => li.textContent.includes("BTQ Beta"));
  const badges = beta ? [...beta.querySelectorAll('[data-slot="badge"]')].map((b) => b.textContent.trim()) : [];
  return { payload: t?.payload ?? null, badges };
})()`);
check("A4b 保存成功（点 option/保存按钮都可点）", a4opt === true && a4save === true);
check(
  "A4c 保存后 store payload 热更新（ocr:false, translate:en，其余字段保留）",
  a4store.payload?.ocr === false && a4store.payload?.translate === "en" && a4store.payload?.autoImport === true,
  JSON.stringify(a4store.payload),
);
check("A4d 行徽标随 payload 更新（OCR 关 + 译为英文）", a4store.badges.join() === "OCR 关,译为英文", a4store.badges.join());
console.log("  · A4 toast:", await evalJS(TOASTS));

// A5：释放占位 → Alpha 转 running → 徽标只读；随即取消（杀掉真实转换进程）
await evalJS(`window.__v.tc.useTaskCenterStore.getState().settleRecoveredTask(window.__vOcc.taskId, "cancelled"); true`);
const a5 = await pollUntil(async () => {
  return await evalJS(`(() => {
    const t = Object.values(window.__v.tc.useTaskCenterStore.getState().tasks)
      .find((x) => x.channel === "book-convert" && x.title.includes("BTQ Alpha"));
    if (!t || t.status !== "running") return null;
    const dialog = document.querySelector('[role="dialog"]');
    const alpha = dialog && [...dialog.querySelectorAll("li")].find((li) => li.textContent.includes("BTQ Alpha"));
    if (!alpha) return null;
    return { taskId: t.taskId, badges: [...alpha.querySelectorAll('[data-slot="badge"]')].map((b) => b.textContent.trim()), trigger: !!alpha.querySelector('[data-slot="popover-trigger"]') };
  })()`);
}, 15000);
check(
  "A5 running 行徽标只读（有徽标、无 popover 触发器）",
  !!a5 && a5.badges.join() === "强制 OCR,译为中文" && a5.trigger === false,
  JSON.stringify(a5),
);
await shot("menu-a5-running-readonly");
if (a5?.taskId) {
  await evalJS(`window.__v.tc.useTaskCenterStore.getState().cancelTask(${JSON.stringify(a5.taskId)}); true`);
}

const a6 = await evalJS(`(() => {
  const dialog = document.querySelector('[role="dialog"]');
  return !!dialog && dialog.textContent.includes("新入队默认选项") && dialog.textContent.includes("已入队任务各持入队时快照");
})()`);
check("A6 顶部「新入队默认选项」说明文案在", a6 === true);

// Part A 收尾：撤掉全部排队/结算行，关窗，还原默认选项
await evalJS(`(async () => {
  const st = window.__v.tc.useTaskCenterStore.getState();
  st.cancelChannel("book-convert");
  await new Promise((r) => setTimeout(r, 1500));
  for (const t of Object.values(window.__v.tc.useTaskCenterStore.getState().tasks)) {
    if (t.channel === "book-convert" && t.status !== "running") st.removeTask(t.taskId);
  }
  st.dismissSettled("book-convert");
  window.__v.cps.useConvertProgressStore.getState().setBookConvertConfig(${JSON.stringify(a0)});
  window.__v.cps.useConvertProgressStore.getState().closeBookConvertDialog();
  return true;
})()`);
console.log("· Part A 收尾完成（通道清空、默认选项还原、关窗）");

// ─── Part B：图书馆右键翻译 ───
console.log("\n—— Part B：图书馆右键翻译 ——");
const b1 = await evalJS(`(async () => {
  const { lib, importMod } = window.__v;
  const before = new Set(lib.useLibraryStore.getState().booksWithStatus.map((b) => b.id));
  const r1 = await importMod.importBookTool.execute({ reasoning: "菜单验证造英文小书", filePath: ${JSON.stringify(tempTiny)} }, {});
  const r2 = await importMod.importBookTool.execute({ reasoning: "菜单验证造中文小书", filePath: ${JSON.stringify(tempZh)} }, {});
  await lib.useLibraryStore.getState().refreshBooks();
  const added = lib.useLibraryStore.getState().booksWithStatus.filter((x) => !before.has(x.id));
  return {
    ok1: r1?.results?.success === true, ok2: r2?.results?.success === true,
    added: added.map((x) => ({ id: x.id, title: x.title, format: x.format, language: x.language })),
  };
})()`);
check("B1 英文/中文小书导入成功", b1.ok1 && b1.ok2 && b1.added.length === 2, JSON.stringify(b1));
const tinyBook = b1.added.find((b) => b.title.includes("Tiny"));
const zhBook = b1.added.find((b) => !b.title.includes("Tiny"));
if (!tinyBook || !zhBook) throw new Error("造书失败，中止");

// 页内助手：按书名找卡 → 右键开菜单 → 返回菜单项（含 disabled 标记）。
// 读 DOM 里最后一个 [role="menu"]（Radix portal 按打开顺序 append，最新开的在最后；开前先在 Node 侧清场）
const openCardMenu = (titleFrag) => `(async () => {
  const card = [...document.querySelectorAll('[data-region="book-card"]')].find((c) => c.textContent.includes(${JSON.stringify(titleFrag)}));
  if (!card) return null;
  const rect = card.getBoundingClientRect();
  card.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: rect.x + rect.width / 2, clientY: rect.y + 60 }));
  await new Promise((r) => setTimeout(r, 700));
  const menus = [...document.querySelectorAll('[role="menu"]')];
  const menu = menus[menus.length - 1];
  if (!menu) return null;
  return [...menu.querySelectorAll('[role="menuitem"]')].map((m) => (m.textContent ?? "").trim() + (m.hasAttribute("data-disabled") ? "[disabled]" : ""));
})()`;

const openMenuFor = async (titleFrag) => {
  await closeAnyMenu();
  return await evalJS(openCardMenu(titleFrag));
};

const b2menu = await openMenuFor("BTQ Tiny Book");
check("B2 右键英文书：菜单含「翻译」且未置灰", Array.isArray(b2menu) && b2menu.includes("翻译"), JSON.stringify(b2menu));
await shot("menu-b2-context-menu");

// 点「翻译」→ toast + 任务在跑 + 通道卡
await evalJS(`(() => {
  const item = [...document.querySelectorAll('[role="menuitem"]')].find((m) => (m.textContent ?? "").trim() === "翻译");
  if (item) item.click();
  return !!item;
})()`);
await sleep(800);
const b2toast = await evalJS(TOASTS);
check("B2b toast「已加入翻译队列」", b2toast.includes("已加入翻译队列"), b2toast.slice(0, 200));
const b2run = await pollUntil(async () => {
  return await evalJS(`(() => {
    const agg = window.__v.agg("book-translate");
    const host = document.getElementById("bottom-right-stack");
    const card = !!host && host.textContent.includes("图书翻译");
    return agg.current && agg.current.targetId === ${JSON.stringify(tinyBook.id)} ? { status: agg.current.status, card } : null;
  })()`);
}, 15000);
check("B2c 翻译任务在跑 + 右下角「图书翻译」通道卡出现", !!b2run && b2run.card === true, JSON.stringify(b2run));
await shot("menu-b2-translate-card");

// B3：翻译在跑 → 右键同书 → 向量化子菜单「开始向量化」→ 冲突 toast
const b3menu = await openMenuFor("BTQ Tiny Book");
if (!b3menu) {
  check("B3 重开菜单", false);
} else {
  // 悬停子菜单触发器（真实鼠标移动，Radix 子菜单 hover 展开）
  const trigRect = await evalJS(`(() => {
    const t = [...document.querySelectorAll('[role="menuitem"]')].find((m) => (m.textContent ?? "").trim().startsWith("向量化"));
    if (!t) return null;
    const r = t.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (trigRect) {
    await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(trigRect.x), y: Math.round(trigRect.y) });
    await sleep(200);
    await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(trigRect.x) + 4, y: Math.round(trigRect.y) });
    await sleep(800);
  }
  const b3click = await evalJS(`(() => {
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((m) => (m.textContent ?? "").trim() === "开始向量化");
    if (!item) return false;
    item.click();
    return true;
  })()`);
  await sleep(800);
  const b3toast = await evalJS(TOASTS);
  const b3noTask = await evalJS(`(() => {
    const agg = window.__v.agg("book-vectorize");
    const mine = [agg.current, ...agg.running].filter(Boolean).some((t) => t.targetId === ${JSON.stringify(tinyBook.id)});
    return !mine && agg.queuedCount === 0;
  })()`);
  check("B3 子菜单展开并点击「开始向量化」", b3click === true);
  check("B3b 冲突 toast「翻译中，完成后再向量化」", b3toast.includes("翻译中，完成后再向量化"), b3toast.slice(-240));
  check("B3c 向量化未入队（同书互斥）", b3noTask === true);
}
await closeAnyMenu();

// B4：中文书置灰 + tooltip
const b4menu = await openMenuFor("BTQ 中文小书");
check("B4 右键中文书：「翻译」置灰", Array.isArray(b4menu) && b4menu.includes("翻译[disabled]"), JSON.stringify(b4menu));
// 悬停置灰项外层 span（置灰项 pointer-events-none，tooltip 挂在包裹 span 上）
const b4rect = await evalJS(`(() => {
  const item = [...document.querySelectorAll('[role="menuitem"]')].find((m) => (m.textContent ?? "").trim() === "翻译" && m.hasAttribute("data-disabled"));
  if (!item) return null;
  const host = item.closest("span") ?? item;
  const r = host.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
})()`);
if (b4rect) {
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(b4rect.x), y: Math.round(b4rect.y) });
  await sleep(700);
}
const b4tip = await evalJS(`(() => {
  // Radix TooltipContent 内含一份 VisuallyHidden 复本（无障碍公告），textContent 会重复——按 includes 断言
  const tip = document.querySelector('[data-slot="tooltip-content"]');
  return tip ? tip.textContent.trim() : null;
})()`);
check("B4b 悬停 tooltip「中文书籍无需对照翻译」", !!b4tip && b4tip.includes("中文书籍无需对照翻译"), String(b4tip));
await shot("menu-b4-zh-disabled-tooltip");
await closeAnyMenu();

// B5：等小书翻译完成（solo 结算刷新图书馆列表——store 内 meta 口径即菜单数据源）
const b5 = await pollUntil(async () => {
  return await evalJS(`(() => {
    const b = window.__v.lib.useLibraryStore.getState().booksWithStatus.find((x) => x.id === ${JSON.stringify(tinyBook.id)});
    const meta = b?.status?.metadata?.translation;
    return meta?.status === "complete" ? { done: meta.doneBlocks, total: meta.totalBlocks } : null;
  })()`);
}, 300000, 3000);
check("B5 小书翻译完成且图书馆 store meta 刷新（solo 收尾）", !!b5 && b5.done > 0, JSON.stringify(b5));
console.log("  · 译本:", JSON.stringify(b5));

// B6：重新翻译 + 确认框（stub 原生 ask）
// B6：重新翻译 + 确认框（fetch 桩拦截 IPC：__TAURI_INTERNALS__ 全员只读不可桩，
// 但 Tauri 自定义协议 IPC 走 window.fetch（http://ipc.localhost/<cmd>，Tauri-Response 头决 resolve/reject），
// 拦它即完整截获 ask——载荷可观测、答案可编排、原生框不触达（本环境原生框不结算，直发会留僵尸挂起）
const stubbed = await evalJS(`(() => {
  if (!window.__TAURI_INTERNALS__) return false;
  window.__askStub = { calls: [], answer: false, armed: true };
  window.__origFetchForAsk = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === "string" ? input : (input?.url ?? "");
    if (window.__askStub.armed && url.includes("ipc.localhost/plugin%3Adialog%7Cask")) {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      window.__askStub.calls.push(body);
      return Promise.resolve(
        new Response(JSON.stringify(window.__askStub.answer), {
          status: 200,
          headers: { "Tauri-Response": "ok", "Content-Type": "application/json" },
        }),
      );
    }
    return window.__origFetchForAsk(input, init);
  };
  return true;
})()`);
check("B6 ask 桩就绪（fetch 拦截 ipc.localhost 的 plugin:dialog|ask）", stubbed === true);

const b6menu = await openMenuFor("BTQ Tiny Book");
check("B6b 已有完整译本 → 菜单显示「重新翻译」", Array.isArray(b6menu) && b6menu.includes("重新翻译"), JSON.stringify(b6menu));
await shot("menu-b6-retranslate");
// 答 false：确认框弹出记录 + 不入队
await evalJS(`(() => {
  const menus = [...document.querySelectorAll('[role="menu"]')];
  const menu = menus[menus.length - 1];
  const item = menu && [...menu.querySelectorAll('[role="menuitem"]')].find((m) => (m.textContent ?? "").trim() === "重新翻译");
  if (item) item.click();
  return !!item;
})()`);
await sleep(800);
const b6deny = await evalJS(`(() => {
  const calls = window.__askStub.calls.map((c) => ({ title: c?.title ?? null, msg: (c?.message ?? "").slice(0, 40) }));
  const agg = window.__v.agg("book-translate");
  return { calls, active: (agg.current ? 1 : 0) + agg.queuedCount };
})()`);
check(
  "B6c 确认框弹出（标题「重新翻译」+ 全量重翻文案）",
  b6deny.calls.length === 1 && b6deny.calls[0].title === "重新翻译" && b6deny.calls[0].msg.includes("全量重新翻译"),
  JSON.stringify(b6deny.calls),
);
check("B6d 确认框答否 → 不入队", b6deny.active === 0, `active=${b6deny.active}`);

// 答 true：入队且 payload.force=true、solo=true
await evalJS(`window.__askStub.answer = true; true`);
const b6menu2 = await openMenuFor("BTQ Tiny Book");
if (Array.isArray(b6menu2)) {
  await evalJS(`(() => {
    const menus = [...document.querySelectorAll('[role="menu"]')];
    const menu = menus[menus.length - 1];
    const item = menu && [...menu.querySelectorAll('[role="menuitem"]')].find((m) => (m.textContent ?? "").trim() === "重新翻译");
    if (item) item.click();
    return !!item;
  })()`);
}
await sleep(1000);
const b6ok = await evalJS(`(() => {
  const t = Object.values(window.__v.tc.useTaskCenterStore.getState().tasks).find(
    (x) => x.channel === "book-translate" && x.targetId === ${JSON.stringify(tinyBook.id)} && (x.status === "queued" || x.status === "running"),
  );
  return t ? { payload: t.payload, status: t.status } : null;
})()`);
check(
  "B6e 确认后入队：payload.force=true、solo=true",
  !!b6ok && b6ok.payload?.force === true && b6ok.payload?.solo === true,
  JSON.stringify(b6ok),
);
const b6toast = await evalJS(TOASTS);
check("B6f 重翻入队 toast「已加入翻译队列」", b6toast.includes("已加入翻译队列"), b6toast.slice(-200));
await shot("menu-b6-retranslate-queued");

// ─── 收尾：撤任务、删书、还原 invoke 与默认选项 ───
await evalJS(`(() => {
  const st = window.__v.tc.useTaskCenterStore.getState();
  st.cancelChannel("book-translate");
  st.cancelChannel("book-vectorize");
  st.cancelChannel("book-convert");
  return true;
})()`);
// 等任务真正结算（删书须在读文件的翻译任务终止之后，否则译文落盘会复活已删目录）
await pollUntil(async () => {
  return await evalJS(`(() => {
    const live = Object.values(window.__v.tc.useTaskCenterStore.getState().tasks).some(
      (t) => !t.mirror && (t.status === "queued" || t.status === "running"),
    );
    return live ? null : true;
  })()`);
}, 30000, 800);
const cleanup = await evalJS(`(async () => {
  const { tc, lib, bs } = window.__v;
  const st = tc.useTaskCenterStore.getState();
  for (const ch of ["book-translate", "book-vectorize", "book-convert"]) st.dismissSettled(ch);
  await lib.useLibraryStore.getState().refreshBooks();
  const ids = new Set([${JSON.stringify(tinyBook.id)}, ${JSON.stringify(zhBook.id)}]);
  const victims = lib.useLibraryStore.getState().booksWithStatus.filter((b) => ids.has(b.id) || b.title.includes("BTQ"));
  for (const b of victims) {
    await bs.deleteBook(b.id).catch(() => {});
    await bs.purgeBook(b.id).catch(() => {});
  }
  await lib.useLibraryStore.getState().refreshBooks();
  if (window.__askStub) {
    window.__askStub.armed = false;
    if (window.__origFetchForAsk) window.fetch = window.__origFetchForAsk;
  }
  const rest = lib.useLibraryStore.getState().booksWithStatus;
  return { purged: victims.map((b) => b.title), left: rest.filter((b) => ids.has(b.id) || b.title.includes("BTQ")).length };
})()`);
check("收尾：测试书籍全部彻底删除、ask 桩还原", cleanup.left === 0, JSON.stringify(cleanup));

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) console.error("失败项:", failures.join(" | "));
ws.close();
process.exit(failures.length > 0 ? 1 : 0);
