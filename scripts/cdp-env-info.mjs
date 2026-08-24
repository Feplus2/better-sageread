// 小规模环境信息采集（tabs 关闭后的 /chat 页）
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
const call = (m, p) => { let r; const pr = new Promise((res) => (r = res)); pending.set(++mid, { r }); ws.send(JSON.stringify({ id: mid, method: m, params: p })); return pr; };
ws.onmessage = (e) => { const msg = JSON.parse(e.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id).r(msg.result); pending.delete(msg.id); } };
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
const r = await call("Runtime.evaluate", {
  expression: `(() => ({
    domNodes: document.querySelectorAll('*').length,
    bodyScrollH: document.body.scrollHeight,
    shadowHosts: Array.from(document.querySelectorAll('*')).filter((e) => e.shadowRoot).length,
    customHighlightRules: Array.from(document.styleSheets).reduce((n, s) => { try { return n + s.cssRules.length; } catch { return n; } }, 0),
    iframes: document.querySelectorAll('iframe').length,
  }))()`,
  returnByValue: true,
  timeout: 15000,
});
console.log("环境:", JSON.stringify(r.result?.value ?? r));
ws.close();
process.exit(0);
