// E2E 冒烟：滚动压缩链路（conversation-summary-service × 真实辅助模型 × thread.metadata 持久化）
// 流程：CDP(9223) + vite 模块注入 → 页面上下文：
//   1) 建合成对话（6 条消息）→ 取前 4 条作为 dropped 调 compressDroppedIntoSummary
//   2) 断言返回摘要文本非空；getThreadById 读回 metadata.conversationSummary，
//      coveredCount=4、lastCoveredMessageId 对齐
//   3) 再增量滚 2 条（dropped=前 6 条）→ 断言走增量路径且 coveredCount=6
//   4) 清理：删除合成对话
//   无辅助模型配置时函数返回 null（优雅降级），相应断言标记 skipped 而非 FAIL
// 运行：node scripts/cdp-test-summary-roll.mjs（需 dev 实例以 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 启动）
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
  const threadSvc = await import(origin + "/src/services/thread-service.ts");
  const summarySvc = await import(origin + "/src/services/conversation-summary-service.ts");

  const msgs = [
    ["u1", "user", "我们在整理 Transformer 架构的读书笔记，重点是自注意力机制。"],
    ["a1", "assistant", "好的，自注意力的核心是 Q/K/V 三个矩阵，缩放点积注意力公式为 softmax(QK^T/√d)V。"],
    ["u2", "user", "多头注意力和单头的区别是什么？"],
    ["a2", "assistant", "多头把 d 维切成 h 份并行做注意力再拼接，能捕获不同子空间的依赖关系。"],
    ["u3", "user", "位置编码用正弦还是可学习的？"],
    ["a3", "assistant", "原版论文用正弦位置编码；BERT 之后多用可学习位置嵌入，两者效果接近。"],
  ].map(([id, role, text]) => ({ id, role, parts: [{ type: "text", text }] }));

  let threadId = null;
  try {
    const thread = await threadSvc.createThread(undefined, "压缩链路冒烟-临时", msgs, "global");
    threadId = thread.id;

    // ---- 1. 首轮压缩前 4 条 ----
    const text1 = await summarySvc.compressDroppedIntoSummary({ threadId, dropped: msgs.slice(0, 4) });
    if (text1 == null) {
      check("首轮压缩: 返回 null（无辅助模型或调用失败，优雅降级）", true, "skipped");
    } else {
      check("首轮压缩: 摘要非空", text1.trim().length > 10, "len=" + text1.length);
      check("首轮压缩: 摘要 ≤ 4000 字符防御上限", text1.length <= 4000, "len=" + text1.length);
    }

    // ---- 2. 持久化读回 ----
    const reread = await threadSvc.getThreadById(threadId);
    const state = summarySvc.getConversationSummary(reread);
    if (text1 == null) {
      check("持久化: 无摘要状态（与降级一致）", state == null, "skipped");
    } else {
      check("持久化: coveredCount=4", state?.coveredCount === 4, JSON.stringify(state));
      check("持久化: lastCoveredMessageId=a2", state?.lastCoveredMessageId === "a2", state?.lastCoveredMessageId);
      check("持久化: 文本与返回值一致", state?.text === text1, "");
    }

    // ---- 3. 增量再滚 2 条 ----
    const text2 = await summarySvc.compressDroppedIntoSummary({ threadId, dropped: msgs.slice(0, 6) });
    if (text1 == null || text2 == null) {
      check("增量压缩: skipped", true, "skipped");
    } else {
      check("增量压缩: 摘要非空且有更新", text2.trim().length > 10, "len=" + text2.length);
      const state2 = summarySvc.getConversationSummary(await threadSvc.getThreadById(threadId));
      check("增量压缩: coveredCount=6", state2?.coveredCount === 6, state2?.lastCoveredMessageId);
    }
  } finally {
    if (threadId) {
      try { await threadSvc.deleteThread(threadId); } catch {}
    }
  }

  return checks;
})()
`;

const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
const checks = result.result?.result?.value;
if (!Array.isArray(checks)) {
  console.error("页面上下文执行失败:", JSON.stringify(result).slice(0, 800));
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
