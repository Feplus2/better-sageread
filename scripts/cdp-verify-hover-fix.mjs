// CDP 验证（修复后）：hover 中文"这展示了…"句 → 英文侧应只亮 "This demonstrates…" 一句
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

// 1. hover 到中文句"这展示了…"上
const setup = await evalJs(`(() => {
  window.getSelection()?.removeAllRanges();
  const div = [...document.querySelectorAll('[data-translation]')].find(d => (d.textContent||'').includes('这展示了如何基于特定组分需求'));
  if (!div) return 'no-div';
  div.scrollIntoView({ block: 'center' });
  // 找包含该句的文本节点，取句中间一个字的坐标
  const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
  let node; while ((node = walker.nextNode())) { if (node.textContent.includes('这展示了')) break; }
  if (!node) return 'no-text-node';
  const off = node.textContent.indexOf('这展示了') + 3;
  const range = document.createRange();
  range.setStart(node, off); range.setEnd(node, off + 1);
  const rect = range.getBoundingClientRect();
  const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
  const el = document.elementFromPoint(x, y);
  (el || div).dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  return JSON.stringify({ x, y });
})()`);
console.log("hover 点:", setup);
await new Promise((r) => setTimeout(r, 600));

// 2. 读覆盖层，并与英文句 "This demonstrates…" 的实际行带比较
console.log("验证:", await evalJs(`(() => {
  const overlay = [...document.querySelectorAll('.paper-sentence-hover-rect')].map(el => {
    const b = el.getBoundingClientRect();
    return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, w: b.width, h: b.height };
  });
  if (!overlay.length) return JSON.stringify({ fail: 'hover 覆盖层为空' });
  // 英文侧 rect：elementFromPoint 判定不在 [data-translation] 内的
  const enRects = overlay.filter(r => !document.elementFromPoint(r.left + 2, r.top + 2)?.closest?.('[data-translation]'));
  const zhRects = overlay.filter(r => !!document.elementFromPoint(r.left + 2, r.top + 2)?.closest?.('[data-translation]'));
  // 找英文块中 "This demonstrates how" 句的 Range 行带（.prose 有很多个，取含译文 div 的那个）
  const container = [...document.querySelectorAll('.prose')].find(el => el.querySelector('[data-translation]')) || document.body;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let n1, n2, node;
  while ((node = walker.nextNode())) {
    if (!n1 && node.textContent.includes('This demonstrates how')) n1 = node;
    if (n1 && !n2 && node.textContent.includes('compositional demands')) n2 = node;
    if (n1 && n2) break;
  }
  if (!n1 || !n2) return JSON.stringify({ fail: '未定位英文句节点', enRects: enRects.length, zhRects: zhRects.length });
  const range = document.createRange();
  range.setStart(n1, n1.textContent.indexOf('This demonstrates how'));
  range.setEnd(n2, n2.textContent.indexOf('compositional demands') + 'compositional demands.'.length);
  const bRect = range.getBoundingClientRect();
  // 英文覆盖 rect 应整体落在该句行带内（±2px 容差）
  const TOL = 2;
  const enInside = enRects.every(r => r.top >= bRect.top - TOL && r.bottom <= bRect.bottom + TOL);
  // 且不应覆盖到相邻句（"For more than" 或 "It is worth noting" 的行带）
  const overlapArea = (a, b) => Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)) * a.w;
  const coverRatio = enRects.reduce((s, r) => s + overlapArea(r, bRect), 0) / (bRect.width * bRect.height);
  return JSON.stringify({
    enRects: enRects.map(r => ({ y: Math.round(r.top), h: Math.round(r.h), w: Math.round(r.w) })),
    zhRectCount: zhRects.length,
    sentenceB: { y: Math.round(bRect.top), h: Math.round(bRect.height) },
    enInsideSentenceB: enInside,
    coverRatioOfB: Number(coverRatio.toFixed(2)),
  });
})()`));
ws.close();
process.exit(0);
