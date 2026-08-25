// P2 证据：拉取尾部水位只推到指针清单实际处理到的 seq_end，不跳到 devices.json 被改大的 latest_seq
// 前置：A 实例已停（不再重写 devices.json）；B 实例在跑；B 此前已追平 A
// 步骤：① 记录 B 的 last_pulled[A] 与 A 指针清单最后 seq_end（应相等 = realSeq）
//       ② 把云端 devices.json 里 A 的 latest_seq 改为 realSeq + 50（模拟读视图不一致）
//       ③ 等 B 跑 1-2 轮 → 断言 B 的 last_pulled[A] 仍 == realSeq（未被改大值污染）
//       ④ 恢复 devices.json
// 用法：node scripts/sync-e2e/p2-inflate.mjs
import {
  B_DIR,
  readCloudJson,
  readSyncState,
  saveEvidence,
  sleep,
  waitFor,
  writeCloudJson,
} from "./lib/common.mjs";

const index = readCloudJson("devices.json");
const aId = Object.keys(index).find((id) => {
  const st = readSyncState(B_DIR);
  return id !== st?.device_id;
});
if (!aId) throw new Error("云端 devices.json 里找不到 A 设备");
const bState0 = readSyncState(B_DIR);
const bId = bState0.device_id;

const pointer = readCloudJson(`devices/${aId}.json`);
const realSeq = pointer.changesets.map((c) => c.seq_end).sort((a, b) => a - b).at(-1) ?? 0;
const pulled0 = bState0.last_pulled?.[aId] ?? 0;
console.log(`A=${aId.slice(0, 8)} B=${bId.slice(0, 8)} realSeq(指针清单末尾)=${realSeq} B.last_pulled[A]=${pulled0}`);

const backup = JSON.parse(JSON.stringify(index));
const INFLATED = realSeq + 50;
index[aId].latest_seq = INFLATED;
writeCloudJson("devices.json", index);
console.log(`已把 devices.json[A].latest_seq 改大为 ${INFLATED}，等 B 跑轮…`);

// 等 B 完成至少一轮（last_l2_sync_at 变化）
const t0 = bState0.last_l2_sync_at ?? 0;
const done = await waitFor(
  () => {
    const st = readSyncState(B_DIR);
    return st && (st.last_l2_sync_at ?? 0) > t0 ? st : false;
  },
  90000,
  3000,
);
// 再补等一轮，确保拉取循环确实执行过（第一轮可能是纯拉取登记）
await sleep(35000);
const st2 = readSyncState(B_DIR);

// 恢复一致
writeCloudJson("devices.json", backup);
console.log("devices.json 已恢复");

const pulledAfter = st2?.last_pulled?.[aId] ?? 0;
const verdict = done && pulledAfter === realSeq && pulledAfter !== INFLATED ? "PASS" : "FAIL";
const evidence = {
  verdict,
  aId,
  bId,
  realSeq,
  inflated: INFLATED,
  bLastPulledBefore: pulled0,
  bLastPulledAfter: pulledAfter,
  note: "P2: 尾部水位只准推到 reached（指针清单实际处理到的 seq_end），不得跳到 info.latest_seq",
};
console.log(JSON.stringify(evidence, null, 2));
saveEvidence("p2-inflate.json", evidence);
