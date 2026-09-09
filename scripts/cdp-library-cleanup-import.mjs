// 开发版书库清理 + 新版转换回归产物导入
// Phase 1: 精确标题重复组（保留最新，其余进回收站——可恢复）
// Phase 2: 6 本回归书的在库旧版进回收站（待会由新构建替换）
// Phase 3: 从 Books_Converter _regress 导入 6 个新 EPUB
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

await evalJS(`(async () => { window.__bs = await import("/src/services/book-service.ts"); window.__cs = await import("/src/services/converter-service.ts"); window.__lib = await import("/src/store/library-store.ts"); })()`);

const books = await evalJS(`window.__bs.getBooks()`);
console.log("清理前在库:", books.length);

// ── Phase 1: 精确标题重复组 ──
const groups = new Map();
for (const b of books) {
  const key = (b.title || "").trim().replace(/\s+/g, " ").toLowerCase();
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(b);
}
const toTrash = [];
for (const arr of groups.values()) {
  if (arr.length < 2) continue;
  arr.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  for (const b of arr.slice(1)) toTrash.push(b);
}

// ── Phase 2: 6 本回归书的在库旧版 ──
const REGR_KEYS = ["汉语语义", "quantum field", "condensed matter", "born a crime", "ideologie", "伊豆"];
for (const b of books) {
  const t = (b.title || "").toLowerCase();
  if (REGR_KEYS.some((k) => t.includes(k.toLowerCase())) && !toTrash.some((x) => x.id === b.id)) {
    toTrash.push(b);
  }
}
console.log("待回收:", toTrash.length);
for (const b of toTrash) console.log(`  回收: ${(b.title || "").slice(0, 45)} [${b.id.slice(0, 8)}]`);
for (const b of toTrash) {
  await evalJS(`window.__bs.deleteBook("${b.id}").then(() => "ok").catch((e) => "ERR " + e.message)`).then((r) => {
    if (r !== "ok") console.log(`  !! ${b.id.slice(0, 8)}: ${r}`);
  });
}

// ── Phase 3: 导入新构建 ──
const EPUBS = [
  "F:\\MyProjects\\Books_Converter\\_regress\\汉语语义学\\汉语语义学.epub",
  "F:\\MyProjects\\Books_Converter\\_regress\\QFT\\A Modern Introduction to Quantum Field Theory.epub",
  "F:\\MyProjects\\Books_Converter\\_regress\\Born a Crime\\Born a Crime_ Stories from a South African Childhood.epub",
  "F:\\MyProjects\\Books_Converter\\_regress\\Condensed Matter and Crystalline Physics\\Fundamentals of Condensed Matter and Crystalline Physics.epub",
  "F:\\MyProjects\\Books_Converter\\_regress\\The German Ideology (Great Books in Philosophy) (Karl Marx, Friedrich Engels) (Z-Library)\\Die deutsche Ideologie.epub",
  "F:\\MyProjects\\Books_Converter\\_regress\\伊豆の踊子\\伊豆の踊子.epub",
];
for (const p of EPUBS) {
  const r = await evalJS(`window.__cs.importConvertedEpub(${JSON.stringify(p)}).then(() => "ok").catch((e) => "ERR " + e.message)`);
  console.log(`导入 ${p.split("\\").pop()}: ${r}`);
}
await evalJS(`window.__lib.useLibraryStore.getState().refreshBooks()`);
const after = await evalJS(`window.__bs.getBooks()`);
console.log("清理后在库:", after.length);
process.exit(0);
