// CDP 验收（词级修复后，真实拖拽）：块39 "stable structures" ↔ "稳定结构" 双向划词精度
// EN 划词 → ZH 镜像应为"稳定结构"；ZH 划词 → EN 锚点应为"stable structures"；结束自动清理测试标注
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
const dump = `(() => {
  const out = {};
  if (CSS.highlights?.forEach) CSS.highlights.forEach((h, name) => {
    if (name.startsWith('paper-anno')) out[name] = [...h].map(r => r.toString());
  });
  return JSON.stringify(out);
})()`;
const diffDump = async (before) => {
  const after = JSON.parse((await evalJs(dump)) || "{}");
  const base = JSON.parse(before || "{}");
  const diff = {};
  for (const [name, ranges] of Object.entries(after)) {
    const added = ranges.filter((r) => !(base[name] || []).includes(r));
    if (added.length) diff[name] = added;
  }
  return diff;
};

async function dragSelect(x1, y1, x2, y2) {
  await call("Input.dispatchMouseEvent", { type: "mousePressed", x: x1, y: y1, button: "left", buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 8; i++) {
    await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: x1 + ((x2 - x1) * i) / 8, y: y1 + ((y2 - y1) * i) / 8, button: "left", buttons: 1 });
    await new Promise((r) => setTimeout(r, 30));
  }
  await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: x2, y: y2, button: "left", buttons: 0, clickCount: 1 });
}

// 定位表达式：EN 词（不在译文 div 内）或 ZH 词（译文 div 内）
const locate = (text, inTranslation) => `(() => {
  const container = [...document.querySelectorAll('.prose')].find(el => el.querySelector('[data-translation]'));
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let node; while ((node = walker.nextNode())) {
    const inTr = !!node.parentElement.closest('[data-translation]');
    if (inTr === ${inTranslation} && node.textContent.includes(${JSON.stringify(text)})) break;
  }
  if (!node) return 'no-node';
  node.parentElement.scrollIntoView({ block: 'center' });
  const i = node.textContent.indexOf(${JSON.stringify(text)});
  const r1 = document.createRange(); r1.setStart(node, i); r1.setEnd(node, i + 1);
  const r2 = document.createRange(); r2.setStart(node, i + ${text.length} - 1); r2.setEnd(node, i + ${text.length});
  const a = r1.getBoundingClientRect(), b = r2.getBoundingClientRect();
  return JSON.stringify({ x1: a.left, y1: a.top + a.height / 2, x2: b.right, y2: b.top + b.height / 2 });
})()`;

async function selectAndHighlight(text, inTranslation) {
  const coords = JSON.parse(await evalJs(locate(text, inTranslation)));
  await dragSelect(coords.x1, coords.y1, coords.x2, coords.y2);
  await new Promise((r) => setTimeout(r, 1500));
  const sel = await evalJs(`window.getSelection()?.toString() ?? ''`);
  const clicked = await evalJs(`(() => {
    const popup = document.querySelector('.selection-buttons');
    if (!popup) return 'no-popup';
    const btns = [...popup.querySelectorAll('button')];
    const btn = btns.find(b => b.title === '高亮') || btns[btns.length - 1];
    btn.click();
    return 'ok';
  })()`);
  await new Promise((r) => setTimeout(r, 2500));
  return { sel, clicked };
}

// ── 方向 1：EN 划 "stable structures" → ZH 镜像 ──
// 先真实点击空白处复位：关掉可能残留的弹窗/选区（避免拖拽起点落在旧弹窗上）
await call("Input.dispatchMouseEvent", { type: "mousePressed", x: 600, y: 300, button: "left", buttons: 1, clickCount: 1 });
await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: 600, y: 300, button: "left", buttons: 0, clickCount: 1 });
await new Promise((r) => setTimeout(r, 500));
let before = await evalJs(dump);
const r1 = await selectAndHighlight("stable structures", false);
console.log("EN 选区:", JSON.stringify(r1));
const d1 = await diffDump(before);
console.log("EN→ZH 新增高亮:", JSON.stringify(d1));

// ── 方向 2：ZH 划 "稳定结构" → EN 锚点 ──
before = await evalJs(dump);
const r2 = await selectAndHighlight("稳定结构", true);
console.log("ZH 选区:", JSON.stringify(r2));
const d2 = await diffDump(before);
console.log("ZH→EN 新增高亮:", JSON.stringify(d2));

// ── 清理测试标注 ──
console.log("清理:", await evalJs(`(async () => {
  const svc = await import('/src/services/book-note-service.ts');
  const notes = await svc.getBookNotes('a27b187c6bd02d3c');
  const targets = notes.filter(n => n.text === 'stable structures');
  for (const n of targets) await svc.deleteBookNote(n.id);
  return JSON.stringify({ deleted: targets.length });
})()`));
ws.close();
process.exit(0);
