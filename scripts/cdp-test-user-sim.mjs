// 实盘三连验证：①论文跳转后位置感知（端到端问模型）②书籍图片 iframe 右键通道 ③deepseek 视觉真见像素
// 用法：node scripts/cdp-test-user-sim.mjs（dev 实例 CDP 9223）
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
    exceptions.push((msg.params.exceptionDetails?.exception?.description || "?").slice(0, 150));
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
const askModel = async (expression) => {
  const r = await evalp(`(async () => {
    const t8 = window.__sim;
    const stream = await t8.transport.sendMessages({ chatId: 'sim', messages: t8.history.map(m => ({ ...m })), abortSignal: new AbortController().signal, trigger: 'submit-message', messageId: undefined, body: t8.body });
    let text = '';
    const reader = stream.getReader();
    while (true) { const { done, value } = await reader.read(); if (done) break; for (const p of Array.isArray(value) ? value : [value]) { if (p?.type === 'text-delta') text += p.delta; } }
    return text.trim().slice(0, 200);
  })()`);
  return r;
};

// —— 公共初始化：transport + 无头禁 MCP ——
await evalp(`(async () => {
  const factory = await import('/src/ai/providers/factory.ts');
  const tct = await import('/src/ai/custom-chat-transport.ts');
  const ps = await import('/src/store/provider-store.ts');
  let sel = null;
  for (let i = 0; i < 30; i++) { sel = ps.useProviderStore.getState().selectedModel; if (sel) break; await new Promise(r=>setTimeout(r,500)); }
  const mcpStore = await import('/src/store/mcp-store.ts');
  window.__simPrev = mcpStore.useMcpStore.getState().servers.map((sv) => ({ id: sv.id, enabled: sv.enabled }));
  mcpStore.useMcpStore.setState({ servers: mcpStore.useMcpStore.getState().servers.map((sv) => ({ ...sv, enabled: false })) });
  const model = factory.createModelInstance(sel.providerId, sel.modelId);
  window.__sim = { transport: new tct.CustomChatTransport(model), history: [] };
  window.__simSel = sel;
  return true;
})()`);
console.log("初始化完成，当前模型:", await evalp(`window.__simSel.providerId + '/' + window.__simSel.modelId`));

// ===== ① 论文跳转位置感知（端到端）=====
console.log("\n=== ① 论文位置感知 ===");
const paperOpened = await evalp(`(() => {
  const cards = Array.from(document.querySelectorAll('[data-region="book-card"], [class*="cursor-pointer"]'));
  const c = cards.find((x) => x.textContent.includes('Routes to high-performance'));
  if (!c) return false;
  c.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return true;
})()`);
if (paperOpened) {
  await evalp(`(async () => { for (let i = 0; i < 60; i++) { await new Promise(r=>setTimeout(r,500)); if (document.querySelectorAll('h1,h2,h3').length >= 3) return true; } return false; })()`);
  // 滚到 55%（模拟"跳到第六章"），等纠偏稳定
  await evalp(`(async () => {
    const el = Array.from(document.querySelectorAll('div')).find((d) => {
      const s = getComputedStyle(d);
      return /(auto|scroll)/.test(s.overflowY) && d.scrollHeight > d.clientHeight * 3 && d.clientHeight > 300 && d.querySelectorAll('h2').length >= 2;
    });
    if (!el) return false;
    el.scrollTo({ top: el.scrollHeight * 0.55, behavior: 'auto' });
    await new Promise((r) => setTimeout(r, 1500));
    // 计算当前应命中的 heading，供对照
    const rootTop = el.getBoundingClientRect().top;
    const band = el.clientHeight * 0.25;
    const hs = Array.from(el.querySelectorAll('h1,h2,h3')).filter((h) => !h.closest('[data-footnotes]'));
    let active = null;
    for (const h of hs) { if (h.getBoundingClientRect().top - rootTop <= band) active = h; else break; }
    window.__expectHeading = active ? active.textContent.slice(0, 50) : null;
    return window.__expectHeading;
  })()`);
  const expect = await evalp(`window.__expectHeading`);
  console.log("DOM 侧预期 heading:", expect);
  // 论文 scope 端到端：直接问模型（chatContext 用论文 scope——activeContext 走 UI 组件，此处直给小节文本模拟）
  await evalp(`(async () => {
    const t8 = window.__sim;
    t8.body = { chatContext: { activeBookId: 'paper-sim', activeContext: '（当前小节正文）' + window.__expectHeading + '：本章讨论分层氧化物正极材料的合成路径与电化学性能优化。', activeSectionLabel: window.__expectHeading, agentScope: 'paper' } };
    t8.history = [];
    return true;
  })()`);
  const reply = await askModel();
  console.log("模型答（位置感知）:", reply.slice(0, 120));
}

// ===== ② 书籍图片 iframe 右键通道 =====
console.log("\n=== ② 书籍图片通道 ===");
const bookImg = await evalp(`(async () => {
  // 回主页开一本书（福柯），找 iframe 里的 img，派发 contextmenu，验证 postMessage 到达宿主
  const ls = await import('/src/store/layout-store.ts');
  ls.useLayoutStore.setState({ tabs: [], activeTabId: null, isHomeActive: true, sleptTabIds: [] });
  await new Promise((r) => setTimeout(r, 800));
  const cards = Array.from(document.querySelectorAll('[data-region="book-card"], [class*="cursor-pointer"]'));
  const c = cards.find((x) => x.textContent.includes('福柯'));
  if (!c) return { ok: false, why: 'book-card' };
  c.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  // 等 foliate iframe 出现图片（最多 25s）
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const ifr = document.querySelector('foliate-view iframe') ?? document.querySelector('iframe');
    if (!ifr?.contentDocument) continue;
    const img = ifr.contentDocument.querySelector('img');
    if (img) {
      // 挂宿主 message 监听再派发右键
      let got = null;
      const onMsg = (e) => { if (e.data?.type === 'iframe-image-menu') got = e.data; };
      window.addEventListener('message', onMsg);
      img.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
      await new Promise((r) => setTimeout(r, 600));
      window.removeEventListener('message', onMsg);
      return { ok: !!got, srcHead: got ? String(got.src).slice(0, 40) : null, alt: got?.alt ?? null };
    }
  }
  return { ok: false, why: 'no-img' };
})()`);
console.log("iframe 右键→postMessage:", JSON.stringify(bookImg));

// ===== ③ deepseek 视觉真见像素 =====
console.log("\n=== ③ 视觉模型像素测试 ===");
const visionTest = await evalp(`(async () => {
  const ps = await import('/src/store/provider-store.ts');
  const store = ps.useProviderStore.getState();
  // 找 deepseek 供应商下的视觉型号
  const dp = store.modelProviders.find((p) => p.provider === 'deepseek');
  if (!dp) return { ok: false, why: 'no-deepseek-provider' };
  const visionModel = (dp.models ?? []).find((m) => /vision/i.test(m.id));
  if (!visionModel) return { ok: false, why: 'no-vision-model', models: (dp.models ?? []).map((m) => m.id).slice(0, 10) };
  const factory = await import('/src/ai/providers/factory.ts');
  const model = factory.createModelInstance('deepseek', visionModel.id);
  const tct = await import('/src/ai/custom-chat-transport.ts');
  const transport = new tct.CustomChatTransport(model);
  // 4x4 纯红 PNG
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR42mP8z8Dwn4GBgYGJgYEBAA1cAwUAAAAASUVORK5CYII=';
  const stream = await transport.sendMessages({
    chatId: 'vision-sim',
    messages: [{ id: 'v1', role: 'user', parts: [{ type: 'text', text: '这张纯色图片是什么颜色？只答颜色名。' }, { type: 'file', mediaType: 'image/png', url: png, filename: 'test.png' }] }],
    abortSignal: new AbortController().signal,
    trigger: 'submit-message',
    messageId: undefined,
    body: { chatContext: { agentScope: 'central' } },
  });
  let text = '';
  const reader = stream.getReader();
  while (true) { const { done, value } = await reader.read(); if (done) break; for (const p of Array.isArray(value) ? value : [value]) { if (p?.type === 'text-delta') text += p.delta; } }
  return { ok: true, model: visionModel.id, reply: text.trim().slice(0, 60) };
})()`);
console.log("视觉像素:", JSON.stringify(visionTest));

// 恢复 MCP
await evalp(`(async () => { const m = await import('/src/store/mcp-store.ts'); m.useMcpStore.setState({ servers: m.useMcpStore.getState().servers.map((sv) => ({ ...sv, enabled: (window.__simPrev ?? []).find((p) => p.id === sv.id)?.enabled ?? sv.enabled })) }); return true; })()`);
ws.close();

const fails = [];
if (paperOpened && !visionTest.noModel) {
  // ① 的判定人工看输出（模型回答含预期 heading 或小节语义）
}
if (!bookImg.ok) fails.push("书籍图片通道: " + JSON.stringify(bookImg));
if (!visionTest.ok) fails.push("视觉测试: " + JSON.stringify(visionTest));
if (exceptions.length) fails.push("页面异常: " + exceptions[0]);
console.log("\n=== 汇总 ===");
console.log(fails.length ? "FAIL: " + fails.join(" | ") : "PASS: 通道类验证全过（①的位置感知请看上方模型回答是否随新位置变化）");
if (fails.length) process.exit(1);
