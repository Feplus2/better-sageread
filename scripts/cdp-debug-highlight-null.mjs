// 调试：多个译文 div 分别划词，看弹窗标亮按钮的禁用与 title
const LIST_URL = "http://127.0.0.1:9222/json/list";
const page = (await (await fetch(LIST_URL)).json()).find((t) => t.type === "page" && t.url.includes("localhost:1420"));
if (!page) { console.log("NO_PAGE"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const call = (m, p = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
  if (msg.method === "Runtime.exceptionThrown") console.log("EXC:", (msg.params.exceptionDetails.exception?.description || "").slice(0, 300));
};
await new Promise((r) => (ws.onopen = r));
await call("Runtime.enable");

const evalJs = async (expr) => (await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;

for (const idx of [3, 20, 60, 120]) {
  const r = await evalJs(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    document.querySelector('.selection-buttons')?.closest('[class*=fixed]')?.remove?.();
    const divs = [...document.querySelectorAll('[data-translation]')].filter(d => (d.textContent||'').trim().length > 30);
    const div = divs[${idx}];
    if (!div) return 'no-div-${idx}';
    const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && node.textContent.trim().length < 4) node = walker.nextNode();
    const sel = window.getSelection();
    sel.setBaseAndExtent(node, 0, node, Math.min(6, node.textContent.length));
    div.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    await sleep(600);
    const popup = document.querySelector('.selection-buttons');
    if (!popup) return { idx: ${idx}, result: 'no-popup' };
    const btns = [...popup.querySelectorAll('button')].map(b => ({ t: b.textContent.trim(), title: b.title, dis: b.disabled }));
    document.body.click();
    await sleep(200);
    return { idx: ${idx}, divText: div.textContent.slice(0, 25), btns };
  })()`);
  console.log(JSON.stringify(r));
}
ws.close();
process.exit(0);
