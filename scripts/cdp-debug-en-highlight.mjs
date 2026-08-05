// 调试：EN 划词标亮后，标注是否落库、cfi 是什么、注册表有没有它的区间
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
  if (r?.exceptionDetails) return "EVAL_ERROR: " + (r.exceptionDetails.exception?.description || "").slice(0, 400);
  return r?.result?.value;
};
const TARGET = "stable structures";

// 拖拽选词（同前）
const coords = JSON.parse(await evalJs(`(() => {
  const container = [...document.querySelectorAll('.prose')].find(el => el.querySelector('[data-translation]'));
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let node; while ((node = walker.nextNode())) {
    if (!node.parentElement.closest('[data-translation]') && node.textContent.includes('${TARGET}')) break;
  }
  if (!node) return 'no-node';
  node.parentElement.scrollIntoView({ block: 'center' });
  const i = node.textContent.indexOf('${TARGET}');
  const r1 = document.createRange(); r1.setStart(node, i); r1.setEnd(node, i + 1);
  const r2 = document.createRange(); r2.setStart(node, i + ${TARGET.length} - 1); r2.setEnd(node, i + ${TARGET.length});
  const a = r1.getBoundingClientRect(), b = r2.getBoundingClientRect();
  return JSON.stringify({ x1: a.left, y1: a.top + a.height / 2, x2: b.right, y2: b.top + b.height / 2 });
})()`));
await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: coords.x1, y: coords.y1, buttons: 0 });
await call("Input.dispatchMouseEvent", { type: "mousePressed", x: coords.x1, y: coords.y1, button: "left", buttons: 1, clickCount: 1 });
for (let i = 1; i <= 10; i++) {
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: coords.x1 + ((coords.x2 - coords.x1) * i) / 10, y: coords.y1, button: "left", buttons: 1 });
  await new Promise((r) => setTimeout(r, 40));
}
await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: coords.x2, y: coords.y2, button: "left", buttons: 0, clickCount: 1 });
await new Promise((r) => setTimeout(r, 1000));
console.log("选区:", await evalJs(`window.getSelection()?.toString()`));
console.log("点标亮:", await evalJs(`(() => {
  const popup = document.querySelector('.selection-buttons');
  if (!popup) return 'no-popup';
  const btns = [...popup.querySelectorAll('button')];
  (btns.find(b => b.title === '高亮') || btns[btns.length - 1]).click();
  return 'ok';
})()`));

// 分阶段观察
for (const wait of [1000, 2000, 3000]) {
  await new Promise((r) => setTimeout(r, wait));
  console.log(`t+${wait/1000}s:`, await evalJs(`(() => {
    const names = [];
    CSS.highlights?.forEach((h, name) => { if (name.startsWith('paper-anno')) names.push(name + ':' + h.size); });
    return JSON.stringify({ popupMode: document.querySelector('.selection-buttons') ? 'open' : 'closed', registry: names });
  })()`));
}
// 查库里这条标注
console.log("DB 标注:", await evalJs(`(async () => {
  const svc = await import('/src/services/book-note-service.ts');
  const notes = await svc.getBookNotes('a27b187c6bd02d3c');
  const hit = notes.find(n => n.text === '${TARGET}');
  return hit ? JSON.stringify({ id: hit.id, cfi: hit.cfi, style: hit.style, color: hit.color, text: hit.text }) : 'not-found';
})()`));
ws.close();
process.exit(0);
