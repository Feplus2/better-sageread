// P0 冒烟 v2：右键菜单回归 + 已翻译徽标（dev 实例 CDP 9223）
// 验证：①已翻译论文卡片有 Languages 徽标；②右键已翻译篇：单一翻译入口标「重新翻译」且无独立「翻译」项，
//      「重新解析」可用；③右键未翻译篇：只有「翻译」，无「重新翻译」，「重新解析」可用。
const list0 = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page0 = list0.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
if (!page0) {
  console.error("实例未就绪");
  process.exit(1);
}
const ws = new WebSocket(page0.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
const call = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP 超时: ${method}`));
    }, 30000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evalp = async (expression) => {
  const r = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500));
  return r.result?.result?.value;
};

// 进文献库（侧边导航项，精确匹配「文献库」，避免误点 AI 中心里的同名卡片）
// 并复位到「全部论文」（实例可能记着上次的文件夹筛选，7/95 这种子集视图里找不到目标卡片）
await evalp(`(async () => {
  const ls = await import('/src/store/layout-store.ts');
  ls.useLayoutStore.setState({ tabs: [], activeTabId: null, isHomeActive: true, sleptTabIds: [] });
  await new Promise((r) => setTimeout(r, 800));
  const navs = Array.from(document.querySelectorAll('nav a, nav button, aside a, aside button'));
  const papersNav = navs.find((t) => t.textContent.trim() === '文献库');
  if (!papersNav) throw new Error('文献库导航未找到');
  papersNav.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 1500));
  const allNode = Array.from(document.querySelectorAll('*')).find(
    (el) => el.children.length < 4 && /^全部论文\\d*$/.test(el.textContent.replace(/\\s+/g, '')),
  );
  if (allNode) allNode.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 2500));
  return true;
})()`);

const findRow = `(titleSnippets) => {
  const rows = Array.from(document.querySelectorAll('[class*="cursor-pointer"]'));
  return rows.find((r) => titleSnippets.some((s) => r.textContent.includes(s)) && r.querySelector('svg'));
}`;

// ① 徽标三色：Discovery（老译本无锚→黄）与 friction（新译本会合→绿）
const badge = await evalp(`(() => {
  const find = (${findRow});
  const probe = (snippets) => {
    const row = find(snippets);
    if (!row) return { row: false };
    const icon = row.querySelector('svg.lucide-languages');
    return { row: true, badge: !!icon, amber: !!icon && icon.classList.contains('text-amber-500'), green: !!icon && icon.classList.contains('text-green-600') };
  };
  return {
    discovery: probe(['Discovery of complex oxides', '复杂氧化物的自动化实验']),
    friction: probe(['Gravitational waves from cosmic strings with friction', '含摩擦宇宙弦']),
  };
})()`);
console.log("①徽标三色:", JSON.stringify(badge));

// ② 右键已翻译篇
const menuTranslated = await evalp(`(async () => {
  const row = (${findRow})(['Discovery of complex oxides', '复杂氧化物的自动化实验']);
  if (!row) return { error: 'row not found' };
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 }));
  await new Promise((r) => setTimeout(r, 700));
  const items = Array.from(document.querySelectorAll('[role="menuitem"]')).map((el) => ({
    text: el.textContent.trim(),
    disabled: el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('data-disabled'),
  }));
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await new Promise((r) => setTimeout(r, 300));
  return { items };
})()`);
console.log("②右键已翻译篇:", JSON.stringify(menuTranslated));

// ③ 右键一篇无徽标的（未翻译）篇目：以①的已翻译卡片为锚，限定在其列表容器内挑兄弟卡片
const menuOther = await evalp(`(async () => {
  const anchor = (${findRow})(['Discovery of complex oxides', '复杂氧化物的自动化实验']);
  if (!anchor) return { error: 'anchor row not found' };
  // 向上找包含多张卡片的容器
  let container = anchor.parentElement;
  while (container && container.querySelectorAll('[class*="cursor-pointer"]').length < 3) {
    container = container.parentElement;
  }
  if (!container) return { error: 'container not found' };
  const rows = Array.from(container.querySelectorAll('[class*="cursor-pointer"]')).filter(
    (r) => r.querySelector('svg') && r.textContent.trim().length > 20,
  );
  const row = rows.find((r) => !r.querySelector('svg.lucide-languages'));
  if (!row) return { error: 'no untranslated row' };
  const titleHead = row.textContent.trim().slice(0, 40);
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 }));
  await new Promise((r) => setTimeout(r, 700));
  const items = Array.from(document.querySelectorAll('[role="menuitem"]')).map((el) => ({
    text: el.textContent.trim(),
    disabled: el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('data-disabled'),
  }));
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return { titleHead, items };
})()`);
console.log("③右键未翻译篇:", JSON.stringify(menuOther));

ws.close();
process.exit(0);
