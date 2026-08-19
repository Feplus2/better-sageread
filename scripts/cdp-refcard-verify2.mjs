// P2 卡片验证 round2：[打开] 在库跳转 / [获取 PDF] 真调 Zotero Brain / [访问页面] URL
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

const openCard = async (n) => {
  await evalJS(`(() => {
    const anchor = Array.from(document.querySelectorAll('a[id="ref-${n}"]')).find(${VIS});
    const scroller = anchor.closest('.overflow-y-auto');
    scroller.scrollTo({ top: anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 200, behavior: 'instant' });
    const block = anchor.closest('p, li');
    const r = block.getBoundingClientRect();
    const el = document.elementFromPoint(r.left + Math.min(80, r.width / 3), r.top + r.height / 2);
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    true;
  })()`);
  const t0 = Date.now();
  for (;;) {
    await sleep(600);
    const card = await evalJS(`(() => {
      const wrap = document.querySelector('[data-radix-popper-content-wrapper]');
      if (!wrap) return null;
      const text = (wrap.textContent ?? '').replace(/\\s+/g, ' ').trim();
      return { text, loading: text.includes('正在解析') };
    })()`);
    if (card && !card.loading) return card.text;
    if (Date.now() - t0 > 30000) return card?.text ?? null;
  }
};
const clickCardButton = async (label) => {
  return evalJS(`(() => {
    const wrap = document.querySelector('[data-radix-popper-content-wrapper]');
    const btn = Array.from(wrap.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes(${JSON.stringify(label)}));
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
};

// ─── 1. [40] 在库 → [打开] → 跳到 e5a68705 tab ───
await openCard(40);
const tabsBefore = await evalJS(`window.__layout.useLayoutStore.getState().tabs.map((t) => t.id).join(',')`);
console.log("1) [打开] 点击:", await clickCardButton("打开"));
await sleep(2500);
console.log("1) 跳转后活动 tab:", await evalJS(`window.__layout.useLayoutStore.getState().activeTabId`), " 跳前 tabs:", tabsBefore);

// 回到宇宙弦 tab
await evalJS(`window.__layout.useLayoutStore.getState().activateTab('paper-6c533ac14d2b48e4'); true`);
await sleep(1200);

// ─── 2. [5] 不在库 → [获取 PDF] 真调 Zotero Brain（确认卡自动允许；成功则取消解析）───
await openCard(5);
console.log("2) [获取 PDF] 点击:", await clickCardButton("获取 PDF"));
// stdio 启动确认卡（若安全模式非 full）：点「允许」
for (let i = 0; i < 10; i++) {
  await sleep(800);
  const approved = await evalJS(`(() => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent ?? '').trim() === '允许');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  if (approved) { console.log("2) stdio 确认卡已允许"); break; }
}
// 等下载结果（Zotero Brain 瀑布可能 1-2 分钟）：盯卡片失败提示或成功 toast
let outcome = null;
const t0 = Date.now();
while (Date.now() - t0 < 180000) {
  await sleep(3000);
  outcome = await evalJS(`(() => {
    const wrap = document.querySelector('[data-radix-popper-content-wrapper]');
    const cardText = wrap ? (wrap.textContent ?? '').replace(/\\s+/g, ' ').trim() : '';
    const fail = cardText.includes('未能获取 PDF') ? cardText.slice(cardText.indexOf('未能获取 PDF'), cardText.indexOf('未能获取 PDF') + 150) : null;
    const toasts = Array.from(document.querySelectorAll('[data-sonner-toast]')).map((t) => (t.textContent ?? '').replace(/\\s+/g, ' ').trim());
    return { fail, toasts, cardOpen: !!wrap };
  })()`);
  if (outcome.fail) break;
  if (outcome.toasts.some((t) => t.includes('已下载') || t.includes('解析'))) break;
}
console.log("2) 获取 PDF 结果:", JSON.stringify(outcome));
// 若下载成功进入了解析链路，立即取消（避免 15 分钟转换占用）
const cancelled = await evalJS(`(async () => {
  const m = await import('/src/services/paper-service.ts');
  await m.cancelPaperPdfImport().catch(() => {});
  return true;
})()`);
console.log("2) 解析取消兜底:", cancelled);

// ─── 3. [访问页面] URL 计算断言（不真点，不打扰用户浏览器）───
const urls = await evalJS(`(async () => {
  const m = await import('/src/services/paper-reference-service.ts');
  const refs = [
    { n: 12, raw: '', title: 'The number of cosmic string loops', doi: '10.1103/PhysRevD.89.023512' },
    { n: 5, raw: 'x'.repeat(200), title: 'Cosmic Strings and Other Topological Defects' },
    { n: 99, raw: 'B. Unknown, Some obscure work, Nowhere 2020.' },
  ];
  return refs.map((r) => m.referenceLandingUrl(r, null));
})()`);
console.log("3) 访问页面 URL:", JSON.stringify(urls, null, 1));

console.log("done");
ws.close();
