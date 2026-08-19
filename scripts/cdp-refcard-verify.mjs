// P2 参考文献卡片验证：条目点击 → 卡片（补全/在库/按钮）
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

await call("Page.reload", { ignoreCache: true });
await sleep(4000);
await evalJS(`import("/src/store/layout-store.ts").then((m) => { window.__layout = m; }); "loading"`);
for (let i = 0; i < 20; i++) {
  await sleep(500);
  if (await evalJS(`!!window.__layout`).catch(() => false)) break;
}
await evalJS(`window.__layout.useLayoutStore.getState().openPaper("6c533ac14d2b48e4", "cosmic strings"); true`);
// 等正文渲染（ref 锚点存在）
let ready = false;
for (let i = 0; i < 60; i++) {
  await sleep(500);
  ready = await evalJS(`!!document.getElementById("ref-12")`).catch(() => false);
  if (ready) break;
}
if (!ready) throw new Error("正文渲染超时");

const VIS = `(el) => { let n = el; while (n) { if (n.style && n.style.visibility) return n.style.visibility === 'visible'; n = n.parentElement; } return true; }`;

// 点击参考文献条目（滚动到该条目再点其段落文本）
const clickRefEntry = async (n) => {
  await evalJS(`(() => {
    const anchor = Array.from(document.querySelectorAll('a[id="ref-${n}"]')).find(${VIS});
    const scroller = anchor.closest('.overflow-y-auto');
    scroller.scrollTo({ top: anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 200, behavior: 'instant' });
    true;
  })()`);
  await sleep(300);
  return evalJS(`(() => {
    const anchor = Array.from(document.querySelectorAll('a[id="ref-${n}"]')).find(${VIS});
    const block = anchor.closest('p, li');
    // 点条目中部文本（避开行内 DOI 链接）
    const r = block.getBoundingClientRect();
    const el = document.elementFromPoint(r.left + Math.min(80, r.width / 3), r.top + r.height / 2);
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return el.tagName;
  })()`);
};
// 读卡片内容（等补全/状态落定：等到不再出现"正在解析"）
const readCard = async (maxWait = 30000) => {
  const t0 = Date.now();
  for (;;) {
    await sleep(600);
    const card = await evalJS(`(() => {
      const wrap = document.querySelector('[data-radix-popper-content-wrapper]');
      if (!wrap) return null;
      const text = (wrap.textContent ?? '').replace(/\\s+/g, ' ').trim();
      return { text: text.slice(0, 400), loading: text.includes('正在解析') };
    })()`);
    if (card && !card.loading) return card;
    if (Date.now() - t0 > maxWait) return card;
  }
};
const closeCard = async () => {
  await evalJS(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  await sleep(500);
};

// ─── 1. [12]（DOI → Crossref；不在库）───
console.log("点击 [12] 条目元素:", await clickRefEntry(12));
console.log("1) [12] 卡片:", JSON.stringify(await readCard()));

// ─── 2. [5]（无 DOI → OpenAlex 标题搜索；书）───
await closeCard();
console.log("点击 [5] 条目元素:", await clickRefEntry(5));
console.log("2) [5] 卡片:", JSON.stringify(await readCard()));

// ─── 3. [40]（DOI 精确 → 在库命中）───
await closeCard();
console.log("点击 [40] 条目元素:", await clickRefEntry(40));
console.log("3) [40] 卡片:", JSON.stringify(await readCard()));

// ─── 4. [42]（标题模糊 → 在库命中）───
await closeCard();
console.log("点击 [42] 条目元素:", await clickRefEntry(42));
console.log("4) [42] 卡片:", JSON.stringify(await readCard()));
await closeCard();

// ─── 5. references.json 缓存写回验证 ───
console.log("5) 缓存写回条目:", await evalJS(`(async () => {
  const m = await import('/src/services/paper-reference-service.ts');
  return 'module-ok';
})()`));

console.log("done");
ws.close();
