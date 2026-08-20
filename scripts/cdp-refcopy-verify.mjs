// 问题1验证：真实解析入库 → references.json 应随入库落进书目录（验完移入回收站）
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
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

const PDF = "C:\\Users\\20995\\AppData\\Local\\Temp\\refcopy-test\\gao2007peroxidase.pdf";

await call("Page.reload", { ignoreCache: true });
await sleep(4500);
await evalJS(`import("/src/store/layout-store.ts").then((m) => { window.__layout = m; }); "loading"`);
await evalJS(`import("/src/store/convert-progress-store.ts").then((m) => { window.__cps = m; }); "loading"`);
for (let i = 0; i < 20; i++) {
  await sleep(500);
  if (await evalJS(`!!window.__layout && !!window.__cps`).catch(() => false)) break;
}
await evalJS(`window.__layout.useLayoutStore.getState().navigateToHome(); true`);
await sleep(800);

await evalJS(`window.__cps.startPaperImportBatch([${JSON.stringify(PDF)}]); true`);
console.log("已提交解析");
// 等终态（卡出现 已入库/失败/取消）
const t0 = Date.now();
let final = null;
while (Date.now() - t0 < 900000) {
  await sleep(6000);
  final = await evalJS(`(() => { const c = document.querySelector('.fixed.right-4.bottom-4'); return c ? (c.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 160) : null; })()`);
  if (final && (final.includes("已入库") || final.includes("失败") || final.includes("已取消") || final.includes("入库过"))) break;
}
console.log("终态卡:", JSON.stringify(final));

// 找新入库条目 + 验证书目录有 references.json
const check = await evalJS(`(async () => {
  const m = await import('/src/services/paper-service.ts');
  const papers = await m.listPapers();
  const hit = papers.find((p) => /peroxidase/i.test(p.title ?? ''));
  if (!hit) return { found: false };
  const path = await import('@tauri-apps/api/path');
  const fs = await import('@tauri-apps/plugin-fs');
  const refsPath = await path.join(await path.appDataDir(), 'books', hit.id, 'references.json');
  const exists = await fs.exists(refsPath);
  let entries = null;
  if (exists) {
    const raw = await fs.readTextFile(refsPath);
    const doc = JSON.parse(raw);
    entries = Array.isArray(doc) ? doc.length : (doc.references ?? []).length;
  }
  return { found: true, id: hit.id, title: hit.title.slice(0, 50), refsExists: exists, entries };
})()`);
console.log("入库条目与 references.json:", JSON.stringify(check));

// 清理：移入回收站 + 删临时 PDF
if (check?.found && check.id) {
  await evalJS(`(async () => { const m = await import('/src/services/paper-service.ts'); await m.trashPaper(${JSON.stringify(check.id)}); return true; })()`);
  console.log("测试条目已入回收站");
}
console.log("done");
ws.close();
