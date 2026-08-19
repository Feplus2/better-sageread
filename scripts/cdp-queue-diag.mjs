// 队列诊断跑（带 console 捕获）：两篇全新 PDF，第二篇在首篇解析中提交
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
const logs = [];
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
  else if (msg.method === "Runtime.consoleAPICalled" && ["debug", "log", "warning", "error"].includes(msg.params.type)) {
    const text = (msg.params.args?.map((a) => a.value ?? a.description ?? "").join(" ") ?? "").slice(0, 200);
    if (text.includes("paper-queue") || text.includes("去重") || text.includes("跳过")) logs.push(`${new Date().toISOString().slice(11, 19)} ${msg.params.type}: ${text}`);
  }
};
await new Promise((r) => (ws.onopen = r));
await call("Runtime.enable", {});
const evalJS = async (expr) => {
  const r = await call("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PDF1 = "C:\\Users\\20995\\AppData\\Local\\Temp\\queue-test3\\hu2011macrophages.pdf";
const PDF2 = "C:\\Users\\20995\\AppData\\Local\\Temp\\queue-test3\\jissn2022pharma.pdf";

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

const storeState = `(async () => { const m = await import('/src/store/convert-progress-store.ts'); const p = m.useConvertProgressStore.getState().paperImport; return p ? p.status + ' | ' + p.fileName + ' | 第' + p.index + '/' + p.total + '篇 待' + p.queuedCount + ' | ' + (p.detail ?? p.error ?? '') : 'null'; })()`;

await evalJS(`window.__cps.startPaperImportBatch([${JSON.stringify(PDF1)}]); true`);
console.log("T+0 第 1 篇已提交");
await sleep(6000);
console.log("首篇状态:", await evalJS(storeState));

// 确认进入解析后提交第二篇
await evalJS(`window.__cps.startPaperImportBatch([${JSON.stringify(PDF2)}]); true`);
console.log("第 2 篇已提交（首篇解析中）");
await sleep(1500);
console.log("入队后状态:", await evalJS(storeState));

// 每分钟打一次状态，直到 success/error 终态且队列空
const t0 = Date.now();
let last = "";
while (Date.now() - t0 < 1500000) {
  await sleep(10000);
  const st = await evalJS(storeState);
  if (st !== last) { console.log("状态:", st); last = st; }
  if (st === "null") break;
  if (st.startsWith("success") || st.startsWith("error")) {
    // 终态后再看一眼是否还有续跑
    await sleep(12000);
    const st2 = await evalJS(storeState);
    console.log("终态后 12s:", st2);
    if (st2 === "null" || st2 === st) break;
  }
}
console.log("--- console 日志 ---");
for (const l of logs) console.log(l);
console.log("done");
ws.close();
