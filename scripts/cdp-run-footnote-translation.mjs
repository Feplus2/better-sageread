// 脚注翻译实盘验收：forecast 篇（57ae0a5f29feecb6，229 块全 hash 命中、7 脚注待翻）
// 走真实续翻（辅助模型只跑 1 个脚注批次）→ 校验落盘 fn: 键 → 阅读器译文模式脚注区渲染中文。
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PID = "57ae0a5f29feecb6";
await evalJS(`Promise.all([
  import("/src/services/paper-translation-service.ts"),
  import("/node_modules/.vite/deps/@tauri-apps_plugin-fs.js"),
  import("/node_modules/.vite/deps/@tauri-apps_api_path.js"),
]).then(([t, fs, path]) => { window.__t = t; window.__fs = fs; window.__path = path; return "loaded"; })`);

console.log("开始续翻（只应有 1 个脚注批次）…");
const result = await evalJS(`(async () => {
  const base = await window.__path.appDataDir();
  const md = await window.__fs.readTextFile(await window.__path.join(base, "books", ${JSON.stringify(PID)}, "paper.md"));
  return await window.__t.translatePaper({ paperId: ${JSON.stringify(PID)}, markdown: md, force: false });
})()`);
console.log("translatePaper 返回:", JSON.stringify(result));

const fnDump = await evalJS(`(async () => {
  const file = await window.__t.loadPaperTranslation(${JSON.stringify(PID)});
  const fn = {};
  for (const [k, v] of Object.entries(file?.blocks ?? {})) if (k.startsWith("fn:")) fn[k] = v.text;
  return { totalKeys: Object.keys(file?.blocks ?? {}).length, sourceHash: file?.sourceHash ?? null, fn };
})()`);
console.log("译本总键数:", fnDump.totalKeys, " sourceHash:", fnDump.sourceHash);
console.log("fn 键译文:");
for (const [k, v] of Object.entries(fnDump.fn)) console.log(` ${k}: ${v}`);

ws.close();
process.exit(0);
