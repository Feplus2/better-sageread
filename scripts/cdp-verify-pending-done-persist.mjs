// 重启级恢复（pending_done 落盘）实盘验证（P3 多数组形态）：
//   ① 种植旧版单对象 pending-done.json → paper_convert_status 应容错迁移读出（向后兼容）；
//   ② clear 命令（pdfPath 定向）只清指定槽，其余保留；缺省清空并删文件；
//   ③ 损坏文件/产物目录缺失时静默清理并返回空数组。
// 前置：dev 实例在跑（CDP 9223）；GlobalConvertProgress 已在启动时消费过恢复（幂等旗标已置位），
// 本脚本种植的探针条目不会触发真实导入（恢复只在挂载时跑一次）。
import { existsSync, writeFileSync } from "node:fs";

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
await new Promise((r) => {
  ws.onopen = r;
});
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

// 注意：本脚本直接走 plugin core invoke（不走 paper-service 包装器）——浏览器对裸 URL
// 模块有会话级缓存，HMR 后裸 URL 拿到的是页面启动代的旧包装器（参数被吞），
// 并非 Rust 侧行为异常。命令参数 camelCase（pdf_path → pdfPath）。
await evalJS(`import("/node_modules/.vite/deps/@tauri-apps_api_core.js").then((m) => {
  window.__ps = {
    getPaperConvertStatus: (pdfPath) => m.invoke("paper_convert_status", { pdfPath: pdfPath ?? null }),
    clearPaperConvertPendingDone: (pdfPath) => m.invoke("clear_paper_convert_pending_done", { pdfPath: pdfPath ?? null }),
  };
  return "loaded";
})`);

// 每次运行先全清一次（内存槽+磁盘双清），防上轮残留污染 ① 的断言
await evalJS(`window.__ps.clearPaperConvertPendingDone().then(() => "reset-done")`);

// ① 种植探针 pending-done（旧版单对象形态；内存槽为空，磁盘兜底应容错迁移读出）
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
assert(Array.isArray(s1?.pendingDones), `pendingDones 为数组形态（got ${JSON.stringify(s1)}）`);
assert(
  s1?.pendingDones?.[0]?.title === "__CDP_PROBE__",
  `磁盘兜底读出旧版单对象并迁移为数组（got ${JSON.stringify(s1?.pendingDones)}）`,
);
assert(s1?.pendingDones?.[0]?.paperDir === REAL_DIR, "pendingDones[0].paperDir 与种植一致");

// ②a 定向 clear：只清指定 pdfPath 的槽（先补种第二条，清一条留一条）
await evalJS("window.__ps.clearPaperConvertPendingDone().then(() => true)"); // 复位
writeFileSync(
  PENDING_PATH,
  JSON.stringify([
    { pdfPath: "C:/fake/__probe_a__.pdf", paperDir: REAL_DIR, title: "__PROBE_A__", degenerate: false, incomplete: false },
    { pdfPath: "C:/fake/__probe_b__.pdf", paperDir: REAL_DIR, title: "__PROBE_B__", degenerate: false, incomplete: false },
  ]),
);
const s2a = await evalJS("window.__ps.getPaperConvertStatus()");
assert(s2a?.pendingDones?.length === 2, `种植两条槽读出 2 条（got ${s2a?.pendingDones?.length}）`);
await evalJS(`window.__ps.clearPaperConvertPendingDone("C:/fake/__probe_a__.pdf").then(() => true)`);
const s2b = await evalJS("window.__ps.getPaperConvertStatus()");
assert(
  s2b?.pendingDones?.length === 1 && s2b.pendingDones[0].title === "__PROBE_B__",
  `定向 clear 只清 A 槽、B 槽保留（got ${JSON.stringify(s2b?.pendingDones)}）`,
);

// ②b 缺省 clear：全清并删文件
await evalJS("window.__ps.clearPaperConvertPendingDone().then(() => true)");
assert(!existsSync(PENDING_PATH), "clear 后 pending-done.json 已删除");
const s2c = await evalJS("window.__ps.getPaperConvertStatus()");
assert(
  Array.isArray(s2c?.pendingDones) && s2c.pendingDones.length === 0,
  `clear 后 pendingDones 为空数组（got ${JSON.stringify(s2c?.pendingDones)}）`,
);

// ③ 损坏文件静默清理
writeFileSync(PENDING_PATH, "{ not json");
const s3 = await evalJS("window.__ps.getPaperConvertStatus()");
assert(s3?.pendingDones?.length === 0, "损坏文件返回空数组");
assert(!existsSync(PENDING_PATH), "损坏文件被顺手清理");

// ③b 产物目录缺失 → 不可恢复，静默清理
writeFileSync(
  PENDING_PATH,
  JSON.stringify([
    {
      pdfPath: "C:/fake/__cdp_probe__.pdf",
      paperDir: "C:/fake/__nonexistent_dir__",
      title: "__CDP_PROBE__",
    },
  ]),
);
const s4 = await evalJS("window.__ps.getPaperConvertStatus()");
assert(s4?.pendingDones?.length === 0, "产物目录缺失返回空数组");
assert(!existsSync(PENDING_PATH), "滞留文件被顺手清理");

console.log(failed === 0 ? "\nPASS" : `\n${failed} 项失败`);
ws.close();
process.exit(failed === 0 ? 0 : 1);
