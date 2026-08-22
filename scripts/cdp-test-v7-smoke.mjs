// P0.5 v7 升级端到端冒烟：页面上下文直跑 CustomChatTransport.sendMessages 全链路
// （convertToModelMessages await / instructions / isStepCount / onEnd / usage 元数据），
// 真实调用当前选中模型（DeepSeek 等），断言流式回包与 finish 元数据。
// 用法：node scripts/cdp-test-v7-smoke.mjs（dev 实例 CDP 9223）
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
if (!page) {
  console.error("未找到应用页面（localhost:1420）");
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
    const d = msg.params.exceptionDetails;
    exceptions.push(
      `${d?.text ?? ""} ${d?.exception?.description ?? d?.exception?.value ?? ""}`.trim().slice(0, 300),
    );
  }
};
const call = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP 超时: ${method}`));
    }, 180000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
await call("Runtime.enable", {});

const expr = `(async () => {
  const out = {};
  const factory = await import('/src/ai/providers/factory.ts');
  const tct = await import('/src/ai/custom-chat-transport.ts');
  const providerStore = await import('/src/store/provider-store.ts');
  // zustand persist 异步水合：轮询等 selectedModel 就位（最多 15s）
  let sel = null;
  for (let i = 0; i < 30; i++) {
    sel = providerStore.useProviderStore.getState().selectedModel;
    if (sel) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  out.selected = sel ? sel.providerId + '/' + sel.modelId : null;
  if (!sel) { out.error = '未选中模型（水合超时）'; return out; }
  const model = factory.createModelInstance(sel.providerId, sel.modelId);
  const transport = new tct.CustomChatTransport(model);
  const ctrl = new AbortController();
  const stream = await transport.sendMessages({
    chatId: 'v7-smoke',
    messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: '只用一句话回答：1+1等于几？' }] }],
    abortSignal: ctrl.signal,
    trigger: 'submit-message',
    messageId: undefined,
  });
  let text = '';
  const errors = [];
  let finishPart = null;
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const part of Array.isArray(value) ? value : [value]) {
      if (part?.type === 'text-delta' && typeof part.delta === 'string') text += part.delta;
      if (part?.type === 'error') errors.push(String(part.errorText ?? part.error ?? 'err'));
      if (part?.type === 'finish') finishPart = { metadata: part.messageMetadata ?? null };
    }
  }
  out.reply = text.trim().slice(0, 150);
  out.errors = errors;
  out.finishMetadata = finishPart ? JSON.stringify(finishPart.metadata).slice(0, 300) : null;
  out.hasUsage = !!(finishPart?.metadata?.totalUsage);
  return out;
})()`;

const res = await call("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
ws.close();

const out = res.result?.result?.value;
if (!out) {
  console.error("无返回值:", JSON.stringify(res.result || res).slice(0, 2000));
  process.exit(1);
}
console.log("=== cdp-test-v7-smoke ===");
console.log("选中模型:", out.selected);
console.log("回复:", out.reply);
console.log("流错误:", out.errors?.length ? out.errors : "无");
console.log("finish 元数据:", out.finishMetadata);
console.log("usage 就位:", out.hasUsage);
console.log("页面异常:", exceptions.length ? exceptions.slice(0, 5) : "无");

const fails = [];
if (!out.selected) fails.push("未选中模型");
if (!out.reply || out.reply.length < 2) fails.push("回复为空");
if (out.errors?.length) fails.push("流错误: " + out.errors.join(";"));
if (exceptions.length) fails.push("页面异常: " + exceptions[0]);
if (out.hasUsage === false) fails.push("finish 无 usage（totalUsage 迁移失败）");
if (fails.length) {
  console.error("FAIL:", fails.join(" | "));
  process.exit(1);
}
console.log("PASS: v7 全链路（transport→streamText→instructions→流回→usage）");
