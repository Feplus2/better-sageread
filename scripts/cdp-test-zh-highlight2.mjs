// CDP 端到端：中文划词 → 标亮 → 验证英文高亮词级精确 + 中文显示回到原选区
const LIST_URL = "http://127.0.0.1:9222/json/list";
async function getPage(timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const page = (await (await fetch(LIST_URL)).json()).find((t) => t.type === "page" && t.url.includes("localhost:1420"));
      if (page) return page;
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}
const page = await getPage();
if (!page) { console.log("NO_PAGE"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const call = (m, p = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const errors = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
  if (msg.method === "Runtime.exceptionThrown") errors.push((msg.params.exceptionDetails.exception?.description || "").slice(0, 200));
};
await new Promise((r) => (ws.onopen = r));
await call("Runtime.enable");
await call("Page.enable");
await call("Page.reload", { ignoreCache: true });
await new Promise((r) => setTimeout(r, 18000));

const evalJs = async (expr) => {
  const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) return "EVAL_ERROR: " + (r.exceptionDetails.exception?.description || "").slice(0, 300);
  return r?.result?.value;
};

// 1. 在一个译文 div 里选一小段中文
console.log("选区:", await evalJs(`(() => {
  const divs = [...document.querySelectorAll('[data-translation]')].filter(d => (d.textContent||'').trim().length > 40 && !d.textContent.includes('\\\\') && !d.querySelector('.katex'));
  const div = divs[12] || divs[3];
  if (!div) return 'no-div';
  const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node && node.textContent.trim().length < 6) node = walker.nextNode();
  if (!node) return 'no-text';
  const sel = window.getSelection();
  sel.setBaseAndExtent(node, 2, node, Math.min(8, node.textContent.length));
  div.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
  return JSON.stringify({ selected: sel.toString(), divHead: div.textContent.slice(0, 30) });
})()`));
await new Promise((r) => setTimeout(r, 1200));

// 2. 点标亮
console.log("点标亮:", await evalJs(`(() => {
  const popup = document.querySelector('.selection-buttons');
  if (!popup) return 'no-popup';
  const btns = [...popup.querySelectorAll('button')];
  const btn = btns.find(b => b.title === '高亮') || btns[btns.length - 1];
  if (!btn) return 'no-highlight-button: ' + popup.innerHTML.slice(0, 200);
  const disabled = btn.disabled;
  btn.click();
  return JSON.stringify({ disabled });
})()`));
await new Promise((r) => setTimeout(r, 2500));

// 3. 检查高亮注册表：英文侧范围文本 vs 中文映射侧范围文本
console.log("高亮:", await evalJs(`(() => {
  const out = {};
  if (CSS.highlights && CSS.highlights.forEach) {
    CSS.highlights.forEach((h, name) => {
      if (!name.startsWith('paper-anno')) return;
      out[name] = [...h].map(r => ({ len: r.toString().length, text: r.toString().slice(0, 50) }));
    });
  }
  return JSON.stringify(out);
})()`));
console.log("异常:", errors.length ? errors.join(" | ") : "无");
ws.close();
process.exit(0);
