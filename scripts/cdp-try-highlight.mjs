// CDP：译文 div 划词 → 检查弹窗按钮状态 → 若可用则点标亮 → 查 DB 前的注册表
const page = (await (await fetch("http://127.0.0.1:9222/json/list")).json()).find((t) => t.type === "page");
if (!page) {
  console.log("NO_PAGE");
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const call = (m, p = {}) =>
  new Promise((r) => {
    const i = ++id;
    pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method: m, params: p }));
  });
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result);
    pending.delete(m.id);
  }
  if (m.method === "Runtime.exceptionThrown") {
    console.log("EXC:", (m.params.exceptionDetails.exception?.description || "").slice(0, 200));
  }
};
await new Promise((r) => (ws.onopen = r));
await call("Runtime.enable");

const evalJs = async (expr) => {
  const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) return "EVAL_ERROR: " + (r.exceptionDetails.exception?.description || "").slice(0, 200);
  return r?.result?.value;
};

const sel = await evalJs(`(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const divs = [...document.querySelectorAll('[data-translation]')].filter(d => (d.textContent||'').trim().length > 30);
  const div = divs[20];
  const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node && node.textContent.trim().length < 4) node = walker.nextNode();
  const sel = window.getSelection();
  sel.setBaseAndExtent(node, 0, node, Math.min(6, node.textContent.length));
  div.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
  await sleep(700);
  const popup = document.querySelector('.selection-buttons');
  if (!popup) return 'no-popup';
  return JSON.stringify([...popup.querySelectorAll('button')].map(b => ({t: b.textContent.trim(), title: b.title, dis: b.disabled})));
})()`);
console.log("按钮:", sel);

if (sel && !sel.startsWith("no-") && !sel.startsWith("EVAL")) {
  const btns = JSON.parse(sel);
  const hlIndex = btns.findIndex((b) => b.title === "高亮" && !b.dis);
  if (hlIndex >= 0) {
    await evalJs(`(() => { document.querySelectorAll('.selection-buttons button')[${hlIndex}].click(); return 1; })()`);
    await new Promise((r) => setTimeout(r, 2000));
    console.log("已点击标亮");
  } else {
    console.log("标亮不可用（禁用）");
  }
}
ws.close();
process.exit(0);
