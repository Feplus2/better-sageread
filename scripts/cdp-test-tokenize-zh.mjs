// CDP 验证 tokenize_zh 命令：jieba 分词 + UTF-16 偏移口径
const LIST_URL = "http://127.0.0.1:9222/json/list";
async function getPage(timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const page = (await (await fetch(LIST_URL)).json()).find((t) => t.type === "page" && t.url.includes("localhost:1420"));
      if (page) return page;
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}
const page = await getPage();
if (!page) { console.log("NO_PAGE"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const call = (m, p = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = (ev) => { const msg = JSON.parse(ev.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); } };
await new Promise((r) => (ws.onopen = r));
await call("Runtime.enable");
const res = await call("Runtime.evaluate", {
  expression: `(async () => {
    const svc = await import('/src/services/zh-tokenizer.ts');
    const texts = [
      '值得注意的是，远离分界线的其他区域也可能导致其他类型的过渡金属氧化物相',
      '或者根本无法形成稳定结构，这有待进一步研究。',
    ];
    const tokens = await svc.tokenizeZhBatch(texts);
    return JSON.stringify(tokens.map((list, i) => ({
      words: list.map(t => t.text).join('/'),
      // 用 JS 自己的 slice 复核 UTF-16 偏移口径
      sliceOk: list.every(t => texts[i].slice(t.start, t.end) === t.text),
    })));
  })()`,
  returnByValue: true,
  awaitPromise: true,
});
console.log(res?.result?.value ?? JSON.stringify(res?.exceptionDetails ?? res).slice(0, 400));
ws.close();
process.exit(0);
