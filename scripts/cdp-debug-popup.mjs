// 调试：选区+mouseup 后 poll 弹窗，并抓 console 错误
const LIST_URL = "http://127.0.0.1:9222/json/list";
const page = (await (await fetch(LIST_URL)).json()).find((t) => t.type === "page" && t.url.includes("localhost:1420"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const call = (m, p = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const logs = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
  if (msg.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(msg.params.type)) {
    logs.push(msg.params.type + ": " + (msg.params.args || []).map(a => a.value ?? a.description ?? "").join(" ").slice(0, 200));
  }
  if (msg.method === "Runtime.exceptionThrown") {
    logs.push("EXC: " + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text || "").slice(0, 300));
  }
};
await new Promise((r) => (ws.onopen = r));
await call("Runtime.enable");
const evalJs = async (expr) => {
  const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) return "EVAL_ERROR: " + (r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails)).slice(0, 300);
  return r?.result?.value;
};

// 与之前成功的 v2 脚本完全相同的方式：divs[12]（普通译文 div）选 2..8
console.log("选区:", await evalJs(`(() => {
  window.getSelection()?.removeAllRanges();
  const divs = [...document.querySelectorAll('[data-translation]')].filter(d => (d.textContent||'').trim().length > 40 && !d.querySelector('.katex'));
  const div = divs[12] || divs[3];
  if (!div) return 'no-div';
  div.scrollIntoView({ block: 'center' });
  const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node && node.textContent.trim().length < 6) node = walker.nextNode();
  if (!node) return 'no-text';
  const sel = window.getSelection();
  sel.setBaseAndExtent(node, 2, node, Math.min(8, node.textContent.length));
  div.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
  return JSON.stringify({ selected: sel.toString(), selLen: sel.toString().length });
})()`));

for (let i = 0; i < 6; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const st = await evalJs(`JSON.stringify({
    popup: !!document.querySelector('.selection-buttons'),
    popupClass: document.querySelector('.selection-buttons')?.className?.slice(0,60) ?? null,
    selLen: window.getSelection()?.toString()?.length ?? -1,
  })`);
  console.log(`t=${(i+1)*0.5}s`, st);
  if (JSON.parse(st).popup) break;
}
console.log("console 错误:", logs.length ? logs.slice(0, 5) : "无");
ws.close();
process.exit(0);
