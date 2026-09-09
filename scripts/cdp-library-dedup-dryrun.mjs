// 开发版书库盘点（dry-run）：列出全部书籍并按标题分组，标注重复组与每组保留项（最新 createdAt）
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
if (!page) throw new Error("dev app 页面不在（localhost:1420）");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
const call = (method, params) => {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  pending.set(++mid, { promise, resolve });
  ws.send(JSON.stringify({ id: mid, method, params }));
  return promise;
};
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id).resolve(msg.result); pending.delete(msg.id); }
};
await new Promise((r) => (ws.onopen = r));
const evalJS = async (expr) => {
  const r = await call("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};

const books = await evalJS(`import("/src/services/book-service.ts").then((m) => m.getBooks())`);
console.log("总数:", books.length);
const groups = new Map();
for (const b of books) {
  const key = (b.title || "").trim().replace(/\s+/g, " ").toLowerCase();
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(b);
}
const dups = [...groups.entries()].filter(([, v]) => v.length > 1);
console.log("重复组:", dups.length);
let trashCount = 0;
for (const [key, arr] of dups) {
  arr.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  const keep = arr[0];
  console.log(`\n【${arr[0].title}】×${arr.length} 保留 ${keep.id.slice(0, 8)} (${new Date(keep.createdAt).toLocaleDateString()})`);
  for (const b of arr.slice(1)) {
    console.log(`  → 回收 ${b.id.slice(0, 8)} (${new Date(b.createdAt).toLocaleDateString()})`);
    trashCount++;
  }
}
console.log("\n预计回收:", trashCount, "；保留:", books.length - trashCount);
process.exit(0);
