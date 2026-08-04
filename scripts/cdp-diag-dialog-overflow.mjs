// 诊断：打开导入 PDF 弹窗 + 注入长路径候选，量各元素实际溢出情况
// 运行：node scripts/cdp-diag-dialog-overflow.mjs
const LIST_URL = "http://127.0.0.1:9223/json/list";
const LONG_PATH = "C:\\\\Users\\\\20995\\\\Zotero\\\\storage\\\\D6JRC7W8\\\\Yuan 等 - 2014 - P2-type Na0.67Mn0.65Fe0.2Ni0.15O2 cathode material with high-capacity for sodium-ion battery.pdf";

const pages = await (await fetch(LIST_URL)).json();
const page = pages.find((p) => p.type === "page" && p.url?.includes("localhost:1420"));
if (!page) throw new Error("找不到 SageRead 页面");

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
  if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails).slice(0, 400));
  return result.result?.result?.value;
}

// 点「导入 PDF」按钮
const clicked = await evalJs(`
  (() => {
    const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "导入 PDF");
    if (!btn) return false;
    btn.click();
    return true;
  })()
`);
if (!clicked) throw new Error("没找到 导入 PDF 按钮");
await new Promise((r) => setTimeout(r, 800));

// 模拟原生拖放注入长路径候选
await evalJs(`
  (async () => {
    const { emit } = await import(location.origin + "/node_modules/.vite/deps/@tauri-apps_api_event.js");
    await emit("tauri://drag-drop", { paths: [${JSON.stringify(LONG_PATH)}], position: { x: 300, y: 300 } });
  })()
`);
await new Promise((r) => setTimeout(r, 800));

// 量各元素
const measure = await evalJs(`
  (() => {
    const content = document.querySelector('[data-slot="dialog-content"]');
    if (!content) return { error: "dialog 未打开" };
    const cRect = content.getBoundingClientRect();
    const items = [];
    for (const el of content.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (r.width > cRect.width + 2 || r.right > cRect.right + 2 || r.left < cRect.left - 2) {
        items.push({
          tag: el.tagName.toLowerCase(),
          cls: (el.className.baseVal ?? el.className ?? "").toString().slice(0, 80),
          text: (el.textContent ?? "").trim().slice(0, 50),
          left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width),
        });
      }
    }
    return {
      dialog: { left: Math.round(cRect.left), right: Math.round(cRect.right), width: Math.round(cRect.width) },
      viewport: window.innerWidth,
      overflowCount: items.length,
      items: items.slice(0, 12),
    };
  })()
`);
console.log(JSON.stringify(measure, null, 1));
ws.close();
