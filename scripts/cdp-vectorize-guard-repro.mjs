// 复现：重解析进行中向量化未被拦截。用 ?t= 同实例 store + 检查页面实际加载的 papers/index.tsx 是否含守卫
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
const call = (m, p) => { let r; const pr = new Promise((res) => (r = res)); pending.set(++mid, { r }); ws.send(JSON.stringify({ id: mid, method: m, params: p })); return pr; };
ws.onmessage = (e) => { const msg = JSON.parse(e.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id).r(msg.result); pending.delete(msg.id); } };
await new Promise((r) => (ws.onopen = r));
const evalJS = async (expression) => {
  const r = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return { __error: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text };
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 0) 页面实际加载的 papers/index.tsx（转换后源码）里向量化守卫是否存在
const guardCheck = await evalJS(`(async () => {
  const resp = await fetch('/src/pages/papers/index.tsx');
  const src = await resp.text();
  return {
    hasGuard: src.includes('正在解析队列中，完成后再向量化'),
    guardCount: (src.match(/isPaperQueuedOrRunning/g) || []).length,
    // 页面里 index.tsx 对 store 的引用带什么 ?t=
    storeRefs: [...src.matchAll(/convert-progress-store[^"'\\s]*/g)].map((m) => m[0]).slice(0, 3),
  };
})()`);
console.log("页面 index.tsx 守卫:", JSON.stringify(guardCheck));

// 1) 抠出消费方转换源码里的 store ?t= URL，import 同实例
const storeInfo = await evalJS(`(async () => {
  const resp = await fetch('/src/pages/papers/index.tsx');
  const src = await resp.text();
  const m = src.match(/\\/src\\/store\\/convert-progress-store\\.ts\\?t=\\d+/);
  const url = m ? m[0] : '/src/store/convert-progress-store.ts';
  const store = await import(url);
  return { url, hasStart: typeof store.startPaperReparse === 'function', hasCheck: typeof store.isPaperQueuedOrRunning === 'function' };
})()`);
console.log("store 实例:", JSON.stringify(storeInfo));

// 2) 活体复现：对 Dvali 论文(620fec06a34349f4) 提交重解析，立即查守卫，然后马上取消
const repro = await evalJS(`(async () => {
  const resp = await fetch('/src/pages/papers/index.tsx');
  const src = await resp.text();
  const m = src.match(/\\/src\\/store\\/convert-progress-store\\.ts\\?t=\\d+/);
  const store = await import(m ? m[0] : '/src/store/convert-progress-store.ts');
  const id = '620fec06a34349f4';
  const started = store.startPaperReparse({ id, title: 'Formation and Evolution of Cosmic D-strings' });
  await new Promise((r) => setTimeout(r, 300));
  const duringQueue = store.isPaperQueuedOrRunning(id);
  await new Promise((r) => setTimeout(r, 1500));
  const duringRun = store.isPaperQueuedOrRunning(id);
  // 马上取消，别真烧 MinerU
  try { await store.cancelPaperImport(); } catch (e) {}
  return { started, duringQueue, duringRun };
})()`);
console.log("复现:", JSON.stringify(repro));
await sleep(1000);
console.log("取消后状态:", await evalJS(`(async () => {
  const resp = await fetch('/src/pages/papers/index.tsx');
  const src = await resp.text();
  const m = src.match(/\\/src\\/store\\/convert-progress-store\\.ts\\?t=\\d+/);
  const store = await import(m ? m[0] : '/src/store/convert-progress-store.ts');
  return store.isPaperQueuedOrRunning('620fec06a34349f4');
})()`));
ws.close();
console.log("done");
