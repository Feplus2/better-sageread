// P1 E2E v2：对已翻译且有 source.pdf 的论文（6c533ac14d2b48e4，宇宙弦引力波 friction）重解析
// 验收：①重解析完成（sourceHash 变化，paper.md 换新）；②title_zh/abstract_zh 保留（原文没变→应保住）；
//      ③translationStale=true（老译本无锚）；④vectorizedStale=true（死向量已清）。
const PAPER_ID = "6c533ac14d2b48e4";
const TITLE = "Gravitational waves from cosmic strings with friction: analytical approximations and parameter space";

const list0 = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page0 = list0.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
if (!page0) {
  console.error("实例未就绪");
  process.exit(1);
}
const ws = new WebSocket(page0.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
const call = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP 超时: ${method}`));
    }, 30000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evalp = async (expression) => {
  const r = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500));
  return r.result?.result?.value;
};

const baseline = await evalp(`(async () => {
  const ps = await import('/src/services/paper-service.ts');
  return await ps.getPaperSourceStatus('${PAPER_ID}');
})()`);
console.log("基线:", JSON.stringify(baseline));

const enq = await evalp(`(async () => {
  const m = await import('/src/store/convert-progress-store.ts');
  return m.startPaperReparse({ id: '${PAPER_ID}', title: ${JSON.stringify(TITLE)} }, { silent: true });
})()`);
console.log("入队:", JSON.stringify(enq));
if (!enq?.ok) {
  console.error("入队被拒，终止");
  process.exit(2);
}

const t0 = Date.now();
let cur = baseline;
while (Date.now() - t0 < 8 * 60 * 1000) {
  await new Promise((r) => setTimeout(r, 10000));
  cur = await evalp(`(async () => {
    const ps = await import('/src/services/paper-service.ts');
    const s = await ps.getPaperSourceStatus('${PAPER_ID}');
    const m = await import('/src/store/convert-progress-store.ts');
    const pi = m.useConvertProgressStore.getState().paperImport;
    return { ...s, queueStatus: pi?.status, queueError: pi?.error ?? null };
  })()`);
  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log(
    `[${elapsed}s] hash=${cur?.sourceHash} tStale=${cur?.translationStale} vStale=${cur?.vectorizedStale} queue=${cur?.queueStatus}${cur?.queueError ? " err=" + cur.queueError : ""}`,
  );
  if (cur?.queueStatus === "error") {
    console.error("解析报错:", cur.queueError);
    process.exit(3);
  }
  if (cur?.sourceHash && baseline?.sourceHash && cur.sourceHash !== baseline.sourceHash) break;
}

// 终态：用 app 模块图内的服务读元数据译文（避免裸 @tauri-apps  specifier 解析失败）
const finalCheck = await evalp(`(async () => {
  const ps = await import('/src/services/paper-service.ts');
  const ts = await import('/src/services/paper-translation-service.ts');
  const status = await ps.getPaperSourceStatus('${PAPER_ID}');
  const meta = await ts.loadPaperTranslatedMeta('${PAPER_ID}');
  return { status, title_zh: meta?.title_zh ?? null, abstract_zh_len: meta?.abstract_zh?.length ?? null };
})()`);
console.log("终态:", JSON.stringify(finalCheck, null, 2));

const ok =
  finalCheck.status?.sourceHash !== baseline?.sourceHash &&
  finalCheck.status?.translationStale === true &&
  finalCheck.status?.vectorizedStale === true &&
  !!finalCheck.title_zh;
console.log(ok ? "E2E PASS" : "E2E FAIL/不确定（见终态）");
ws.close();
process.exit(ok ? 0 : 3);
