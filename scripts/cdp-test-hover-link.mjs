// CDP：对照模式下 hover 中文句子 → 验证联动高亮覆盖英文对应句（句级映射链路）
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

// 1. 清选区，挑一个译文 div 的中文句，滚动到可视区并取坐标
const setup = await evalJs(`(() => {
  window.getSelection()?.removeAllRanges();
  const divs = [...document.querySelectorAll('[data-translation]')].filter(d => (d.textContent||'').trim().length > 60);
  const div = divs.find(d => /[\\u4e00-\\u9fff]/.test(d.textContent)) || divs[0];
  if (!div) return 'no-div';
  div.scrollIntoView({ block: 'center' });
  const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
  let node; while ((node = walker.nextNode())) { if (node.textContent.trim().length > 10) break; }
  if (!node) return 'no-text';
  const range = document.createRange();
  range.setStart(node, 1); range.setEnd(node, 2);
  const rect = range.getBoundingClientRect();
  if (rect.width === 0) return 'zero-rect';
  const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
  const el = document.elementFromPoint(x, y);
  (el || div).dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  return JSON.stringify({ x, y, zh: div.textContent.slice(0, 30) });
})()`);
console.log("hover 点:", setup);
await new Promise((r) => setTimeout(r, 600));

// 2. 读覆盖层 rect，与译文 div / 英文块的位置对比
console.log("覆盖层:", await evalJs(`(() => {
  const rects = [...document.querySelectorAll('.paper-sentence-hover-rect')].map(el => {
    const b = el.getBoundingClientRect();
    return { y: Math.round(b.top), h: Math.round(b.height), x: Math.round(b.left), w: Math.round(b.width) };
  });
  if (!rects.length) return JSON.stringify({ rects: 0, hint: 'hover 未触发或已禁用' });
  const divs = [...document.querySelectorAll('[data-translation]')];
  // 找每个 rect 落在译文 div 带还是英文块带：用 elementFromPoint 判定所属
  const bands = rects.map(r => {
    const el = document.elementFromPoint(r.x + 2, r.y + 2);
    const inTr = el?.closest?.('[data-translation]') ? 'zh' : 'en/other';
    return inTr;
  });
  return JSON.stringify({ rects: rects.length, bands, sample: rects.slice(0, 4) });
})()`));

// 3. 移出容器清理 hover
await evalJs(`(() => {
  const c = document.querySelector('.paper-sentence-hover-rect')?.closest('div')?.parentElement;
  document.querySelector('[data-region="reader-content"], .prose')?.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
  return 'ok';
})()`);
ws.close();
process.exit(0);
