// 第三刀 CDP 实测：AI 工具路径的队列/守卫（processPaper reparse/translate/align + vectorizeItem）
// 前提：dev 实例 CDP 9223；先 reload 页面使裸路径 import 与 app 同实例；测完立即 cancelPaperImport 清理。
// 用法：node scripts/cdp-ai-tool-guard-verify.mjs [paperId]  （默认 6c533ac14d2b48e4，须为库内 MARKDOWN 论文）
import { writeFileSync } from "node:fs";
import http from "node:http";

const PAPER_ID = process.argv[2] ?? "6c533ac14d2b48e4";
const OUT = "scripts/.ai-tool-guard-verify.result.json";
const log = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getPageWs() {
  return new Promise((resolve, reject) => {
    http
      .get("http://127.0.0.1:9223/json", (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          const page = JSON.parse(buf).find((t) => t.type === "page");
          page ? resolve(page.webSocketDebuggerUrl) : reject(new Error("no page target"));
        });
      })
      .on("error", reject);
  });
}

let msgId = 0;
const pending = new Map();
let ws;
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function ev(expression) {
  const r = await rpc("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return `EXC: ${JSON.stringify(r.exceptionDetails).slice(0, 400)}`;
  return r.result?.value;
}

const wsUrl = await getPageWs();
ws = new WebSocket(wsUrl);
ws.onmessage = (event) => {
  const m = JSON.parse(String(event.data));
  if (m.id && pending.has(m.id)) {
    pending.get(m.id).resolve(m.result ?? m);
    pending.delete(m.id);
  }
};
await new Promise((r) => {
  ws.onopen = r;
});
await rpc("Runtime.enable");
await rpc("Page.enable");

// 0. reload，等模块图全新（裸 import = app 同实例）
await rpc("Page.reload", { ignoreCache: false });
await sleep(7000);
for (let i = 0; i < 20; i++) {
  const ok = await ev(`import('/src/store/convert-progress-store.ts').then(() => 'ok').catch(() => 'wait')`);
  if (ok === "ok") break;
  await sleep(1000);
}
log.url = await ev("location.href");

// 1. reparse + 显式不存在 filePath → 早期错误（不入队）
log.reparseBadFilePath = await ev(`import('/src/ai/tools/central/process-paper.ts').then(m =>
  m.processPaperTool.execute(
    { reasoning: 'CDP 实测', action: 'reparse', paperId: '${PAPER_ID}', filePath: 'C:/nonexistent/definitely-missing.pdf' },
    {},
  ).then(r => JSON.stringify(r.results)))`);

// 2. reparse 正常入队（走 startPaperReparse）→ 入队即返 + isPaperQueuedOrRunning=true
log.reparseEnqueue = await ev(`import('/src/ai/tools/central/process-paper.ts').then(m =>
  m.processPaperTool.execute(
    { reasoning: 'CDP 实测', action: 'reparse', paperId: '${PAPER_ID}' },
    {},
  ).then(r => JSON.stringify(r.results)))`);
await sleep(500);
log.queuedOrRunningAfterEnqueue = await ev(
  `import('/src/store/convert-progress-store.ts').then(m => String(m.isPaperQueuedOrRunning('${PAPER_ID}')))`,
);

// 3. 等 running，看右下角进度卡（主页视角 #/papers）
for (let i = 0; i < 15; i++) {
  const st = await ev(
    `import('/src/store/convert-progress-store.ts').then(m => JSON.stringify(m.useConvertProgressStore.getState().paperImport))`,
  );
  if (st && st.includes('"status":"running"')) break;
  await sleep(1000);
}
log.paperImportRunning = await ev(
  `import('/src/store/convert-progress-store.ts').then(m => { const p = m.useConvertProgressStore.getState().paperImport; return JSON.stringify({ status: p?.status, fileName: p?.fileName, queuedCount: p?.queuedCount }); })`,
);
log.progressCard = await ev(`(() => {
  const card = document.querySelector('.fixed.right-4.bottom-4');
  return card ? card.textContent.slice(0, 90) : 'NO CARD';
})()`);

// 4. 守卫三连：translate / align / vectorize（应返回守卫消息而非真执行）
log.translateGuard = await ev(`import('/src/ai/tools/central/process-paper.ts').then(m =>
  m.processPaperTool.execute({ reasoning: 'CDP 实测', action: 'translate', paperId: '${PAPER_ID}' }, {}).then(r => JSON.stringify(r.results)))`);
log.alignGuard = await ev(`import('/src/ai/tools/central/process-paper.ts').then(m =>
  m.processPaperTool.execute({ reasoning: 'CDP 实测', action: 'align', paperId: '${PAPER_ID}' }, {}).then(r => JSON.stringify(r.results)))`);
log.vectorizeGuard = await ev(`import('/src/ai/tools/central/vectorize-book.ts').then(m =>
  m.vectorizeItem(
    { id: '${PAPER_ID}', title: 'Gravitational waves from cosmic strings', author: '', format: 'MARKDOWN' },
    { embeddingsUrl: '', model: '', apiKey: null, dimension: 0 },
  ).then(r => JSON.stringify(r)))`);

// 5. 同篇重复 reparse → 拒入队（已在解析队列中）
log.reparseDup = await ev(`import('/src/ai/tools/central/process-paper.ts').then(m =>
  m.processPaperTool.execute({ reasoning: 'CDP 实测', action: 'reparse', paperId: '${PAPER_ID}' }, {}).then(r => JSON.stringify(r.results)))`);

// 6. 清理：取消当前解析 + 清空队列
log.cancel = await ev(
  `import('/src/store/convert-progress-store.ts').then(async m => { await m.cancelPaperImport(); return 'cancelled'; })`,
);
await sleep(1000);
log.afterCancel = await ev(
  `import('/src/store/convert-progress-store.ts').then(m => JSON.stringify({ queuedOrRunning: m.isPaperQueuedOrRunning('${PAPER_ID}'), status: m.useConvertProgressStore.getState().paperImport?.status }))`,
);

writeFileSync(OUT, JSON.stringify(log, null, 2));
ws.close();
console.log("written:", OUT);
