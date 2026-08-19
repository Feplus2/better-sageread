// 驱动运行中的主实例（CDP 9223）把 OA 论文 PDF 走完整转换+入库链路，作为新 fixture 的来源
// 流程：跳到文献库页 → startPaperPdfImport → 轮询 listPapers 直到新论文入库（done 事件由页面监听器接住）
// 运行：node scripts/cdp-import-oa-fixture.mjs   （转换约 5-20 分钟）
const PDF = "F:\\MyProjects\\SageRead\\.tmp-fixture\\oa-2605.27229.pdf";
const TITLE_HINT = "At-Scale";

const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
if (!page) throw new Error("未找到主实例页面（1420）");

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const call = (method, params) =>
  new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    if (msg.error) pending.get(msg.id).reject(new Error(JSON.stringify(msg.error)));
    else pending.get(msg.id).resolve(msg.result);
    pending.delete(msg.id);
  }
};
await new Promise((r) => (ws.onopen = r));

const evalJs = async (expression) => {
  const { result, exceptionDetails } = await call("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails) throw new Error(JSON.stringify(exceptionDetails.exception));
  return result?.value;
};

// 1. 跳到文献库页（确保页面级 progress 监听器就位，done 后能自动 importPapers 入库）
await evalJs(`location.hash = "#/papers"; "ok"`);
await new Promise((r) => setTimeout(r, 3000));

// 2. 启动转换
const start = await evalJs(`(async () => {
  const svc = await import("/src/services/paper-service.ts");
  await svc.startPaperPdfImport(${JSON.stringify(PDF)});
  return "started";
})()`);
console.log("convert started:", start);

// 3. 轮询直到入库（每 20s，上限 40 分钟）
const deadline = Date.now() + 40 * 60 * 1000;
let found = null;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 20000));
  try {
    const papers = await evalJs(`(async () => {
      const svc = await import("/src/services/paper-service.ts");
      const list = await svc.listPapers();
      return list.map((p) => ({ id: p.id, title: p.title }));
    })()`);
    found = papers?.find((p) => p.title?.includes(TITLE_HINT));
    if (found) break;
    process.stdout.write(".");
  } catch (e) {
    console.log("\npoll error (ignored):", String(e).slice(0, 200));
  }
}
console.log(found ? `\n入库完成: ${JSON.stringify(found)}` : "\n超时未入库");
ws.close();
process.exit(found ? 0 : 1);
