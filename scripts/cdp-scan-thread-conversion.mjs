// 排查：扫描全部对话，找出 convertToModelMessages 校验失败的消息组合
const LIST_URL = "http://127.0.0.1:9223/json/list";
const pages = await (await fetch(LIST_URL)).json();
const page = pages.find((p) => p.type === "page" && p.url?.includes("localhost:1420"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let mid = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const cdp = (method, params = {}) => { const id = ++mid; ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => pending.set(id, r)); };

const expression = `
(async () => {
  const origin = location.origin;
  const core = await import(origin + "/@id/@tauri-apps/api/core");
  const utils = await import(origin + "/src/ai/utils/index.ts");
  const registry = await import(origin + "/src/ai/tools/registry.ts");
  const { convertToModelMessages } = await import(origin + "/@id/ai");

  const threads = await core.invoke("get_all_threads");
  const report = [];
  for (const summary of threads) {
    const t = await core.invoke("get_thread_by_id", { threadId: summary.id });
    let messages;
    try { messages = JSON.parse(t.messages); } catch { continue; }
    if (!Array.isArray(messages) || messages.length === 0) continue;
    const scope = t.scope === "global" ? "central" : "reader";
    const tools = registry.getToolsForScope(scope === "central" ? "central" : "reader", { bookId: t.book_id });
    let err = null;
    try {
      const processed = utils.processQuoteMessages(messages);
      const sel = utils.selectMessagesWithinBudget(processed);
      const stripped = utils.stripUnknownToolParts(sel.kept, tools);
      convertToModelMessages(stripped, { tools, ignoreIncompleteToolCalls: true });
    } catch (e) {
      err = String(e?.cause ?? e).slice(0, 300);
    }
    report.push({
      title: summary.title, msgs: messages.length, scope,
      parts: messages.map((m) => m.role + ":" + (m.parts || []).map((p) => p.type + (p.state ? "@" + p.state : "")).join("|")),
      err,
    });
  }
  return report;
})()
`;

const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
const val = r.result?.result?.value;
if (!Array.isArray(val)) {
  console.log(JSON.stringify(r).slice(0, 600));
} else {
  for (const row of val) {
    console.log(`${row.err ? "❌" : "✅"} [${row.scope}] ${row.title} (${row.msgs} msgs)`);
    if (row.err) {
      console.log("   parts:", JSON.stringify(row.parts));
      console.log("   err:", row.err);
    }
  }
}
ws.close();
