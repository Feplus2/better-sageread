// 任务1 E2E：[获取 PDF] 全链路（下载→解析→入库→可打开）+ 全局进度层可见性
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
for (let i = 0; i < 60; i++) {
  await sleep(500);
  if (await evalJS(`!!document.getElementById("ref-12")`).catch(() => false)) break;
}
await sleep(3000); // references.json 加载余量

const VIS = `(el) => { let n = el; while (n) { if (n.style && n.style.visibility) return n.style.visibility === 'visible'; n = n.parentElement; } return true; }`;
// 开 [12] 卡片
await evalJS(`(() => {
  const anchor = Array.from(document.querySelectorAll('a[id="ref-12"]')).find(${VIS});
  const scroller = anchor.closest('.overflow-y-auto');
  scroller.scrollTo({ top: anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 200, behavior: 'instant' });
  const r = anchor.closest('p').getBoundingClientRect();
  document.elementFromPoint(r.left + 60, r.top + r.height / 2).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  true;
})()`);
// 等卡片与按钮可用
let btnOk = false;
for (let i = 0; i < 40; i++) {
  await sleep(500);
  btnOk = await evalJS(`(() => {
    const wrap = document.querySelector('[data-radix-popper-content-wrapper]');
    if (!wrap) return false;
    const btn = Array.from(wrap.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('获取 PDF'));
    return btn ? !btn.disabled : false;
  })()`);
  if (btnOk) break;
}
console.log("卡片打开且按钮可用:", btnOk);

// 点 [获取 PDF]
await evalJS(`(() => {
  const wrap = document.querySelector('[data-radix-popper-content-wrapper]');
  Array.from(wrap.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('获取 PDF')).click();
  true;
})()`);
await sleep(1500);
console.log("启动 toast:", await evalJS(`Array.from(document.querySelectorAll('[data-sonner-toast]')).map((t) => t.textContent).join(' | ').slice(0, 120)`));

// 进度状态从主页进度卡 DOM 读（动态 import 的 store 可能与页内实例不同实例，DOM 是唯一事实源）
const dumpProgress = async (label) => {
  await evalJS(`window.__layout.useLayoutStore.getState().navigateToHome(); true`).catch(() => {});
  await sleep(600);
  const st = await evalJS(`(() => {
    const c = document.querySelector('.fixed.right-4.bottom-4');
    return c ? (c.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 160) : null;
  })()`);
  console.log(label, JSON.stringify(st));
  return st;
};

// 下载阶段：进度卡应为 running 且阶段1 active
await sleep(2000);
const downloading = await dumpProgress("下载阶段:");
// 回主页：进度卡应可见（非豁免视图）
await evalJS(`window.__layout.useLayoutStore.getState().navigateToHome(); true`);
await sleep(1200);
console.log("主页进度卡 DOM:", await evalJS(`(() => {
  const card = document.querySelector('.fixed.right-4.bottom-4');
  return card ? (card.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 150) : null;
})()`));
// 回论文页：进度卡应豁免
await evalJS(`window.__layout.useLayoutStore.getState().activateTab('paper-6c533ac14d2b48e4'); true`);
await sleep(800);
console.log("阅读页进度卡豁免(应 null):", await evalJS(`(() => { const c = document.querySelector('.fixed.right-4.bottom-4'); return c ? 'VISIBLE(异常)' : null; })()`));

// 等下载完成 → 解析阶段（卡文本出现解析阶段名）
const t0 = Date.now();
let parsing = false;
while (Date.now() - t0 < 300000) {
  await sleep(4000);
  const st = await dumpProgress("等待解析:");
  if (!st) break;
  if (st.includes("失败") || st.includes("错误") || st.includes("取消")) break;
  if (st.includes("OCR 解析") || st.includes("元数据提取") || st.includes("内容处理")) { parsing = true; break; }
}
console.log("进入解析阶段:", parsing);
// 解析期再抓一次主页卡证据
await evalJS(`window.__layout.useLayoutStore.getState().navigateToHome(); true`);
await sleep(1000);
console.log("解析期主页进度卡:", await evalJS(`(() => { const c = document.querySelector('.fixed.right-4.bottom-4'); return c ? (c.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 150) : null; })()`));

// 等解析+入库完成（最长 16 分钟，按卡文本判定）
let final = null;
const t1 = Date.now();
while (Date.now() - t1 < 960000) {
  await sleep(8000);
  final = await evalJS(`(() => { const c = document.querySelector('.fixed.right-4.bottom-4'); return c ? (c.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 200) : null; })()`);
  if (!final || final.includes("已入库") || final.includes("失败") || final.includes("取消") || final.includes("已存在") || final.includes("入库过")) break;
}
console.log("最终结果:", JSON.stringify(final));

// 入库验证：列表里找新论文并打开
const found = await evalJS(`(async () => {
  const m = await import('/src/services/paper-service.ts');
  const papers = await m.listPapers();
  const hit = papers.find((p) => (p.title ?? '').toLowerCase().includes('cosmic string loops'));
  return hit ? { id: hit.id, title: hit.title.slice(0, 60) } : null;
})()`);
console.log("库中新论文:", JSON.stringify(found));
if (found) {
  await evalJS(`window.__layout.useLayoutStore.getState().openPaper(${JSON.stringify(found.id)}, ${JSON.stringify(found.title)}); true`).catch(
    () => {},
  );
  // 等正文渲染验证可打开
  let opened = false;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    opened = await evalJS(`(() => {
      const c = Array.from(document.querySelectorAll('.paper-content')).find((x) => {
        let n = x; while (n) { if (n.style && n.style.visibility) return n.style.visibility === 'visible'; n = n.parentElement; }
        return true;
      });
      return c ? (c.textContent ?? '').length > 500 : false;
    })()`).catch(() => false);
    if (opened) break;
  }
  console.log("新论文打开渲染:", opened);
}
ws.close();
console.log("done");
