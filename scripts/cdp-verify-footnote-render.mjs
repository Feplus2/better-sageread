// 脚注译文真实数据重建校验：forecast 篇真实译本 × 真实 paper.md
// ① 译文模式：脚注定义替换为中文、正文 [^N] 引用标记不丢（restoreFootnoteRefs）
// ② 对照模式：脚注定义内嵌译文 div
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
if (!page) throw new Error("未找到 dev 页面");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
};
await new Promise((r) => (ws.onopen = r));
const evalJS = async (expression) => {
  const r = await new Promise((res) => {
    const id = ++mid;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};

await evalJS(`Promise.all([
  import("/src/services/paper-translation-service.ts"),
  import("/src/pages/paper-reader/paper-blocks.ts"),
  import("/node_modules/.vite/deps/@tauri-apps_plugin-fs.js"),
  import("/node_modules/.vite/deps/@tauri-apps_api_path.js"),
]).then(([t, b, fs, path]) => { window.__t = t; window.__b = b; window.__fs = fs; window.__path = path; return 1; })`);

const report = await evalJS(`(async () => {
  const base = await window.__path.appDataDir();
  const md = await window.__fs.readTextFile(await window.__path.join(base, "books", "57ae0a5f29feecb6", "paper.md"));
  const file = await window.__t.loadPaperTranslation("57ae0a5f29feecb6");
  const blockMap = new Map(); const fnMap = new Map();
  for (const [k, v] of Object.entries(file.blocks)) {
    if (k.startsWith("fn:")) fnMap.set(k.slice(3), v.text); else blockMap.set(Number(k), v.text);
  }
  const translated = window.__b.buildPaperViewMarkdown(md, blockMap, "translated", fnMap);
  const bilingual = window.__b.buildPaperViewMarkdown(md, blockMap, "bilingual", fnMap);
  const srcRefs = (md.match(/\\[\\^\\d+\\](?!:)/g) || []).length;
  const outRefs = (translated.match(/\\[\\^\\d+\\](?!:)/g) || []).length;
  const fnTranslated = window.__b.extractPaperFootnotes(translated).map((f) => f.id + ":" + (/[\\u4e00-\\u9fff]/.test(f.text) ? "zh" : "??"));
  // 对照模式：[^1] 定义段内应出现 data-translation div
  const fn1Seg = bilingual.slice(bilingual.indexOf("[^1]:"));
  const biOk = fn1Seg.slice(0, 400).includes("data-translation");
  return { srcRefs, outRefs, fnTranslated, biOk };
})()`);
console.log(JSON.stringify(report, null, 1));
ws.close();
process.exit(0);
