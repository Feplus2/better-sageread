// E2E 冒烟：P1 Agent 写工具 + 安全守卫（writeFile/editFile/runCommand/searchFiles + readLocalFile 加固 + tool-guard）
// 流程：CDP(9223) + vite 模块注入 → 页面上下文：
//   1) registry：central 含 4 个新工具
//   2) 裸工具链路（直调 execute，绕过 transport 守卫包装）：
//      writeFile 界内写 → readLocalFile 分页读回（行号）→ searchFiles glob/grep 命中
//      → editFile 精确改 / 非唯一报错 / replaceAll → runCommand echo / 引号内联 / 非零错误 / CSV TOTAL=44
//      → 审计保留原始命令；界外写无 allowOutside 被 Rust 拒绝
//   3) tool-guard 包装链路（严格模式，界外写）：挂起 → 拒绝返回取消；挂起 → 允许写入成功；
//      "不再询问"勾选后同 key 直通；full 模式直通
//   4) 图片 canonical 守卫：strict 确认/拒绝与授权绑定，relaxed/full 的 .. 和真实 junction 端到端读取，
//      viewImages trim/dedup、混合批次逐路径授权、附件直通，imageRoots/grants 不进入模型 schema
//   5) 清理唯一测试路径，恢复原安全模式、工作区、per-agent roots 与会话确认状态
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

  const originalSafetyMode = settingsStore.getState().safetyMode;
  const originalWorkspaceRoot = settingsStore.getState().workspaceRoot;
  const originalQueue = confirmStore.getState().queue;
  const originalSessionAllowlist = new Set(confirmStore.getState().sessionAllowlist);
  if (originalQueue.length !== 0) throw new Error("确认队列非空，拒绝操作既有用户确认卡");

  const runId = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  const smokeDir = "p1-smoke-" + runId;
  const testPath = smokeDir + "/test.txt";
  const csvPath = smokeDir + "/data file.csv";
  const tmpDir = (await pathApi.tempDir()).replace(/[\\\\/]+$/, "");
  const outsidePath = await pathApi.join(tmpDir, "sageread-p1-guard-" + runId + ".txt");
  const appData = (await pathApi.appDataDir()).replace(/[\\\\/]+$/, "");
  const auditPath = appData + "/agent-audit/commands.jsonl";
  const readAudit = async () => {
    try {
      const head = await core.invoke("agent_read_file", {
        root: null, path: auditPath, offset: 1, limit: 1, allowOutside: true,
      });
      const totalLines = head?.totalLines || 0;
      if (totalLines <= 1) return head;
      return await core.invoke("agent_read_file", {
        root: null, path: auditPath, offset: Math.max(1, totalLines - 200), limit: null, allowOutside: true,
      });
    } catch {
      return { content: "", totalLines: 0 };
    }
  };
  const auditStart = await readAudit();
  const smokePre = await core.invoke("agent_resolve_path", { root: originalWorkspaceRoot, path: smokeDir });
  const outsidePre = await core.invoke("agent_resolve_path", { root: originalWorkspaceRoot, path: outsidePath });
  if (smokePre?.exists || outsidePre?.exists) throw new Error("唯一测试路径已存在，拒绝覆盖");

  const tools = registry.getToolsForScope("central");
  const execOpts = { toolCallId: "smoke-" + runId, messages: [] };

  try {
    // ---- 1. 注册断言 ----
    for (const name of ["writeFile", "editFile", "runCommand", "searchFiles"]) {
      check("registry: central 含 " + name, !!tools[name], "");
    }

    // ---- 2. 裸工具链路 ----
    const w = await tools.writeFile.execute(
      { reasoning: "smoke", path: testPath, content: "hello p1\\nsecond line\\nhello again\\n" },
      execOpts,
    );
    check("writeFile: 界内写成功", w?.results?.success === true, JSON.stringify(w?.results).slice(0, 160));
    const resolvedPath = w?.results?.path || "";
    check("writeFile: 落点在工作区", resolvedPath.includes(smokeDir), resolvedPath);

    const r = await tools.readLocalFile.execute({ reasoning: "smoke", path: testPath, mode: "read" }, execOpts);
    check("readLocalFile: 读回含行号", r?.results?.success === true && /1\\thello p1/.test(r?.results?.content || ""), (r?.results?.content || "").slice(0, 80));
    const r2 = await tools.readLocalFile.execute(
      { reasoning: "smoke", path: testPath, mode: "read", offset: 2, limit: 1 },
      execOpts,
    );
    check("readLocalFile: 分页 offset=2 limit=1", /2\\tsecond line/.test(r2?.results?.content || "") && r2?.results?.truncated === true, JSON.stringify(r2?.results).slice(0, 160));

    const g = await tools.searchFiles.execute({ reasoning: "smoke", mode: "glob", pattern: "**/test.txt", subdir: smokeDir }, execOpts);
    check("searchFiles glob: 找到文件", g?.results?.success === true && (g?.results?.matches || []).some((m) => m.includes("test.txt")), (g?.results?.matches || []).join(","));
    const grep = await tools.searchFiles.execute({ reasoning: "smoke", mode: "grep", pattern: "hello", subdir: smokeDir }, execOpts);
    check("searchFiles grep: 命中两行", grep?.results?.success === true && (grep?.results?.matches || []).length === 2, (grep?.results?.matches || []).join(" | "));

    const e1 = await tools.editFile.execute(
      { reasoning: "smoke", path: testPath, oldString: "second line", newString: "LINE2", replaceAll: false },
      execOpts,
    );
    check("editFile: 唯一命中替换", e1?.results?.success === true && e1?.results?.replacements === 1, JSON.stringify(e1?.results).slice(0, 120));
    const e2 = await tools.editFile.execute(
      { reasoning: "smoke", path: testPath, oldString: "hello", newString: "hi", replaceAll: false },
      execOpts,
    );
    check("editFile: 非唯一报错", e2?.results?.success === false && /2 处/.test(e2?.results?.message || ""), e2?.results?.message || "");
    const e3 = await tools.editFile.execute(
      { reasoning: "smoke", path: testPath, oldString: "hello", newString: "hi", replaceAll: true },
      execOpts,
    );
    check("editFile: replaceAll 替换两处", e3?.results?.success === true && e3?.results?.replacements === 2, JSON.stringify(e3?.results).slice(0, 120));

    const echoCommand = "echo p1-smoke-out";
    const rc = await tools.runCommand.execute({ reasoning: "smoke", command: echoCommand }, execOpts);
    check("runCommand: echo 成功", rc?.results?.success === true && (rc?.results?.stdout || "").includes("p1-smoke-out"), (rc?.results?.stdout || "").trim());

    const quotedCommand = "python -c \\"print(123)\\"";
    const quoted = await tools.runCommand.execute({ reasoning: "smoke", command: quotedCommand }, execOpts);
    check("runCommand: 引号内联命令 stdout=123", quoted?.results?.success === true && (quoted?.results?.stdout || "").trim() === "123", JSON.stringify(quoted?.results).slice(0, 240));

    const nonzeroCommand = "python -c \\"1/0\\"";
    const nonzero = await tools.runCommand.execute({ reasoning: "smoke", command: nonzeroCommand }, execOpts);
    check("runCommand: 非零退出与 stderr 不回空", nonzero?.results?.success === false && nonzero?.results?.exitCode === 1 && /ZeroDivisionError/.test(nonzero?.results?.stderr || ""), JSON.stringify(nonzero?.results).slice(0, 240));

    const csvWrite = await tools.writeFile.execute(
      { reasoning: "smoke", path: csvPath, content: "value\\n20\\n24\\n" },
      execOpts,
    );
    check("runCommand: CSV 夹具写入", csvWrite?.results?.success === true, JSON.stringify(csvWrite?.results).slice(0, 160));
    const csvCommand = "python -c \\"import csv; rows=csv.DictReader(open('" + csvPath + "', encoding='utf-8')); print('TOTAL=' + str(sum(int(row['value']) for row in rows)))\\"";
    const csv = await tools.runCommand.execute({ reasoning: "smoke", command: csvCommand }, execOpts);
    check("runCommand: CSV TOTAL=44", csv?.results?.success === true && (csv?.results?.stdout || "").trim() === "TOTAL=44", JSON.stringify(csv?.results).slice(0, 240));

    const audit = await readAudit();
    const auditEntries = (audit?.content || "").split(/\\r?\\n/).flatMap((line) => {
      const match = line.match(/^(\\d+)\\t(.*)$/);
      if (!match || Number(match[1]) <= (auditStart?.totalLines || 0)) return [];
      try {
        return [JSON.parse(match[2])];
      } catch {
        return [];
      }
    });
    check("runCommand: 审计日志含本条命令", auditEntries.some((entry) => entry.command === echoCommand), "newEntries=" + auditEntries.length);
    check("runCommand: 审计保留原始引号命令", auditEntries.some((entry) => entry.command === quotedCommand && String(entry.stdoutPreview || "").trim() === "123"), "newEntries=" + auditEntries.length);

    // 界外写无 allowOutside → Rust 拒绝
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
  } finally {
    // ---- 4. 只清理本测试唯一路径，并恢复所有运行态设置 ----
    try {
      const outsideCleanup = await tools.runCommand.execute({ reasoning: "cleanup", command: "del /q \\"" + outsidePath + "\\"" }, execOpts);
      const smokeCleanup = await tools.runCommand.execute({ reasoning: "cleanup", command: "rmdir /s /q " + smokeDir }, execOpts);
      const smokePost = await core.invoke("agent_resolve_path", { root: originalWorkspaceRoot, path: smokeDir });
      const outsidePost = await core.invoke("agent_resolve_path", { root: originalWorkspaceRoot, path: outsidePath });
      check(
        "cleanup: 自建测试文件已清理",
        outsideCleanup?.results?.success === true
          && outsideCleanup?.results?.exitCode === 0
          && smokeCleanup?.results?.success === true
          && smokeCleanup?.results?.exitCode === 0
          && !smokePost?.exists
          && !outsidePost?.exists,
        JSON.stringify({ outside: outsideCleanup?.results, smoke: smokeCleanup?.results, smokeExists: smokePost?.exists, outsideExists: outsidePost?.exists }).slice(0, 500),
      );
    } catch (error) {
      check("cleanup: 自建测试文件已清理", false, String(error));
    } finally {
      settingsStore.getState().setSafetyMode(originalSafetyMode);
      confirmStore.setState({ queue: originalQueue, sessionAllowlist: originalSessionAllowlist });
      await new Promise((resolve) => setTimeout(resolve, 750));
      const restoredAllowlist = confirmStore.getState().sessionAllowlist;
      const allowlistRestored = restoredAllowlist.size === originalSessionAllowlist.size
        && [...restoredAllowlist].every((key) => originalSessionAllowlist.has(key));
      check(
        "cleanup: 原安全模式与工作区已恢复",
        settingsStore.getState().safetyMode === originalSafetyMode && settingsStore.getState().workspaceRoot === originalWorkspaceRoot,
        originalSafetyMode + " | " + String(originalWorkspaceRoot),
      );
      check("cleanup: 会话确认状态已恢复", confirmStore.getState().queue === originalQueue && allowlistRestored, "");
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

const imageExpression = `
(async () => {
  const imageChecks = [];
  const check = (name, pass, info) => imageChecks.push({ name, pass: !!pass, info: info == null ? "" : String(info).slice(0, 500) });
  const origin = location.origin;
  const registry = await import(origin + "/src/ai/tools/registry.ts");
  const guardMod = await import(origin + "/src/ai/utils/tool-guard.ts");
  const settingsStore = (await import(origin + "/src/store/agent-settings-store.ts")).useAgentSettingsStore;
  const confirmStore = (await import(origin + "/src/store/agent-confirm-store.ts")).useAgentConfirmStore;
  const attachmentService = await import(origin + "/src/services/attachment-service.ts");
  const core = await import(origin + "/@id/@tauri-apps/api/core");
  const pathApi = await import(origin + "/@id/@tauri-apps/api/path");
  const fsApi = await import(origin + "/@id/@tauri-apps/plugin-fs");
  const tools = registry.getToolsForScope("central");

  const originalSafetyMode = settingsStore.getState().safetyMode;
  const originalWorkspaceRoot = settingsStore.getState().workspaceRoot;
  const originalPerAgentRoots = { ...settingsStore.getState().perAgentRoots };
  const originalQueue = confirmStore.getState().queue;
  const originalAllowlist = new Set(confirmStore.getState().sessionAllowlist);
  if (originalQueue.length !== 0) throw new Error("图片守卫测试：确认队列非空，拒绝操作既有确认卡");

  const runId = Date.now().toString(36) + "-img-" + Math.random().toString(36).slice(2, 10);
  const temp = (await pathApi.tempDir()).replace(/[\\\\/]+$/, "");
  const appData = (await pathApi.appDataDir()).replace(/[\\\\/]+$/, "");
  const sharedRoot = temp + "/sageread-task9-shared-" + runId;
  const agentRoot = temp + "/sageread-task9-agent-" + runId;
  const outsideA = temp + "/sageread-task9-outside-a-" + runId;
  const outsideB = temp + "/sageread-task9-outside-b-" + runId;
  const insideImage = sharedRoot + "/inside.png";
  const agentImage = agentRoot + "/agent.png";
  const sensitiveImage = sharedRoot + "/model-provider.json";
  const outsideImageA = outsideA + "/outside.png";
  const outsideAliasA = outsideA + "/nested/../outside.png";
  const outsideImageB = outsideB + "/outside.png";
  const junction = sharedRoot + "/junction";
  const junctionImage = junction + "/figure.png";
  const attachmentId = "task9-" + runId;
  const attachmentPath = appData + "/attachments/" + attachmentService.attachmentFilename(attachmentId, "image/png");
  const execOpts = { toolCallId: "task9-image-" + runId, messages: [] };
  const runCommand = (command) => core.invoke("agent_run_command", { root: null, command, timeoutSecs: 30 });
  const isContent = (result) => result?.type === "content";
  const pauseForCard = () => new Promise((resolve) => setTimeout(resolve, 300));
  let attachmentRef = "";
  let attachmentCreated = false;
  let junctionCreated = false;

  for (const path of [sharedRoot, agentRoot, outsideA, outsideB, attachmentPath]) {
    if (await fsApi.exists(path)) throw new Error("图片守卫唯一测试路径已存在，拒绝覆盖: " + path);
  }
  const canvas = document.createElement("canvas");
  canvas.width = 2;
  canvas.height = 2;
  const context = canvas.getContext("2d");
  context.fillStyle = "#5577cc";
  context.fillRect(0, 0, 2, 2);
  const dataUrl = canvas.toDataURL("image/png");
  const pngBytes = Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(",") + 1)), (char) => char.charCodeAt(0));

  try {
    for (const path of [sharedRoot, agentRoot, outsideA, outsideB]) await fsApi.mkdir(path, { recursive: true });
    await fsApi.mkdir(outsideA + "/nested", { recursive: true });
    for (const path of [insideImage, agentImage, sensitiveImage, outsideImageA, outsideImageB, outsideA + "/figure.png", outsideB + "/figure.png"]) {
      await fsApi.writeFile(path, pngBytes);
    }
    attachmentRef = await attachmentService.saveImageAttachment(attachmentId, dataUrl, "image/png");
    attachmentCreated = true;
    settingsStore.getState().setWorkspaceRoot(sharedRoot);
    settingsStore.getState().setPerAgentRoot("reader", agentRoot);

    const schemaKeys = (tool) => Object.keys(tool.inputSchema?.shape || {});
    check(
      "图片授权字段不进入模型 schema",
      [tools.readImage, tools.viewImages].every((tool) => {
        const keys = schemaKeys(tool);
        return !["allowOutside", "expectedPath", "expectedResolved", "imageRoots", "imageGrant", "imageGrants", "additionalRoots"].some((key) => keys.includes(key));
      }),
      schemaKeys(tools.readImage).join(",") + " | " + schemaKeys(tools.viewImages).join(","),
    );

    for (const mode of ["strict", "relaxed", "full"]) {
      settingsStore.getState().setSafetyMode(mode);
      const wrapped = guardMod.wrapToolsWithGuard({ readImage: tools.readImage }, "central");
      const result = await wrapped.readImage.execute({ path: insideImage }, execOpts);
      check("readImage 界内普通图 " + mode + " 可读且零确认", isContent(result) && confirmStore.getState().queue.length === 0, result.type || JSON.stringify(result).slice(0, 180));
    }

    settingsStore.getState().setSafetyMode("strict");
    const strictTools = guardMod.wrapToolsWithGuard({ readImage: tools.readImage, viewImages: tools.viewImages }, "central");
    const agentResult = await strictTools.readImage.execute({ path: agentImage }, execOpts);
    check("readImage 允许任一 per-agent root 且零确认", isContent(agentResult) && confirmStore.getState().queue.length === 0, agentResult.type || agentResult.value);

    const traversalPending = strictTools.readImage.execute({ path: outsideAliasA }, execOpts);
    await pauseForCard();
    check("strict .. 界外读只出一张确认卡", confirmStore.getState().queue.length === 1, "queue=" + confirmStore.getState().queue.length);
    if (confirmStore.getState().queue.length > 0) confirmStore.getState().resolvePending(false, false);
    const traversalResult = await traversalPending;
    check("strict .. 界外读拒绝后不执行读取", traversalResult?.meta?.cancelled === true && /拒绝/.test(traversalResult?.results?.message || ""), JSON.stringify(traversalResult).slice(0, 220));

    if (/^[A-Za-z]:[\\\\/]/.test(appData)) {
      const linked = await runCommand('mklink /J "' + junction + '" "' + outsideA + '"');
      junctionCreated = linked.exitCode === 0;
      check("P1 真实 Windows junction 夹具创建", junctionCreated, JSON.stringify(linked).slice(0, 240));
    } else {
      check("P1 真实 Windows junction（平台跳过）", true, "SKIP: 当前 AppData 不是 Windows 盘符路径；mklink /J 仅适用于 Windows");
    }
    if (junctionCreated) {
      const junctionPending = strictTools.readImage.execute({ path: junctionImage }, execOpts);
      await pauseForCard();
      check("strict junction 界外读出卡", confirmStore.getState().queue.length === 1, "queue=" + confirmStore.getState().queue.length);
      if (confirmStore.getState().queue.length > 0) confirmStore.getState().resolvePending(false, false);
      const junctionResult = await junctionPending;
      check("strict junction 拒绝后不读目标", junctionResult?.meta?.cancelled === true, JSON.stringify(junctionResult).slice(0, 220));
    }

    let capturedReadArgs = null;
    const capturingReadTool = {
      ...tools.readImage,
      execute: async (args, options) => {
        capturedReadArgs = args;
        return tools.readImage.execute(args, options);
      },
    };
    const capturingStrict = guardMod.wrapToolsWithGuard({ readImage: capturingReadTool }, "central");
    const approvedPending = capturingStrict.readImage.execute({ path: outsideImageA }, execOpts);
    await pauseForCard();
    check("strict 普通界外图片批准前出卡", confirmStore.getState().queue.length === 1, "queue=" + confirmStore.getState().queue.length);
    if (confirmStore.getState().queue.length > 0) confirmStore.getState().resolvePending(true, false);
    const approvedResult = await approvedPending;
    check("strict 批准后界外图片可读", isContent(approvedResult), approvedResult.type || JSON.stringify(approvedResult).slice(0, 220));
    check(
      "批准授权绑定原始 path 与 expectedResolved",
      capturedReadArgs?.imageGrant?.path === outsideImageA
        && capturedReadArgs?.imageGrant?.allowOutside === true
        && typeof capturedReadArgs?.imageGrant?.expectedResolved === "string"
        && capturedReadArgs.imageGrant.expectedResolved.length > 0,
      JSON.stringify(capturedReadArgs).slice(0, 400),
    );
    const reboundResult = await tools.readImage.execute({ ...capturedReadArgs, path: outsideAliasA }, execOpts);
    check(
      "同一授权换成不同原始 path 必须失败",
      reboundResult.type === "error-text" && String(reboundResult.value).includes("原始路径"),
      reboundResult.value || reboundResult.type,
    );

    if (junctionCreated) {
      const retargetBase = {
        ...tools.readImage,
        execute: async (args, options) => {
          const removed = await runCommand('rmdir "' + junction + '"');
          const recreated = await runCommand('mklink /J "' + junction + '" "' + outsideB + '"');
          check("确认后重定向 junction 夹具", removed.exitCode === 0 && recreated.exitCode === 0, JSON.stringify({ removed, recreated }).slice(0, 300));
          return tools.readImage.execute(args, options);
        },
      };
      const retargetWrapped = guardMod.wrapToolsWithGuard({ readImage: retargetBase }, "central");
      const retargetPending = retargetWrapped.readImage.execute({ path: junctionImage }, execOpts);
      await pauseForCard();
      check("junction 批准前等待确认", confirmStore.getState().queue.length === 1, "queue=" + confirmStore.getState().queue.length);
      if (confirmStore.getState().queue.length > 0) confirmStore.getState().resolvePending(true, false);
      const retargetResult = await retargetPending;
      check(
        "批准后 expectedResolved 变化必须拒绝",
        retargetResult.type === "error-text" && String(retargetResult.value).includes("规范化路径"),
        retargetResult.value || retargetResult.type,
      );
    }

    let capturedBatchArgs = null;
    let batchEntered = false;
    const capturingBatchTool = {
      ...tools.viewImages,
      execute: async (args, options) => {
        batchEntered = true;
        capturedBatchArgs = args;
        return tools.viewImages.execute(args, options);
      },
    };
    const batchWrapped = guardMod.wrapToolsWithGuard({ viewImages: capturingBatchTool }, "central");
    const batchPending = batchWrapped.viewImages.execute({ paths: [insideImage, outsideImageA, outsideImageB], refs: [attachmentRef] }, execOpts);
    await pauseForCard();
    const batchCard = confirmStore.getState().queue[0];
    check(
      "viewImages 混合路径聚合一次确认且确认前未读取",
      confirmStore.getState().queue.length === 1 && !batchEntered && batchCard?.detail.includes(outsideImageA) && batchCard?.detail.includes(outsideImageB),
      "queue=" + confirmStore.getState().queue.length + ", entered=" + batchEntered + ", detail=" + (batchCard?.detail || ""),
    );
    if (confirmStore.getState().queue.length > 0) confirmStore.getState().resolvePending(true, false);
    const batchResult = await batchPending;
    const batchFiles = isContent(batchResult) ? batchResult.value.filter((part) => part.type === "file") : [];
    check("viewImages 批准后本地两界外一界内与附件均返回", batchFiles.length === 4, "files=" + batchFiles.length + ", type=" + batchResult.type);
    const batchGrants = capturedBatchArgs?.imageGrants || [];
    check(
      "viewImages 授权逐原始路径且无整批 allowOutside",
      capturedBatchArgs?.allowOutside === undefined
        && batchGrants.length === 3
        && batchGrants.every((grant) => typeof grant.expectedResolved === "string" && grant.expectedResolved.length > 0)
        && batchGrants.find((grant) => grant.path === insideImage)?.allowOutside === false
        && batchGrants.find((grant) => grant.path === outsideImageA)?.allowOutside === true
        && batchGrants.find((grant) => grant.path === outsideImageB)?.allowOutside === true
        && !batchGrants.some((grant) => grant.path === attachmentRef),
      JSON.stringify(capturedBatchArgs).slice(0, 500),
    );

    const attachmentResult = await strictTools.viewImages.execute({ refs: [attachmentRef] }, execOpts);
    const attachmentFiles = isContent(attachmentResult) ? attachmentResult.value.filter((part) => part.type === "file") : [];
    check(
      "纯附件 viewImages 零本地判界零确认且保留附件读取",
      confirmStore.getState().queue.length === 0 && attachmentFiles.length === 1 && String(attachmentFiles[0].url).startsWith("data:image/png"),
      "queue=" + confirmStore.getState().queue.length + ", files=" + attachmentFiles.length,
    );

    const normalizedBatch = await strictTools.viewImages.execute({ paths: ["  " + insideImage + "  ", insideImage] }, execOpts);
    const normalizedFiles = isContent(normalizedBatch) ? normalizedBatch.value.filter((part) => part.type === "file") : [];
    check(
      "viewImages 与守卫共用 trim/dedup 后只读取一张图",
      confirmStore.getState().queue.length === 0 && normalizedFiles.length === 1,
      "queue=" + confirmStore.getState().queue.length + ", files=" + normalizedFiles.length + ", type=" + normalizedBatch.type,
    );

    for (const mode of ["relaxed", "full"]) {
      settingsStore.getState().setSafetyMode(mode);
      const wrapped = guardMod.wrapToolsWithGuard({ readImage: tools.readImage }, "central");
      const result = await wrapped.readImage.execute({ path: outsideImageA }, execOpts);
      check("readImage 界外读 " + mode + " 按既有语义免确认放行", isContent(result) && confirmStore.getState().queue.length === 0, result.type || JSON.stringify(result).slice(0, 220));
      const traversal = await wrapped.readImage.execute({ path: outsideAliasA }, execOpts);
      check(
        "wrapped readImage .. 界外读 " + mode + " 免确认且真实返回图片",
        isContent(traversal) && confirmStore.getState().queue.length === 0,
        traversal.type || JSON.stringify(traversal).slice(0, 220),
      );
      if (junctionCreated) {
        const junctionResult = await wrapped.readImage.execute({ path: junctionImage }, execOpts);
        check(
          "wrapped readImage 真实 junction " + mode + " 免确认且真实返回图片",
          isContent(junctionResult) && confirmStore.getState().queue.length === 0,
          junctionResult.type || JSON.stringify(junctionResult).slice(0, 220),
        );
      }
    }

    for (const mode of ["strict", "relaxed", "full"]) {
      settingsStore.getState().setSafetyMode(mode);
      const wrapped = guardMod.wrapToolsWithGuard({ readImage: tools.readImage }, "central");
      const result = await wrapped.readImage.execute({ path: sensitiveImage }, execOpts);
      check(
        "敏感文件名伪 PNG 在 " + mode + " 仍拒绝",
        result.type === "error-text" && String(result.value).includes("凭据") && confirmStore.getState().queue.length === 0,
        result.value || result.type,
      );
    }
  } finally {
    if (junctionCreated) await runCommand('rmdir "' + junction + '"').catch(() => {});
    for (const path of [sharedRoot, agentRoot, outsideA, outsideB]) await fsApi.remove(path, { recursive: true }).catch(() => {});
    if (attachmentCreated) await fsApi.remove(attachmentPath).catch(() => {});
    settingsStore.getState().setSafetyMode(originalSafetyMode);
    settingsStore.getState().setWorkspaceRoot(originalWorkspaceRoot);
    settingsStore.getState().setPerAgentRoot("reader", originalPerAgentRoots.reader || null);
    confirmStore.setState({ queue: originalQueue, sessionAllowlist: originalAllowlist });
  }

  const remaining = [];
  for (const path of [sharedRoot, agentRoot, outsideA, outsideB, attachmentPath]) {
    if (await fsApi.exists(path)) remaining.push(path);
  }
  check("P1 图片测试仅清理唯一自建数据", remaining.length === 0, remaining.join(" | "));
  const restoredRoots = settingsStore.getState().perAgentRoots;
  const rootsRestored = restoredRoots.reader === originalPerAgentRoots.reader
    && Object.keys(restoredRoots).length === Object.keys(originalPerAgentRoots).length;
  check(
    "P1 图片测试恢复安全模式/共享根/per-agent 根",
    settingsStore.getState().safetyMode === originalSafetyMode
      && settingsStore.getState().workspaceRoot === originalWorkspaceRoot
      && rootsRestored,
    originalSafetyMode + " | " + String(originalWorkspaceRoot) + " | " + JSON.stringify(originalPerAgentRoots),
  );
  const allowlist = confirmStore.getState().sessionAllowlist;
  check(
    "P1 图片测试恢复确认队列与 allowlist",
    confirmStore.getState().queue === originalQueue
      && allowlist.size === originalAllowlist.size
      && [...allowlist].every((key) => originalAllowlist.has(key)),
    "queue=" + confirmStore.getState().queue.length + ", allowlist=" + allowlist.size,
  );
  return imageChecks;
})()
`;

const imageResult = await cdp("Runtime.evaluate", { expression: imageExpression, awaitPromise: true, returnByValue: true });
const imageChecks = imageResult.result?.result?.value;
if (!Array.isArray(imageChecks)) {
  console.error("图片守卫页面上下文执行失败:", JSON.stringify(imageResult).slice(0, 1200));
  process.exit(1);
}
checks.push(...imageChecks);

let pass = 0;
for (const c of checks) {
  console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.info ? "  | " + c.info : ""}`);
  if (c.pass) pass++;
}
console.log(`\n${pass}/${checks.length} PASS`);
ws.close();
process.exit(pass === checks.length ? 0 : 1);
