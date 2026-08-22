// 真实卡片流程验证：forecast ref-3（有 arxiv_id）→ 开卡片 → 看内容 → 获取PDF → 下载成功即取消（不入库）
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
await evalJS(`window.__layout.useLayoutStore.getState().openPaper("57ae0a5f29feecb6", "forecast"); true`);
for (let i = 0; i < 60; i++) {
  await sleep(500);
  if (await evalJS(`!!document.getElementById("ref-3")`).catch(() => false)) break;
}
await sleep(3000);

// 开 ref-3 卡片
const VIS = `(el) => { let n = el; while (n) { if (n.style && n.style.visibility) return n.style.visibility === 'visible'; n = n.parentElement; } return true; }`;
await evalJS(`(() => {
  const anchor = Array.from(document.querySelectorAll('a[id="ref-3"]')).find(${VIS});
  const scroller = anchor.closest('.overflow-y-auto');
  scroller.scrollTo({ top: anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 200, behavior: 'instant' });
  const r = anchor.closest('li, p').getBoundingClientRect();
  document.elementFromPoint(r.left + 60, r.top + r.height / 2).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  true;
})()`);
await sleep(2500);

// 卡片内容转储
console.log("卡片内容:", await evalJS(`(() => {
  const wrap = document.querySelector('[data-radix-popper-content-wrapper]');
  if (!wrap) return null;
  const btns = Array.from(wrap.querySelectorAll('button')).map((b) => ({ t: (b.textContent ?? '').trim().slice(0, 20), disabled: b.disabled }));
  return { text: (wrap.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 300), btns };
})()`));

// 点 获取PDF
const clicked = await evalJS(`(() => {
  const wrap = document.querySelector('[data-radix-popper-content-wrapper]');
  if (!wrap) return 'no-card';
  const btn = Array.from(wrap.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('获取 PDF'));
  if (!btn) return 'no-btn';
  if (btn.disabled) return 'disabled';
  btn.click();
  return 'clicked';
})()`);
console.log("获取PDF:", clicked);
if (clicked !== "clicked") { ws.close(); process.exit(0); }

// 有确认卡就点允许
for (let i = 0; i < 5; i++) {
  await sleep(1000);
  await evalJS(`(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => /允许|确认启动|确认/.test(x.textContent ?? '') && x.closest('[role="dialog"], [role="alertdialog"]'));
    if (b) b.click();
    return !!b;
  })()`).catch(() => false);
}

// 轮询进度卡：等到进入解析阶段（=下载成功）或失败
const t0 = Date.now();
let outcome = "timeout";
while (Date.now() - t0 < 240000) {
  await sleep(3000);
  const st = await evalJS(`(() => {
    const c = document.querySelector('.fixed.right-4.bottom-4');
    return c ? (c.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 200) : null;
  })()`);
  console.log("进度:", JSON.stringify(st));
  if (st && (st.includes("失败") || st.includes("未能") || st.includes("错误"))) { outcome = "FAILED: " + st; break; }
  if (st && (st.includes("OCR") || st.includes("解析") || st.includes("元数据提取") || st.includes("内容处理") || st.includes("启动解析"))) { outcome = "DOWNLOAD_OK"; break; }
  const toasts = await evalJS(`Array.from(document.querySelectorAll('[data-sonner-toast]')).map((t) => t.textContent).join(' | ').slice(0, 200)`);
  if (toasts.includes("未能") || toasts.includes("失败")) { outcome = "TOAST_FAIL: " + toasts; break; }
}
console.log("结论:", outcome);

// 取消（防入库）
if (outcome === "DOWNLOAD_OK") {
  await evalJS(`(() => {
    const c = document.querySelector('.fixed.right-4.bottom-4');
    const b = c && Array.from(c.querySelectorAll('button')).find((x) => (x.textContent ?? '').includes('取消'));
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(1500);
  console.log("取消后 toast:", await evalJS(`Array.from(document.querySelectorAll('[data-sonner-toast]')).map((t) => t.textContent).join(' | ').slice(0, 150)`));
}
ws.close();
console.log("done");
