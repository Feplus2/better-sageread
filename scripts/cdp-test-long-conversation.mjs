// T8 长对话实测（用户授权使用 DeepSeek）：
// 阶段A——真实 8 轮读书对话（多轮强制 RAG），逐轮记录 inputTokens/cacheReadTokens 趋势；
// 阶段B——活塞集成：向真实 transport 注入"含大体积 ragSearch 结果的 16 轮历史"，断言请求成功（存根化历史 API 兼容）。
// 用法：node scripts/cdp-test-long-conversation.mjs（dev 实例 CDP 9223）
const BOOK_ID = "8641306906165cf145aa6911e055cf4f"; // 天地翻覆（下）——已向量化

const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
if (!page) {
  console.error("未找到应用页面");
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
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
    }, 300000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evalp = async (expression) => {
  const r = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600));
  return r.result?.result?.value;
};

const QUESTIONS = [
  "这本书的总体结构是什么？分几部分？（先检索再回答）",
  "第一部讲了什么内容？请引用原文关键句",
  "第二部的核心事件是什么？",
  "第三部里最重要的转折是什么？请引用",
  "书中如何描述1967年的局势？",
  "作者对这段历史的总体判断是什么？引用原文",
  "书末的结论部分说了什么？",
  "最后用三句话总结全书脉络",
];

// —— 阶段A：初始化（transport/历史挂 window）——
await evalp(`(async () => {
  const factory = await import('/src/ai/providers/factory.ts');
  const tct = await import('/src/ai/custom-chat-transport.ts');
  const ps = await import('/src/store/provider-store.ts');
  let sel = null;
  for (let i = 0; i < 30; i++) { sel = ps.useProviderStore.getState().selectedModel; if (sel) break; await new Promise(r=>setTimeout(r,500)); }
  const model = factory.createModelInstance(sel.providerId, sel.modelId);
  // 无头测试：stdio MCP 的启动确认卡没人点会无限挂起——临时禁用全部 server（测完由脚本尾恢复）
  const mcpStore = await import('/src/store/mcp-store.ts');
  window.__t8PrevEnabled = mcpStore.useMcpStore.getState().servers.map((sv) => ({ id: sv.id, enabled: sv.enabled }));
  mcpStore.useMcpStore.setState({ servers: mcpStore.useMcpStore.getState().servers.map((sv) => ({ ...sv, enabled: false })) });
  const confirmStore = await import('/src/store/agent-confirm-store.ts');
  const cs = confirmStore.useAgentConfirmStore.getState();
  (cs.queue ?? []).forEach(() => cs.resolvePending(false));
  window.__t8 = { transport: new tct.CustomChatTransport(model), history: [], usage: [] };
  return true;
})()`);

console.log("=== 阶段A：真实 8 轮对话（书：天地翻覆·下）===");
const usageRows = [];
let failedAt = -1;
for (const q of QUESTIONS) {
  const row = await evalp(`(async () => {
    const t8 = window.__t8;
    const question = ${JSON.stringify(q)};
    t8.history.push({ id: 'u' + t8.history.length, role: 'user', parts: [{ type: 'text', text: question }] });
    const stream = await t8.transport.sendMessages({ chatId: 't8-long', messages: t8.history.map(m => ({ ...m })), abortSignal: new AbortController().signal, trigger: 'submit-message', messageId: undefined, body: { chatContext: { activeBookId: '8641306906165cf145aa6911e055cf4f', agentScope: 'reader' } } });
    let text = ''; let finish = null; let tools = 0;
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const p of Array.isArray(value) ? value : [value]) {
        if (p?.type === 'text-delta') text += p.delta;
        if (p?.type === 'tool-input-available') tools += 1;
        if (p?.type === 'finish') finish = p.messageMetadata?.totalUsage ?? null;
      }
    }
    if (!text.trim()) return { failed: true };
    t8.history.push({ id: 'a' + t8.history.length, role: 'assistant', parts: [{ type: 'text', text }] });
    return {
      turn: t8.usage.length + 1,
      tools,
      input: finish?.inputTokens ?? null,
      cacheRead: finish?.inputTokenDetails?.cacheReadTokens ?? finish?.cachedInputTokens ?? null,
      output: finish?.outputTokens ?? null,
    };
  })()`);
  if (row.failed) {
    failedAt = usageRows.length + 1;
    break;
  }
  usageRows.push(row);
  const pct = row.input && row.cacheRead != null ? Math.round((row.cacheRead / row.input) * 100) : "?";
  console.log(`第${usageRows.length + 1}轮  tools=${row.tools}  input=${row.input}  cacheRead=${row.cacheRead}(${pct}%)  output=${row.output}`);
}
const finalHead = failedAt === -1 ? await evalp(`window.__t8.history[window.__t8.history.length-1].parts[0].text.slice(0, 80)`) : "";
console.log("末轮回答开头:", finalHead);

// —— 阶段B：活塞集成 ——
console.log("=== 阶段B：活塞集成（16 轮合成历史走真实请求）===");
const phaseB = await evalp(`(async () => {
  const t8 = window.__t8;
  const slim = await import('/src/ai/utils/tool-result-slimming.ts');
  const big = (n) => JSON.stringify({ results: Array.from({ length: 3 }, (_, k) => ({ chunk_id: 100 + n * 10 + k, related_chapter_titles: '第二部·第五章', text: '历'.repeat(1500) })) });
  const history = [];
  for (let t = 1; t <= 15; t++) {
    history.push({ id: 'su' + t, role: 'user', parts: [{ type: 'text', text: '问题' + t }] });
    if (t <= 2) {
      history.push({ id: 'sa' + t, role: 'assistant', parts: [
        { type: 'tool-ragSearch', toolCallId: 'tc' + t + 'a', state: 'output-available', input: { question: 'q' }, output: big(t) },
        { type: 'tool-ragSearch', toolCallId: 'tc' + t + 'b', state: 'output-available', input: { question: 'q' }, output: big(t + 50) },
        { type: 'text', text: '要点' + t + '[100]' },
      ] });
    } else {
      history.push({ id: 'sa' + t, role: 'assistant', parts: [{ type: 'text', text: '回答' + t }] });
    }
  }
  history.push({ id: 'su16', role: 'user', parts: [{ type: 'text', text: '用一句话回答：1+1等于几？' }] });
  const piston = slim.compactAgedRagResults(history);
  const stubbed = [];
  piston.forEach((m) => (m.parts ?? []).forEach((p) => { if (String(p.type).startsWith('tool-ragSearch') && typeof p.output === 'string' && p.output.startsWith('⟦')) stubbed.push(p.output); }));
  const stream = await t8.transport.sendMessages({ chatId: 't8-piston', messages: piston, abortSignal: new AbortController().signal, trigger: 'submit-message', messageId: undefined, body: { chatContext: { activeBookId: '8641306906165cf145aa6911e055cf4f', agentScope: 'reader' } } });
  let text = '';
  const reader = stream.getReader();
  while (true) { const { done, value } = await reader.read(); if (done) break; for (const p of Array.isArray(value) ? value : [value]) { if (p?.type === 'text-delta') text += p.delta; } }
  return { stubCount: stubbed.length, stubSample: stubbed[0] ?? null, reply: text.trim().slice(0, 60) };
})()`);
await evalp(`(async () => {
  const m = await import('/src/store/mcp-store.ts');
  m.useMcpStore.setState({ servers: m.useMcpStore.getState().servers.map((sv) => ({ ...sv, enabled: (window.__t8PrevEnabled ?? []).find((p) => p.id === sv.id)?.enabled ?? sv.enabled })) });
  return true;
})()`);
ws.close();

console.log("存根数:", phaseB.stubCount, "| 样例:", phaseB.stubSample);
console.log("带存根历史的真实回复:", phaseB.reply);

const fails = [];
if (failedAt !== -1 || usageRows.length < 8) fails.push(`阶段A 未满 8 轮（failedAt=${failedAt}）`);
if (phaseB.stubCount !== 4) fails.push(`活塞存根数 ${phaseB.stubCount} ≠ 预期 4`);
if (!phaseB.reply || phaseB.reply.length < 2) fails.push("带存根历史的请求失败");
if (exceptions.length) fails.push("页面异常: " + exceptions[0]);
if (fails.length) {
  console.error("FAIL:", fails.join(" | "));
  process.exit(1);
}
console.log("PASS: 长对话实测（8 轮真实 + 活塞全链路 API 兼容）");
