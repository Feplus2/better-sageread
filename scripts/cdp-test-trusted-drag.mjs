// CDP 真实拖拽选词（Input.dispatchMouseEvent）→ 检查标注弹窗
const LIST_URL = "http://127.0.0.1:9222/json/list";
const page = (await (await fetch(LIST_URL)).json()).find((t) => t.type === "page" && t.url.includes("localhost:1420"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const call = (m, p = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = (ev) => { const msg = JSON.parse(ev.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); } };
await new Promise((r) => (ws.onopen = r));
await call("Runtime.enable");
const evalJs = async (expr) => {
  const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) return "EVAL_ERROR: " + (r.exceptionDetails.exception?.description || "").slice(0, 300);
  return r?.result?.value;
};

// 定位 "stable structures" 的起止坐标（EN 侧）
const coords = await evalJs(`(() => {
  const container = [...document.querySelectorAll('.prose')].find(el => el.querySelector('[data-translation]'));
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let node; while ((node = walker.nextNode())) {
    if (node.textContent.includes('stable structures') && !node.parentElement.closest('[data-translation]')) break;
  }
  if (!node) return 'no-node';
  node.parentElement.scrollIntoView({ block: 'center' });
  const i = node.textContent.indexOf('stable structures');
  const r1 = document.createRange(); r1.setStart(node, i); r1.setEnd(node, i + 1);
  const r2 = document.createRange(); r2.setStart(node, i + 'stable structures'.length - 1); r2.setEnd(node, i + 'stable structures'.length);
  const a = r1.getBoundingClientRect(), b = r2.getBoundingClientRect();
  return JSON.stringify({ x1: a.left, y1: a.top + a.height / 2, x2: b.right, y2: b.top + b.height / 2 });
})()`);
console.log("坐标:", coords);
if (typeof coords !== "string" || coords.startsWith("no-") || coords.startsWith("EVAL")) { ws.close(); process.exit(1); }
const { x1, y1, x2, y2 } = JSON.parse(coords);

await call("Input.dispatchMouseEvent", { type: "mousePressed", x: x1, y: y1, button: "left", buttons: 1, clickCount: 1 });
const steps = 8;
for (let i = 1; i <= steps; i++) {
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: x1 + ((x2 - x1) * i) / steps, y: y1 + ((y2 - y1) * i) / steps, button: "left", buttons: 1 });
  await new Promise((r) => setTimeout(r, 30));
}
await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: x2, y: y2, button: "left", buttons: 0, clickCount: 1 });
await new Promise((r) => setTimeout(r, 1500));
console.log("选区与弹窗:", await evalJs(`JSON.stringify({ selected: window.getSelection()?.toString(), popup: !!document.querySelector('.selection-buttons') })`));
ws.close();
process.exit(0);
