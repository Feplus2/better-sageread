// E2E 冒烟：P3 上下文拓宽窗口（token 预算选择 + 滚动压缩的纯函数部分）
// 页面上下文 import token-estimator / message-selector：
//   1) estimateTokens：空串为 0、CJK ≈1 token/字、ASCII ≈1 token/4 字符、随长度单调
//   2) selectMessagesWithinBudget：小体量全保留（dropped 为空）
//   3) 超 256k 预算长对话：kept ≥ 40 条、dropped 非空、首条为 user、角色交替合法、kept+dropped=总数
//   4) 预算极小 override：floor 保底生效（kept 恰好 40 条）
// 运行：node scripts/cdp-test-context-window.mjs（需 dev 实例以 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 启动）
const LIST_URL = "http://127.0.0.1:9223/json/list";

const pages = await (await fetch(LIST_URL)).json();
const page = pages.find((p) => p.type === "page" && p.url?.includes("localhost:1420"));
if (!page) throw new Error("找不到 SageRead 页面（9223 CDP 未连接或未以调试端口启动）");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let mid = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
function cdp(method, params = {}) {
  const id = ++mid;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve) => pending.set(id, resolve));
}

const expression = `
(async () => {
  const checks = [];
  const check = (name, pass, info) => checks.push({ name, pass: !!pass, info: info == null ? "" : String(info) });
  const origin = location.origin;
  const estimator = await import(origin + "/src/ai/utils/token-estimator.ts");
  const selector = await import(origin + "/src/ai/utils/message-selector.ts");

  const makeMessages = (count, textLen) =>
    Array.from({ length: count }, (_, i) => ({
      id: "m" + i,
      role: i % 2 === 0 ? "user" : "assistant",
      parts: [{ type: "text", text: "字".repeat(textLen) + i }],
    }));

  // ---- 1. estimateTokens ----
  check("estimateTokens: 空串为 0", estimator.estimateTokens("") === 0, "");
  check("estimateTokens: 2 个 CJK 字 ≈ 2 tokens", estimator.estimateTokens("你好") === 2, "");
  check("estimateTokens: 8 个 ASCII ≈ 2 tokens", estimator.estimateTokens("abcdefgh") === 2, "");
  check(
    "estimateTokens: 随长度单调",
    estimator.estimateTokens("字".repeat(100)) > estimator.estimateTokens("字".repeat(10)),
    "",
  );

  // ---- 2. 小体量全保留 ----
  const small = makeMessages(6, 20);
  const smallSel = selector.selectMessagesWithinBudget(small);
  check("小体量: kept 全保留", smallSel.kept.length === 6, "kept=" + smallSel.kept.length);
  check("小体量: dropped 为空", smallSel.dropped.length === 0, "");

  // ---- 3. 超 256k 预算 ----
  // 60 条 × (6000 CJK + 8 开销) ≈ 360k tokens > 256k 预算
  const big = makeMessages(60, 6000);
  const bigSel = selector.selectMessagesWithinBudget(big);
  check("超预算: kept ≥ 40 条保底", bigSel.kept.length >= 40, "kept=" + bigSel.kept.length);
  check("超预算: dropped 非空", bigSel.dropped.length > 0, "dropped=" + bigSel.dropped.length);
  check(
    "超预算: kept+dropped = 总数",
    bigSel.kept.length + bigSel.dropped.length === big.length,
    bigSel.kept.length + "+" + bigSel.dropped.length,
  );
  check("超预算: kept 首条为 user", bigSel.kept[0]?.role === "user", bigSel.kept[0]?.role);
  const alternates = bigSel.kept.every((m, i) => (i % 2 === 0 ? m.role === "user" : m.role === "assistant"));
  check("超预算: kept 角色交替合法", alternates, "");
  const droppedTailId = bigSel.dropped[bigSel.dropped.length - 1]?.id;
  const keptHeadId = bigSel.kept[0]?.id;
  check(
    "超预算: dropped 尾部与 kept 头部相接",
    Number(droppedTailId?.slice(1)) + 1 === Number(keptHeadId?.slice(1)),
    droppedTailId + "→" + keptHeadId,
  );

  // ---- 4. 极小预算 override：floor 保底 ----
  const floorSel = selector.selectMessagesWithinBudget(makeMessages(60, 50), { budget: 100, floor: 40 });
  check("floor: kept 恰好 40 条", floorSel.kept.length === 40, "kept=" + floorSel.kept.length);
  check("floor: dropped 20 条", floorSel.dropped.length === 20, "dropped=" + floorSel.dropped.length);

  return checks;
})()
`;

const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
const checks = result.result?.result?.value;
if (!Array.isArray(checks)) {
  console.error("页面上下文执行失败:", JSON.stringify(result).slice(0, 500));
  process.exit(1);
}

let pass = 0;
for (const c of checks) {
  console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.info ? "  | " + c.info : ""}`);
  if (c.pass) pass++;
}
console.log(`\n${pass}/${checks.length} PASS`);
ws.close();
process.exit(pass === checks.length ? 0 : 1);
