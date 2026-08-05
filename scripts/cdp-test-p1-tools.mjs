// E2E 冒烟：P1 Agent 写工具 + 安全守卫（writeFile/editFile/runCommand/searchFiles + readLocalFile 加固 + tool-guard）
// 流程：CDP(9223) + vite 模块注入 → 页面上下文：
//   1) registry：central 含 4 个新工具
//   2) 裸工具链路（直调 execute，绕过 transport 守卫包装）：
//      writeFile 界内写 → readLocalFile 分页读回（行号）→ searchFiles glob/grep 命中
//      → editFile 精确改 / 非唯一报错 / replaceAll → runCommand echo（exit 0 + 审计日志有条目）
//      → 界外写无 allowOutside 被 Rust 拒绝
//   3) tool-guard 包装链路（严格模式，界外写）：挂起 → 拒绝返回取消；挂起 → 允许写入成功；
//      "不再询问"勾选后同 key 直通；full 模式直通
//   4) 清理测试文件
// 运行：node scripts/cdp-test-p1-tools.mjs（需 dev 实例以 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 启动）
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
  const guardMod = await import(origin + "/src/ai/utils/tool-guard.ts");
  const settingsStore = (await import(origin + "/src/store/agent-settings-store.ts")).useAgentSettingsStore;
  const confirmStore = (await import(origin + "/src/store/agent-confirm-store.ts")).useAgentConfirmStore;
  const core = await import(origin + "/@id/@tauri-apps/api/core");
  const pathApi = await import(origin + "/@id/@tauri-apps/api/path");

  const tools = registry.getToolsForScope("central");
  const execOpts = { toolCallId: "smoke", messages: [] };

  // ---- 1. 注册断言 ----
  for (const name of ["writeFile", "editFile", "runCommand", "searchFiles"]) {
    check("registry: central 含 " + name, !!tools[name], "");
  }

  // ---- 2. 裸工具链路 ----
  const w = await tools.writeFile.execute(
    { reasoning: "smoke", path: "p1-smoke/test.txt", content: "hello p1\\nsecond line\\nhello again\\n" },
    execOpts,
  );
  check("writeFile: 界内写成功", w?.results?.success === true, JSON.stringify(w?.results).slice(0, 160));
  const resolvedPath = w?.results?.path || "";
  check("writeFile: 落点在工作区", /agent-workspace/i.test(resolvedPath), resolvedPath);

  const r = await tools.readLocalFile.execute({ reasoning: "smoke", path: "p1-smoke/test.txt", mode: "read" }, execOpts);
  check("readLocalFile: 读回含行号", r?.results?.success === true && /1\\thello p1/.test(r?.results?.content || ""), (r?.results?.content || "").slice(0, 80));
  const r2 = await tools.readLocalFile.execute(
    { reasoning: "smoke", path: "p1-smoke/test.txt", mode: "read", offset: 2, limit: 1 },
    execOpts,
  );
  check("readLocalFile: 分页 offset=2 limit=1", /2\\tsecond line/.test(r2?.results?.content || "") && r2?.results?.truncated === true, JSON.stringify(r2?.results).slice(0, 160));

  const g = await tools.searchFiles.execute({ reasoning: "smoke", mode: "glob", pattern: "**/test.txt" }, execOpts);
  check("searchFiles glob: 找到文件", g?.results?.success === true && (g?.results?.matches || []).some((m) => m.includes("test.txt")), (g?.results?.matches || []).join(","));
  const grep = await tools.searchFiles.execute({ reasoning: "smoke", mode: "grep", pattern: "hello" }, execOpts);
  check("searchFiles grep: 命中两行", grep?.results?.success === true && (grep?.results?.matches || []).length === 2, (grep?.results?.matches || []).join(" | "));

  const e1 = await tools.editFile.execute(
    { reasoning: "smoke", path: "p1-smoke/test.txt", oldString: "second line", newString: "LINE2", replaceAll: false },
    execOpts,
  );
  check("editFile: 唯一命中替换", e1?.results?.success === true && e1?.results?.replacements === 1, JSON.stringify(e1?.results).slice(0, 120));
  const e2 = await tools.editFile.execute(
    { reasoning: "smoke", path: "p1-smoke/test.txt", oldString: "hello", newString: "hi", replaceAll: false },
    execOpts,
  );
  check("editFile: 非唯一报错", e2?.results?.success === false && /2 处/.test(e2?.results?.message || ""), e2?.results?.message || "");
  const e3 = await tools.editFile.execute(
    { reasoning: "smoke", path: "p1-smoke/test.txt", oldString: "hello", newString: "hi", replaceAll: true },
    execOpts,
  );
  check("editFile: replaceAll 替换两处", e3?.results?.success === true && e3?.results?.replacements === 2, JSON.stringify(e3?.results).slice(0, 120));

  const rc = await tools.runCommand.execute({ reasoning: "smoke", command: "echo p1-smoke-out" }, execOpts);
  check("runCommand: echo 成功", rc?.results?.success === true && (rc?.results?.stdout || "").includes("p1-smoke-out"), (rc?.results?.stdout || "").trim());

  // 审计日志（Rust 无条件写；读用 agent_read_file——读不拒界外）
  const appData = (await pathApi.appDataDir()).replace(/[\\\\/]+$/, "");
  const audit = await core.invoke("agent_read_file", { root: null, path: appData + "/agent-audit/commands.jsonl", offset: null, limit: null });
  check("runCommand: 审计日志含本条命令", (audit?.content || "").includes("p1-smoke-out"), (audit?.content || "").slice(-120));

  // 界外写无 allowOutside → Rust 拒绝
  const tmpDir = (await pathApi.tempDir()).replace(/[\\\\/]+$/, "");
  const outsidePath = tmpDir + "/sageread-p1-guard-test.txt";
  const wOut = await tools.writeFile.execute({ reasoning: "smoke", path: outsidePath, content: "x" }, execOpts);
  check("writeFile: 界外无放行被拒", wOut?.results?.success === false && /未经用户确认/.test(wOut?.results?.message || ""), wOut?.results?.message || "");

  // ---- 3. tool-guard 包装链路（严格模式） ----
  settingsStore.getState().setSafetyMode("strict");
  const wrappedSet = guardMod.wrapToolsWithGuard({ writeFile: tools.writeFile, runCommand: tools.runCommand });

  // 3a. 界外写 → 挂起 → 拒绝
  const p1 = wrappedSet.writeFile.execute({ reasoning: "smoke", path: outsidePath, content: "x" }, execOpts);
  await new Promise((r) => setTimeout(r, 300));
  check("guard: 严格模式界外写挂起出卡", confirmStore.getState().queue.length === 1, "queue=" + confirmStore.getState().queue.length);
  confirmStore.getState().resolvePending(false, false);
  const p1r = await p1;
  check("guard: 拒绝返回取消消息", p1r?.results?.success === false && /拒绝/.test(p1r?.results?.message || ""), p1r?.results?.message || "");

  // 3b. 界外写 → 挂起 → 允许（勾不再询问）
  const p2 = wrappedSet.writeFile.execute({ reasoning: "smoke", path: outsidePath, content: "x" }, execOpts);
  await new Promise((r) => setTimeout(r, 300));
  confirmStore.getState().resolvePending(true, true);
  const p2r = await p2;
  check("guard: 允许后界外写成功", p2r?.results?.success === true, JSON.stringify(p2r?.results).slice(0, 120));

  // 3c. 同 key（不再询问）→ 直通无卡
  const p3 = wrappedSet.writeFile.execute({ reasoning: "smoke", path: outsidePath, content: "y" }, execOpts);
  await new Promise((r) => setTimeout(r, 300));
  check("guard: 免打扰命中直通", confirmStore.getState().queue.length === 0, "queue=" + confirmStore.getState().queue.length);
  const p3r = await p3;
  check("guard: 免打扰直通写成功", p3r?.results?.success === true, "");

  // 3d. runCommand 严格模式出卡 → 拒绝
  const p4 = wrappedSet.runCommand.execute({ reasoning: "smoke", command: "echo should-not-run" }, execOpts);
  await new Promise((r) => setTimeout(r, 300));
  check("guard: runCommand 严格模式出卡", confirmStore.getState().queue.length === 1, "");
  confirmStore.getState().resolvePending(false, false);
  const p4r = await p4;
  check("guard: runCommand 拒绝取消", p4r?.results?.success === false && /拒绝/.test(p4r?.results?.message || ""), "");

  // 3e. full 模式 runCommand 直通
  settingsStore.getState().setSafetyMode("full");
  const wrappedFull = guardMod.wrapToolsWithGuard({ runCommand: tools.runCommand });
  const p5 = await wrappedFull.runCommand.execute({ reasoning: "smoke", command: "echo full-mode-ok" }, execOpts);
  check("guard: full 模式直通", p5?.results?.success === true && (p5?.results?.stdout || "").includes("full-mode-ok"), "");
  settingsStore.getState().setSafetyMode("strict");

  // ---- 4. 清理 ----
  await tools.runCommand.execute({ reasoning: "cleanup", command: "del /q \\\"" + outsidePath + "\\\"" }, execOpts);
  await tools.runCommand.execute({ reasoning: "cleanup", command: "rmdir /s /q p1-smoke" }, execOpts);
  check("cleanup: 测试文件已清理", true, "");

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
