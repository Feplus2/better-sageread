// 人类式全流程仿真：跳转 → 在论文聊天面板真实提问"我在哪" → 读模型回答 → 再跳 → 再问
// 复刻用户路径：面板输入框打字 → 提交 → 模型应答（走真实 chatContext 组装链）
// 用法：node scripts/cdp-test-ask-position.mjs（dev 实例 CDP 9223）
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
const exceptions = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
  if (msg.method === "Runtime.exceptionThrown") {
    exceptions.push((msg.params.exceptionDetails?.exception?.description || "?").slice(0, 120));
  }
};
const call = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP 超时: ${method}`));
    }, 240000);
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

// ── 1) 环境：禁 MCP（stdio 确认卡无头挂起陷阱）+ 开论文 ──
await evalp(`(async () => {
  const m = await import('/src/store/mcp-store.ts');
  window.__prevMcp = m.useMcpStore.getState().servers.map((sv) => ({ id: sv.id, enabled: sv.enabled }));
  m.useMcpStore.setState({ servers: m.useMcpStore.getState().servers.map((sv) => ({ ...sv, enabled: false })) });
  const c = await import('/src/store/agent-confirm-store.ts');
  const cs = c.useAgentConfirmStore.getState();
  (cs.queue ?? []).forEach(() => cs.resolvePending(false));
  const ls = await import('/src/store/layout-store.ts');
  ls.useLayoutStore.setState({ tabs: [], activeTabId: null, isHomeActive: true, sleptTabIds: [] });
  const ps = await import('/src/services/paper-service.ts');
  const papers = await ps.listPapers();
  const p = papers.find((x) => x.title.includes('Routes'));
  ls.useLayoutStore.getState().openPaper(p.id, p.title);
  return true;
})()`);
await evalp(`(async () => { for (let i = 0; i < 60; i++) { await new Promise(r=>setTimeout(r,500)); if (document.querySelectorAll('.paper-content h2').length >= 3) return true; } return false; })()`);
console.log("论文已打开，正文就绪");

// ── 工具：跳到指定比例的最近标题 ──
const jumpTo = (frac) =>
  evalp(`(async () => {
    const root = document.querySelector('div.relative.h-full.min-h-0.overflow-y-auto');
    const hs = Array.from(root.querySelectorAll('.paper-content h1, .paper-content h2')).filter((h) => !h.closest('[data-footnotes]'));
    // 找位置最接近 frac 的标题（模拟用户点 TOC 第 N 项）
    const total = root.scrollHeight;
    let best = hs[0]; let bestDiff = Infinity;
    for (const h of hs) {
      const hTop = h.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
      const diff = Math.abs(hTop - total * ${frac});
      if (diff < bestDiff) { bestDiff = diff; best = h; }
    }
    const targetTop = best.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop - 16;
    root.scrollTo({ top: targetTop, behavior: 'smooth' });
    await new Promise((r) => setTimeout(r, 2600));
    return { heading: best.textContent.slice(0, 40), scrollTop: Math.round(root.scrollTop) };
  })()`);

// ── 工具：在论文聊天面板真实提问并取回答 ──
const askPanel = async (question) =>
  evalp(`(async () => {
    // 面板可能在折叠态：找不到就点 header 的聊天开关
    let panel = document.querySelector('#paper-chat-panel');
    if (!panel) {
      const btns = Array.from(document.querySelectorAll('button'));
      const chatBtn = btns.find((b) => {
        const svg = b.querySelector('svg');
        return svg && (b.getAttribute('aria-label')?.includes('聊') || b.title?.includes('聊') || b.innerHTML.includes('message'));
      });
      if (chatBtn) { chatBtn.click(); await new Promise((r) => setTimeout(r, 800)); }
      panel = document.querySelector('#paper-chat-panel');
    }
    if (!panel) return { ok: false, why: 'panel-not-found' };
    const ta = panel.querySelector('textarea');
    if (!ta) return { ok: false, why: 'no-textarea' };
    const before = panel.innerText.length;
    // 打字（React 受控）
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(question)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    // 提交：submit 按钮优先，回车兜底
    const form = ta.closest('form');
    const btn = form?.querySelector('button[type=submit]:not([disabled])') ?? panel.querySelector('button[type=submit]:not([disabled])');
    if (btn) btn.click();
    else ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    await new Promise((r) => setTimeout(r, 900));
    if (ta.value.trim() !== '') {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    }
    // 等回答：panel 文本长度稳定 3s
    let last = panel.innerText; let stable = 0;
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const cur = panel.innerText;
      if (cur === last) { stable++; if (stable >= 3) break; } else stable = 0;
      last = cur;
    }
    // 取新增部分（回答在末尾）
    const added = last.slice(Math.min(before, last.length - 5));
    const tail = last.slice(-320).replace(/\\s+/g, ' ').trim();
    return { ok: true, tail };
  })()`);

// ── 2) 第一跳 30% → 问 ──
const j1 = await jumpTo(0.3);
console.log("\n第一跳:", JSON.stringify(j1));
const a1 = await askPanel("我现在正在读这篇论文的哪个小节？只回答小节标题，不要其他内容。");
console.log("第一次回答尾部:", a1.tail ?? JSON.stringify(a1));

// ── 3) 第二跳 65% → 再问 ──
const j2 = await jumpTo(0.65);
console.log("\n第二跳:", JSON.stringify(j2));
const a2 = await askPanel("我现在在哪个小节？只回答小节标题。");
console.log("第二次回答尾部:", a2.tail ?? JSON.stringify(a2));

// ── 4) 第三跳 10% → 再问 ──
const j3 = await jumpTo(0.1);
console.log("\n第三跳:", JSON.stringify(j3));
const a3 = await askPanel("我现在在哪个小节？只回答小节标题。");
console.log("第三次回答尾部:", a3.tail ?? JSON.stringify(a3));

// 恢复 MCP
await evalp(`(async () => { const m = await import('/src/store/mcp-store.ts'); m.useMcpStore.setState({ servers: m.useMcpStore.getState().servers.map((sv) => ({ ...sv, enabled: (window.__prevMcp ?? []).find((p) => p.id === sv.id)?.enabled ?? sv.enabled })) }); return true; })()`);
ws.close();

console.log("\n异常:", exceptions.length ? exceptions.slice(0, 3) : "无");
console.log("\n=== 判定（人工比对：回答应分别接近三个跳转标题）===");
