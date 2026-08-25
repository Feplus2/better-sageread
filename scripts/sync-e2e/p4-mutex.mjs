// P4 证据：L2 互斥锁——一轮同步进行中再触发手动同步，后者必须被「L2 同步已在进行中，本轮跳过」拒绝
// 手法：CDP 连到实例，并发发起 8 个 syncRunNow()；期望恰好 1 个真跑、其余被守卫拒绝
// 用法：node scripts/sync-e2e/p4-mutex.mjs [9224|9225]
import { B_CDP, cdp, saveEvidence } from "./lib/common.mjs";

const port = Number(process.argv[2] ?? B_CDP);
const c = await cdp(port);

// 并发 8 发：allSettled 收集每发结果（拒绝 = 互斥守卫生效）
const result = await c.ev(`import('/src/services/sync-service.ts').then(async m => {
  const settled = await Promise.allSettled([
    m.syncRunNow(), m.syncRunNow(), m.syncRunNow(), m.syncRunNow(),
    m.syncRunNow(), m.syncRunNow(), m.syncRunNow(), m.syncRunNow(),
  ]);
  return JSON.stringify(settled.map(s => s.status === 'fulfilled' ? { ok: s.value.message } : { rejected: String(s.reason) }));
})`);
c.close();

let parsed = null;
try {
  parsed = JSON.parse(result);
} catch {
  parsed = { raw: result };
}
const rejected =
  Array.isArray(parsed) ? parsed.filter((r) => r.rejected?.includes("L2 同步已在进行中")) : [];
const fulfilled = Array.isArray(parsed) ? parsed.filter((r) => r.ok !== undefined) : [];
const verdict = rejected.length >= 1 && fulfilled.length >= 1 ? "PASS" : "FAIL";
const evidence = { port, verdict, fulfilled: fulfilled.length, rejectedByGuard: rejected.length, settled: parsed };
console.log(JSON.stringify(evidence, null, 2));
saveEvidence("p4-mutex.json", evidence);
