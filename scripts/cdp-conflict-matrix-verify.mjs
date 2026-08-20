// 冲突矩阵 + 标签页 UX 验证：
// (a) 解析队列跑 A 时向量化 B 正常、向量化 A 给提示；(b) B 向量化中提交 B 重解析被拒；
// (c) A 标签页开着时提交 A 重解析 → 引导 toast；完成后横幅 + 重新加载生效；(d) 打开队列中论文 → 旧版本提示
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
const STORE = `(async () => { const m = await import('/src/store/convert-progress-store.ts'); const p = m.useConvertProgressStore.getState().paperImport; return p ? { status: p.status, fileName: (p.fileName ?? '').slice(0, 30), q: p.queuedCount } : null; })()`;
const TOASTS = `Array.from(document.querySelectorAll('[data-sonner-toast]')).map((t) => (t.textContent ?? '').replace(/\\s+/g, ' ').trim()).join(' | ').slice(0, 260)`;

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

// ─── 导入两篇测试论文 ───
await evalJS(`window.__cps.startPaperImportBatch([${JSON.stringify(PDF1)}, ${JSON.stringify(PDF2)}]); true`);
console.log("导入已提交");
let A = null;
let B = null;
{
  const t0 = Date.now();
  while (Date.now() - t0 < 900000) {
    await sleep(8000);
    const found = await evalJS(`(async () => {
      const m = await import('/src/services/paper-service.ts');
      return (await m.listPapers()).filter((p) => /refractive index|mass transfer/i.test(p.title ?? '')).map((p) => ({ id: p.id, title: p.title.slice(0, 45) }));
    })()`);
    if (found.length >= 2) {
      A = found.find((p) => /refractive/i.test(p.title));
      B = found.find((p) => /mass transfer/i.test(p.title));
      break;
    }
  }
}
console.log("入库:", JSON.stringify({ A, B }));
if (!A || !B) throw new Error("导入未完成");

// ─── (a) 解析队列跑 A（重解析），向量化 B 应正常、向量化 A 应提示 ───
await evalJS(`window.__cps.startPaperReparse(${JSON.stringify({ id: A.id, title: A.title })}); true`);
{
  const t0 = Date.now();
  for (;;) {
    await sleep(1500);
    const st = await evalJS(STORE);
    if (st && st.status === "running") break;
    if (Date.now() - t0 > 120000) throw new Error("A 未运行");
  }
}
console.log("(a) A 重解析运行中");
// 向量化 A → 应提示（直接调页面同源逻辑：isPaperQueuedOrRunning 判定 + toast）
console.log("(a) isPaperQueuedOrRunning(A)（应 true）:", await evalJS(`window.__cps.isPaperQueuedOrRunning('${A.id}')`));
// 向量化 B（真实调用单篇向量化路径 —— 经 papers 页的 handleVectorize 不可达，store 层判据 + 真实 vectorizePaper 调用）
console.log("(a) isPaperQueuedOrRunning(B)（应 false）:", await evalJS(`window.__cps.isPaperQueuedOrRunning('${B.id}')`));
console.log("(a) 向量化 B 启动:", await evalJS(`(async () => {
  const m = await import('/src/services/paper-service.ts');
  window.__cps.markPaperVectorizing('${B.id}', true);
  m.vectorizePaper({ id: '${B.id}', title: 'x', author: '' }).then(
    () => { window.__vecB = 'ok'; window.__cps.markPaperVectorizing('${B.id}', false); },
    (e) => { window.__vecB = 'fail:' + String(e).slice(0, 80); window.__cps.markPaperVectorizing('${B.id}', false); },
  );
  return 'started';
})()`));
await sleep(3000);
console.log("(a) B 向量化中:", await evalJS(`window.__cps.isPaperVectorizing('${B.id}')`));

// ─── (b) B 向量化中提交 B 重解析 → 应拒入队 ───
console.log("(b) startPaperReparse(B) 返回（应 false）:", await evalJS(`window.__cps.startPaperReparse(${JSON.stringify({ id: B.id, title: B.title })})`));
console.log("(b) toast:", await evalJS(TOASTS));

// ─── (c) A 标签页开着时提交 A 重解析 → 警告 toast；完成后横幅 ───
// 等 A 重解析完成
{
  const t0 = Date.now();
  for (;;) {
    await sleep(4000);
    const st = await evalJS(STORE);
    if (!st || st.status !== "running") break;
    if (Date.now() - t0 > 600000) break;
  }
}
console.log("(c) A 重解析完成:", JSON.stringify(await evalJS(STORE)));
// 打开 A 的标签页，再提交 A 重解析 → 应有警告 toast
await evalJS(`window.__layout.useLayoutStore.getState().openPaper('${A.id}', 'A'); true`);
await sleep(2500);
await evalJS(`window.__cps.startPaperReparse(${JSON.stringify({ id: A.id, title: A.title })}); true`);
await sleep(1000);
console.log("(c) 提交 A（标签页开着）后 toast:", await evalJS(TOASTS));
// 等完成 → 横幅应出现
{
  const t0 = Date.now();
  for (;;) {
    await sleep(4000);
    const banner = await evalJS(`(() => { const els = Array.from(document.querySelectorAll('div')).filter((d) => (d.textContent ?? '').includes('本文已重新解析')); return els.length > 0; })()`);
    if (banner) { console.log("(c) 横幅出现: true"); break; }
    const st = await evalJS(STORE);
    if (Date.now() - t0 > 600000) { console.log("(c) 横幅超时, 状态:", JSON.stringify(st)); break; }
  }
}
// 点「重新加载」→ 横幅消失且内容重载
console.log("(c) 点重新加载:", await evalJS(`(() => {
  const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent ?? '').trim() === '重新加载');
  if (!btn) return false;
  btn.click();
  return true;
})()`));
await sleep(2500);
console.log("(c) 重载后横幅(应 false):", await evalJS(`Array.from(document.querySelectorAll('div')).some((d) => (d.textContent ?? '').includes('本文已重新解析'))`));

// ─── (d) 打开队列中的论文 → 旧版本提示 ───
await evalJS(`window.__cps.startPaperReparse(${JSON.stringify({ id: B.id, title: B.title })}); true`);
await sleep(1500);
await evalJS(`window.__layout.useLayoutStore.getState().openPaper('${B.id}', 'B'); true`);
await sleep(2500);
console.log("(d) 打开队列中论文的 toast:", await evalJS(TOASTS));

// 收尾：取消队列 + purge 两篇
await evalJS(`window.__cps.cancelPaperImport(); true`);
await sleep(1500);
for (const p of [A, B]) {
  await evalJS(`(async () => { const m = await import('/src/services/book-service.ts'); await m.deleteBook('${p.id}').catch(() => {}); await m.purgeBook('${p.id}').catch(() => {}); return true; })()`);
}
console.log("清理完成");
console.log("done");
ws.close();
