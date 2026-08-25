// P0 证据：修剪远端 changesets 时任一设备指针读失败 → 本轮放弃修剪（fail-closed）
// 前置：A、B 均在跑。脚本先等 B 追平 A（稳态：A 云端恰好 5 包，候选=0）
// 步骤：① 快照 changesets/<A>/ + 备份 B 指针 ② 写坏 devices/<B>.json
//       ③ CDP 让 A 拨动星标制造本地变更并 syncRunNow（推送成功 → 进入修剪）
//       ④ 断言：A 云端 6 包全在（含反事实"若修剪必删"的旧包）+ A 日志「本轮放弃修剪」
//       ⑤ 恢复 B 指针
// 用法：node scripts/sync-e2e/p0-prune.mjs
import fs from "node:fs";
import path from "node:path";
import {
  A_CDP,
  A_DIR,
  A_LOCAL,
  B_DIR,
  CLOUD_L2,
  cdp,
  findLogFile,
  listCloudFiles,
  readCloudJson,
  readSyncState,
  saveEvidence,
  sleep,
  tailLog,
  waitFor,
} from "./lib/common.mjs";

const aId = readSyncState(A_DIR).device_id;
const bId = readSyncState(B_DIR).device_id;
console.log(`A=${aId.slice(0, 8)} B=${bId.slice(0, 8)}`);

// ① 等 B 追平 A
const caughtUp = await waitFor(
  () => {
    const idx = readCloudJson("devices.json");
    const bst = readSyncState(B_DIR);
    return (bst?.last_pulled?.[aId] ?? 0) >= (idx?.[aId]?.latest_seq ?? Infinity) ? bst : false;
  },
  90000,
  3000,
);
if (!caughtUp) throw new Error("B 90s 内未追平 A，放弃构造");
const minPulled = caughtUp.last_pulled[aId];
const before = listCloudFiles(`changesets/${aId}`);
console.log(`已追平：minPulled=${minPulled}，A 云端包=${before.length} [${before.join(",")}]`);

const bPointerPath = path.join(CLOUD_L2, "devices", `${bId}.json`);
const bPointerRaw = fs.readFileSync(bPointerPath, "utf8");
const logFile = findLogFile(A_LOCAL);
const logMark = tailLog(logFile).offset;

// ② 写坏 B 指针
fs.writeFileSync(bPointerPath, "{ corrupted json !!!");
console.log("已写坏 B 指针文件");

// ③ A 制造本地变更并同步（推送 → 修剪）
let runResult;
try {
  const c = await cdp(A_CDP);
  await c.ev(`import('/src/services/thread-service.ts').then(async m => {
    const t = (await m.getAllThreads())[0];
    if (t) await m.editThread(t.id, { starred: !t.starred });
    return 'ok';
  })`);
  runResult = await c.ev(
    `import('/src/services/sync-service.ts').then(m => m.syncRunNow().then(r => JSON.stringify(r)).catch(e => 'ERR:' + String(e)))`,
  );
  c.close();
} catch (e) {
  runResult = `CDP-FAIL: ${e}`;
}
console.log("syncRunNow:", String(runResult).slice(0, 300));
await sleep(4000);

// ④ 断言
const after = listCloudFiles(`changesets/${aId}`);
const deleted = before.filter((f) => !after.includes(f));
const ownPointer = readCloudJson(`devices/${aId}.json`);
const seqEnds = ownPointer.changesets.map((c) => c.seq_end).sort((a, b) => a - b);
const newest5 = new Set(seqEnds.slice(-5));
const wouldDelete = seqEnds.filter((s) => s < minPulled && !newest5.has(s));
const newLog = tailLog(logFile, logMark).text;
const abortLine = newLog.split("\n").find((l) => l.includes("本轮放弃修剪"))?.trim() ?? null;

// ⑤ 恢复 B 指针
fs.writeFileSync(bPointerPath, bPointerRaw);
console.log("已恢复 B 指针文件");

const evidence = {
  verdict: deleted.length === 0 && !!abortLine && wouldDelete.length > 0 ? "PASS" : "FAIL",
  minPulled,
  packsBefore: before,
  packsAfter: after,
  deletedFiles: deleted,
  wouldDeleteIfPruneRan: wouldDelete,
  abortLogLine: abortLine,
  pruneWarnLine: newLog.split("\n").find((l) => l.includes("云端修剪失败"))?.trim() ?? null,
  syncRunResult: String(runResult).slice(0, 300),
  note: "反事实：wouldDeleteIfPruneRan 非空说明若修剪真跑必有包被删；坏指针下全量保留+放弃日志 = fail-closed 成立",
};
console.log(JSON.stringify(evidence, null, 2));
saveEvidence("p0-prune.json", evidence);
