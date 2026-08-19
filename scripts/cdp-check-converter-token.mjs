// 探测主实例（CDP 9223）转换器 token 是否就绪（不打印密钥本体，只打印有无）
// 运行：node scripts/cdp-check-converter-token.mjs
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
if (!page) throw new Error("未找到主实例页面（1420）");

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const call = (method, params) =>
  new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id).resolve(msg.result);
    pending.delete(msg.id);
  }
};
await new Promise((r) => (ws.onopen = r));

const { result } = await call("Runtime.evaluate", {
  expression: `(async () => {
    const m = await import("/src/store/converter-store.ts");
    const s = m.useConverterStore.getState();
    return { paperEngine: s.paperEngine, hasMinerU: !!s.mineruToken, hasPaddle: !!s.paddleocrToken };
  })()`,
  awaitPromise: true,
  returnByValue: true,
});
console.log(JSON.stringify(result.value));
ws.close();
