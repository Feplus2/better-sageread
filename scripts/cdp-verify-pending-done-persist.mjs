// 重启级恢复（pending_done 落盘）实盘验证：
//   ① 种植 pending-done.json → paper_convert_status 应从磁盘兜底读出（内存槽为空）；
//   ② clear_paper_convert_pending_done 应连文件一起清掉；
//   ③ 损坏文件/产物目录缺失时静默清理并返回 null。
// 前置：dev 实例在跑（CDP 9223）；GlobalConvertProgress 已在启动时消费过恢复（幂等旗标已置位），
// 本脚本种植的探针条目不会触发真实导入（恢复只在挂载时跑一次）。
import { existsSync, rmSync, writeFileSync } from "node:fs";

const PENDING_PATH = "C:/Users/20995/AppData/Roaming/com.bettersageread.dev/papers-converter/pending-done.json";
const REAL_DIR = "C:/Users/20995/AppData/Roaming/com.bettersageread.dev/papers-converter/wang2023routes";
if (!existsSync(REAL_DIR)) throw new Error(`探针依赖的真实产物目录不存在: ${REAL_DIR}`);

const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
if (!page) throw new Error("未找到 dev 页面（1420）");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
const call = (method, params) => {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  pending.set(++mid, { promise, resolve });
  ws.send(JSON.stringify({ id: mid, method, params }));
  return promise;
};
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id).resolve(msg.result);
    pending.delete(msg.id);
  }
};
await new Promise((r) => (ws.onopen = r));
const evalJS = async (expr) => {
  const r = await call("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};

let failed = 0;
const assert = (cond, msg) => {
  if (!cond) {
    failed++;
    console.error(`FAIL - ${msg}`);
  } else {
    console.log(`ok - ${msg}`);
  }
};

await evalJS(`import("/src/services/paper-service.ts").then((m) => { window.__ps = m; }); "loaded"`);

// ① 种植探针 pending-done（内存槽为空，磁盘兜底应读出）
writeFileSync(
  PENDING_PATH,
  JSON.stringify({
    pdfPath: "C:/fake/__cdp_probe__.pdf",
    paperDir: REAL_DIR,
    title: "__CDP_PROBE__",
    slug: "wang2023routes",
    degenerate: false,
    incomplete: false,
  }),
);
const s1 = await evalJS("window.__ps.getPaperConvertStatus()");
assert(
  s1?.pendingDone?.title === "__CDP_PROBE__",
  `磁盘兜底读出 pendingDone（got ${JSON.stringify(s1?.pendingDone)}）`,
);
assert(s1?.pendingDone?.paperDir === REAL_DIR, "pendingDone.paperDir 与种植一致");

// ② clear 命令连文件一起清
await evalJS("window.__ps.clearPaperConvertPendingDone().then(() => true)");
assert(!existsSync(PENDING_PATH), "clear 后 pending-done.json 已删除");
const s2 = await evalJS("window.__ps.getPaperConvertStatus()");
assert(s2?.pendingDone === null, `clear 后 pendingDone 为 null（got ${JSON.stringify(s2?.pendingDone)}）`);

// ③ 损坏文件静默清理
writeFileSync(PENDING_PATH, "{ not json");
const s3 = await evalJS("window.__ps.getPaperConvertStatus()");
assert(s3?.pendingDone === null, "损坏文件返回 null");
assert(!existsSync(PENDING_PATH), "损坏文件被顺手清理");

// ③b 产物目录缺失 → 不可恢复，静默清理
writeFileSync(
  PENDING_PATH,
  JSON.stringify({
    pdfPath: "C:/fake/__cdp_probe__.pdf",
    paperDir: "C:/fake/__nonexistent_dir__",
    title: "__CDP_PROBE__",
  }),
);
const s4 = await evalJS("window.__ps.getPaperConvertStatus()");
assert(s4?.pendingDone === null, "产物目录缺失返回 null");
assert(!existsSync(PENDING_PATH), "滞留文件被顺手清理");

console.log(failed === 0 ? "\nPASS" : `\n${failed} 项失败`);
ws.close();
process.exit(failed === 0 ? 0 : 1);
