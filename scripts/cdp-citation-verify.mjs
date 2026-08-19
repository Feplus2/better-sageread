// 引用标验证 step4b：伪造含工具输出的"老消息"线程，确定性覆盖全部来源路径：
// [2227] 映射内本论文 / [909] 映射内跨论文(flame) / [910] 未映射他论文(守卫) / [999999] 不存在 / [1] 垃圾引用
// 测试线程与早前误建的垃圾线程用后即删。
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
// 活动 tab 容器带 inline style visibility:visible（reader-layout），沿祖先链找第一个 inline visibility 判定
const VIS = `(el) => { let n = el; while (n) { if (n.style && n.style.visibility) return n.style.visibility === 'visible'; n = n.parentElement; } return true; }`;
const PANEL = `Array.from(document.querySelectorAll('#paper-chat-panel')).find(${VIS})`;

await evalJS(`import("/src/services/thread-service.ts").then((m) => { window.__threads = m; }); "ok"`);
// 清理上次中断可能残留的测试线程
await evalJS(`(async () => {
  const all = await window.__threads.getThreadsByBookId ? window.__threads.getThreadsByBookId("6c533ac14d2b48e4") : [];
  for (const t of all) if ((t.title ?? '').includes('引用标兼容测试')) await window.__threads.deleteThread(t.id).catch(() => {});
  return true;
})()`);

// 建测试线程（assistant 消息带持久化形态的 tool-paperSearch 输出 + 正文引用标）
const threadId = await evalJS(`(async () => {
  const t = await window.__threads.createThread("6c533ac14d2b48e4", "引用标兼容测试", [
    { id: "u1", role: "user", parts: [{ type: "text", text: "老消息兼容测试" }] },
    {
      id: "a1", role: "assistant",
      parts: [
        { type: "tool-paperSearch", toolCallId: "call_compat_1", state: "output-available",
          input: { reasoning: "兼容测试", question: "q", limit: 5, searchMode: "hybrid" },
          output: {
            results: [
              { rank: 1, paper_id: "6c533ac14d2b48e4", paper_title: "Gravitational waves from cosmic strings with friction: analytical approximations and parameter space", similarity: 70, content: "x", position: { chunk_id: 2227, file_position: "1/2" } },
              { rank: 2, paper_id: "03ff5bdec78942da", paper_title: "Flame aerosol synthesis of nanostructured materials and functional devices", similarity: 65, content: "x", position: { chunk_id: 909, file_position: "1/2" } }
            ],
            citations: [], citation_guide: "", meta: { reasoning: "t", total_found: 2, query: "q", scope: "全部文献" }
          } },
        { type: "text", text: "这是老消息格式的回答：本论文的片段[2227]，另一篇论文的片段[909]，未映射的他论文分块[910]，不存在的分块[999999]，垃圾引用[1]。" }
      ]
    },
  ], "book");
  return t.id;
})()`);
console.log("测试线程:", threadId);

// 打开历史对话并选中（它是最新的，排第一）
await evalJS(`(() => {
  const panel = ${PANEL};
  const listOpen = Array.from(panel.querySelectorAll('button')).some((b) => (b.textContent ?? '').includes('条消息'));
  if (!listOpen) Array.from(panel.querySelectorAll('button')).find((b) => b.querySelector('svg.lucide-history')).click();
  true;
})()`);
await sleep(1500);
console.log("选中:", await evalJS(`(() => {
  const panel = ${PANEL};
  const btn = Array.from(panel.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('引用标兼容测试'));
  if (!btn) return false;
  btn.click();
  return true;
})()`));
await sleep(2000);
console.log("引用标:", await evalJS(`(() => { const panel = ${PANEL}; return JSON.stringify(Array.from(panel.querySelectorAll('[data-region="chat-message-assistant"] span.rounded-full')).map((s) => s.textContent)); })()`));

const openPopover = async (mark) => {
  await evalJS(`(() => {
    const panel = ${PANEL};
    const el = Array.from(panel.querySelectorAll('[data-region="chat-message-assistant"] span.rounded-full')).find((s) => s.textContent === ${JSON.stringify(mark)});
    el.click();
    true;
  })()`);
  for (let i = 0; i < 25; i++) {
    await sleep(400);
    const pop = await evalJS(`(() => {
      const wrap = document.querySelector('[data-radix-popper-content-wrapper]');
      if (!wrap) return null;
      const text = (wrap.textContent ?? '').replace(/\\s+/g, ' ').trim();
      if (!text || text.includes('加载中')) return { pending: true };
      return { text: text.slice(0, 200) };
    })()`);
    if (pop && !pop.pending) return pop;
  }
  return null;
};
const closePopover = async () => {
  await evalJS(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  await sleep(500);
};

// ─── 1. [2227] 映射内本论文：弹层取数 + 跳转定位闪烁 ───
const pop1 = await openPopover("2227");
console.log("1) [2227] 弹层:", JSON.stringify(pop1));
const SCROLLER = `Array.from(document.querySelectorAll('.paper-content')).find(${VIS})?.closest('.overflow-y-auto')`;
const before1 = await evalJS(`Math.round((${SCROLLER}).scrollTop)`);
const jump1 = await evalJS(`(() => { const btn = document.querySelector('[data-radix-popper-content-wrapper]')?.querySelector('button'); if (!btn) return false; btn.click(); return true; })()`);
const flash1 = await evalJS(`new Promise((res) => {
  const t0 = Date.now(); let seen = null;
  const iv = setInterval(() => {
    const h = CSS.highlights && CSS.highlights.get("paper-anno-current");
    if (h && h.size > 0 && !seen) { const r = h.values().next().value; seen = (r.toString() ?? '').replace(/\\s+/g, ' ').trim().slice(0, 80); }
    if (Date.now() - t0 > 1800) { clearInterval(iv); res(seen); }
  }, 40);
})`);
await sleep(2500);
const after1 = await evalJS(`Math.round((${SCROLLER}).scrollTop)`);
console.log("1) 跳转:", jump1, "滚动", before1, "→", after1, "闪烁:", JSON.stringify(flash1));

// ─── 2. [909] 映射内跨论文：弹层显示 flame 标题，跳转打开 flame tab 并定位 ───
const pop2 = await openPopover("909");
console.log("2) [909] 弹层:", JSON.stringify(pop2));
const jump2 = await evalJS(`(() => { const btn = document.querySelector('[data-radix-popper-content-wrapper]')?.querySelector('button'); if (!btn) return false; btn.click(); return true; })()`);
await sleep(1000);
const tabAfter2 = await evalJS(`window.__layout.useLayoutStore.getState().activeTabId`);
// flame tab 加载后 pending quote 自动重放：等滚动或闪烁
let flameScroll = 0;
let flash2 = null;
for (let i = 0; i < 40; i++) {
  await sleep(500);
  flameScroll = await evalJS(`(() => { const s = Array.from(document.querySelectorAll('.paper-content')).find(${VIS})?.closest('.overflow-y-auto'); return s ? Math.round(s.scrollTop) : 0; })()`);
  flash2 = await evalJS(`(() => { const h = CSS.highlights && CSS.highlights.get('paper-anno-current'); if (h && h.size > 0) { const r = h.values().next().value; return (r.toString() ?? '').replace(/\\s+/g, ' ').trim().slice(0, 80); } return null; })()`);
  if (flameScroll > 0 || flash2) break;
}
const toast2 = await evalJS(`Array.from(document.querySelectorAll('[data-sonner-toast]')).map((t) => t.textContent).join(' | ').slice(0, 150)`);
console.log("2) 跳转:", jump2, "新 tab:", tabAfter2, "flame 滚动:", flameScroll, "闪烁:", JSON.stringify(flash2), "toast:", JSON.stringify(toast2));

// 回到 cosmic tab 继续测
await evalJS(`window.__layout.useLayoutStore.getState().activateTab ? window.__layout.useLayoutStore.getState().activateTab('paper-6c533ac14d2b48e4') : window.__layout.useLayoutStore.getState().openPaper('6c533ac14d2b48e4', 'x'); true`);
await sleep(1500);

// ─── 3. [910] 未映射他论文：归属守卫应拦截 ───
const pop3 = await openPopover("910");
console.log("3) [910] 弹层:", JSON.stringify(pop3));
await closePopover();

// ─── 4. [999999] 不存在：准确报错 ───
const pop4 = await openPopover("999999");
console.log("4) [999999] 弹层:", JSON.stringify(pop4));
await closePopover();

// ─── 5. [1] 垃圾引用：准确报错（chunk 1 不存在）───
const pop5 = await openPopover("1");
console.log("5) [1] 弹层:", JSON.stringify(pop5));
await closePopover();

// 清理：删测试线程 + 早前误建的垃圾线程
await evalJS(`(async () => {
  await window.__threads.deleteThread(${JSON.stringify(threadId)});
  await window.__threads.deleteThread('3b46f265-66a8-4b5a-8903-018d0eb63ced').catch(() => {});
  return true;
})()`);
console.log("测试线程已删");
console.log("done");
ws.close();
