// 脚注翻译实盘探针：不重翻任何正文块，只算"若现在续翻，有多少块/脚注待翻"
// （块 hash 全匹配 = 只有脚注进 pending，续翻成本最低）
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
if (!page) throw new Error("未找到 dev 页面");
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

await evalJS(`Promise.all([
  import("/src/services/paper-translation-service.ts"),
  import("/src/pages/paper-reader/paper-blocks.ts"),
  import("/node_modules/.vite/deps/@tauri-apps_plugin-fs.js"),
  import("/node_modules/.vite/deps/@tauri-apps_api_path.js"),
]).then(([t, b, fs, path]) => { window.__t = t; window.__b = b; window.__fs = fs; window.__path = path; return "loaded"; })`);

for (const id of ["57ae0a5f29feecb6", "6c533ac14d2b48e4"]) {
  const report = await evalJS(`(async () => {
    const id = ${JSON.stringify(id)};
    const base = await window.__path.appDataDir();
    const mdPath = await window.__path.join(base, "books", id, "paper.md");
    const md = await window.__fs.readTextFile(mdPath).catch(() => null);
    if (!md) return { id, error: "paper.md 读取失败" };
    const file = await window.__t.loadPaperTranslation(id);
    const blocks = window.__b.cutPaperBlocks(md).filter((b) => b.translatable);
    const footnotes = window.__b.extractPaperFootnotes(md);
    let blockMiss = 0;
    for (const b of blocks) {
      const h = await window.__t.hashBlockText(b.sourceText);
      if (file?.blocks?.[String(b.index)]?.hash !== h) blockMiss++;
    }
    let fnMiss = 0;
    for (const f of footnotes) {
      const h = await window.__t.hashBlockText(f.text);
      if (file?.blocks?.["fn:" + f.id]?.hash !== h) fnMiss++;
    }
    return { id, blocks: blocks.length, blockMiss, footnotes: footnotes.length, fnMiss, hasFile: !!file, sourceHash: file?.sourceHash ?? null };
  })()`);
  console.log(JSON.stringify(report));
}
ws.close();
process.exit(0);
