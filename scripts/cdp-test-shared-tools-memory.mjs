// E2E 冒烟：写工具下放 reader/paper + memory.md 注入（2026-08-05）
//   1) reader/paper scope 均含 writeFile/editFile/searchFiles/readLocalFile/runCommand/exportNotes/askAppHelp
//   2) reader/paper 不含 httpRequest/downloadFile/extractZip（网络外发锁 central）
//   3) loadWorkspaceSection 恒含根路径与记忆指引；loadMemorySection 在无 memory.md 时为空串
//   4) writeFile 写 memory.md → loadMemorySection 返回含内容（行号已剥）→ 清理
// 运行：node scripts/cdp-test-shared-tools-memory.mjs（需 dev 实例 CDP 9223）
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
  const registry = await import(origin + "/src/ai/tools/registry.ts");
  const wsCtx = await import(origin + "/src/ai/utils/workspace-context.ts");

  const SHARED_NEW = ["writeFile", "editFile", "searchFiles", "readLocalFile", "runCommand", "exportNotes", "askAppHelp"];
  const CENTRAL_ONLY = ["httpRequest", "downloadFile", "extractZip"];

  // ---- 1/2. scope 归属 ----
  for (const scope of ["reader", "paper"]) {
    const t = registry.getToolsForScope(scope, { bookId: "smoke-book", paperId: "smoke-paper" });
    for (const name of SHARED_NEW) check(scope + ": 含 " + name, !!t[name], "");
    for (const name of CENTRAL_ONLY) check(scope + ": 不含 " + name, !t[name], "");
  }
  const central = registry.getToolsForScope("central");
  for (const name of [...SHARED_NEW, ...CENTRAL_ONLY]) check("central: 含 " + name, !!central[name], "");

  // ---- 3. 工作区段恒在（含根路径与记忆指引） ----
  const wsSection = await wsCtx.loadWorkspaceSection();
  check("workspaceSection: 含工作区根", /Agent 工作区根目录：/.test(wsSection) && /agent-workspace|\\\\/.test(wsSection), wsSection.slice(0, 90));
  check("workspaceSection: 含记忆指引", wsSection.includes("memory.md"), "");

  // ---- 4. memory.md 注入 ----
  const before = await wsCtx.loadMemorySection();
  check("memory: 无文件时为空串", before === "", "len=" + before.length);

  const execOpts = { toolCallId: "smoke", messages: [] };
  await central.writeFile.execute({
    reasoning: "smoke",
    path: "memory.md",
    content: "# 记忆\\n- 用户偏好：中文回答\\n- 引用格式：GB/T 7714\\n",
  }, execOpts);
  const after = await wsCtx.loadMemorySection();
  check("memory: 注入含内容", after.includes("用户偏好：中文回答"), after.slice(0, 100));
  check("memory: 行号已剥", !/^\\d+\\t/m.test(after), "");
  check("memory: 含更新指引", after.includes("writeFile/editFile"), "");
  await central.runCommand.execute({ reasoning: "cleanup", command: "del /q memory.md" }, execOpts);
  const cleaned = await wsCtx.loadMemorySection();
  check("memory: 清理后回落空串", cleaned === "", "");

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
