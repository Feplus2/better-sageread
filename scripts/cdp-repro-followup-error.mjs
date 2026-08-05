// 排查 follow-up 报错：直调 CustomChatTransport.sendMessages，用真实轮次消息 + 新提问
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
  try {
    const origin = location.origin;
    const core = await import(origin + "/@id/@tauri-apps/api/core");
    const transportMod = await import(origin + "/src/ai/custom-chat-transport.ts");
    const factory = await import(origin + "/src/ai/providers/factory.ts");

    const t = await core.invoke("get_thread_by_id", { threadId: (await core.invoke("get_all_threads")).sort((a,b)=>b.updated_at-a.updated_at)[0].id });
    const history = JSON.parse(t.messages);
    const followUp = { id: "u-followup", role: "user", parts: [{ type: "text", text: "再来一个问题：刚才那段的核心结论是什么？" }] };
    const messages = [...history, followUp];

    // 取当前选中的模型（不硬编码）
    const provSrc = await (await fetch(origin + "/src/ai/custom-chat-transport.ts")).text();
    const providerStoreUrl = provSrc.match(new RegExp('"(/src/store/provider-store\\\\.ts[^"]*)"'))[1];
    const providerStore = (await import(origin + providerStoreUrl)).useProviderStore;
    const sel = providerStore.getState().selectedModel;
    if (!sel) return "no selected model";

    const model = factory.createModelInstance(sel.providerId, sel.modelId);
    const transport = new transportMod.CustomChatTransport(model, {});
    let errText = "null";
    let gotStream = "no";
    let firstChunk = "none";
    try {
      const stream = await transport.sendMessages({
        chatId: "probe",
        messages,
        abortSignal: undefined,
        trigger: "submit-message",
        messageId: followUp.id,
        body: { chatContext: { agentScope: "reader", activeBookId: t.book_id } },
      });
      gotStream = stream ? "yes" : "no";
      // 关键：消费流才会触发 AI SDK 的 prompt 校验
      const reader = stream.getReader();
      const first = await Promise.race([
        reader.read(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout10s")), 10000)),
      ]);
      firstChunk = JSON.stringify(first).slice(0, 200);
      await reader.cancel().catch(() => {});
    } catch (e) {
      errText = String(e && e.cause ? e.cause : e).slice(0, 500);
    }
    return JSON.stringify({ errText, gotStream, firstChunk, msgCount: messages.length });
  } catch (outer) {
    return "OUTER: " + String(outer).slice(0, 400);
  }
})()
`;

const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
console.log("value:", r.result?.result?.value);
if (r.result?.exceptionDetails) console.log("EXC:", JSON.stringify(r.result.exceptionDetails).slice(0, 400));
ws.close();
