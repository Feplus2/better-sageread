// soak：A 给某对话加星 → 2 分钟内 B 的库出现该星标（功能管线没被改坏）
// 用法：node scripts/sync-e2e/soak-star.mjs
import { execFileSync } from "node:child_process";
import { A_CDP, cdp, saveEvidence, waitFor } from "./lib/common.mjs";

const c = await cdp(A_CDP);
// 取一个未加星的对话，加星
const picked = await c.ev(`import('/src/services/thread-service.ts').then(async m => {
  const all = await m.getAllThreads();
  const t = all.find(x => !x.starred) ?? all[0];
  if (!t) return 'NO_THREAD';
  const updated = await m.editThread(t.id, { starred: !t.starred });
  return JSON.stringify({ id: t.id, starred: updated.starred, title: t.title });
})`);
c.close();
if (picked === "NO_THREAD") throw new Error("A 上没有对话可星标");
const { id: threadId, starred, title } = JSON.parse(picked);
console.log(`A 已加星: ${threadId} starred=${starred} 「${title}」，等 B 出现…`);

const hit = await waitFor(
  () => {
    const out = execFileSync("python", ["scripts/sync-e2e/db.py", "star-check", "B", threadId], {
      cwd: "F:/MyProjects/SageRead",
      encoding: "utf8",
    }).trim();
    const row = JSON.parse(out);
    return row && row.starred === (starred ? 1 : 0) ? row : false;
  },
  120000,
  5000,
);
const evidence = {
  verdict: hit ? "PASS" : "FAIL",
  threadId,
  starred,
  title,
  bRow: hit || null,
  latencyNote: "上限 120s（30s/轮 × 推+拉各一轮 + 余量）",
};
console.log(JSON.stringify(evidence, null, 2));
saveEvidence("soak-star.json", evidence);
