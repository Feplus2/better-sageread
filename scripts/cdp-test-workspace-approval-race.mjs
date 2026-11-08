// 确认等待期间更换 junction 目标：批准 A 后不得读取 B，必须重新确认。
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cdpPort = process.env.CDP_PORT ?? "9224";
const appPort = process.env.APP_PORT ?? "1421";
const toolGuardSource = await (await fetch(`http://127.0.0.1:${appPort}/src/ai/utils/tool-guard.ts`)).text();
const confirmationModule = toolGuardSource
  .split("\n")
  .find((line) => line.includes("agent-confirm-store"))
  ?.match(/["']([^"']+)["']/)?.[1];
if (!confirmationModule) throw new Error("无法匹配应用实际使用的确认 store 模块");
const outDir = process.env.VERIFY_OUT ?? ".superpowers/sdd/agent-followup-backlog-2026-10-25/review-fixes";
mkdirSync(outDir, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "approval-race-root-"));
const outsideA = mkdtempSync(join(tmpdir(), "approval-race-a-"));
const outsideB = mkdtempSync(join(tmpdir(), "approval-race-b-"));
writeFileSync(join(outsideA, "value.txt"), "A");
writeFileSync(join(outsideB, "value.txt"), "B");
const link = join(root, "linked");
symlinkSync(outsideA, link, "junction");

const pages = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
const page = pages.find((p) => p.type === "page" && p.url?.includes(`localhost:${appPort}`));
if (!page) throw new Error(`找不到 SageRead 页面（${cdpPort}/${appPort}）`);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let seq = 0;
const pending = new Map();
const exceptions = [];
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
  if (msg.method === "Runtime.exceptionThrown") exceptions.push(msg.params.exceptionDetails);
};
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP 超时: ${method}`));
    }, 30000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      pending.delete(id);
      if (msg.error) reject(new Error(`${method}: ${JSON.stringify(msg.error)}`));
      else resolve(msg);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
await call("Runtime.enable");
const evalJs = async (expression, phase = "") => {
  if (phase) console.log("STAGE", phase);
  const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.result?.exceptionDetails)
    throw new Error(result.result.exceptionDetails.exception?.description ?? result.result.exceptionDetails.text);
  return result.result?.result?.value;
};
const previewDataDir = await evalJs(`(async () => {
  const pathApi = await import("/@id/@tauri-apps/api/path");
  return pathApi.appDataDir();
})()`);
if (!previewDataDir.includes("com.bettersageread.preview") && process.env.ALLOW_DAILY !== "1") {
  throw new Error(`拒绝在非隔离数据目录运行授权竞态探针：${previewDataDir}`);
}
await evalJs(`(async () => {
  const agent = (await import("/src/store/agent-settings-store.ts")).useAgentSettingsStore;
  const files = (await import("/src/store/file-workspace-store.ts")).useFileWorkspaceStore;
  for (let i = 0; i < 100 && (!agent.persist.hasHydrated() || !files.persist.hasHydrated()); i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!agent.persist.hasHydrated() || !files.persist.hasHydrated()) throw new Error("工作区设置水合超时");
})()`);
const checks = [];
const check = (name, pass, detail = "") => {
  checks.push({ name, pass: !!pass, detail });
  console.log("CHECK", name, pass);
};
try {
  await evalJs(
    `(() => {
    window.__approvalRaceStage = "开始准备";
    window.__approvalRaceSetupError = null;
    window.__approvalRaceSetup = (async () => {
      window.__approvalRaceStage = "加载应用设置";
      const agentModule = await import("/src/store/agent-settings-store.ts");
      window.__approvalRaceStage = "加载文件工作区";
      const files = await import("/src/store/file-workspace-store.ts");
      window.__approvalRaceStage = "加载确认队列";
      const confirmations = await import(${JSON.stringify(confirmationModule)});
      const agent = agentModule.useAgentSettingsStore.getState();
      window.__approvalRacePrevious = {
        root: agent.workspaceRoot,
        safetyMode: agent.safetyMode,
        hosts: files.useFileWorkspaceStore.getState().hosts,
        recentRoots: files.useFileWorkspaceStore.getState().recentRoots,
        queue: confirmations.useAgentConfirmStore.getState().queue,
        sessionAllowlist: confirmations.useAgentConfirmStore.getState().sessionAllowlist,
        previewGrants: confirmations.useAgentConfirmStore.getState().previewGrants,
        historyOpen: (() => {
  const panel = document.querySelector('[data-panel-viewport] [data-region="assistant-history-panel"]');
  return !!panel && !panel.closest("[inert]") && panel.getBoundingClientRect().width > 0;
})(),
      };
      window.__approvalRaceStage = "设置严格模式";
      agent.setWorkspaceRoot(${JSON.stringify(root)});
      agent.setSafetyMode("strict");
      files.useFileWorkspaceStore.setState({ hosts: {}, recentRoots: {} });
      window.__approvalRaceStage = "切换全局助手";
      (await import("/src/store/layout-store.ts")).useLayoutStore.getState().navigateToHome();
      location.hash = "#/chat";
      await new Promise((resolve) => setTimeout(resolve, 300));
      document.querySelector('[aria-label="收起文件工作区，返回对话"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 200));
      const historyOpen = (() => {
  const panel = document.querySelector('[data-panel-viewport] [data-region="assistant-history-panel"]');
  return !!panel && !panel.closest("[inert]") && panel.getBoundingClientRect().width > 0;
})();
      if (!historyOpen) document.querySelector('[data-panel-viewport] button:has(svg.lucide-history)')?.click();
      window.__approvalRaceStage = "等待历史面板";
      await new Promise((resolve) => setTimeout(resolve, 250));
      window.__approvalRaceAbort = new AbortController();
      window.__approvalRaceStage = "加载文件服务";
      const service = await import("/src/services/agent-workspace-files.ts");
      window.__approvalRaceStage = "文件服务已加载，发起读取";
      window.__approvalRaceResult = service.readWorkspaceChunk("central", ${JSON.stringify(join(link, "value.txt"))}, 0, 64, { abortSignal: window.__approvalRaceAbort.signal })
        .then((value) => ({ value }))
        .catch((error) => ({ error: String(error) }));
      window.__approvalRaceStage = "准备完成";
    })().catch((error) => {
      window.__approvalRaceSetupError = String(error);
    });
  })()`,
    "启动异步准备",
  );
  let setup;
  for (let i = 0; i < 100; i++) {
    setup = await evalJs("({ stage: window.__approvalRaceStage, error: window.__approvalRaceSetupError })");
    if (setup.stage === "准备完成" || setup.error) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  console.log("SETUP", setup);
  if (setup.stage !== "准备完成") throw new Error(`场景准备未完成: ${JSON.stringify(setup)}`);
  for (let i = 0; i < 60; i++) {
    const visible = await evalJs(
      `(() => {
  const panel = document.querySelector('[data-panel-viewport] [data-region="assistant-history-panel"]');
  return !!panel && !panel.closest("[inert]") && panel.getBoundingClientRect().width > 0;
})()`,
    );
    if (visible) break;
    const present = await evalJs(`(() => {
      const panel = document.querySelector('[data-panel-viewport] [data-region="assistant-history-panel"]');
      return !!panel && !panel.closest("[inert]");
    })()`);
    if (!present)
      await evalJs(`document.querySelector('[data-panel-viewport] button:has(svg.lucide-history)')?.click(); true`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  check(
    "历史面板确实处于打开状态",
    await evalJs(
      `(() => {
  const panel = document.querySelector('[data-panel-viewport] [data-region="assistant-history-panel"]');
  return !!panel && !panel.closest("[inert]") && panel.getBoundingClientRect().width > 0;
})()`,
    ),
  );
  let confirmation = false;
  for (let i = 0; i < 60; i++) {
    confirmation = await evalJs(
      `(async () => (await import(${JSON.stringify(confirmationModule)})).useAgentConfirmStore.getState().queue.length > 0)()`,
    );
    if (confirmation) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  check("界外路径先出现确认卡", confirmation);
  if (!confirmation) throw new Error("没有出现界外确认卡");
  let allowButton = false;
  for (let i = 0; i < 50; i++) {
    allowButton = await evalJs(
      `Array.from(document.querySelectorAll("button")).some((item) => item.textContent.trim() === "允许" && item.offsetParent !== null)`,
    );
    if (allowButton) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  check("确认卡在历史面板上方真实可见", allowButton);
  if (!allowButton) throw new Error("确认队列已出现，但可见允许按钮未渲染");
  unlinkSync(link);
  symlinkSync(outsideB, link, "junction");
  await evalJs(`(() => {
    const button = Array.from(document.querySelectorAll("button")).find((item) => item.textContent.trim() === "允许" && item.offsetParent !== null);
    if (!button) throw new Error("找不到允许按钮");
    button.click();
  })()`);
  const result = await evalJs("window.__approvalRaceResult");
  check(
    "确认后改目标必须拒绝并重新授权",
    !result?.value && /已变化|重新确认|安全守卫/.test(result?.error ?? ""),
    result,
  );
  check("不得读取新目标内容", result?.value?.content !== "B", result);
} catch (error) {
  check("授权竞态验收执行异常", false, error instanceof Error ? error.stack : String(error));
} finally {
  await evalJs(`(async () => {
    window.__approvalRaceAbort?.abort();
    const previous = window.__approvalRacePrevious;
    if (!previous) return;
    const agentModule = await import("/src/store/agent-settings-store.ts");
    const files = await import("/src/store/file-workspace-store.ts");
    const confirmations = await import(${JSON.stringify(confirmationModule)});
    agentModule.useAgentSettingsStore.getState().setWorkspaceRoot(previous.root);
    agentModule.useAgentSettingsStore.getState().setSafetyMode(previous.safetyMode);
    files.useFileWorkspaceStore.setState({ hosts: previous.hosts, recentRoots: previous.recentRoots });
    confirmations.useAgentConfirmStore.setState({ queue: previous.queue, sessionAllowlist: previous.sessionAllowlist, previewGrants: previous.previewGrants });
    if (!previous.historyOpen && (() => {
  const panel = document.querySelector('[data-panel-viewport] [data-region="assistant-history-panel"]');
  return !!panel && !panel.closest("[inert]") && panel.getBoundingClientRect().width > 0;
})()) {
      document.querySelector('[data-panel-viewport] button:has(svg.lucide-history)')?.click();
    }
    delete window.__approvalRacePrevious;
    delete window.__approvalRaceAbort;
    delete window.__approvalRaceStage;
    delete window.__approvalRaceSetup;
    delete window.__approvalRaceSetupError;
    delete window.__approvalRaceResult;
  })()`).catch(() => {});
  ws.close();
  try {
    unlinkSync(link);
  } catch {}
  rmSync(root, { recursive: true, force: true });
  rmSync(outsideA, { recursive: true, force: true });
  rmSync(outsideB, { recursive: true, force: true });
}
const report = {
  checks,
  exceptions: exceptions.map((item) => item.exception?.description ?? item.text).filter(Boolean),
};
writeFileSync(`${outDir}/approval-race.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (checks.some((item) => !item.pass) || report.exceptions.length) process.exit(1);
