// 5 本建档新书导入开发版阅读器（从 appdata converter/_regress-import，fs 权限域内）
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
await evalJS(`(async () => { window.__cs = await import("/src/services/converter-service.ts"); window.__lib = await import("/src/store/library-store.ts"); window.__bs = await import("/src/services/book-service.ts"); })()`);
const base = "C:\\Users\\20995\\AppData\\Roaming\\com.bettersageread.dev\\converter\\_regress-import\\";
const files = [
  "朱镕基传：朱镕基与现代中国的转型.epub",
  "中国36问：对一个崛起大国的洞察.epub",
  "八次危机：中国的真实经验 1949-2009.epub",
  "全球化与国家竞争：新兴七国比较研究.epub",
  "秦汉史讲义.epub",
];
for (const f of files) {
  const r = await evalJS(`window.__cs.importConvertedEpub(${JSON.stringify(base + f)}).then(() => "ok").catch((e) => "ERR " + (e && e.message ? e.message : String(e)))`);
  console.log(`导入 ${f}: ${r}`);
}
await evalJS(`window.__lib.useLibraryStore.getState().refreshBooks()`);
const after = await evalJS(`window.__bs.getBooks()`);
console.log("当前在库:", after.length);
for (const f of ["朱镕基", "中国36问", "八次危机", "全球化与国家竞争", "秦汉史"]) {
  const hits = after.filter((b) => (b.title || "").includes(f));
  console.log(f, "→", hits.map((b) => `${(b.title || "").slice(0, 30)}[${b.id.slice(0, 8)}]`).join(" | "));
}
process.exit(0);
