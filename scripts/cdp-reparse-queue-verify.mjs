// 队列统一 E2E：(a) 重解析运行中再加队 (b) 重复入队提示 (c) 翻译撞车/不撞车
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
const call = (method, params) => {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  pending.set(++mid, { promise, resolve });
  ws.send(JSON.stringify({ id: mid, method, params }));
  return promise;
};
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id).resolve(msg.result); pending.delete(msg.id); }
};
await new Promise((r) => (ws.onopen = r));
const evalJS = async (expr) => {
  const r = await call("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PDF1 = "C:\\Users\\20995\\AppData\\Local\\Temp\\queue-reparse-test\\aloui2016refractive.pdf";
const PDF2 = "C:\\Users\\20995\\AppData\\Local\\Temp\\queue-reparse-test\\schmieg2020enzyme.pdf";
const CARD = `(() => { const c = document.querySelector('.fixed.right-4.bottom-4'); return c ? (c.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 170) : null; })()`;
const TOASTS = `Array.from(document.querySelectorAll('[data-sonner-toast]')).map((t) => (t.textContent ?? '').replace(/\\s+/g, ' ').trim()).join(' | ').slice(0, 200)`;
const STORE = `(async () => { const m = await import('/src/store/convert-progress-store.ts'); const p = m.useConvertProgressStore.getState().paperImport; return p ? { status: p.status, fileName: (p.fileName ?? '').slice(0, 40), i: p.index, n: p.total, q: p.queuedCount, detail: (p.detail ?? p.error ?? '').slice(0, 50) } : null; })()`;

await call("Page.reload", { ignoreCache: true });
await sleep(4500);
await evalJS(`import("/src/store/layout-store.ts").then((m) => { window.__layout = m; }); "loading"`);
await evalJS(`import("/src/store/convert-progress-store.ts").then((m) => { window.__cps = m; }); "loading"`);
for (let i = 0; i < 20; i++) {
  await sleep(500);
  if (await evalJS(`!!window.__layout && !!window.__cps`).catch(() => false)) break;
}
await evalJS(`window.__layout.useLayoutStore.getState().navigateToHome(); true`);
await sleep(800);

// ─── 阶段 1：导入两篇测试 PDF（排队入库）───
await evalJS(`window.__cps.startPaperImportBatch([${JSON.stringify(PDF1)}, ${JSON.stringify(PDF2)}]); true`);
console.log("阶段1: 两篇导入已提交");
let paperA = null;
let paperB = null;
{
  const t0 = Date.now();
  while (Date.now() - t0 < 900000) {
    await sleep(8000);
    const st = await evalJS(STORE);
    if (!st || st.status !== "running") {
      const found = await evalJS(`(async () => {
        const m = await import('/src/services/paper-service.ts');
        const papers = await m.listPapers();
        return papers.filter((p) => /refractive index|mass transfer/i.test(p.title ?? '')).map((p) => ({ id: p.id, title: p.title.slice(0, 40) }));
      })()`);
      if (found.length >= 2) {
        paperA = found.find((p) => /refractive/i.test(p.title));
        paperB = found.find((p) => /mass transfer/i.test(p.title));
        console.log("阶段1: 两篇均已入库", JSON.stringify({ A: paperA, B: paperB }));
        break;
      }
      if (!st) continue;
      if (st.status === "error") { console.log("阶段1 失败:", JSON.stringify(st)); break; }
    }
  }
}
if (!paperA || !paperB) throw new Error("导入阶段未完成");

// ─── 阶段 2：重解析 A → 运行中重解析 B（应入队）→ 再点 B（应提示已在队列）───
await evalJS(`window.__cps.startPaperReparse(${JSON.stringify({ id: paperA.id, title: paperA.title })}); true`);
console.log("阶段2: A 重解析已提交", paperA.title);
// 等 A 真正进入解析
let aRunning = null;
{
  const t0 = Date.now();
  while (Date.now() - t0 < 120000) {
    await sleep(2000);
    aRunning = await evalJS(STORE);
    if (aRunning && aRunning.status === "running" && /refractive/i.test(aRunning.fileName)) break;
  }
}
console.log("阶段2: A 解析中:", JSON.stringify(aRunning));

// 运行中提交 B
await evalJS(`window.__cps.startPaperReparse(${JSON.stringify({ id: paperB.id, title: paperB.title })}); true`);
await sleep(1200);
console.log("阶段2(a): B 提交后 toast:", await evalJS(TOASTS));
console.log("阶段2(a): 卡片:", await evalJS(STORE));

// 重复提交 B
await evalJS(`(() => { window.__lastToasts = document.querySelectorAll('[data-sonner-toast]').length; window.__cps.startPaperReparse(${JSON.stringify({ id: paperB.id, title: paperB.title })}); return true; })()`);
await sleep(1200);
console.log("阶段2(b): 重复提交 B toast:", await evalJS(TOASTS));

// ─── 阶段 3：等 A 完成、B 开跑；此时翻译 A（不撞车）应启动，翻译 B（撞车）应被提示 ───
console.log("阶段3: 等 A 完成、B 开跑…");
{
  const t0 = Date.now();
  while (Date.now() - t0 < 600000) {
    await sleep(6000);
    const st = await evalJS(STORE);
    if (st && st.status === "running" && /mass transfer/i.test(st.fileName)) break;
    if (!st || st.status !== "running") { await sleep(4000); }
  }
}
console.log("阶段3: 当前:", JSON.stringify(await evalJS(STORE)));
// 翻译 B（撞车，应给提示）——通过 UI：文献库页右键 B 的卡片
const ctxMenuClick = async (title, menuText) => {
  return evalJS(`(async () => {
    const cards = Array.from(document.querySelectorAll('[data-slot="card"], .group')).filter((el) => (el.textContent ?? '').includes(${JSON.stringify(title.slice(0, 20))}));
    const card = cards.find((el) => el.querySelector('h3, [class*="title"], p'));
    if (!card) return 'card not found';
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 800));
    const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find((m) => (m.textContent ?? '').trim() === ${JSON.stringify(menuText)});
    if (!item) return 'menu item not found';
    item.click();
    return 'clicked';
  })()`);
};
console.log("阶段3(c2): 翻译撞车篇 B:", await ctxMenuClick(paperB.title, "翻译"));
await sleep(1500);
console.log("阶段3(c2): toast:", await evalJS(TOASTS));
// 翻译 A（不撞车，应启动）
console.log("阶段3(c1): 翻译已完成篇 A:", await ctxMenuClick(paperA.title, "翻译"));
await sleep(4000);
console.log("阶段3(c1): toast:", await evalJS(TOASTS));
console.log("阶段3(c1): 页面批量卡:", await evalJS(`(() => {
  const el = Array.from(document.querySelectorAll('div')).find((d) => (d.textContent ?? '').includes('批量翻译') && (d.textContent ?? '').includes('取消'));
  return el ? (el.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 120) : null;
})()`));
// 取消翻译（点批量卡的取消/X）
console.log("阶段3(c1): 取消翻译:", await evalJS(`(() => {
  const el = Array.from(document.querySelectorAll('div')).find((d) => (d.textContent ?? '').includes('批量翻译') && (d.textContent ?? '').includes('取消'));
  const btn = el?.querySelector('button');
  if (!btn) return 'no btn';
  btn.click();
  return 'clicked';
})()`));

// B 的重解析让它跑完或取消？取消以省时间（同时验证取消语义：取消当前+清队）
await evalJS(`window.__cps.cancelPaperImport(); true`);
await sleep(2000);
console.log("阶段4: 取消后卡片:", await evalJS(STORE));

// 清理：两篇测试条目移回收站
for (const p of [paperA, paperB]) {
  await evalJS(`(async () => { const m = await import('/src/services/paper-service.ts'); await m.trashPaper(${JSON.stringify(p.id)}); return true; })()`);
}
console.log("测试条目已入回收站");
console.log("done");
ws.close();
