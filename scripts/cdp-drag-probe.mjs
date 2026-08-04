// 拖放探针：在运行中的 SageRead 里挂 tauri://drag-* 原生事件监听并记录到 window.__dragProbe
// 用法：node scripts/cdp-drag-probe.mjs install   —— 安装探针（然后请用户真实拖一次文件进窗口）
//      node scripts/cdp-drag-probe.mjs read      —— 读取探针记录
//      node scripts/cdp-drag-probe.mjs clear     —— 清空记录
const LIST_URL = "http://127.0.0.1:9223/json/list";
const mode = process.argv[2] ?? "read";

const pages = await (await fetch(LIST_URL)).json();
const page = pages.find((p) => p.type === "page" && p.url?.includes("localhost:1420"));
if (!page) throw new Error("找不到 SageRead 页面（9223 CDP 未连接）");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let mid = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
function cdp(method, params = {}) {
  const id = ++mid;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve) => pending.set(id, resolve));
}
async function evalJs(expression) {
  const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails).slice(0, 300));
  return result.result?.result?.value;
}

if (mode === "install") {
  const res = await evalJs(`
    (async () => {
      const { listen } = await import(location.origin + "/node_modules/.vite/deps/@tauri-apps_api_event.js");
      window.__dragProbe = window.__dragProbe ?? [];
      for (const name of ["tauri://drag-enter", "tauri://drag-over", "tauri://drag-leave", "tauri://drag-drop"]) {
        await listen(name, (e) => {
          window.__dragProbe.push({ event: name, payload: e.payload, at: new Date().toISOString() });
          console.log("[dragProbe]", name, JSON.stringify(e.payload));
        });
      }
      return "installed, listeners=4";
    })()
  `);
  console.log(res, "—— 请现在把任意 PDF 真实拖入 SageRead 窗口，然后运行: node scripts/cdp-drag-probe.mjs read");
} else if (mode === "read") {
  const records = await evalJs("window.__dragProbe ?? []");
  console.log(`探针记录 ${records.length} 条:`);
  for (const r of records) console.log(" ", r.event, JSON.stringify(r.payload));
  if (records.length === 0) console.log("（空：原生拖放事件仍未到达 webview）");
} else if (mode === "clear") {
  await evalJs("window.__dragProbe = []; 'cleared'");
  console.log("已清空");
}
ws.close();
