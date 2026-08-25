// P1 证据采集：高频采样两个实例的 sync-state.json
// 断言：① 每次采样都是合法 JSON（原子写——绝不出现半截文件）
//       ② last_pushed_seq 与各设备 last_pulled 水位单调不回退
// 用法：node scripts/sync-e2e/p1-state-watch.mjs [时长秒，默认 1800]
import fs from "node:fs";
import {
  A_DIR,
  B_DIR,
  EVIDENCE_DIR,
  ensureEvidenceDir,
  readSyncState,
  sleep,
} from "./lib/common.mjs";

const DURATION_S = Number(process.argv[2] ?? 1800);
ensureEvidenceDir();
const out = fs.createWriteStream(`${EVIDENCE_DIR}/p1-samples.jsonl`, { flags: "a" });

let prev = { A: null, B: null };
let samples = 0;
let invalidCount = 0;
let regressions = [];

function checkMonotonic(who, prevState, curState) {
  if (!prevState || !curState || curState.__invalid || prevState.__invalid) return;
  const prevPushed = prevState.last_pushed_seq ?? 0;
  const curPushed = curState.last_pushed_seq ?? 0;
  if (curPushed < prevPushed) {
    regressions.push({ who, field: "last_pushed_seq", prev: prevPushed, cur: curPushed, at: Date.now() });
  }
  const prevPulled = prevState.last_pulled ?? {};
  const curPulled = curState.last_pulled ?? {};
  for (const [dev, seq] of Object.entries(prevPulled)) {
    const cur = curPulled[dev] ?? 0;
    if (cur < seq) {
      regressions.push({ who, field: `last_pulled.${dev.slice(0, 8)}`, prev: seq, cur, at: Date.now() });
    }
  }
}

console.log(`P1 watch 启动：采样 ${DURATION_S}s，输出 ${EVIDENCE_DIR}/p1-samples.jsonl`);
const deadline = Date.now() + DURATION_S * 1000;
while (Date.now() < deadline) {
  for (const [who, dir] of [
    ["A", A_DIR],
    ["B", B_DIR],
  ]) {
    const st = readSyncState(dir);
    samples++;
    if (st?.__invalid) {
      invalidCount++;
      regressions.push({ who, field: "INVALID_JSON", raw: st.__invalid, at: Date.now() });
    }
    if (st) checkMonotonic(who, prev[who], st);
    prev[who] = st ?? prev[who];
    out.write(
      JSON.stringify({
        t: Date.now(),
        who,
        invalid: !!st?.__invalid,
        pushed: st?.last_pushed_seq ?? null,
        pulled: st?.last_pulled ?? null,
        transient: st?.failed_packs_transient ?? null,
        result: st?.last_l2_result ?? null,
      }) + "\n",
    );
  }
  await sleep(2000);
}
out.end();
const verdict = invalidCount === 0 && regressions.length === 0 ? "PASS" : "FAIL";
console.log(JSON.stringify({ verdict, samples, invalidCount, regressions }, null, 2));
fs.writeFileSync(
  `${EVIDENCE_DIR}/p1-verdict.json`,
  JSON.stringify({ verdict, samples, invalidCount, regressions }, null, 2),
);
