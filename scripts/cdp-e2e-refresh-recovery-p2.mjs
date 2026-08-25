// P2-4 解析刷新恢复 E2E（task-center 模型版，cdp-e2e-refresh-recovery.mjs 的继任者）：
// 情形 A：friction 篇重解析跑起来后刷新页面 → 恢复卡（occupyForRecovery 占位）接管 → done 后落库；
// 情形 B：done 落在刷新窗口（页面死亡期进程完成）→ 重新打开后恢复链路补落库。
// 落库判定：宿主侧 paper.md mtime 变化 + Rust pending_done 槽清空 + 通道任务 success。
// 运行：node scripts/cdp-e2e-refresh-recovery-p2.mjs   （dev 实例 vite 1420 / CDP 9223 需在跑）
import { statSync } from "node:fs";

const PAPER_ID = "6c533ac14d2b48e4";
const TITLE = "Gravitational waves from cosmic strings with friction: analytical approximations and parameter space";
const PAPER_MD = "C:/Users/20995/AppData/Roaming/com.bettersageread.dev/books/6c533ac14d2b48e4/paper.md";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mtimeOf = () => statSync(PAPER_MD).mtimeMs;

let failed = 0;
const assert = (cond, msg) => {
  if (!cond) {
    failed++;
    console.error(`FAIL - ${msg}`);
  } else {
    console.log(`ok - ${msg}`);
  }
};

// ---- CDP 连接（reload 后 ws 断，需重连） ----
const listTargets = async () => {
  const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
  return list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
};
let page = await listTargets();
if (!page) {
  console.error("实例未就绪");
  process.exit(1);
}
let ws = null;
let seq = 0;
const pending = new Map();
const bind = () => {
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
};
const connect = async () => {
  page = await listTargets();
  ws = new WebSocket(page.webSocketDebuggerUrl);
  bind();
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
};
await connect();
const call = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("timeout"));
    }, 30000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evalp = async (expression) => {
  const r = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600));
  return r.result?.result?.value;
};

// store 实例对齐（HMR ?t= 陷阱）：存活页面内从消费方转换源码抠带版本 URL；
// 刷新后页面整体重载，裸 URL 即最新实例（?t= 只对存活页面的 HMR 模块有意义）。
const probeCode = `(async (file, key) => {
  const src = await (await fetch(file)).text();
  const i = src.indexOf(key);
  if (i < 0) return null;
  const end = src.indexOf('.ts', i);
  let url = src.slice(i, end + 3);
  const m = src.slice(end + 3).match(/^\\?t=\\d+/);
  if (m) url += m[0];
  return url;
})`;
const probeLive = async () => {
  const cps = await evalp(`(${probeCode})('/src/pages/papers/index.tsx', '/src/store/convert-progress-store')`);
  if (!cps?.startsWith("/src/")) throw new Error(`探 convert-progress-store URL 失败: ${cps}`);
  const tc = await evalp(`(${probeCode})(${JSON.stringify(cps)}, '/src/store/task-center-store')`);
  if (!tc?.startsWith("/src/")) throw new Error(`探 task-center-store URL 失败: ${tc}`);
  return { cps, tc };
};
const importLive = async () => {
  const { cps, tc } = await probeLive();
  await evalp(`Promise.all([import(${JSON.stringify(cps)}), import(${JSON.stringify(tc)})]).then(([c, t]) => {
    window.__cps = c; window.__tc = t; return 1;
  })`);
  console.log("模块已对齐:", cps, "|", tc);
};

/** 通道聚合快照（paper-parse；current/queued/settled 摘要）。window.__tc 丢失（整页重载）时自愈重导入 */
const aggSnapshot = async () => {
  for (let i = 0; i < 3; i++) {
    try {
      return await evalp(`(() => {
        const { useTaskCenterStore, selectChannelAggregate } = window.__tc;
        const agg = selectChannelAggregate(useTaskCenterStore.getState(), "paper-parse");
        const brief = (t) => t && { status: t.status, detail: t.detail, percent: t.percent, recovered: t.payload?.recovered === true, result: t.result?.outcome };
        return { current: brief(agg.current), queuedCount: agg.queuedCount, settled: agg.settled.map(brief) };
      })()`);
    } catch (e) {
      if (String(e).includes("window.__tc")) {
        await importLive();
        continue;
      }
      throw e;
    }
  }
  throw new Error("aggSnapshot 自愈失败");
};

const rustStatus = async () =>
  evalp(`(async () => {
    const ps = await import('/src/services/paper-service.ts');
    return ps.getPaperConvertStatus();
  })()`);

const reloadAndReconnect = async () => {
  await call("Page.reload", {});
  console.log("已刷新，等重启…");
  await sleep(2500);
  for (let i = 0; i < 10; i++) {
    try {
      await connect();
      await importLive();
      return;
    } catch {
      await sleep(2000);
    }
  }
  throw new Error("刷新后重连失败");
};

// ==================== 情形 A：解析进行中刷新 → 恢复卡接管 → done 落库 ====================
console.log("\n── 情形 A：解析进行中刷新页面 ──");
await importLive();
await evalp(`window.__tc.useTaskCenterStore.getState().dismissSettled("paper-parse"); true`);
const mtimeA0 = mtimeOf();
const enq = await evalp(
  `(async () => window.__cps.startPaperReparse({ id: '${PAPER_ID}', title: ${JSON.stringify(TITLE)} }, { silent: true }))()`,
);
console.log("入队:", JSON.stringify(enq));
assert(enq?.ok === true, `情形 A 重解析入队（got ${JSON.stringify(enq)}）`);

// 等任务跑起来（通道 current running）
let preA = null;
for (let i = 0; i < 40; i++) {
  await sleep(1000);
  preA = await aggSnapshot();
  if (preA.current?.status === "running") break;
}
console.log("刷新前通道:", JSON.stringify(preA.current));
assert(preA.current?.status === "running", "情形 A 刷新前任务进入 running");

await reloadAndReconnect();

// 恢复卡：paper-parse 通道应出现 recovered 占位的 running 任务（情形 A 接管）
let recA = null;
for (let i = 0; i < 15; i++) {
  recA = await aggSnapshot();
  if (recA.current?.status === "running") break;
  await sleep(2000);
}
console.log("刷新后恢复卡:", JSON.stringify(recA.current));
assert(
  recA.current?.status === "running" && recA.current.recovered === true,
  `情形 A 恢复卡接管（recovered running，got ${JSON.stringify(recA.current)}）`,
);

// 等 done 落库：paper.md mtime 变化 + 通道任务转 success + pending_done 清空
// （恢复任务 success 后卡片 6s 自动 dismiss——settled 会清空，成功证据在轮询途中捕获）
const tA = Date.now();
let doneA = false;
let seenRecoveredSuccessA = false;
while (Date.now() - tA < 6 * 60 * 1000) {
  await sleep(5000);
  const [snap, st] = await Promise.all([aggSnapshot(), rustStatus()]);
  if (snap.settled.some((t) => t.status === "success" && t.recovered === true)) seenRecoveredSuccessA = true;
  const changed = mtimeOf() !== mtimeA0;
  console.log(
    `[A ${Math.round((Date.now() - tA) / 1000)}s] mtime=${changed ? "已变" : "未变"} current=${snap.current?.status ?? "-"} pendingDone=${st?.pendingDones?.length > 0 ? "有" : "无"}`,
  );
  if (changed && !snap.current && !(st?.pendingDones?.length > 0)) {
    doneA = true;
    break;
  }
}
assert(doneA, "情形 A done 落库（paper.md 更新 + 通道排空 + pending_done 清空）");
assert(seenRecoveredSuccessA, "情形 A 恢复任务以 success 结算（轮询途中捕获，6s 自动 dismiss 前）");

// ==================== 情形 B：done 落在刷新窗口 → 重开补落库 ====================
// 难点：旧页面消费 done 极快（importPapers 亚秒级清槽），轮询 pending_done 抓不住窗口。
// 确定性做法：进度进尾段后 Debugger.pause 冻结页面 JS（done 事件无人消费，pending_done 滞留），
// 等解析跑完再刷新——恢复链路只看到 pending_done，走情形 B 补落库。
console.log("\n── 情形 B：done 落在刷新窗口 ──");
let passB = false;
for (let attempt = 1; attempt <= 3 && !passB; attempt++) {
  await importLive();
  await evalp(`window.__tc.useTaskCenterStore.getState().dismissSettled("paper-parse"); true`);
  const mtimeB0 = mtimeOf();
  const enqB = await evalp(
    `(async () => window.__cps.startPaperReparse({ id: '${PAPER_ID}', title: ${JSON.stringify(TITLE)} }, { silent: true }))()`,
  );
  assert(enqB?.ok === true, `情形 B（第 ${attempt} 次）重解析入队`);

  // 追到 90% 平台段才冻结（实测 90%→done 约 60~70s，冻结窗口 110s 覆盖方差）
  let tailSeen = false;
  const tTrack = Date.now();
  while (Date.now() - tTrack < 6 * 60 * 1000) {
    const snap = await aggSnapshot();
    const pct = snap.current?.percent ?? 0;
    if (Math.round((Date.now() - tTrack) / 400) % 12 === 0) {
      console.log(
        `  [B 追踪 ${Math.round((Date.now() - tTrack) / 1000)}s] percent=${pct} current=${snap.current?.status ?? "-"}`,
      );
    }
    if (pct >= 90) {
      tailSeen = true;
      console.log(`追到尾段（percent=${pct}），冻结页面`);
      break;
    }
    // 任务已结算（done 在追到阈值前落地——本轮作废重试）；current 瞬时空不算数
    if (!snap.current && snap.settled.length > 0) break;
    await sleep(400);
  }
  if (!tailSeen) {
    console.log(`第 ${attempt} 次未追到尾段，${attempt < 3 ? "重试" : "放弃"}`);
    continue;
  }
  // 冻结页面 JS：done 落 pending_done 也无人消费；等解析收尾后刷新
  await call("Debugger.enable", {});
  await call("Debugger.pause", {});
  await sleep(110000);
  await call("Page.reload", {});
  console.log("已刷新（冻结窗口 110s），等重启 + 恢复…");
  // 调试器暂停态随导航解除；重连
  await sleep(2500);
  for (let i = 0; i < 10; i++) {
    try {
      await connect();
      await importLive();
      break;
    } catch {
      await sleep(2000);
    }
  }

  // 命中判定：恢复走情形 B（pending_done 滞留）→ recovered 任务先「恢复解析产物入库…」后 success；
  // 若 done 未在冻结窗口落地则走情形 A（running 恢复监控）——本轮不算命中，等它收尾后重试
  let hit = null;
  let sawBMarker = false;
  for (let i = 0; i < 240; i++) {
    const snap = await aggSnapshot();
    const rec = snap.current?.recovered ? snap.current : snap.settled.find((t) => t.recovered);
    if (rec) {
      hit = rec;
      if (rec.detail?.includes("恢复解析产物入库")) sawBMarker = true;
      if (rec.status !== "running") break;
    }
    if (i % 20 === 0) console.log(`  [B 检测 ${i / 2}s] rec=${hit ? `${hit.status}:${hit.detail}` : "未出现"}`);
    await sleep(500);
  }
  console.log("情形 B 恢复任务:", JSON.stringify(hit), "B 标记:", sawBMarker);
  if (!sawBMarker && hit) {
    console.log(`第 ${attempt} 次走的是情形 A（done 未落在冻结窗口），等通道排空后重试`);
    const tDrain = Date.now();
    while (Date.now() - tDrain < 6 * 60 * 1000) {
      const snap = await aggSnapshot();
      if (!snap.current && snap.queuedCount === 0) break;
      if (Math.round((Date.now() - tDrain) / 3000) % 10 === 0) {
        console.log(
          `  [B 排空等待 ${Math.round((Date.now() - tDrain) / 1000)}s] current=${snap.current?.status ?? "-"}`,
        );
      }
      await sleep(3000);
    }
    continue;
  }
  const changedB = mtimeOf() !== mtimeB0;
  const stB2 = await rustStatus();
  assert(hit?.status === "success", `情形 B 恢复任务 success 结算（got ${JSON.stringify(hit)}）`);
  assert(changedB, "情形 B 补落库：paper.md 已更新");
  assert(!(stB2?.pendingDones?.length > 0), "情形 B pending_done 槽已清空");
  passB = hit?.status === "success" && changedB && !(stB2?.pendingDones?.length > 0);
}

console.log(failed === 0 ? "\nRECOVERY P2 E2E PASS" : `\nRECOVERY P2 E2E FAIL（${failed} 项）`);
process.exit(failed === 0 ? 0 : 1);
