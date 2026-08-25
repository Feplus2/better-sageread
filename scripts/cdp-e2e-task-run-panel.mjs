// P2-5 实盘验证：通道聚合卡点开子任务面板（task-run-panel）。
// 覆盖：① 向量化批量 3 篇 → 卡片渲染（含 P2-3 渲染源修正复核）；② 点击卡片 → 面板清单
// （状态图标/题名/实时 percent/detail 与 store 一致）；③ 面板内单项取消 queued 任务；
// ④ 快速连打开合无残影；⑤ 暗色主题视觉截图；⑥ 禁区（#/chat）栈与面板同隐。
// 截图输出：.tmp-task-panel/
import { mkdirSync, writeFileSync } from "node:fs";

const PAPERS = ["2f64e2c4a1b836ab", "6f0c2fcfc3e03b17", "57ae0a5f29feecb6"];
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

// store 真实带版本 URL（HMR ?t= 陷阱）：从执行器转换源码抠
const tcUrl = await evalJS(`(async () => {
  const src = await (await fetch("/src/services/task-executors/paper-vectorize.ts")).text();
  const i = src.indexOf("/src/store/task-center-store");
  if (i < 0) return null;
  const end = src.indexOf(".ts", i);
  let url = src.slice(i, end + 3);
  const m = src.slice(end + 3).match(/^\\?t=\\d+/);
  if (m) url += m[0];
  return url;
})()`);
if (!tcUrl) throw new Error("未能探到 task-center-store 的版本 URL");
await evalJS(`Promise.all([
  import(${JSON.stringify(tcUrl)}),
  import("/src/services/task-executors/paper-vectorize.ts"),
]).then(([tc, pv]) => { window.__tc = tc; window.__pv = pv; return 1; })`);

// 进 /papers（双通道卡只在 PapersPage 挂载时渲染；hash 路由）
await evalJS(`document.querySelector('a[href="#/papers"]').click(); 1`);
await sleep(1500);
assert((await evalJS("location.hash")) === "#/papers", "已导航到文献库页");

// 通道复位（清掉探针遗留的已结算/在跑）
await evalJS(`(() => {
  const st = window.__tc.useTaskCenterStore.getState();
  st.cancelChannel("paper-vectorize");
  return 1;
})()`);
await sleep(1500);
await evalJS(`window.__tc.useTaskCenterStore.getState().dismissSettled("paper-vectorize"); 1`);
await sleep(400);

// ① 批量入队 3 篇 → 通道卡渲染（P2-5 渲染源修正复核：此前读 storeProgress 不渲染）
console.log("入队 3 篇向量化…");
const enq = await evalJS(`(() => ${JSON.stringify(PAPERS)}.map((id) =>
  window.__pv.enqueuePaperVectorize({ id, title: id })))()`);
assert(enq.filter((r) => r.ok).length === 3, `3 篇全部入队成功（got ${JSON.stringify(enq)}）`);

let cardFound = false;
for (let i = 0; i < 20; i++) {
  await sleep(400);
  cardFound = await evalJS(`(() => {
    const items = [...document.querySelectorAll("#bottom-right-stack .motion-stack-item")];
    return items.some((el) => el.textContent.includes("批量向量化"));
  })()`);
  if (cardFound) break;
}
assert(cardFound, "向量化通道卡在右下角栈渲染（P2-3 渲染源修正生效）");
await shot("01-card");

// ② 点开面板
await evalJS(`(() => {
  const items = [...document.querySelectorAll("#bottom-right-stack .motion-stack-item")];
  const card = items.find((el) => el.textContent.includes("批量向量化"));
  card.querySelector('[role="button"][title="点击查看任务清单"]').click();
  return 1;
})()`);
await sleep(400);
const panelInfo = await evalJS(`(() => {
  const dlg = document.querySelector('#bottom-right-stack [role="dialog"]');
  if (!dlg) return null;
  const rows = [...dlg.querySelectorAll("li")].map((li) => li.textContent.replace(/\\s+/g, " ").trim());
  return { inStack: !!dlg.closest("#bottom-right-stack"), rows, header: dlg.textContent.slice(0, 60) };
})()`);
assert(panelInfo !== null, "点击卡片后面板弹出");
assert(panelInfo?.inStack === true, "面板挂在 #bottom-right-stack 内（随栈禁区同隐）");
console.log("  面板行:", JSON.stringify(panelInfo?.rows));
assert((panelInfo?.rows.length ?? 0) === 3, `面板列出 3 个子任务（got ${panelInfo?.rows.length}）`);
await shot("02-panel-open");

// 实时性：面板里 running 行的 percent/detail 与 store 的 current 一致
const live = await evalJS(`(() => {
  const dlg = document.querySelector('#bottom-right-stack [role="dialog"]');
  const agg = window.__tc.selectChannelAggregate(window.__tc.useTaskCenterStore.getState(), "paper-vectorize");
  if (!dlg || !agg.current) return null;
  return {
    storePercent: agg.current.percent,
    storeDetail: agg.current.detail,
    panelText: dlg.textContent,
    panelHasPercent: dlg.textContent.includes(String(agg.current.percent) + "%"),
    panelHasTitle: dlg.textContent.includes(agg.current.title),
  };
})()`);
assert(live === null || (live.panelHasPercent && live.panelHasTitle),
  `面板 running 行与 store 实时一致（${JSON.stringify(live && { p: live.storePercent, d: live.storeDetail, hit: live.panelHasPercent })}）`);

// ③ 单项取消：挑一个 queued 任务，点它行内的取消按钮
const cancelResult = await evalJS(`(() => {
  const s = window.__tc.useTaskCenterStore.getState();
  const agg = window.__tc.selectChannelAggregate(s, "paper-vectorize");
  const queued = s.order.map((id) => s.tasks[id]).filter((t) => t && t.channel === "paper-vectorize" && t.status === "queued");
  if (queued.length === 0) return { skipped: true, agg: { cur: !!agg.current, q: agg.queuedCount } };
  const target = queued[0];
  const dlg = document.querySelector('#bottom-right-stack [role="dialog"]');
  const row = [...dlg.querySelectorAll("li")].find((li) => li.textContent.includes(target.title));
  const btn = row?.querySelector('button[title="取消该任务"]');
  if (!btn) return { skipped: false, error: "行内未找到取消按钮", title: target.title };
  btn.click();
  return { skipped: false, taskId: target.taskId, title: target.title };
})()`);
await sleep(600);
if (cancelResult.skipped) {
  console.log("  （无 queued 任务可取消——结算太快，跳过单项取消断言）", JSON.stringify(cancelResult));
} else if (cancelResult.error) {
  assert(false, `单项取消：${cancelResult.error}`);
} else {
  const st = await evalJS(`(() => {
    const t = window.__tc.useTaskCenterStore.getState().tasks[${JSON.stringify(cancelResult.taskId)}];
    return t?.status;
  })()`);
  assert(st === "cancelled", `面板单项取消生效（${cancelResult.title} → ${st}）`);
}
await shot("03-panel-after-cancel");

// ④ 快速连打开合无残影
const toggleRes = await evalJS(`(async () => {
  const card = [...document.querySelectorAll("#bottom-right-stack .motion-stack-item")]
    .find((el) => el.textContent.includes("批量向量化"));
  if (!card) return { error: "卡片已消失（全部结算/消失）" };
  const btn = card.querySelector('[role="button"][title="点击查看任务清单"]');
  let maxDialogs = 0;
  for (let i = 0; i < 6; i++) {
    btn.click();
    await new Promise((r) => setTimeout(r, 90));
    maxDialogs = Math.max(maxDialogs, document.querySelectorAll('#bottom-right-stack [role="dialog"]').length);
  }
  // 确保最终关闭：若还开着就 Esc
  const openNow = document.querySelectorAll('#bottom-right-stack [role="dialog"]').length;
  if (openNow > 0) document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await new Promise((r) => setTimeout(r, 500));
  return { maxDialogs, openNow, afterClose: document.querySelectorAll('#bottom-right-stack [role="dialog"]').length };
})()`);
assert(toggleRes.error ? true : toggleRes.maxDialogs <= 1, `快速连打最多 1 个面板实例（got ${toggleRes.maxDialogs}）`);
assert(toggleRes.error ? true : toggleRes.afterClose === 0, `Esc/连打后无面板残影（got ${toggleRes.afterClose}）`);
console.log("  连打观测:", JSON.stringify(toggleRes));
await shot("04-after-toggle");

// ⑤ 暗色主题下复核视觉（重开面板截图）
await evalJS(`document.documentElement.classList.add("dark"); 1`);
await sleep(300);
const reopen = await evalJS(`(() => {
  const card = [...document.querySelectorAll("#bottom-right-stack .motion-stack-item")]
    .find((el) => el.textContent.includes("批量向量化"));
  if (!card) return false;
  card.querySelector('[role="button"][title="点击查看任务清单"]').click();
  return true;
})()`);
await sleep(400);
if (reopen) await shot("05-panel-dark");
const darkRows = await evalJS(`(() => {
  const dlg = document.querySelector('#bottom-right-stack [role="dialog"]');
  return dlg ? [...dlg.querySelectorAll("li")].map((li) => li.textContent.replace(/\\s+/g, " ").trim()) : null;
})()`);
console.log("  暗色面板行:", JSON.stringify(darkRows));
await evalJS(`(() => {
  const dlg = document.querySelector('#bottom-right-stack [role="dialog"]');
  if (dlg) document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  document.documentElement.classList.remove("dark");
  return 1;
})()`);
await sleep(400);

// ⑥ 禁区：#/chat 下栈与面板同隐（面板若在切页前开着也应随栈 display:none 藏掉）
await evalJS(`(() => {
  const card = [...document.querySelectorAll("#bottom-right-stack .motion-stack-item")]
    .find((el) => el.textContent.includes("批量向量化"));
  if (card) card.querySelector('[role="button"][title="点击查看任务清单"]').click();
  return 1;
})()`);
await sleep(300);
await evalJS(`document.querySelector('a[href="#/chat"]').click(); 1`);
await sleep(800);
const exempt = await evalJS(`(() => {
  const stack = document.getElementById("bottom-right-stack");
  const dlg = document.querySelector('#bottom-right-stack [role="dialog"]');
  return {
    stackDisplay: getComputedStyle(stack).display,
    dlgExists: !!dlg,
    dlgVisible: dlg ? getComputedStyle(dlg).display !== "none" && dlg.getClientRects().length > 0 : false,
  };
})()`);
assert(exempt.stackDisplay === "none", `#/chat 禁区栈隐藏（display=${exempt.stackDisplay}）`);
assert(!exempt.dlgVisible, "面板随栈同隐（dialog 不可见）");
await shot("06-chat-exempt");
await evalJS(`document.querySelector('a[href="#/papers"]').click(); 1`);
await sleep(800);

// 收尾：撤掉剩余任务并清卡，dev 实例恢复干净
await evalJS(`(() => {
  const st = window.__tc.useTaskCenterStore.getState();
  st.cancelChannel("paper-vectorize");
  return 1;
})()`);
await sleep(1500);
await evalJS(`window.__tc.useTaskCenterStore.getState().dismissSettled("paper-vectorize"); 1`);

ws.close();
console.log(failed === 0 ? "\nPASS" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
