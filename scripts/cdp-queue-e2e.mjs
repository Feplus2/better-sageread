// 队列 E2E：两篇 PDF 连续导入（第二篇在首篇解析中提交）→ 串行接续 + 卡片队列计数
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

const PDF1 = "C:\\Users\\20995\\AppData\\Local\\Temp\\queue-test2\\prasad2017scaffold.pdf";
const PDF2 = "C:\\Users\\20995\\AppData\\Local\\Temp\\queue-test2\\iijima2009surface.pdf";

await call("Page.reload", { ignoreCache: true });
await sleep(4500);
await evalJS(`import("/src/store/layout-store.ts").then((m) => { window.__layout = m; }); "loading"`);
await evalJS(`import("/src/store/convert-progress-store.ts").then((m) => { window.__cps = m; }); "loading"`);
for (let i = 0; i < 20; i++) {
  await sleep(500);
  if (await evalJS(`!!window.__layout && !!window.__cps`).catch(() => false)) break;
}
// 主页（进度卡非豁免视图）
await evalJS(`window.__layout.useLayoutStore.getState().navigateToHome(); true`);
await sleep(800);

const cardText = `(() => { const c = document.querySelector('.fixed.right-4.bottom-4'); return c ? (c.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 200) : null; })()`;

// 提交第 1 篇
await evalJS(`window.__cps.startPaperImportBatch([${JSON.stringify(PDF1)}]); true`);
console.log("第 1 篇已提交");
let st = null;
for (let i = 0; i < 40; i++) {
  await sleep(500);
  st = await evalJS(cardText);
  if (st && st.includes("prasad2017scaffold")) break;
}
console.log("首篇进度卡:", JSON.stringify(st));

// 等首篇真正进入解析（出现解析阶段名/百分比）再提交第 2 篇
const t0 = Date.now();
for (;;) {
  await sleep(2000);
  st = await evalJS(cardText);
  if (st && (st.includes("OCR 解析") || st.includes("%"))) break;
  if (Date.now() - t0 > 60000) break;
}
console.log("首篇解析中:", JSON.stringify(st));

// 解析中提交第 2 篇 → 应入队（toast + 卡片计数）
await evalJS(`window.__cps.startPaperImportBatch([${JSON.stringify(PDF2)}]); true`);
await sleep(1500);
console.log("第 2 篇提交 toast:", await evalJS(`Array.from(document.querySelectorAll('[data-sonner-toast]')).map((t) => (t.textContent ?? '').replace(/\\s+/g, ' ').trim()).join(' | ').slice(0, 160)`));
console.log("入队后进度卡:", JSON.stringify(await evalJS(cardText)));

// 等两篇全部结算（卡出现 已入库x2 / 批量解析完成 / 失败）
const t1 = Date.now();
let final = null;
let sawSecond = null;
while (Date.now() - t1 < 1500000) {
  await sleep(6000);
  final = await evalJS(cardText);
  if (final && final.includes("iijima2009surface") && !sawSecond) {
    sawSecond = final;
    console.log("接续第 2 篇进度卡:", JSON.stringify(sawSecond));
  }
  if (final && (final.includes("批量解析完成") || final.includes("失败") || final.includes("已取消"))) break;
  if (!final) break;
}
console.log("最终进度卡:", JSON.stringify(final));

// 库内验证 + 清理测试条目
const found = await evalJS(`(async () => {
  const m = await import('/src/services/paper-service.ts');
  const papers = await m.listPapers();
  return papers.filter((p) => /prasad|solvent casting|iijima|surface modification/i.test(p.title ?? '')).map((p) => ({ id: p.id, title: p.title.slice(0, 50) }));
})()`);
console.log("库内新条目:", JSON.stringify(found));
for (const p of found) {
  await evalJS(`(async () => { const m = await import('/src/services/paper-service.ts'); await m.trashPaper(${JSON.stringify(p.id)}); return true; })()`);
}
console.log("测试条目已移入回收站:", found.length);
console.log("done");
ws.close();
