// 监听 SageRead 页面控制台，捕获 Invalid prompt / ModelMessage 相关报错的完整细节（含 zod cause）
// 用法：node scripts/cdp-watch-prompt-error.mjs  —— 启动后请在应用里复现"追问报错"，抓到后自动退出
const LIST_URL = "http://127.0.0.1:9223/json/list";
const pages = await (await fetch(LIST_URL)).json();
const page = pages.find((p) => p.type === "page" && p.url?.includes("localhost:1420"));
if (!page) throw new Error("找不到 SageRead 页面");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let mid = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
    return;
  }
  if (msg.method === "Runtime.consoleAPICalled") {
    const text = (msg.params.args || [])
      .map((a) => a.value ?? a.description ?? a.unserializableValue ?? "")
      .join(" ");
    if (/Invalid prompt|ModelMessage|messages must/i.test(text)) {
      console.log("=== 命中控制台报错 ===");
      for (const a of msg.params.args || []) {
        console.log(JSON.stringify(a.value ?? a.description ?? a, null, 2)?.slice(0, 3000));
      }
      process.exit(0);
    }
  }
  if (msg.method === "Log.entryAdded") {
    const entry = msg.params.entry;
    if (/Invalid prompt|ModelMessage|messages must/i.test(entry.text || "")) {
      console.log("=== 命中 Log 域 ===");
      console.log((entry.text || "").slice(0, 3000));
      process.exit(0);
    }
  }
};
const cdp = (method, params = {}) => { const id = ++mid; ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => pending.set(id, r)); };

await cdp("Runtime.enable");
await cdp("Log.enable");
console.log("监听中…请在应用里复现追问报错（Ctrl+C 退出）");

// 命中后也要把 error 对象的 cause 拉出来：注入一个全局钩子太侵入，先靠 description 预览
setTimeout(() => { console.log("（20 分钟未命中，退出）"); process.exit(2); }, 20 * 60 * 1000);
