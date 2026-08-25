// P3 证据：半截 gzip 包归入传输性失败——计 failed_packs_transient、不进内容性 3 次上限、不推水位；恢复后自愈
// 前置：A 已推送一个 B 尚未消费的包（A 实例已停，防干扰）；B 实例在跑
// 步骤：① 取 A 指针清单末尾 seq_end=targetSeq，确认 B.last_pulled[A] < targetSeq
//       ② 备份云端 changesets/<A>/<targetSeq>.jsonl → 截断成前半截（坏 gzip）
//       ③ 等 B 拉一轮 → 断言 B 日志「changeset 解压失败（疑似半截包）」+
//          sync-state failed_packs_transient 含 <A前8>/<targetSeq> 计 1 + failed_packs 不含 + last_pulled 不推进
//       ④ 恢复完整包 → 再等 → 断言应用成功、transient 清除、水位推进到 targetSeq
// 用法：node scripts/sync-e2e/p3-halfpack.mjs <abort|restore-free>
import fs from "node:fs";
import path from "node:path";
import {
  B_DIR,
  B_LOCAL,
  CLOUD_L2,
  findLogFile,
  readCloudJson,
  readSyncState,
  saveEvidence,
  tailLog,
  waitFor,
} from "./lib/common.mjs";

const bState0 = readSyncState(B_DIR);
const bId = bState0.device_id;
const index = readCloudJson("devices.json");
const aId = Object.keys(index).find((id) => id !== bId);
if (!aId) throw new Error("找不到 A 设备");
const pointer = readCloudJson(`devices/${aId}.json`);
const targetSeq = pointer.changesets.map((c) => c.seq_end).sort((a, b) => a - b).at(-1);
const pulled0 = bState0.last_pulled?.[aId] ?? 0;
if (!(pulled0 < targetSeq)) throw new Error(`B 已消费到 ${pulled0}，没有未消费包可截断（targetSeq=${targetSeq}）`);

const name = `${String(targetSeq).padStart(10, "0")}.jsonl`;
const packPath = path.join(CLOUD_L2, "changesets", aId, name);
const backupPath = `${packPath}.p3bak`;
if (!fs.existsSync(backupPath)) {
  fs.copyFileSync(packPath, backupPath);
  const full = fs.readFileSync(packPath);
  fs.writeFileSync(packPath, full.subarray(0, Math.floor(full.length / 2)));
  console.log(`已截断 ${name}（${full.length} → ${Math.floor(full.length / 2)} 字节），等 B 拉取…`);
} else {
  console.log(`检测到已截断的 ${name}（备份在 ${backupPath}），直接等 B 拉取…`);
}

const logFile = findLogFile(B_LOCAL);
const logMark = tailLog(logFile).offset;
const failKey = `${aId}/${targetSeq}`;

// 等 transient 计数出现（B 拉到坏包）
const hit = await waitFor(
  () => {
    const st = readSyncState(B_DIR);
    const n = st?.failed_packs_transient?.[failKey] ?? 0;
    return n >= 1 ? st : false;
  },
  100000,
  3000,
);
if (!hit) {
  fs.copyFileSync(backupPath, packPath);
  throw new Error("超时：B 的 failed_packs_transient 未计数");
}
const midLog = tailLog(logFile, logMark).text;
const logHit = midLog.includes("changeset 解压失败（疑似半截包）");
const stMid = hit;
const evidence = {
  aId,
  bId,
  targetSeq,
  failKey,
  phase1: {
    logHit,
    logLine: midLog.split("\n").find((l) => l.includes("疑似半截包"))?.trim() ?? null,
    transient: stMid.failed_packs_transient ?? {},
    contentFailed: stMid.failed_packs ?? {},
    lastPulled: stMid.last_pulled?.[aId] ?? 0,
    pulled0Unchanged: (stMid.last_pulled?.[aId] ?? 0) === pulled0,
  },
};
console.log("phase1（坏包）:", JSON.stringify(evidence.phase1, null, 2));

// 恢复完整包，等自愈
fs.copyFileSync(backupPath, packPath);
fs.rmSync(backupPath);
console.log("已恢复完整包，等 B 重拉…");
const healed = await waitFor(
  () => {
    const st = readSyncState(B_DIR);
    return (st?.last_pulled?.[aId] ?? 0) >= targetSeq ? st : false;
  },
  100000,
  3000,
);
evidence.phase2 = healed
  ? {
      lastPulled: healed.last_pulled?.[aId],
      transientCleared: !healed.failed_packs_transient?.[failKey],
      transient: healed.failed_packs_transient ?? {},
    }
  : { timeout: true };

const p1ok =
  evidence.phase1.logHit &&
  evidence.phase1.pulled0Unchanged &&
  (evidence.phase1.transient[failKey] ?? 0) >= 1 &&
  !(evidence.phase1.contentFailed ?? {})[failKey];
const p2ok = !!healed && evidence.phase2.transientCleared && evidence.phase2.lastPulled >= targetSeq;
evidence.verdict = p1ok && p2ok ? "PASS" : "FAIL";
console.log(JSON.stringify({ verdict: evidence.verdict, phase2: evidence.phase2 }, null, 2));
saveEvidence("p3-halfpack.json", evidence);
