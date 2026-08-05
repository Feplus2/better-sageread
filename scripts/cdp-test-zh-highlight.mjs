// CDP 实测：译文 div 内划词 → 弹窗 → 点标亮 → 验证
const LIST_URL = "http://127.0.0.1:9222/json/list";
const res0 = await fetch(LIST_URL);
const page = (await res0.json()).find((t) => t.type === "page" && t.url.includes("localhost:1420"));
if (!page) {
  console.log("NO_PAGE");
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const call = (method, params = {}) =>
  new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result);
    pending.delete(msg.id);
  }
  if (msg.method === "Runtime.exceptionThrown") {
    const d = msg.params.exceptionDetails;
    console.log("EXCEPTION:", (d.exception?.description || d.text || "").slice(0, 500));
  }
  if (msg.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(msg.params.type)) {
    const text = msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
    console.log(`console.${msg.params.type}:`, text.slice(0, 300));
  }
};
await new Promise((r) => (ws.onopen = r));
await call("Runtime.enable");

const evalJs = async (expr) => {
  const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) return `EVAL_ERROR: ${r.exceptionDetails.exception?.description?.slice(0, 300)}`;
  return r?.result?.value;
};

// 1. 在第 10 个译文 div 里选中一段文字（纯中文片段）
console.log("步骤1 选区:", await evalJs(`(() => {
  const divs = [...document.querySelectorAll('[data-translation]')].filter(d => (d.textContent||'').trim().length > 30);
  const div = divs[10] || divs[0];
  if (!div) return 'no-div';
  const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
  const node = walker.nextNode();
  if (!node) return 'no-text-node';
  const sel = window.getSelection();
  sel.setBaseAndExtent(node, 0, node, Math.min(8, node.textContent.length));
  div.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 100, clientY: 100 }));
  return JSON.stringify({ selected: sel.toString(), divText: div.textContent.slice(0, 40) });
})()`));

await new Promise((r) => setTimeout(r, 1200));

// 2. 弹窗状态
console.log("步骤2 弹窗:", await evalJs(`(() => {
  const popup = document.querySelector('.selection-buttons');
  if (!popup) return 'no-popup';
  const buttons = [...popup.querySelectorAll('button')].map(b => ({
    text: b.textContent.trim(), disabled: b.disabled, title: b.title || b.getAttribute('aria-label') || ''
  }));
  return JSON.stringify(buttons);
})()`));

// 3. 点标亮（高亮按钮，title=高亮 或含 PiHighlighterFill）
console.log("步骤3 点标亮:", await evalJs(`(() => {
  const popup = document.querySelector('.selection-buttons');
  if (!popup) return 'no-popup';
  const btn = [...popup.querySelectorAll('button')].find(b => (b.title === '高亮') || b.querySelector('svg'));
  const target = [...popup.querySelectorAll('button')].find(b => b.title === '高亮') ||
                 [...popup.querySelectorAll('button')].pop();
  if (!target) return 'no-button';
  const info = { text: target.textContent.trim(), disabled: target.disabled, title: target.title };
  target.click();
  return JSON.stringify(info);
})()`));

await new Promise((r) => setTimeout(r, 2500));

// 4. 验证：侧栏标注数 & 弹窗残留 & 选区
console.log("步骤4 状态:", await evalJs(`(() => {
  return JSON.stringify({
    popupStillThere: !!document.querySelector('.selection-buttons'),
    sidebarText: (document.querySelector('[data-region="notepad-panel"]')?.innerText || '').slice(0, 200),
  });
})()`));

ws.close();
process.exit(0);
