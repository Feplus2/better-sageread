// P2 卡片验证 round3：[获取 PDF] 真调 Zotero Brain（等按钮可用再点；含 execute 超时兜底验证）
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
const VIS = `(el) => { let n = el; while (n) { if (n.style && n.style.visibility) return n.style.visibility === 'visible'; n = n.parentElement; } return true; }`;

await call("Page.reload", { ignoreCache: true });
await sleep(4000);
await evalJS(`import("/src/store/layout-store.ts").then((m) => { window.__layout = m; }); "loading"`);
for (let i = 0; i < 20; i++) {
  await sleep(500);
  if (await evalJS(`!!window.__layout`).catch(() => false)) break;
}
await evalJS(`window.__layout.useLayoutStore.getState().openPaper("6c533ac14d2b48e4", "cosmic strings"); true`);
let ready = false;
for (let i = 0; i < 60; i++) {
  await sleep(500);
  ready = await evalJS(`!!document.getElementById("ref-5")`).catch(() => false);
  if (ready) break;
}
if (!ready) throw new Error("正文渲染超时");

// 开 [5] 卡片（不在库；书条目，瀑布大概率失败走 no_pdf 路径）
await evalJS(`(() => {
  const anchor = Array.from(document.querySelectorAll('a[id="ref-5"]')).find(${VIS});
  const scroller = anchor.closest('.overflow-y-auto');
  scroller.scrollTo({ top: anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 200, behavior: 'instant' });
  const block = anchor.closest('p, li');
  const r = block.getBoundingClientRect();
  const el = document.elementFromPoint(r.left + Math.min(80, r.width / 3), r.top + r.height / 2);
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  true;
})()`);

// 等卡片 + 按钮可用（store 水合）
let btnState = null;
for (let i = 0; i < 40; i++) {
  await sleep(500);
  btnState = await evalJS(`(() => {
    const wrap = document.querySelector('[data-radix-popper-content-wrapper]');
    if (!wrap) return null;
    const btn = Array.from(wrap.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('获取 PDF'));
    if (!btn) return null;
    return { disabled: btn.disabled, loading: (wrap.textContent ?? '').includes('正在解析') };
  })()`);
  if (btnState && !btnState.disabled && !btnState.loading) break;
}
console.log("按钮状态:", JSON.stringify(btnState));
if (!btnState || btnState.disabled) throw new Error("获取 PDF 按钮未可用（zoteroAvailable 仍 false？）");

console.log("点击:", await evalJS(`(() => {
  const wrap = document.querySelector('[data-radix-popper-content-wrapper]');
  const btn = Array.from(wrap.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('获取 PDF'));
  btn.click();
  return true;
})()`));

// 等结果：失败卡片提示 / 成功 toast（最长 4 分钟）
let outcome = null;
const t0 = Date.now();
while (Date.now() - t0 < 240000) {
  await sleep(3000);
  outcome = await evalJS(`(() => {
    const wrap = document.querySelector('[data-radix-popper-content-wrapper]');
    const cardText = wrap ? (wrap.textContent ?? '').replace(/\\s+/g, ' ').trim() : '';
    const failIdx = cardText.indexOf('未能获取 PDF');
    const fail = failIdx >= 0 ? cardText.slice(failIdx, failIdx + 160) : null;
    const spinning = !!(wrap?.querySelector('svg.animate-spin'));
    const toasts = Array.from(document.querySelectorAll('[data-sonner-toast]')).map((t) => (t.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 100));
    return { fail, spinning, toasts };
  })()`);
  if (outcome.fail || outcome.toasts.length > 0) break;
}
console.log("获取 PDF 结果:", JSON.stringify(outcome, null, 1));
// 若成功进入解析链路，取消（避免分钟级转换）
await evalJS(`(async () => { const m = await import('/src/services/paper-service.ts'); await m.cancelPaperPdfImport().catch(() => {}); return true; })()`);
console.log("done");
ws.close();
