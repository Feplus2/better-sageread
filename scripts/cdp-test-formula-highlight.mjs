// CDP：含公式译文 div 的中文划词 → 标亮 → 验证英文侧词级精确（公式归一路径）
const LIST_URL = "http://127.0.0.1:9222/json/list";
async function getPage(timeoutMs = 60000) {
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
  if (msg.method === "Runtime.exceptionThrown") errors.push((msg.params.exceptionDetails.exception?.description || "").slice(0, 300));
};
await new Promise((r) => (ws.onopen = r));
await call("Runtime.enable");

const evalJs = async (expr) => {
  const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) return "EVAL_ERROR: " + (r.exceptionDetails.exception?.description || "").slice(0, 300);
  return r?.result?.value;
};

// 0. 现有高亮基线
const dump = `(() => {
  const out = {};
  if (CSS.highlights && CSS.highlights.forEach) CSS.highlights.forEach((h, name) => {
    if (name.startsWith('paper-anno')) out[name] = [...h].map(r => r.toString());
  });
  return JSON.stringify(out);
})()`;
const before = await evalJs(dump);

// 1. 找含 .katex 的译文 div，在公式后面的中文文本节点里选一小段
console.log("选区:", await evalJs(`(() => {
  const divs = [...document.querySelectorAll('[data-translation]')].filter(d => d.querySelector('.katex') && (d.textContent||'').trim().length > 40);
  if (!divs.length) return 'no-katex-div';
  // 取第一个含公式 div，找公式之后的中文文本节点（纯中文片段更贴近真实划词）
  const div = divs[0];
  const katexEl = div.querySelector('.katex');
  const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
  let node = null, n;
  while ((n = walker.nextNode())) {
    if (katexEl.contains(n)) continue;
    if (/[\\u4e00-\\u9fff]/.test(n.textContent) && n.textContent.trim().length >= 6) { node = n; break; }
  }
  if (!node) return 'no-zh-text';
  const start = node.textContent.search(/[\\u4e00-\\u9fff]/);
  const sel = window.getSelection();
  sel.setBaseAndExtent(node, start, node, Math.min(start + 5, node.textContent.length));
  div.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
  return JSON.stringify({ selected: sel.toString(), divHead: div.textContent.slice(0, 50) });
})()`));
await new Promise((r) => setTimeout(r, 1200));

// 2. 点标亮
console.log("点标亮:", await evalJs(`(() => {
  const popup = document.querySelector('.selection-buttons');
  if (!popup) return 'no-popup';
  const btns = [...popup.querySelectorAll('button')];
  const btn = btns.find(b => b.title === '高亮') || btns[btns.length - 1];
  if (!btn) return 'no-highlight-button';
  const disabled = btn.disabled;
  btn.click();
  return JSON.stringify({ disabled });
})()`));
await new Promise((r) => setTimeout(r, 2500));

// 3. 与基线对比，输出新增高亮区间
const after = JSON.parse((await evalJs(dump)) || "{}");
const base = JSON.parse(before || "{}");
console.log("新增/变化的高亮:");
for (const [name, ranges] of Object.entries(after)) {
  const old = base[name] || [];
  const added = ranges.filter((r) => !old.includes(r));
  if (added.length) console.log(" ", name, JSON.stringify(added.map((t) => t.slice(0, 80))));
}
console.log("异常:", errors.length ? errors.join(" | ") : "无");
ws.close();
process.exit(0);
