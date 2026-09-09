// 回收站与在库对账：磁盘重复目录 vs DB 状态
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
const trashed = await evalJS(`import("/src/services/book-service.ts").then((m) => m.getTrashedBooks())`);
console.log("回收站:", trashed.length);
const g = (t) => trashed.filter((b) => (b.title || "").toLowerCase().includes(t));
for (const k of ["quantum field", "condensed matter", "feeling great", "born a crime", "ideologie", "society", "汉语语义", "城市与国家", "btq"]) {
  const hits = g(k);
  if (hits.length) console.log(k, "→", hits.map((b) => `${(b.title || "").slice(0, 30)}[${b.id.slice(0, 8)}]`).join(" "));
}
const books = await evalJS(`import("/src/services/book-service.ts").then((m) => m.getBooks())`);
console.log("在库 汉语语义学:", books.filter((b) => (b.title || "").includes("汉语语义")).map((b) => b.id.slice(0, 8)));
console.log("在库 QFT:", books.filter((b) => (b.title || "").includes("Quantum Field")).map((b) => `${b.createdAt}[${b.id.slice(0, 8)}]`));
console.log("在库 FeelingGreat:", books.filter((b) => (b.title || "").includes("Feeling Great")).map((b) => `${b.createdAt}[${b.id.slice(0, 8)}]`));
console.log("在库 BTQ:", books.filter((b) => (b.title || "").toLowerCase().includes("btq")).map((b) => `${b.title}[${b.id.slice(0, 8)}]`));
process.exit(0);
