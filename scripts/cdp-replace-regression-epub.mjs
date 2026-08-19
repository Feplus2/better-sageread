// 替换坏书：purge 8/15 坏导入（565c5cf7…）→ 导入干净的 v1.3.1 回归版
import { readFileSync } from "node:fs";

const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
const call = (method, params) => {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  const id = ++mid;
  pending.set(id, { promise, resolve });
  ws.send(JSON.stringify({ id, method, params }));
  return promise;
};
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    p.resolve(msg.result);
  }
};
await new Promise((r) => (ws.onopen = r));
const evalJS = async (expr) => {
  const r = await call("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};

// 模块预载
await evalJS(`import("/src/services/book-service.ts").then((m) => { window.__bs = m; }); "bs"`);
await evalJS(`import("/src/store/library-store.ts").then((m) => { window.__lib = m; }); "lib"`);
for (let i = 0; i < 10; i++) {
  await new Promise((r) => setTimeout(r, 500));
  if (await evalJS(`!!(window.__bs && window.__lib)`).catch(() => false)) break;
}

// ① 删坏书（彻底删除——该条目是我导入的测试版，回收站都不留）
const del = await evalJS(`(async () => {
  try {
    await window.__bs.deleteBook("4a5938e035dc6d2b07671ceb7b973998");
    await window.__lib.useLibraryStore.getState().refreshBooks();
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e) }; }
})()`);
console.log("删除坏书:", JSON.stringify(del));

// ② 注入干净 epub 字节
const buf = readFileSync("D:/My_Library/高等数学/高等数学 第七版 上册.epub");
const b64 = buf.toString("base64");
await evalJS(`window.__b64 = ""; "init"`);
const CHUNK = 500_000;
for (let i = 0; i < b64.length; i += CHUNK) {
  await evalJS(`window.__b64 += ${JSON.stringify(b64.slice(i, i + CHUNK))}; true`);
}
await evalJS(`window.__upload = (async () => {
  const bin = atob(window.__b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const file = new File([bytes], "高等数学 第七版 上册（v1.3.1 回归版·干净解析）.epub", { type: "application/epub+zip" });
  window.__b64 = null;
  try {
    const book = await window.__bs.uploadBook(file);
    await window.__lib.useLibraryStore.getState().refreshBooks();
    return { ok: true, id: book.id, title: book.title };
  } catch (e) { return { ok: false, error: String(e) }; }
})(); "started"`);
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const res = await evalJS(`(async () => await window.__upload)()`).catch(() => null);
  if (res) {
    console.log("导入干净版:", JSON.stringify(res));
    ws.close();
    process.exit(res.ok ? 0 : 1);
  }
}
console.log("TIMEOUT");
ws.close();
process.exit(1);
