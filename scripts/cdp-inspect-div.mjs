// CDP：在页面里直接调用 vite 模块的归一函数，检查 divs[20] 的实际状态
const page = (await (await fetch("http://127.0.0.1:9222/json/list")).json()).find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const call = (m, p = {}) =>
  new Promise((r) => {
    const i = ++id;
    pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method: m, params: p }));
  });
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result);
    pending.delete(m.id);
  }
};
await new Promise((r) => (ws.onopen = r));
await call("Runtime.enable");
const res = await call("Runtime.evaluate", {
  expression: `(async () => {
    const m = await import('/src/pages/paper-reader/paper-cross-anchor.ts');
    const divs = [...document.querySelectorAll('[data-translation]')].filter(d => (d.textContent||'').trim().length > 30);
    const div = divs[20];
    const normL = m.normalizeLiveElement(div);
    const normS = m.normalizeMathText(div.textContent);
    return JSON.stringify({
      katexCount: div.querySelectorAll('.katex').length,
      normLTokens: m.tokenizeWords(normL.text).length,
      normLSpans: normL.spans.length,
      textHead: div.textContent.slice(0, 80),
      normHead: normL.text.slice(0, 80),
      innerHead: div.innerHTML.slice(0, 200),
    });
  })()`,
  returnByValue: true,
  awaitPromise: true,
});
console.log(res?.result?.value ?? JSON.stringify(res));
ws.close();
process.exit(0);
