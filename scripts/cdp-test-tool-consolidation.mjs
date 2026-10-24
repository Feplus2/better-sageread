// E2E 冒烟：Agent 工具合并（13 旧工具 → 5 个管理工具）+ 历史工具适配
// 流程：CDP(9223) + vite 模块注入 → 页面上下文：
//   1) registry：central 含 manageBook/manageSync/managePreferences/manageThreads/manageSkill，
//      且不含 13 个已下线的旧工具名
//   2) 无副作用动作直调冒烟（裸工具 execute，绕过 transport 守卫包装）：
//      manageThreads action=list（真实库）→ 返回对话摘要列表
//      manageSkill action=toggle 不传 skillName（只读列出技能）
//      写操作类动作（delete/restore 等）不在此冒烟
//   3) adaptToolHistoryForRequest：未知/已下线 part 与 tool-only 消息保留，
//      原 UI/DB 消息不变；await convertToModelMessages 不抛错且 output 不静默丢弃
// 运行：node scripts/cdp-test-tool-consolidation.mjs（需 dev 实例以 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 启动）
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
  // 强制 vite 重新转换（避开 HMR 前的缓存模块实例），确保拿到磁盘上的最新内容
  const bust = "?smoke=" + Date.now();
  const registry = await import(origin + "/src/ai/tools/registry.ts" + bust);
  const processor = await import(origin + "/src/ai/utils/message-processor.ts" + bust);
  const ai = await import(origin + "/@id/ai");

  const tools = registry.getToolsForScope("central");
  const execOpts = { toolCallId: "smoke", messages: [] };

  // ---- 1. 注册断言 ----
  for (const name of ["manageBook", "manageSync", "managePreferences", "manageThreads", "manageSkill"]) {
    check("registry: central 含 " + name, !!tools[name], "");
  }
  const retired = [
    "deleteBook", "openBook", "resetProgress",
    "backupNow", "backupRestore", "syncNow", "syncPreferences",
    "getThreads", "exportThreads",
    "setTheme", "readerPreferences", "uiPreferences", "toggleSkill",
  ];
  for (const name of retired) {
    check("registry: central 不含旧工具 " + name, !tools[name], "");
  }

  // ---- 2. 无副作用动作冒烟 ----
  const tl = await tools.manageThreads.execute({ reasoning: "smoke", action: "list", starredOnly: false }, execOpts);
  check(
    "manageThreads list: 返回对话列表",
    tl?.results?.success === true && Array.isArray(tl?.results?.threads) && typeof tl?.results?.total === "number",
    "total=" + tl?.results?.total,
  );

  const sk = await tools.manageSkill.execute({ reasoning: "smoke", action: "toggle" }, execOpts);
  check(
    "manageSkill toggle(无 skillName): 只读列出技能",
    sk?.results?.success === true && Array.isArray(sk?.results?.skills),
    "count=" + (sk?.results?.skills || []).length,
  );

  // ---- 3. 历史适配：未知/已下线工具不删除，tool-only assistant 也保留 ----
  const legacyMessages = [
    {
      id: "m1",
      role: "assistant",
      parts: [
        { type: "tool-deleteBook", toolCallId: "c1", state: "output-available", input: { bookId: "x" }, output: { retired: "deleteBook" } },
        { type: "text", text: "已删除" },
      ],
    },
    {
      id: "m2",
      role: "assistant",
      parts: [
        { type: "tool-backupNow", toolCallId: "c2", state: "output-available", input: {}, output: { retired: "backupNow" } },
      ],
    },
    {
      id: "m3",
      role: "assistant",
      parts: [
        { type: "tool-manageBook", toolCallId: "c3", state: "output-available", input: { action: "open", bookId: "y" }, output: {} },
      ],
    },
  ];
  const beforeAdapt = JSON.stringify(legacyMessages);
  const adapted = processor.adaptToolHistoryForRequest(legacyMessages, { directoryMode: false, tools });
  const m1 = adapted.find((m) => m.id === "m1");
  check("adapt: 未知 tool-deleteBook part 与文本都保留", m1 && m1.parts.length === 2 && m1.parts[0].output.retired === "deleteBook", JSON.stringify(m1?.parts?.map((p) => p.type)));
  check("adapt: tool-only 未知 assistant 不丢弃", adapted.some((m) => m.id === "m2" && m.parts[0].output.retired === "backupNow"), "remaining=" + adapted.map((m) => m.id).join(","));
  check("adapt: 在册工具 part 保留", adapted.some((m) => m.id === "m3" && m.parts.length === 1), "");
  check("adapt: 只改请求副本，UI/DB 原消息未变", JSON.stringify(legacyMessages) === beforeAdapt, "");

  let convertOk = true;
  let convertErr = "";
  let converted = [];
  try {
    converted = await ai.convertToModelMessages(adapted, { tools, ignoreIncompleteToolCalls: true });
  } catch (e) {
    convertOk = false;
    convertErr = String(e);
  }
  check("adapt 后 await convertToModelMessages 不抛错", convertOk, convertErr);
  const retiredResult = converted.flatMap((m) => m.role === "tool" ? m.content : []).find((p) => p.toolCallId === "c2");
  check("convert: 已下线工具 output 未静默丢弃", retiredResult?.output?.value?.retired === "backupNow", JSON.stringify(retiredResult || null));

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
  console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.info ? `  | ${c.info}` : ""}`);
  if (c.pass) pass++;
}
console.log(`\n${pass}/${checks.length} PASS`);
ws.close();
process.exit(pass === checks.length ? 0 : 1);
