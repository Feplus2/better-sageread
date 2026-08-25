// 图书转换小卡：点击卡片直接还原详情窗口（无中间面板层）实盘验证
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
if (!page) throw new Error("未找到 dev 页面");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let mid = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
};
const evalJS = async (expression) => {
  const r = await new Promise((res) => {
    const id = ++mid;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description ?? "").slice(0, 300));
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// store 实例对齐
const tcUrl = await evalJS(`(async () => {
  const src = await (await fetch("/src/services/task-executors/book-convert.ts")).text();
  const i = src.indexOf("/src/store/task-center-store");
  const end = src.indexOf(".ts", i);
  let url = src.slice(i, end + 3);
  const m = src.slice(end + 3).match(/^\\?t=\\d+/);
  if (m) url += m[0];
  return url;
})()`);
await evalJS(`Promise.all([
  import(${JSON.stringify(tcUrl)}),
  import("/src/services/task-executors/book-convert.ts"),
]).then(([tc, bc]) => { window.__tc = tc; window.__bc = bc; return 1; })`);

// 入队一个必然快速失败的任务（不存在的 PDF）——只为让小卡现身
await evalJS(`window.__bc.enqueueBookConvert({ pdfPath: "C:/__no_such_file__.pdf", ocr: false, translate: "none", autoImport: false })`);
let cardText = null;
for (let i = 0; i < 20; i++) {
  await sleep(500);
  cardText = await evalJS(`(() => {
    const el = Array.from(document.querySelectorAll("#bottom-right-stack [title='点击查看转换详情']"))[0];
    return el ? (el.textContent ?? "").slice(0, 60) : null;
  })()`);
  if (cardText) break;
}
console.log("小卡:", JSON.stringify(cardText));
if (!cardText) {
  console.error("FAIL - 图书转换小卡未出现");
  process.exit(1);
}
console.log("ok - 图书转换小卡出现（title=点击查看转换详情）");

// 点卡片 → 详情窗口打开
await evalJS(`document.querySelector("#bottom-right-stack [title='点击查看转换详情']")?.click(); "click"`);
await sleep(1200);
const dialogOpen = await evalJS(`(() => {
  const dlg = document.querySelector('[role="dialog"], [data-radix-popper-content-wrapper]');
  return dlg ? (dlg.textContent ?? "").slice(0, 80) : null;
})()`);
console.log("点击后弹窗:", JSON.stringify(dialogOpen));
const okDialog = dialogOpen !== null && (dialogOpen.includes("转换") || dialogOpen.includes("EPUB") || dialogOpen.includes("导入"));
console.log(okDialog ? "ok - 点击卡片直接打开转换详情窗口（无中间面板层）" : "FAIL - 点击卡片未打开详情窗口");

// 还原现场：关掉弹窗、清掉失败任务卡
await evalJS(`(() => {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  window.__tc.useTaskCenterStore.getState().dismissSettled("book-convert");
  return 1;
})()`);

ws.close();
process.exit(okDialog ? 0 : 1);
