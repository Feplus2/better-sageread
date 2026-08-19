// 任务2验证：MCP 环境变量秘钥选择器（弹列表/点选填入/新建占位符/Tooltip 主题化）
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
const call = (method, params) => {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  pending.set(++mid, { promise, resolve });
  ws.send(JSON.stringify({ id: mid, method, params }));
  return promise;
};
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id).resolve(msg.result); pending.delete(msg.id); }
};
await new Promise((r) => (ws.onopen = r));
const evalJS = async (expr) => {
  const r = await call("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await call("Page.reload", { ignoreCache: true });
await sleep(4500);
await evalJS(`import("/src/store/layout-store.ts").then((m) => { window.__layout = m; }); "loading"`);
for (let i = 0; i < 20; i++) {
  await sleep(500);
  if (await evalJS(`!!window.__layout`).catch(() => false)) break;
}
// 回主页并进 AI 中心（/skills）
await evalJS(`window.__layout.useLayoutStore.getState().navigateToHome(); true`);
await sleep(800);
console.log("进 /skills:", await evalJS(`(() => {
  const link = document.querySelector('a[href="/skills"]');
  if (!link) return 'no link';
  link.click();
  return 'clicked';
})()`));
await sleep(1500);

// 点到 MCP 标签页（若默认不是）
console.log("MCP tab:", await evalJS(`(() => {
  const tab = Array.from(document.querySelectorAll('button, [role="tab"]')).find((b) => (b.textContent ?? '').trim() === 'MCP');
  if (!tab) return 'not-found(可能已是)';
  tab.click();
  return 'clicked';
})()`));
await sleep(1000);

// 打开 zotero-brain 的编辑对话框（Pencil 图标按钮）
console.log("编辑 zotero-brain:", await evalJS(`(() => {
  const rows = Array.from(document.querySelectorAll('*')).filter((el) => el.children.length === 0 && (el.textContent ?? '').trim() === 'zotero-brain');
  if (rows.length === 0) return 'server row not found';
  const row = rows[0].closest('div[class*="border"]') ?? rows[0].parentElement.parentElement;
  const btn = row.querySelector('button:has(svg.lucide-pencil');
  if (!btn) return 'no edit button';
  btn.click();
  return 'clicked';
})()`));
await sleep(1000);
console.log("对话框:", await evalJS(`(() => {
  const dlg = document.querySelector('[data-slot="dialog-content"], [role="dialog"]');
  return dlg ? (dlg.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 80) : null;
})()`));

// 找环境变量区的秘钥按钮（KeyRound 图标），hover 验证 Tooltip 组件（非原生 title）
const keyBtnProbe = await evalJS(`(() => {
  const dlg = document.querySelector('[role="dialog"]');
  if (!dlg) return null;
  const btns = Array.from(dlg.querySelectorAll('button')).filter((b) => b.querySelector('svg.lucide-key-round'));
  if (btns.length === 0) return { found: false };
  const btn = btns[0];
  const hasNativeTitle = btn.hasAttribute('title');
  // hover 触发项目 Tooltip
  btn.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
  btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  return { found: true, hasNativeTitle };
})()`);
console.log("秘钥按钮:", JSON.stringify(keyBtnProbe));
await sleep(800);
console.log("主题化 Tooltip 内容:", await evalJS(`(() => {
  const tip = document.querySelector('[data-slot="tooltip-content"], [role="tooltip"]');
  return tip ? (tip.textContent ?? '').trim() : null;
})()`));

// 点击秘钥按钮 → 弹出列表
await evalJS(`(() => {
  const dlg = document.querySelector('[role="dialog"]');
  const btn = Array.from(dlg.querySelectorAll('button')).find((b) => b.querySelector('svg.lucide-key-round'));
  btn.click();
  true;
})()`);
await sleep(1200);
const popState = await evalJS(`(() => {
  const wrap = document.querySelector('[data-radix-popper-content-wrapper]');
  if (!wrap) return null;
  const items = Array.from(wrap.querySelectorAll('button')).map((b) => (b.textContent ?? '').trim()).filter(Boolean);
  return { text: (wrap.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 200), items };
})()`);
console.log("秘钥列表弹层:", JSON.stringify(popState));

// 点选第一个秘钥 → 填入验证
if (popState && popState.items.length > 0) {
  const firstName = popState.items[0];
  await evalJS(`(() => {
    const wrap = document.querySelector('[data-radix-popper-content-wrapper]');
    const btn = Array.from(wrap.querySelectorAll('button')).find((b) => (b.textContent ?? '').trim() === ${JSON.stringify(popState.items[0])});
    btn.click();
    true;
  })()`);
  await sleep(600);
  console.log("点选填入:", firstName, "→", await evalJS(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    const inputs = Array.from(dlg.querySelectorAll('input'));
    return JSON.stringify(inputs.map((i) => i.value).filter((v) => v.includes('{{secret:')));
  })()`));
}

// 新建占位符：输入 TEST_TOKEN_X 插入
await evalJS(`(() => {
  const dlg = document.querySelector('[role="dialog"]');
  const btn = Array.from(dlg.querySelectorAll('button')).find((b) => b.querySelector('svg.lucide-key-round'));
  btn.click();
  true;
})()`);
await sleep(800);
await evalJS(`(() => {
  const wrap = document.querySelector('[data-radix-popper-content-wrapper]');
  const input = wrap.querySelector('input');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, 'TEST_TOKEN_X');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  const insertBtn = Array.from(wrap.querySelectorAll('button')).find((b) => (b.textContent ?? '').trim() === '插入');
  insertBtn.click();
  true;
})()`);
await sleep(600);
console.log("新建占位符填入:", await evalJS(`(() => {
  const dlg = document.querySelector('[role="dialog"]');
  return JSON.stringify(Array.from(dlg.querySelectorAll('input')).map((i) => i.value).filter((v) => v.includes('TEST_TOKEN_X')));
})()`));

// 关闭对话框不保存（Escape），不污染用户配置
await evalJS(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
await sleep(400);
await evalJS(`(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((x) => (x.textContent ?? '').trim() === '取消'); b?.click(); true; })()`);
console.log("done");
ws.close();
