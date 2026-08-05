// CDP 验收（方向1 补测，带重试）：EN 划 "stable structures" → ZH 镜像应为"稳定结构"
const LIST_URL = "http://127.0.0.1:9222/json/list";
const page = (await (await fetch(LIST_URL)).json()).find((t) => t.type === "page" && t.url.includes("localhost:1420"));
if (!page) { console.log("NO_PAGE"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const call = (m, p = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
};
await new Promise((r) => (ws.onopen = r));
await call("Runtime.enable");
const evalJs = async (expr) => {
  const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) return "EVAL_ERROR: " + (r.exceptionDetails.exception?.description || "").slice(0, 300);
  return r?.result?.value;
};
const TARGET = "stable structures";
const dump = `(() => {
  const out = {};
  if (CSS.highlights?.forEach) CSS.highlights.forEach((h, name) => {
    if (name.startsWith('paper-anno')) out[name] = [...h].map(r => r.toString());
  });
  return JSON.stringify(out);
})()`;

async function drag(x1, y1, x2, y2) {
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: x1, y: y1, buttons: 0 });
  await new Promise((r) => setTimeout(r, 100));
  await call("Input.dispatchMouseEvent", { type: "mousePressed", x: x1, y: y1, button: "left", buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 10; i++) {
    await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: x1 + ((x2 - x1) * i) / 10, y: y1 + ((y2 - y1) * i) / 10, button: "left", buttons: 1 });
    await new Promise((r) => setTimeout(r, 40));
  }
  await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: x2, y: y2, button: "left", buttons: 0, clickCount: 1 });
}

const locate = `(() => {
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
})()`;

// 复位：点击空白清弹窗/选区
await call("Input.dispatchMouseEvent", { type: "mousePressed", x: 600, y: 60, button: "left", buttons: 1, clickCount: 1 });
await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: 600, y: 60, button: "left", buttons: 0, clickCount: 1 });
await new Promise((r) => setTimeout(r, 400));

let ok = false;
for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
  const coords = JSON.parse(await evalJs(locate));
  await new Promise((r) => setTimeout(r, 300));
  await drag(coords.x1, coords.y1, coords.x2, coords.y2);
  await new Promise((r) => setTimeout(r, 800));
  const sel = await evalJs(`window.getSelection()?.toString() ?? ''`);
  console.log(`尝试 ${attempt}: 选区=${JSON.stringify((sel || '').slice(0, 40))}`);
  ok = sel === TARGET;
  if (!ok) {
    // 失败：escape 清选区再试
    await evalJs(`window.getSelection()?.removeAllRanges()`);
    await new Promise((r) => setTimeout(r, 300));
  }
}
if (!ok) { console.log("选区三次未命中，放弃"); ws.close(); process.exit(1); }

const before = await evalJs(dump);
console.log("点标亮:", await evalJs(`(() => {
  const popup = document.querySelector('.selection-buttons');
  if (!popup) return 'no-popup';
  const btns = [...popup.querySelectorAll('button')];
  (btns.find(b => b.title === '高亮') || btns[btns.length - 1]).click();
  return 'ok';
})()`));
await new Promise((r) => setTimeout(r, 3000));
const after = JSON.parse((await evalJs(dump)) || "{}");
const base = JSON.parse(before || "{}");
for (const [name, ranges] of Object.entries(after)) {
  const added = ranges.filter((r) => !(base[name] || []).includes(r));
  if (added.length) console.log("新增", name, JSON.stringify(added));
}

console.log("清理:", await evalJs(`(async () => {
  const svc = await import('/src/services/book-note-service.ts');
  const notes = await svc.getBookNotes('a27b187c6bd02d3c');
  const targets = notes.filter(n => n.text === '${TARGET}');
  for (const n of targets) await svc.deleteBookNote(n.id);
  return JSON.stringify({ deleted: targets.length });
})()`));
ws.close();
process.exit(0);
