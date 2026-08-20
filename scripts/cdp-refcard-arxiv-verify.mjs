// ref-3（title=null, arxiv_id=hep-th/0204074）卡片验证：S2 补全 + 获取PDF（title 空）+ 解析阶段即取消
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
await sleep(4500);
await evalJS(`import("/src/store/layout-store.ts").then((m) => { window.__layout = m; }); "loading"`);
for (let i = 0; i < 20; i++) {
  await sleep(500);
  if (await evalJS(`!!window.__layout`).catch(() => false)) break;
}
await evalJS(`window.__layout.useLayoutStore.getState().openPaper("57ae0a5f29feecb6", "Forecast constraints"); true`);
const VIS = `(el) => { let n = el; while (n) { if (n.style && n.style.visibility) return n.style.visibility === 'visible'; n = n.parentElement; } return true; }`;
let ready = false;
for (let i = 0; i < 240; i++) {
  await sleep(500);
  ready = await evalJS(`(() => { const c = Array.from(document.querySelectorAll('.paper-content')).find(${VIS}); return !!(c && c.querySelector('a[id="ref-3"]')); })()`).catch(() => false);
  if (ready) break;
}
if (!ready) throw new Error("渲染超时");

// ─── 1. 点 ref-3 条目 → 卡片应显示 S2 补全的元数据 ───
await evalJS(`(() => {
  const anchor = Array.from(document.querySelectorAll('a[id="ref-3"]')).find(${VIS});
  const block = anchor.closest('p, li');
  block.scrollIntoView({ block: 'center' });
  const r = block.getBoundingClientRect();
  document.elementFromPoint(r.left + 60, r.top + r.height / 2).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  true;
})()`);
let card = null;
for (let i = 0; i < 40; i++) {
  await sleep(600);
  card = await evalJS(`(() => {
    const wrap = document.querySelector('[data-radix-popper-content-wrapper]');
    if (!wrap) return null;
    const t = (wrap.textContent ?? '').replace(/\\s+/g, ' ').trim();
    return { t: t.slice(0, 300), loading: t.includes('正在解析') };
  })()`);
  if (card && !card.loading) break;
}
console.log("1) ref-3 卡片:", JSON.stringify(card));

// ─── 2. 点「获取 PDF」→ 进度卡下载 → 一进解析阶段立即取消 ───
await evalJS(`(() => {
  const wrap = document.querySelector('[data-radix-popper-content-wrapper]');
  const btn = Array.from(wrap.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('获取 PDF'));
  btn.click();
  true;
})()`);
console.log("2) 已点获取 PDF");
await sleep(1500);
console.log("2) 启动 toast:", await evalJS(`Array.from(document.querySelectorAll('[data-sonner-toast]')).map((t) => t.textContent).join(' | ').slice(0, 140)`));
// 回主页看进度卡
await evalJS(`window.__layout.useLayoutStore.getState().navigateToHome(); true`);
const cardText = `(() => { const c = document.querySelector('.fixed.right-4.bottom-4'); return c ? (c.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 160) : null; })()`;
let sawDownload = null;
let sawParse = null;
let cancelled = false;
const t0 = Date.now();
while (Date.now() - t0 < 300000) {
  await sleep(1500);
  const st = await evalJS(cardText);
  if (st && !sawDownload && st.includes("下载")) sawDownload = st;
  if (st && (st.includes("OCR 解析") || st.includes("元数据提取") || st.includes("上传") || st.includes("清洗"))) {
    sawParse = st;
    // 进入解析阶段立即取消（点进度卡 X）
    await evalJS(`(() => {
      const c = document.querySelector('.fixed.right-4.bottom-4');
      const x = c?.querySelector('button');
      x?.click();
      true;
    })()`);
    cancelled = true;
    break;
  }
  if (st && (st.includes("失败") || st.includes("未能获取"))) break;
}
console.log("2) 下载阶段卡:", JSON.stringify(sawDownload));
console.log("2) 解析阶段卡:", JSON.stringify(sawParse), " 已取消:", cancelled);
await sleep(2000);
console.log("2) 取消后卡:", JSON.stringify(await evalJS(cardText)));
console.log("done");
ws.close();
