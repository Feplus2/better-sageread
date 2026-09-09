// 从 appdata converter/_regress-import 导入 6 个回归 EPUB（fs 权限范围内）
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0; const pending = new Map();
const call = (m, p) => new Promise((res) => { pending.set(++mid, res); ws.send(JSON.stringify({ id: mid, method: m, params: p })); });
ws.onmessage = (e) => { const msg = JSON.parse(e.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); } };
await new Promise((r) => (ws.onopen = r));
const evalJS = async (expr) => {
  const r = await call("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
await evalJS(`(async () => { window.__cs = await import("/src/services/converter-service.ts"); window.__lib = await import("/src/store/library-store.ts"); })()`);
const base = "C:\\Users\\20995\\AppData\\Roaming\\com.bettersageread.dev\\converter\\_regress-import\\";
const files = [
  "汉语语义学.epub",
  "A Modern Introduction to Quantum Field Theory.epub",
  "Born a Crime_ Stories from a South African Childhood.epub",
  "Fundamentals of Condensed Matter and Crystalline Physics.epub",
  "Die deutsche Ideologie.epub",
  "伊豆の踊子.epub",
];
for (const f of files) {
  const r = await evalJS(`window.__cs.importConvertedEpub(${JSON.stringify(base + f)}).then(() => "ok").catch((e) => "ERR " + (e && e.message ? e.message : String(e)))`);
  console.log(`导入 ${f}: ${r}`);
}
await evalJS(`window.__lib.useLibraryStore.getState().refreshBooks()`);
const after = await evalJS(`import("/src/services/book-service.ts").then((m) => m.getBooks())`);
console.log("当前在库:", after.length);
for (const f of ["汉语语义", "Quantum Field", "Born a Crime", "Condensed Matter", "Ideologie", "伊豆"]) {
  const hits = after.filter((b) => (b.title || "").includes(f));
  console.log(f, "→", hits.map((b) => `${(b.title || "").slice(0, 35)}[${b.id.slice(0, 8)}]`).join(" | "));
}
process.exit(0);
