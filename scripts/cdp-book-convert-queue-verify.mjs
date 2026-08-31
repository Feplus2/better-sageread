// 卡 1 + 卡 2 CDP 实盘验证（docs/book-convert-queue-plan.md 验收口径）：
// A. 通道注册 + translateBook 工具注册
// B. 冲突矩阵（occupyForRecovery 注入假占用，零 token 消耗）：同书互斥提示语、异书豁免
// C. 造书：导入小 EPUB（2 章 12 段英文；经 %TEMP% 路径绕开 plugin-fs 作用域）
// D. 阅读器路径翻译（enqueueBookTranslate）：主页右下角「图书翻译」卡可见→真实在跑时同书向量化被拒、
//    异书翻译可入队→点卡上「取消」→ cancelled
// E. translateBook 工具全链路：status → translate（续翻 D 的残篇至完成）→ status 复核
// F. 转换队列：3 份极小 PDF 排队连转（严格串行）+ 完成自动导入 + 自动出队；中途关窗→通道卡→点卡还原
// G. 失败滞留（不存在路径）+ 重试 + 单行删除 + 运行中取消
// H. 拖放遮罩只盖窗口本体（旗标驱动断言 + 截图；真实系统拖放无法从页面合成，接线已人工核）
// 收尾：删除全部测试书籍（回收站→彻底删除），通道复位
//
// HMR 纪律：页内动态 import 一律走 modUrl（从 resource 条目解析最新 ?t= 版本化 URL；
// 裸 import 会拿到与 app 实例不同的第二实例——2026-08-31 本脚本首跑即实证踩坑）。
// 运行：node scripts/cdp-book-convert-queue-verify.mjs（需 dev 实例 1420/9223 在跑）
import { copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const assetDir = join(repoRoot, ".tmp-bt-verify");
for (const f of ["btq-tiny.epub", "BTQ Alpha.pdf", "BTQ Beta.pdf", "BTQ Gamma.pdf", "BTQ Delta.pdf"]) {
  if (!existsSync(join(assetDir, f))) throw new Error(`缺测试资产 ${f}——先跑 node .tmp-bt-verify/make-assets.mjs`);
}
// plugin-fs 作用域只覆盖 appdata/appconfig/temp：EPUB 导入走 JS readFile，须放 temp
const tempAssetDir = join(tmpdir(), "btq-verify");
const tempEpub = join(tempAssetDir, "btq-tiny.epub");
{
  const { mkdirSync } = await import("node:fs");
  mkdirSync(tempAssetDir, { recursive: true });
  copyFileSync(join(assetDir, "btq-tiny.epub"), tempEpub);
}

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
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(assetDir, `${name}.png`), Buffer.from(res.data, "base64"));
  return name;
};
// HMR 版本化 URL 解析：resource 条目里取该模块的最新一条（含 ?t=）；未加载过则回落裸 /src 路径
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

// 刷新页面拿全新模块实例（归零 HMR 版本栈；此后仍一律 modUrl 解析，双保险）
await call("Page.reload", { ignoreCache: true });
await sleep(1000);
const ready = await pollUntil(
  async () => {
    try {
      const tcUrl = await modUrl("store/task-center-store.ts");
      const libUrl = await modUrl("store/library-store.ts");
      return await evalJS(`(async () => {
      const lib = await import(${JSON.stringify(libUrl)});
      const reg = await import(${JSON.stringify(await modUrl("store/task-executor-registry.ts"))});
      return lib.useLibraryStore.getState().booksWithStatus.length > 0 && !!reg.getChannelDef("book-convert");
    })()`);
    } catch {
      return false;
    }
  },
  40000,
  800,
);
if (!ready) throw new Error("页面刷新后 40s 未就绪");
console.log("· 页面已刷新并就绪");

// 页内公共助手：模块句柄（全部 modUrl 解析）+ 通道聚合快照
const urls = {
  tc: await modUrl("store/task-center-store.ts"),
  cps: await modUrl("store/convert-progress-store.ts"),
  reg: await modUrl("ai/tools/registry.ts"),
  bc: await modUrl("services/task-executors/book-convert.ts"),
  bt: await modUrl("services/task-executors/book-translate.ts"),
  bv: await modUrl("services/task-executors/book-vectorize.ts"),
  lib: await modUrl("store/library-store.ts"),
  bs: await modUrl("services/book-service.ts"),
  tool: await modUrl("ai/tools/central/translate-book.ts"),
  importBook: await modUrl("ai/tools/central/import-book.ts"),
};
await evalJS(`(async () => {
  const [tc, cps, reg, bc, bt, bv, lib, bs, toolMod, importMod] = await Promise.all([
    import(${JSON.stringify(urls.tc)}),
    import(${JSON.stringify(urls.cps)}),
    import(${JSON.stringify(urls.reg)}),
    import(${JSON.stringify(urls.bc)}),
    import(${JSON.stringify(urls.bt)}),
    import(${JSON.stringify(urls.bv)}),
    import(${JSON.stringify(urls.lib)}),
    import(${JSON.stringify(urls.bs)}),
    import(${JSON.stringify(urls.tool)}),
    import(${JSON.stringify(urls.importBook)}),
  ]);
  window.__btq = { tc, cps, reg, bc, bt, bv, lib, bs, toolMod, importMod };
  window.__btq.agg = (channel) => tc.selectChannelAggregate(tc.useTaskCenterStore.getState(), channel);
  return true;
})()`);

// ─── A. 注册断言 ───
const a = await evalJS(`(() => {
  const { reg, bc, bt, tc } = window.__btq;
  const tools = reg.getToolsForScope("central");
  return {
    translateBook: !!tools.translateBook,
    batch: typeof bc.enqueueBookConvertBatch === "function",
    retry: typeof bc.retryBookConvertTask === "function",
    andWait: typeof bt.enqueueBookTranslateAndWait === "function",
    removeTask: typeof tc.useTaskCenterStore.getState().removeTask === "function",
  };
})()`);
check("A1 central 工具集含 translateBook", a.translateBook);
check(
  "A2 book-convert 批量/重试入口 + book-translate AndWait + store removeTask 就绪",
  a.batch && a.retry && a.andWait && a.removeTask,
);

// ─── B. 冲突矩阵（假占用，零消耗） ───
const b = await evalJS(`(() => {
  const { tc, bv, bt, bc } = window.__btq;
  const st = tc.useTaskCenterStore.getState();
  const occ = st.occupyForRecovery({ channel: "book-translate", targetId: "btq-fake-x", title: "假占用" });
  if (!occ) return { occ: false };
  const vecDenied = bv.enqueueBookVectorize({ id: "btq-fake-x", title: "假占用" });
  // book-convert 归属键是 pdfPath，与 bookId 不同名不撞——用同名字串模拟同归属场景
  const convDenied = bc.enqueueBookConvert({ pdfPath: "btq-fake-x", ocr: true, translate: "none", autoImport: true });
  const otherOk = bt.enqueueBookTranslate({ id: "btq-fake-y", title: "别的书" });
  const out = {
    occ: true,
    vecDenied: !vecDenied.ok && vecDenied.reason === "conflict" ? (vecDenied.detail ?? "") : "未拒: " + JSON.stringify(vecDenied),
    convDenied: !convDenied.ok && convDenied.reason === "conflict" ? (convDenied.detail ?? "") : "未拒: " + JSON.stringify(convDenied),
    otherOk: otherOk.ok === true,
  };
  if (otherOk.ok) st.cancelTask(otherOk.taskId);
  st.settleRecoveredTask(occ.taskId, "cancelled");
  st.dismissSettled("book-translate");
  st.dismissSettled("book-vectorize");
  st.dismissSettled("book-convert");
  return out;
})()`);
check("B1 同书翻译占用 → 向量化拒入且提示语正确", b.vecDenied === "翻译中，完成后再向量化", b.vecDenied);
check("B2 同书翻译占用 → 转换（同归属键）拒入且提示语正确", b.convDenied === "翻译中，完成后再转换", b.convDenied);
check("B3 异书翻译入队豁免", b.otherOk === true);

// ─── C. 造书：导入小 EPUB（temp 路径，plugin-fs 作用域内） ───
const c = await evalJS(`(async () => {
  const { lib, importMod } = window.__btq;
  const before = new Set(lib.useLibraryStore.getState().booksWithStatus.map((b) => b.id));
  const r = await importMod.importBookTool.execute({ reasoning: "卡2 实测造书", filePath: ${JSON.stringify(tempEpub)} }, {});
  await lib.useLibraryStore.getState().refreshBooks();
  const after = lib.useLibraryStore.getState().booksWithStatus;
  const added = after.filter((x) => !before.has(x.id));
  return { ok: r?.results?.success === true, err: r?.results?.message ?? null, title: r?.results?.importedBook?.title ?? null, added: added.map((x) => ({ id: x.id, title: x.title, format: x.format })) };
})()`);
check("C1 小 EPUB 导入成功", c.ok && c.added.length === 1, JSON.stringify(c));
const tinyBook = c.added[0];
if (!tinyBook) throw new Error("造书失败，中止");

// ─── D. 阅读器路径翻译：卡片可见→互斥→点卡取消 ───
const d1 = await evalJS(`(() => {
  const r = window.__btq.bt.enqueueBookTranslate({ id: ${JSON.stringify(tinyBook.id)}, title: ${JSON.stringify(tinyBook.title)} });
  return { ok: r.ok, detail: r.detail ?? null };
})()`);
check("D1 阅读器入口入队翻译", d1.ok === true, d1.detail ?? "");

const d2 = await pollUntil(async () => {
  return await evalJS(`(() => {
    const agg = window.__btq.agg("book-translate");
    const cardHost = document.getElementById("bottom-right-stack");
    const cardVisible = !!cardHost && cardHost.textContent.includes("图书翻译");
    return agg.current && agg.current.targetId === ${JSON.stringify(tinyBook.id)} && cardVisible
      ? { percent: agg.current.percent, detail: agg.current.detail }
      : null;
  })()`);
}, 15000);
check("D2 翻译在跑 + 主页右下角「图书翻译」卡可见", !!d2);
if (d2) await shot("queue-d2-translate-card");

// 真实在跑期间的互斥（同书向量化拒 / 异书翻译入队豁免）
const d3 = await evalJS(`(() => {
  const { bv, bt } = window.__btq;
  const denied = bv.enqueueBookVectorize({ id: ${JSON.stringify(tinyBook.id)}, title: "x" });
  const other = bt.enqueueBookTranslate({ id: "7a87db6c21dba74df45c7061c15c9951", title: "Society Must Be Defended" });
  return {
    denied: !denied.ok ? (denied.detail ?? denied.reason) : "未拒",
    otherOk: other.ok === true,
    otherTaskId: other.ok ? other.taskId : null,
  };
})()`);
check("D3 真实翻译在跑：同书向量化拒入提示语正确", d3.denied === "翻译中，完成后再向量化", d3.denied);
check("D4 异书翻译并行入队无干扰", d3.otherOk === true);
if (d3.otherTaskId) {
  await evalJS(`window.__btq.tc.useTaskCenterStore.getState().cancelTask(${JSON.stringify(d3.otherTaskId)})`);
}

// 点卡上「取消」按钮
const d4 = await evalJS(`(() => {
  const host = document.getElementById("bottom-right-stack");
  if (!host) return { found: false };
  const btns = [...host.querySelectorAll("button")];
  const cancel = btns.find((b) => b.textContent.trim() === "取消");
  if (!cancel) return { found: false, text: host.textContent.slice(0, 120) };
  cancel.click();
  return { found: true };
})()`);
check("D5 卡片「取消」按钮可点", d4.found === true, d4.text ?? "");
const d5 = await pollUntil(async () => {
  return await evalJS(`(() => {
    const agg = window.__btq.agg("book-translate");
    const t = agg.settled.find((x) => x.targetId === ${JSON.stringify(tinyBook.id)});
    return t && t.status === "cancelled" ? true : null;
  })()`);
}, 20000);
check("D6 取消落账为 cancelled（已翻部分保留可续翻）", d5 === true);
await evalJS(`window.__btq.tc.useTaskCenterStore.getState().dismissSettled("book-translate")`);

// ─── E. translateBook 工具全链路（小书续翻至完成） ───
await evalJS(`(() => {
  window.__btqToolDone = null;
  const tool = window.__btq.toolMod.translateBookTool;
  tool.execute({ reasoning: "卡2 验收：翻译这本书全链路", action: "translate", bookId: ${JSON.stringify(tinyBook.id)} }, {})
    .then((r) => { window.__btqToolDone = { ok: true, r }; })
    .catch((e) => { window.__btqToolDone = { ok: false, err: String(e) }; });
  return true;
})()`);
const e1 = await pollUntil(async () => await evalJS("window.__btqToolDone"), 300000, 2000);
check("E1 translateBook 工具执行返回", !!e1);
if (e1?.ok) {
  const res = e1.r?.results;
  check(
    "E2 翻译成功（续翻完成）且消息含统计",
    res?.success === true && typeof res?.message === "string" && res.message.includes("翻译完成"),
    JSON.stringify(res)?.slice(0, 300),
  );
  console.log("  · 工具消息:", res?.message);
} else {
  check("E2 翻译成功（续翻完成）", false, e1?.err ?? "");
}
const e3 = await evalJS(`(async () => {
  const r = await window.__btq.toolMod.translateBookTool.execute(
    { reasoning: "状态复核", action: "status", bookId: ${JSON.stringify(tinyBook.id)} }, {});
  return r?.results;
})()`);
check(
  "E3 status 复核：有译本且段落计数>0",
  e3?.success === true && e3?.hasTranslation === true && e3?.doneBlocks > 0,
  JSON.stringify(e3)?.slice(0, 200),
);

// ─── F. 转换队列：3 PDF 连转 + 自动导入 + 自动出队 + 双态 ───
const libBefore = await evalJS("window.__btq.lib.useLibraryStore.getState().booksWithStatus.map((b) => b.id)");
await evalJS("window.__btq.cps.useConvertProgressStore.getState().openBookConvertDialog()");
await sleep(600);
const f1 = await evalJS(`(() => {
  const r = window.__btq.bc.enqueueBookConvertBatch(
    ${JSON.stringify([join(assetDir, "BTQ Alpha.pdf"), join(assetDir, "BTQ Beta.pdf"), join(assetDir, "BTQ Gamma.pdf")])},
    { ocr: true, translate: "none" },
  );
  return { ...r };
})()`);
check("F1 三份 PDF 批量入队", f1.queued === 3, JSON.stringify(f1));
// React 重渲跨 tick：行数断言走轮询（同 tick 内读 DOM 必读不到）
const f2rows = await pollUntil(async () => {
  const n = await evalJS(`[...document.querySelectorAll('[role="dialog"] li')].length`);
  return n === 3 ? n : null;
}, 8000);
check("F2 任务台队列列表呈现 3 行", f2rows === 3, `rows=${f2rows}`);
await shot("queue-f2-window-3rows");

// 串行观测：轮询记录 running 峰值；通道全空（成功行自动出队后）标记 done
await evalJS(`(() => {
  window.__btqWatch = { maxRunning: 0, done: false };
  const timer = setInterval(() => {
    const agg = window.__btq.agg("book-convert");
    const running = agg.running.length;
    if (running > window.__btqWatch.maxRunning) window.__btqWatch.maxRunning = running;
    if (!agg.current && agg.queuedCount === 0 && agg.settled.length === 0) {
      window.__btqWatch.done = true;
      clearInterval(timer);
    }
  }, 400);
  return true;
})()`);

// 连转期间：关窗 → 通道卡 → 点卡还原
await sleep(2500);
await evalJS("window.__btq.cps.useConvertProgressStore.getState().closeBookConvertDialog()");
const f3 = await pollUntil(async () => {
  return await evalJS(`(() => {
    const host = document.getElementById("bottom-right-stack");
    const dialog = document.querySelector('[role="dialog"]');
    return !dialog && host && host.textContent.includes("PDF 转 EPUB") ? true : null;
  })()`);
}, 8000);
check("F3 中途关窗 → 通道卡呈现且窗口已关", f3 === true);
await shot("queue-f3-minicard");
const f4 = await evalJS(`(() => {
  const host = document.getElementById("bottom-right-stack");
  const card = [...host.querySelectorAll('[role="button"]')].find((el) => el.textContent.includes("PDF 转 EPUB"));
  if (!card) return false;
  card.click();
  return true;
})()`);
await sleep(900);
const f5 = await evalJS(`(() => {
  const dialog = document.querySelector('[role="dialog"]');
  if (!dialog) return { open: false };
  const rows = [...dialog.querySelectorAll("li")].map((li) => li.textContent.slice(0, 40));
  const all = Object.values(window.__btq.tc.useTaskCenterStore.getState().tasks).filter((t) => t.channel === "book-convert");
  const channelTitles = all.map((t) => t.title);
  return { open: true, rows, channelTitles };
})()`);
check("F4 点卡还原窗口", f4 === true && f5.open === true);
check(
  "F5 还原后队列现场与通道一致（零状态损失，含排队行）",
  f5.open && f5.rows.length > 0 && f5.channelTitles.every((t) => f5.rows.some((r) => r.includes(t.slice(0, 20)))),
  JSON.stringify(f5),
);
await shot("queue-f5-restored");

// 等全部自动出队（每本成功 2.5s 后移除；三本连转 + 导入预算 8 分钟）
const f6 = await pollUntil(async () => await evalJS("window.__btqWatch.done ? true : null"), 480000, 3000);
const f7 = await evalJS(`(async () => {
  await window.__btq.lib.useLibraryStore.getState().refreshBooks();
  const now = window.__btq.lib.useLibraryStore.getState().booksWithStatus;
  const added = now.filter((b) => !${JSON.stringify(libBefore)}.includes(b.id) && b.format === "EPUB" && b.id !== ${JSON.stringify(tinyBook.id)});
  window.__btqAddedIds = added.map((b) => b.id);
  return { maxRunning: window.__btqWatch.maxRunning, added: added.map((b) => b.title), settled: window.__btq.agg("book-convert").settled.length };
})()`);
check("F6 三本连转完成且全部自动出队（通道清空）", f6 === true);
check("F7 严格串行（running 峰值 = 1）", f7.maxRunning === 1, `maxRunning=${f7.maxRunning}`);
check("F8 完成自动导入：图书馆新增 3 本 EPUB", f7.added.length === 3, JSON.stringify(f7.added));

// ─── G. 失败滞留 + 重试 + 删除 + 运行中取消 ───
const g1 = await evalJS(`(() => {
  const r = window.__btq.bc.enqueueBookConvert({ pdfPath: ${JSON.stringify(join(assetDir, "BTQ Missing.pdf"))}, ocr: true, translate: "none", autoImport: true });
  return r;
})()`);
check("G1 不存在路径入队（任务将在启动时失败）", g1.ok === true);
const g2 = await pollUntil(async () => {
  return await evalJS(`(() => {
    const t = window.__btq.agg("book-convert").settled.find((x) => x.targetId.includes("BTQ Missing"));
    return t && t.status === "error" ? { error: t.error, taskId: t.taskId } : null;
  })()`);
}, 15000);
check("G2 失败滞留队列且带错误原因", !!g2 && (g2.error ?? "").length > 0, g2?.error ?? "");
const g3 = await evalJS(`(() => {
  window.__btq.bc.retryBookConvertTask(${JSON.stringify(g2?.taskId ?? "")});
  const agg = window.__btq.agg("book-convert");
  return { active: (agg.current ? 1 : 0) + agg.queuedCount, settled: agg.settled.length };
})()`);
check("G3 失败行重试 → 重新入队（旧行移除新行起跑）", g3.active === 1 && g3.settled === 0, JSON.stringify(g3));
const g4 = await pollUntil(async () => {
  return await evalJS(`(() => {
    const t = window.__btq.agg("book-convert").settled.find((x) => x.targetId.includes("BTQ Missing"));
    return t && t.status === "error" ? t.taskId : null;
  })()`);
}, 15000);
const g5 = await evalJS(`(() => {
  const ok = window.__btq.tc.useTaskCenterStore.getState().removeTask(${JSON.stringify(g4 ?? "")});
  return { ok, left: window.__btq.agg("book-convert").settled.length };
})()`);
check("G4 重试仍失败滞留", !!g4);
check("G5 单行删除（×）移除失败行", g5.ok === true && g5.left === 0, JSON.stringify(g5));

// 运行中取消：真 PDF 起跑后撤
await evalJS(
  `window.__btq.bc.enqueueBookConvert({ pdfPath: ${JSON.stringify(join(assetDir, "BTQ Delta.pdf"))}, ocr: true, translate: "none", autoImport: true })`,
);
const g6 = await pollUntil(async () => {
  return await evalJS(`(() => {
    const agg = window.__btq.agg("book-convert");
    return agg.current && agg.current.targetId.includes("BTQ Delta") ? agg.current.taskId : null;
  })()`);
}, 15000);
if (g6) {
  await evalJS(`window.__btq.tc.useTaskCenterStore.getState().cancelTask(${JSON.stringify(g6)})`);
}
const g7 = await pollUntil(async () => {
  return await evalJS(`(() => {
    const t = window.__btq.agg("book-convert").settled.find((x) => x.targetId.includes("BTQ Delta"));
    return t && t.status === "cancelled" ? t.taskId : null;
  })()`);
}, 20000);
check("G6 运行中取消 → cancelled 行滞留可删", !!g7);
if (g7) await evalJS(`window.__btq.tc.useTaskCenterStore.getState().removeTask(${JSON.stringify(g7)})`);

// ─── H. 拖放遮罩只盖窗口本体（旗标驱动；真实系统拖放无法页面合成，接线已人工核） ───
await evalJS("window.__btq.cps.useConvertProgressStore.getState().openBookConvertDialog()");
await sleep(600);
await evalJS("window.__btq.cps.useConvertProgressStore.getState().setBookConvertDragOver(true)");
await sleep(400);
const h2 = await evalJS(`(() => {
  const dialog = document.querySelector('[role="dialog"]');
  const winOverlay = dialog && [...dialog.querySelectorAll("div")].find((d) => d.textContent.includes("松开将 PDF 加入转换队列"));
  // 全主页遮罩特征：「拖放文件以上传」
  const pageOverlay = [...document.querySelectorAll("div")].find((d) => d.textContent.includes("拖放文件以上传"));
  return { dialogOpen: !!dialog, winOverlay: !!winOverlay, pageOverlay: !!pageOverlay };
})()`);
check("H1 窗口可见时拖放 → 遮罩盖窗口本体", h2.dialogOpen && h2.winOverlay, JSON.stringify(h2));
check("H2 全主页遮罩未出现", !h2.pageOverlay);
await shot("queue-h-window-overlay");
await evalJS("window.__btq.cps.useConvertProgressStore.getState().setBookConvertDragOver(false)");
await evalJS("window.__btq.cps.useConvertProgressStore.getState().closeBookConvertDialog()");

// ─── 收尾：删除测试书籍（回收站 → 彻底删除），通道复位 ───
const cleanup = await evalJS(`(async () => {
  const { lib, bs } = window.__btq;
  await lib.useLibraryStore.getState().refreshBooks();
  const ids = new Set([${JSON.stringify(tinyBook.id)}, ...(window.__btqAddedIds ?? [])]);
  const victims = lib.useLibraryStore.getState().booksWithStatus.filter((b) => ids.has(b.id) || b.title.includes("BTQ"));
  const names = [];
  for (const b of victims) {
    names.push(b.title);
    await bs.deleteBook(b.id).catch(() => {});
    await bs.purgeBook(b.id).catch(() => {});
  }
  await lib.useLibraryStore.getState().refreshBooks();
  const st = window.__btq.tc.useTaskCenterStore.getState();
  for (const ch of ["book-convert", "book-translate", "book-vectorize"]) st.dismissSettled(ch);
  window.__btq.cps.useConvertProgressStore.getState().resetBookConvert();
  const rest = lib.useLibraryStore.getState().booksWithStatus;
  return { purged: names, left: rest.filter((b) => ids.has(b.id) || b.title.includes("BTQ")).length };
})()`);
check("收尾：测试书籍全部彻底删除", cleanup.left === 0, JSON.stringify(cleanup));

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) console.error("失败项:", failures.join(" | "));
ws.close();
process.exit(failures.length > 0 ? 1 : 0);
