// 用户路径终验：TOC 下拉真点击 → 高亮/header 随动 + Agent 位置问答
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res) => {
  ws.onopen = res;
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
  new Promise((res) => {
    const id = ++seq;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
const evalp = async (expression) => {
  const r = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  return r.result?.result?.value;
};

// 开 Review of cathode materials
await evalp(`(async () => {
  const m = await import('/src/store/mcp-store.ts');
  window.__prevMcp = m.useMcpStore.getState().servers.map((sv) => ({ id: sv.id, enabled: sv.enabled }));
  m.useMcpStore.setState({ servers: m.useMcpStore.getState().servers.map((sv) => ({ ...sv, enabled: false })) });
  const ls = await import('/src/store/layout-store.ts');
  ls.useLayoutStore.setState({ tabs: [], activeTabId: null, isHomeActive: true, sleptTabIds: [] });
  const ps = await import('/src/services/paper-service.ts');
  const papers = await ps.listPapers();
  const p = papers.find((x) => x.title.toLowerCase().includes('review of cathode'));
  ls.useLayoutStore.getState().openPaper(p.id, p.title);
  return p.title.slice(0, 40);
})()`);
await evalp(`(async () => { for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 500)); if (document.querySelectorAll('.paper-content h1').length >= 3) return true; } return false; })()`);

const observe = `(() => {
  const root = document.querySelector('div.relative.h-full.min-h-0.overflow-y-auto');
  const spans = Array.from(document.querySelectorAll('span.max-w-100'));
  let header = null;
  for (const s of spans) { let el = s; let hid = false; while (el) { if (el.style && el.style.visibility === 'hidden') { hid = true; break; } el = el.parentElement; } if (!hid) { header = s.textContent.trim().slice(0, 35); break; } }
  return { scrollTop: root ? Math.round(root.scrollTop) : -1, header };
})()`;
console.log("开论文后:", JSON.stringify(await evalp(observe)));

// TOC 打开 + 点击（pointerdown 序列）+ 观察
const tocJump = async (pickRe) => {
  await evalp(`(async () => {
    const icons = Array.from(document.querySelectorAll('svg'));
    const tocIcon = icons.find((s) => s.classList.contains('lucide-table-of-contents'));
    const btn = tocIcon.closest('button');
    btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
    btn.click();
    await new Promise((r) => setTimeout(r, 900));
    return document.querySelectorAll('[role=menu] button').length;
  })()`);
  return evalp(`(async () => {
    const items = Array.from(document.querySelectorAll('[role=menu] button'));
    const re = ${pickRe};
    const target = items.find((b) => re.test(b.textContent.trim()));
    if (!target) return { ok: false };
    const label = target.textContent.trim().slice(0, 45);
    target.click();
    await new Promise((r) => setTimeout(r, 3500));
    return { ok: true, clicked: label };
  })()`);
};

console.log("跳 1:", JSON.stringify(await tocJump("/^1[.\\s]/")));
console.log("跳后:", JSON.stringify(await evalp(observe)));
console.log("跳 5:", JSON.stringify(await tocJump("/^5[.\\s]/")));
console.log("跳后:", JSON.stringify(await evalp(observe)));
console.log("跳 3:", JSON.stringify(await tocJump("/^3[.\\s]/")));
console.log("跳后:", JSON.stringify(await evalp(observe)));

// Agent 位置问答（复述注入段——直读真相）
const ask = async (q) =>
  evalp(`(async () => {
    const panel = document.querySelector('#paper-chat-panel');
    if (!panel) return '(无面板)';
    const ta = panel.querySelector('textarea');
    const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    s.call(ta, ${JSON.stringify(q)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    const btn = panel.querySelector('button[type=submit]:not([disabled])');
    if (btn) btn.click();
    else ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    let last = panel.innerText;
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const cur = panel.innerText;
      if (cur !== last) last = cur;
      else if (!cur.includes('Thinking') && !cur.includes('…')) break;
    }
    await new Promise((r) => setTimeout(r, 2000));
    return panel.innerText.slice(-70).replace(/\\s+/g, ' ').trim();
  })()`);
console.log("\nAgent 复述注入段:", await ask("只逐字复述系统提示里【当前阅读小节】的标题，不看对话历史。"));

// 恢复 MCP
await evalp(`(async () => { const m = await import('/src/store/mcp-store.ts'); m.useMcpStore.setState({ servers: m.useMcpStore.getState().servers.map((sv) => ({ ...sv, enabled: (window.__prevMcp ?? []).find((p) => p.id === sv.id)?.enabled ?? sv.enabled })) }); return 1; })()`);
ws.close();
