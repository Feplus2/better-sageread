// 撞车/解锁 UI 验证（搜索过滤 + 右键菜单驱动）
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

const A_ID = "b3b3f351280a1f39";
const B_ID = "66c6e59031cc822e";
const STORE = `(async () => { const m = await import('/src/store/convert-progress-store.ts'); const p = m.useConvertProgressStore.getState().paperImport; return p ? { status: p.status, fileName: (p.fileName ?? '').slice(0, 35), q: p.queuedCount } : null; })()`;
const TOASTS = `Array.from(document.querySelectorAll('[data-sonner-toast]')).map((t) => (t.textContent ?? '').replace(/\\s+/g, ' ').trim()).join(' | ').slice(0, 240)`;

await evalJS(`import("/src/store/layout-store.ts").then((m) => { window.__layout = m; }); "loading"`);
await evalJS(`import("/src/store/convert-progress-store.ts").then((m) => { window.__cps = m; }); "loading"`);
for (let i = 0; i < 20; i++) {
  await sleep(500);
  if (await evalJS(`!!window.__layout && !!window.__cps`).catch(() => false)) break;
}

// 搜索过滤并右键卡片
const searchAndMenu = async (query) => {
  await evalJS(`(() => {
    const input = Array.from(document.querySelectorAll('input')).find((i) => (i.placeholder ?? '').match(/搜索|检索/));
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify("")} );
    input.dispatchEvent(new Event('input', { bubbles: true }));
    setter.call(input, ${JSON.stringify(query)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    true;
  })()`);
  await sleep(1500);
  return evalJS(`(async () => {
    const leaves = Array.from(document.querySelectorAll('*')).filter((el) => el.children.length === 0 && (el.textContent ?? '').includes(${JSON.stringify(query)}));
    if (leaves.length === 0) return null;
    const card = leaves[0].closest('[class*="rounded"]') ?? leaves[0].parentElement;
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 900));
    return Array.from(document.querySelectorAll('[role="menuitem"]')).map((m) => (m.textContent ?? '').trim() + (m.getAttribute('aria-disabled') === 'true' || m.hasAttribute('data-disabled') ? '[disabled]' : ''));
  })()`);
};
const clickMenu = async (text) =>
  evalJS(`(() => {
    const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find((m) => (m.textContent ?? '').trim() === ${JSON.stringify(text)});
    if (!item) return false;
    item.click();
    return true;
  })()`);

// 1. A 重解析入队（造运行窗口）
await evalJS(`window.__cps.startPaperReparse({ id: '${A_ID}', title: 'Relationships between refractive index change' }); true`);
{
  const t0 = Date.now();
  for (;;) {
    await sleep(2000);
    const st = await evalJS(STORE);
    if (st && st.status === "running") break;
    if (Date.now() - t0 > 120000) throw new Error("A 未运行");
  }
}
console.log("1) A 重解析运行中:", JSON.stringify(await evalJS(STORE)));

// 2. c2：A（解析中）菜单 + 翻译
const menuA = await searchAndMenu("refractive");
console.log("2) A 菜单项:", JSON.stringify(menuA));
console.log("2) 点翻译:", await clickMenu("翻译"));
await sleep(1500);
console.log("2) toast（应撞车提示）:", await evalJS(TOASTS));
await evalJS(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
await sleep(500);

// 3. c1：B（不撞车）翻译 → 应启动
await searchAndMenu("Mass Transfer");
console.log("3) 点翻译:", await clickMenu("翻译"));
await sleep(5000);
console.log("3) 批量翻译卡:", await evalJS(`(() => {
  const els = Array.from(document.querySelectorAll('div')).filter((d) => (d.textContent ?? '').includes('批量翻译'));
  const el = els.pop();
  return el ? (el.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 140) : null;
})()`));
console.log("3) 取消翻译:", await evalJS(`(() => {
  const els = Array.from(document.querySelectorAll('div')).filter((d) => (d.textContent ?? '').includes('批量翻译'));
  const btn = els.pop()?.querySelector('button');
  if (!btn) return 'no btn';
  btn.click();
  return 'clicked';
})()`));

// 4. b2：A 运行中「重新解析」→ 确认 → 应提示已在队列
await searchAndMenu("refractive");
console.log("4) 点重新解析:", await clickMenu("重新解析"));
await sleep(800);
console.log("4) 确认框:", await evalJS(`(() => {
  const btn = Array.from(document.querySelectorAll('[role="alertdialog"] button, [role="dialog"] button')).find((b) => /确定|确认|继续|是/.test(b.textContent ?? ''));
  if (!btn) return 'none';
  btn.click();
  return 'confirmed';
})()`));
await sleep(1500);
console.log("4) toast（应'已在解析队列中'）:", await evalJS(TOASTS));

// 5. 收尾
await evalJS(`window.__cps.cancelPaperImport(); true`);
await sleep(1500);
for (const id of [A_ID, B_ID]) {
  await evalJS(`(async () => { const m = await import('/src/services/paper-service.ts'); await m.trashPaper('${id}'); return true; })()`);
}
console.log("5) 清理完成");
console.log("done");
ws.close();
