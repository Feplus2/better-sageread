// 实测 paper-dedup：库内重复 / 批内重复 / 全新文件 三场景
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

await evalJS(`import("/src/services/paper-dedup.ts").then((m) => { window.__dedup = m; }); "loading"`);
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 600));
  if (await evalJS(`!!window.__dedup`).catch(() => false)) break;
}
if (!(await evalJS(`!!window.__dedup`))) throw new Error("模块加载失败");

// 场景输入：
// ① 库内已有的 PDF（cosmic strings 的 staging source.pdf）
// ② 同一份再来一遍（批内重复）
// ③ 全新 PDF（高等数学源书，与论文库无关）
const stagingPdf = "C:/Users/20995/AppData/Roaming/com.bettersageread.dev/papers-converter/mukovnikovgravitational-3cbb0a/source.pdf";
const freshPdf = "D:/My_Library/高等数学/高等数学·上册 第七版 (同济大学数学系) (z-library.sk, 1lib.sk, z-lib.sk).pdf";

const result = await evalJS(`(async () => {
  const inputs = [${JSON.stringify(stagingPdf)}, ${JSON.stringify(stagingPdf)}, ${JSON.stringify(freshPdf)}];
  const verdicts = await window.__dedup.findPaperDuplicates(inputs);
  return [...verdicts.entries()].map(([p, v]) => ({
    file: p.split(/[\\\\/]/).pop().slice(0, 30),
    kind: v.kind,
    title: v.title ?? null,
  }));
})()`);
console.log(JSON.stringify(result, null, 2));
ws.close();
