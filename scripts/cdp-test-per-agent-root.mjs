// E2E 冒烟：共享根 + 按助手覆盖（2026-08-05 拍板）
//   1) reader 覆盖根后：wrapToolsWithGuard(reader) 的 writeFile 相对路径落到覆盖根（rootOverride 注入生效）
//   2) central（无覆盖）writeFile 仍落默认共享根
//   3) 记忆随根走：reader 覆盖根写 memory.md → loadMemorySection("reader") 命中、("central") 为空
//   4) loadWorkspaceSection("reader") 显示覆盖根路径
//   5) 清理：删临时文件与覆盖配置
// 运行：node scripts/cdp-test-per-agent-root.mjs（需 dev 实例 CDP 9223）
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
  const wsCtx = await import(origin + "/src/ai/utils/workspace-context.ts");
  // 关键：vite HMR 后 store 被加上 ?t= 查询串，与裸 URL 是两个模块实例。
  // 从 tool-guard 的转换产物里提取应用实际使用的 store URL，保证读写同一实例。
  const guardSrc = await (await fetch(origin + "/src/ai/utils/tool-guard.ts")).text();
  const storeUrl = guardSrc.match(new RegExp('"(/src/store/agent-settings-store\\\\.ts[^"]*)"'))[1];
  const settingsStore = (await import(origin + storeUrl)).useAgentSettingsStore;
  const pathApi = await import(origin + "/@id/@tauri-apps/api/path");

  const execOpts = { toolCallId: "smoke", messages: [] };
  const readerRoot = ((await pathApi.tempDir()).replace(/[\\\\/]+$/, "")) + "/sageread-reader-ws";

  // reader 覆盖到临时目录
  settingsStore.getState().setPerAgentRoot("reader", readerRoot);

  // ---- 1. reader 界内写落覆盖根 ----
  const readerTools = guardMod.wrapToolsWithGuard(registry.getToolsForScope("reader", { bookId: "smoke" }), "reader");
  const w1 = await readerTools.writeFile.execute({ reasoning: "smoke", path: "notes/a.md", content: "reader 笔记\\n" }, execOpts);
  check("reader 覆盖根: 写入成功", w1?.results?.success === true, JSON.stringify(w1?.results).slice(0, 140));
  check("reader 覆盖根: 落点在覆盖根", (w1?.results?.path || "").replace(/\\\\/g, "/").includes("sageread-reader-ws"), w1?.results?.path || "");

  // ---- 2. central 无覆盖仍落默认共享根 ----
  const centralTools = guardMod.wrapToolsWithGuard(registry.getToolsForScope("central"), "central");
  const w2 = await centralTools.writeFile.execute({ reasoning: "smoke", path: "central-probe.txt", content: "c" }, execOpts);
  check("central 共享根: 落点在默认 agent-workspace", /agent-workspace/i.test(w2?.results?.path || ""), w2?.results?.path || "");

  // ---- 3. 记忆随根走 ----
  await readerTools.writeFile.execute({ reasoning: "smoke", path: "memory.md", content: "- reader 专属记忆：先读方法节\\n" }, execOpts);
  const memReader = await wsCtx.loadMemorySection("reader");
  const memCentral = await wsCtx.loadMemorySection("central");
  check("记忆随根: reader 命中专属记忆", memReader.includes("reader 专属记忆"), memReader.slice(0, 90));
  check("记忆随根: central 不受影响", memCentral === "" || !memCentral.includes("reader 专属记忆"), "");

  // ---- 4. reader 工作区段显示覆盖根 ----
  const sec = await wsCtx.loadWorkspaceSection("reader");
  check("workspaceSection(reader): 显示覆盖根", sec.replace(/\\\\/g, "/").includes("sageread-reader-ws"), sec.slice(0, 110));

  // ---- 5. 清理（用未包装的 runCommand，绕开确认卡挂起） ----
  const rawRun = registry.getToolsForScope("central").runCommand;
  await rawRun.execute({ reasoning: "cleanup", command: "rmdir /s /q \\\"" + readerRoot + "\\\"" }, execOpts);
  await rawRun.execute({ reasoning: "cleanup", command: "del /q central-probe.txt" }, execOpts);
  settingsStore.getState().setPerAgentRoot("reader", null);
  check("cleanup: 完成", true, "");

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
