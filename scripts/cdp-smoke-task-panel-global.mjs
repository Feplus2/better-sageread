// P2-5 冒烟（store 级，不动执行器）：全局两张卡的面板接入。
// ① paper-parse：occupyForRecovery 注入 running 任务（恢复链路同款 API）→ 全局解析卡出现 →
//    点开面板核对行；同注一条 mirror 任务（Zotero 段形态）→ 断言不进面板。
// ② book-convert：注入 running + bookConvertMinimized=true → 小卡出现 → 点开面板 →
//    「打开详情窗口」入口存在且点击后大窗口开启（bookConvertDialogOpen）→ 关闭还原。
// 截图输出：.tmp-task-panel/
import { mkdirSync, writeFileSync } from "node:fs";

const SHOTS = ".tmp-task-panel";
mkdirSync(SHOTS, { recursive: true });

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
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description ?? "eval 失败").slice(0, 300));
  return r.result.value;
};
const send = (method, params) =>
  new Promise((res) => {
    const id = ++mid;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
const shot = async (name) => {
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(r.data, "base64"));
  console.log(`  截图 ${name}.png`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const assert = (cond, msg) => {
  if (!cond) { failed++; console.error(`FAIL - ${msg}`); } else { console.log(`ok - ${msg}`); }
};

// store 真实带版本 URL（HMR ?t= 陷阱）+ convert-progress-store（小卡可见性开关在其上）
const tcUrl = await evalJS(`(async () => {
  const src = await (await fetch("/src/services/task-executors/paper-vectorize.ts")).text();
  const i = src.indexOf("/src/store/task-center-store");
  const end = src.indexOf(".ts", i);
  let url = src.slice(i, end + 3);
  const m = src.slice(end + 3).match(/^\\?t=\\d+/);
  if (m) url += m[0];
  return url;
})()`);
await evalJS(`(async () => {
  const tc = await import(${JSON.stringify(tcUrl)});
  const cpSrc = await (await fetch("/src/services/task-executors/book-convert.ts")).text();
  const i = cpSrc.indexOf("/src/store/convert-progress-store");
  const end = cpSrc.indexOf(".ts", i);
  let cpUrl = cpSrc.slice(i, end + 3);
  const m = cpSrc.slice(end + 3).match(/^\\?t=\\d+/);
  if (m) cpUrl += m[0];
  const cp = await import(cpUrl);
  window.__tc = tc; window.__cp = cp;
  return 1;
})()`);

// 在图书馆页测（非禁区）
await evalJS(`document.querySelector('a[href="#/"]').click(); 1`);
await sleep(1000);

// ─── ① paper-parse：注入 running 恢复任务 + 一条 mirror ───
const parseIds = await evalJS(`(() => {
  const st = window.__tc.useTaskCenterStore.getState();
  const occ = st.occupyForRecovery({ channel: "paper-parse", targetId: "__panel_probe__", title: "面板冒烟·解析样例.pdf" });
  if (!occ) return { error: "paper-parse 通道被占" };
  occ.report(42, "转换中（面板冒烟）");
  const mirrorId = st.beginMirrorTask({ channel: "paper-parse", targetId: "__mirror_probe__", title: "镜像任务·不应进面板" });
  return { taskId: occ.taskId, mirrorId };
})()`);
if (parseIds.error) {
  assert(false, `paper-parse 注入失败：${parseIds.error}`);
} else {
  await sleep(800);
  const cardSeen = await evalJS(`(() => {
    const items = [...document.querySelectorAll("#bottom-right-stack .motion-stack-item")];
    const el = items.find((x) => x.textContent.includes("面板冒烟"));
    if (el) el.querySelector('[role="button"][title="点击查看任务清单"]').click();
    return !!el;
  })()`);
  assert(cardSeen, "解析卡渲染（occupyForRecovery 注入的 running 任务）");
  await sleep(400);
  const panelRows = await evalJS(`(() => {
    const dlg = document.querySelector('#bottom-right-stack [role="dialog"]');
    if (!dlg) return null;
    return [...dlg.querySelectorAll("li")].map((li) => li.textContent.replace(/\\s+/g, " ").trim());
  })()`);
  console.log("  解析面板行:", JSON.stringify(panelRows));
  assert(panelRows !== null, "解析卡面板弹出");
  assert(panelRows?.some((r) => r.includes("面板冒烟·解析样例.pdf") && r.includes("42%")), "面板含 running 行（42% 实时进度）");
  assert(!panelRows?.some((r) => r.includes("镜像任务")), "镜像任务不进面板（mirror:true 排除）");
  await shot("07-parse-panel");
  // 关闭面板 → 结算注入任务 → 清卡
  await evalJS(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); 1`);
  await evalJS(`(() => {
    const st = window.__tc.useTaskCenterStore.getState();
    st.settleRecoveredTask(${JSON.stringify(parseIds.taskId)}, "cancelled");
    st.endMirrorTask(${JSON.stringify(parseIds.mirrorId)});
    st.dismissSettled("paper-parse");
    return 1;
  })()`);
  await sleep(600);
}

// ─── ② book-convert：注入 running + 最小化标志 → 小卡 → 面板「打开详情窗口」───
const bcIds = await evalJS(`(() => {
  const st = window.__tc.useTaskCenterStore.getState();
  const occ = st.occupyForRecovery({ channel: "book-convert", targetId: "__panel_probe__.pdf", title: "面板冒烟·图书转换.pdf" });
  if (!occ) return { error: "book-convert 通道被占" };
  occ.report(55, "EPUB 排版中（面板冒烟）");
  window.__cp.useConvertProgressStore.setState({ bookConvertMinimized: true });
  return { taskId: occ.taskId };
})()`);
if (bcIds.error) {
  assert(false, `book-convert 注入失败：${bcIds.error}`);
} else {
  await sleep(800);
  const miniSeen = await evalJS(`(() => {
    const items = [...document.querySelectorAll("#bottom-right-stack .motion-stack-item")];
    const el = items.find((x) => x.textContent.includes("PDF 转 EPUB"));
    if (el) el.querySelector('[role="button"][title="点击查看任务清单"]').click();
    return !!el;
  })()`);
  assert(miniSeen, "图书转换小卡渲染（minimized + 通道 running）");
  await sleep(400);
  const bcPanel = await evalJS(`(() => {
    const dlg = document.querySelector('#bottom-right-stack [role="dialog"]');
    if (!dlg) return null;
    const rows = [...dlg.querySelectorAll("li")].map((li) => li.textContent.replace(/\\s+/g, " ").trim());
    const detailBtn = [...dlg.querySelectorAll("button")].find((b) => b.textContent.includes("打开详情窗口"));
    return { rows, hasDetail: !!detailBtn };
  })()`);
  console.log("  图书转换面板:", JSON.stringify(bcPanel));
  assert(bcPanel?.rows.some((r) => r.includes("面板冒烟·图书转换.pdf") && r.includes("55%")), "面板含 running 行（55% 实时进度）");
  assert(bcPanel?.hasDetail === true, "面板含「打开详情窗口」入口");
  await shot("08-book-convert-panel");
  // 点「打开详情窗口」→ 大窗口开启（bookConvertDialogOpen）且面板关闭
  const detail = await evalJS(`(() => {
    const dlg = document.querySelector('#bottom-right-stack [role="dialog"]');
    const btn = [...dlg.querySelectorAll("button")].find((b) => b.textContent.includes("打开详情窗口"));
    btn.click();
    return 1;
  })()`);
  await sleep(600);
  const afterDetail = await evalJS(`(() => ({
    dialogOpen: window.__cp.useConvertProgressStore.getState().bookConvertDialogOpen,
    panelGone: !document.querySelector('#bottom-right-stack [role="dialog"]'),
    hash: location.hash,
  }))()`);
  console.log("  点详情入口后:", JSON.stringify(afterDetail));
  assert(afterDetail.dialogOpen === true, "「打开详情窗口」开启转换大窗口");
  assert(afterDetail.panelGone === true, "点详情入口后面板关闭");
  await shot("09-book-convert-dialog");
  // 还原：关大窗口（idle 语义彻底关）→ 结算注入任务 → 清小卡
  await evalJS(`(() => {
    const st = window.__tc.useTaskCenterStore.getState();
    st.settleRecoveredTask(${JSON.stringify(bcIds.taskId)}, "cancelled");
    st.dismissSettled("book-convert");
    window.__cp.useConvertProgressStore.setState({ bookConvertDialogOpen: false, bookConvertMinimized: false });
    return 1;
  })()`);
  await sleep(600);
}

// 收尾确认：栈内无残卡
const restack = await evalJS(`document.getElementById("bottom-right-stack").querySelectorAll(".motion-stack-item").length`);
console.log("收尾后栈内卡片数:", restack);

ws.close();
console.log(failed === 0 ? "\nPASS" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
