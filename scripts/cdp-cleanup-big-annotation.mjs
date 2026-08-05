// 清理验收事故残留的大段标注（text 长度 >100 且含 "may not lead to"）
const LIST_URL = "http://127.0.0.1:9222/json/list";
const page = (await (await fetch(LIST_URL)).json()).find((t) => t.type === "page" && t.url.includes("localhost:1420"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const call = (m, p = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = (ev) => { const msg = JSON.parse(ev.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); } };
await new Promise((r) => (ws.onopen = r));
await call("Runtime.enable");
const res = await call("Runtime.evaluate", {
  expression: `(async () => {
    const svc = await import('/src/services/book-note-service.ts');
    const notes = await svc.getBookNotes('a27b187c6bd02d3c');
    const targets = notes.filter(n => (n.text || '').length > 100 && (n.text || '').includes('may not lead to'));
    for (const n of targets) await svc.deleteBookNote(n.id);
    return JSON.stringify({ deleted: targets.map(n => ({ id: n.id, len: (n.text||'').length })), remaining: notes.length - targets.length });
  })()`,
  returnByValue: true, awaitPromise: true,
});
console.log(res?.result?.value ?? JSON.stringify(res?.exceptionDetails ?? res).slice(0, 300));
ws.close();
process.exit(0);
