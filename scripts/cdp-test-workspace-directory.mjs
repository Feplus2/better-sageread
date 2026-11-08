import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const cdpPort = process.env.CDP_PORT ?? "9224";
const appPort = process.env.APP_PORT ?? "1421";
const toolGuardSource = await (await fetch(`http://127.0.0.1:${appPort}/src/ai/utils/tool-guard.ts`)).text();
const confirmationModule = toolGuardSource
  .split("\n")
  .find((line) => line.includes("agent-confirm-store"))
  ?.match(/["']([^"']+)["']/)?.[1];
if (!confirmationModule) throw new Error("无法匹配应用实际使用的确认 store 模块");
const outDir = process.env.VERIFY_OUT ?? ".superpowers/sdd/devil-dinosaur-aquaman-riri-williams/directory";
mkdirSync(outDir, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "workspace-shared-")).replace(/\\/g, "/");
const otherRoot = join(process.cwd(), ".tmp-workspace-demo", "workspace-other").replace(/\\/g, "/");
const nestedRoot = `${otherRoot}/nested`;
mkdirSync(nestedRoot, { recursive: true });
writeFileSync(join(root, "a.txt"), "shared-content");
writeFileSync(join(otherRoot, "other.txt"), "other-content");
writeFileSync(join(nestedRoot, "deep.txt"), "deep-content");
const pages = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
const page = pages.find((target) => target.type === "page" && target.url?.includes(`localhost:${appPort}`));
if (!page) throw new Error("找不到隔离 SageRead 页面");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let seq = 0;
const pending = new Map();
const exceptions = [];
const directoryCalls = [];
const nativePickerEvidence = [];
const nativePickerCleanup = [];
async function runNativePicker(cancelExisting = false) {
  const executable = join(process.cwd(), "packages/app/src-tauri/target/debug/better-sageread.exe");
  const script = join(process.cwd(), "scripts/select-workspace-directory.ps1");
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    "-ExecutablePath",
    executable,
    "-DirectoryPath",
    otherRoot,
    "-DialogTitle",
    "更换预览目录",
    "-SelectButtonText",
    "选择文件夹",
  ];
  if (cancelExisting) args.push("-CancelExisting");
  const { stdout, stderr } = await execFileAsync("powershell.exe", args, {
    encoding: "utf8",
    timeout: 60000,
    windowsHide: true,
  }).catch((error) => {
    console.error("原生目录选择器执行失败", { message: error.message, stdout: error.stdout, stderr: error.stderr });
    throw error;
  });
  if (stderr.trim()) console.warn(stderr.trim());
  const result = JSON.parse(stdout.trim());
  (cancelExisting ? nativePickerCleanup : nativePickerEvidence).push(result);
}
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
  if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails);
};
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP 超时：${method}`));
    }, 20000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
await call("Runtime.enable");
await runNativePicker(true);
const evalJs = async (expression) => {
  const response = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.result?.exceptionDetails)
    throw new Error(response.result.exceptionDetails.exception?.description ?? response.result.exceptionDetails.text);
  return response.result?.result?.value;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (expression, description, attempts = 100) => {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      if (await evalJs(`(async () => Boolean(await (${expression})))()`)) {
        if (lastError) console.log(`等待恢复：${description}；${lastError.message ?? lastError}`);
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  const diagnostic = await evalJs(`(async () => JSON.stringify({
    text: document.body.innerText.slice(-1800),
    queue: (await import(${JSON.stringify(confirmationModule)})).useAgentConfirmStore.getState().queue.map((item) => ({ title: item.title, detail: item.detail })),
    hosts: (await import("/src/store/file-workspace-store.ts")).useFileWorkspaceStore.getState().hosts,
  }))()`);
  throw new Error(
    `等待超时：${description}；${diagnostic}${lastError ? `；最近异常：${lastError.message ?? lastError}` : ""}`,
  );
};
const checks = [];
const check = (name, pass, detail = "") => {
  checks.push({ name, pass: !!pass, detail: String(detail) });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` | ${String(detail).slice(0, pass ? 400 : 4000)}` : ""}`);
};
const clickText = (text, selector = "button") =>
  evalJs(`(() => {
  const button = Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find((item) => item.textContent.includes(${JSON.stringify(text)}) && item.getClientRects().length > 0 && !item.closest("[inert]"));
  if (!button) throw new Error("找不到可点击按钮：" + ${JSON.stringify(text)});
  button.click();
  return true;
})()`);
const clickSelector = (selector) =>
  evalJs(`(() => {
  const button = document.querySelector(${JSON.stringify(selector)});
  if (!button) return false;
  button.click();
  return true;
})()`);
const fillDirectory = (path) =>
  evalJs(`(() => {
  const input = document.querySelector("#workspace-directory-path");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(input, ${JSON.stringify(path)});
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return input.value;
})()`);
const refreshExplorer = async () => {
  await evalJs(`(() => {
    if (!document.querySelector('[data-region="file-explorer"]')) document.querySelector('[aria-label="打开文件资源管理器标签"]')?.click();
    return true;
  })()`);
  await waitFor(`document.querySelector('[data-region="file-explorer"]')`, "目录标签");
  await clickSelector('[aria-label="刷新目录"]');
  await waitFor(`!document.querySelector('[data-region="file-explorer"] .animate-spin')`, "目录加载结束");
};
const openFile = async (name) => {
  await refreshExplorer();
  if (!(await clickText(name, '[data-region="file-explorer"] button'))) throw new Error(`找不到文件 ${name}`);
  await waitFor(
    `document.querySelector('[role="tab"][aria-selected="true"]')?.textContent === ${JSON.stringify(name)} && document.querySelector('[data-region="file-preview"]')?.dataset.status === "ready"`,
    `${name} 预览`,
  );
};
const hostState = (expression) =>
  evalJs(
    `(async () => (await import("/src/store/file-workspace-store.ts")).useFileWorkspaceStore.getState().hosts.central${expression})()`,
  );
let previous;
try {
  previous = await evalJs(`(async () => {
    const providers = (await import("/src/store/provider-store.ts")).useProviderStore;
    for (let i = 0; i < 100 && !providers.persist.hasHydrated(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    const agentStore = (await import("/src/store/agent-settings-store.ts")).useAgentSettingsStore;
    const files = (await import("/src/store/file-workspace-store.ts")).useFileWorkspaceStore;
    for (let i = 0; i < 100 && (!agentStore.persist.hasHydrated() || !files.persist.hasHydrated()); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    if (!agentStore.persist.hasHydrated() || !files.persist.hasHydrated()) throw new Error("工作区设置水合超时");
    const agent = agentStore.getState();
    const filesState = files.getState();
    const confirmations = (await import(${JSON.stringify(confirmationModule)})).useAgentConfirmStore;
    const confirmationState = confirmations.getState();
    const task = (await import("/src/store/task-workspace-store.ts")).useTaskWorkspaceStore.getState();
    const previous = {
      workspaceRoot: agent.workspaceRoot, perAgentRoots: agent.perAgentRoots, safetyMode: agent.safetyMode, documentToolMode: agent.documentToolMode,
      hosts: filesState.hosts, recentRoots: filesState.recentRoots, queue: confirmationState.queue, sessionAllowlist: confirmationState.sessionAllowlist, previewGrants: confirmationState.previewGrants, task,
    };
    window.__directoryPrevious = previous;
    agent.setWorkspaceRoot(${JSON.stringify(root)});
    for (const scope of ["central", "reader", "paper"]) agent.setPerAgentRoot(scope, null);
    agent.setSafetyMode("strict");
    agent.setDocumentToolMode("new");
    files.setState({ hosts: {}, recentRoots: {} });
    confirmations.setState({ queue: [], sessionAllowlist: new Set(), previewGrants: {} });
    (await import("/src/store/layout-store.ts")).useLayoutStore.getState().navigateToHome();
    location.hash = "#/chat";
    document.querySelector('[data-panel-viewport] [data-region="assistant-history-panel"] button:has(svg.lucide-arrow-left)')?.click();
    return true;
  })()`);
  await waitFor(
    `(() => {
      const button = document.querySelector('[aria-label="打开文件工作区"]');
      return !!button && !button.closest("[inert]") && getComputedStyle(button).visibility === "visible";
    })()`,
    "可见的工作区入口",
  );
  await evalJs(`(() => {
    const textarea = document.querySelector("textarea");
    window.__directoryTextarea = textarea;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(textarea, "directory-draft");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await clickSelector('[aria-label="打开文件工作区"]');
  await waitFor(`document.querySelector('[data-region="file-explorer"]')`, "默认目录打开");
  await openFile("a.txt");
  check(
    "文件可直接打开且目录不与文件并排",
    (await evalJs(`document.querySelector('[data-region="file-preview"]')?.textContent.includes("shared-content")`)) &&
      !(await evalJs(`document.querySelector('[data-region="file-explorer"]')`)) &&
      (await evalJs(`document.querySelectorAll('[data-region="file-workspace"] [role="tabpanel"]').length === 1`)),
  );

  await refreshExplorer();
  await clickSelector('[aria-label^="更换预览目录"]');
  await waitFor(`document.querySelector("#workspace-directory-path")`, "目录对话框");
  console.log(`NATIVE_PICKER_WIN32 ${otherRoot}`);
  await clickText("系统目录选择");
  await runNativePicker();
  await waitFor(
    `document.querySelector("#workspace-directory-path")?.value.replaceAll(String.fromCharCode(92), "/") === ${JSON.stringify(otherRoot)}`,
    "真实系统目录回填",
    100,
  );
  directoryCalls.push(
    await evalJs(`document.querySelector("#workspace-directory-path").value.replaceAll(String.fromCharCode(92), "/")`),
  );
  check(
    "真实系统目录选择器回填所选目录",
    directoryCalls[0] === otherRoot &&
      nativePickerEvidence[0]?.selectedPath?.replaceAll(String.fromCharCode(92), "/") === otherRoot,
    JSON.stringify({ directoryCalls, nativePickerEvidence }),
  );
  await clickText("打开目录");
  await waitFor(
    `(async () => (await import(${JSON.stringify(confirmationModule)})).useAgentConfirmStore.getState().queue.length > 0)()`,
    "界外目录确认",
  );
  check(
    "界外目录先确认而不是静默授予",
    await evalJs(`(async () => {
    const queue = (await import(${JSON.stringify(confirmationModule)})).useAgentConfirmStore.getState().queue;
    return queue.length === 1 && queue[0].detail.replaceAll(String.fromCharCode(92), "/") === ${JSON.stringify(otherRoot)};
  })()`),
  );
  await clickText("允许");
  await waitFor(
    `(async () => (await import(${JSON.stringify(confirmationModule)})).useAgentConfirmStore.getState().queue.length === 0)()`,
    "目录确认已处理",
  );
  await waitFor(
    `(async () => (await import("/src/store/file-workspace-store.ts")).useFileWorkspaceStore.getState().hosts.central.rootResolved === ${JSON.stringify(otherRoot)})()`,
    "新预览根",
  );
  check(
    "最近目录按 scope 隔离",
    await evalJs(`(async () => {
    const roots = (await import("/src/store/file-workspace-store.ts")).useFileWorkspaceStore.getState().recentRoots;
    return roots.central?.[0] === ${JSON.stringify(otherRoot)} && !roots.reader?.includes(${JSON.stringify(otherRoot)}) && !roots.paper?.includes(${JSON.stringify(otherRoot)});
  })()`),
  );
  check(
    "换预览根不提升文件父目录权限且保留旧根标签",
    await hostState(
      `.tabs.some((tab) => tab.path.replaceAll(String.fromCharCode(92), "/") === ${JSON.stringify(join(root, "a.txt").replace(/\\/g, "/"))} && tab.rootResolved.replaceAll(String.fromCharCode(92), "/") === ${JSON.stringify(root)})`,
    ),
  );
  await openFile("other.txt");
  check(
    "新根文件真实可读",
    await evalJs(`document.querySelector('[data-region="file-preview"]')?.textContent.includes("other-content")`),
  );
  await refreshExplorer();
  await clickText("nested", '[data-region="file-explorer"] button');
  await waitFor(
    `(async () => (await import("/src/store/file-workspace-store.ts")).useFileWorkspaceStore.getState().hosts.central.explorerPath === ${JSON.stringify(nestedRoot)})()`,
    "子目录导航",
  );
  await openFile("deep.txt");
  await clickText("文件资源管理器", '[role="tab"]');
  check("目录切换保留子目录位置", await hostState(`.explorerPath === ${JSON.stringify(nestedRoot)}`));

  const keyboard = await evalJs(`(async () => {
    const tabs = Array.from(document.querySelectorAll('[data-region="file-workspace"] [role="tab"]'));
    const first = tabs[0];
    first.focus({ preventScroll: true });
    const before = document.activeElement?.dataset.tabId;
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const afterLeft = { id: document.activeElement?.dataset.tabId, selected: document.activeElement?.getAttribute("aria-selected") };
    const wrapped = afterLeft.id === tabs.at(-1)?.dataset.tabId && afterLeft.selected === "true";
    const end = document.activeElement;
    end.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const afterHome = { id: document.activeElement?.dataset.tabId, selected: document.activeElement?.getAttribute("aria-selected") };
    return { before, afterLeft, afterHome, wrapped, expectedFirst: first.dataset.tabId, expectedLast: tabs.at(-1)?.dataset.tabId };
  })()`);
  check(
    "活动标签键盘循环、焦点与单页面板",
    keyboard.before === keyboard.expectedFirst &&
      keyboard.wrapped &&
      keyboard.afterHome.id === keyboard.expectedFirst &&
      keyboard.afterHome.selected === "true" &&
      (await evalJs(`document.querySelectorAll('[data-region="file-workspace"] [role="tabpanel"]').length === 1`)),
    JSON.stringify(keyboard),
  );
  const tabRect = await evalJs(`(() => {
    const tab = document.querySelector('[role="tab"][aria-selected="false"]');
    const rect = tab.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  const beforeHover = await evalJs(
    `getComputedStyle(document.querySelector('[role="tab"][aria-selected="false"]').parentElement).backgroundColor`,
  );
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", ...tabRect });
  await sleep(250);
  const afterHover = await evalJs(
    `getComputedStyle(document.querySelector('[role="tab"][aria-selected="false"]').parentElement).backgroundColor`,
  );
  await evalJs(
    `document.querySelector('[role="tab"][aria-selected="false"]').parentElement.querySelector("button[aria-label^='关闭']").focus(); true`,
  );
  await sleep(250);
  const focusHover = await evalJs(
    `getComputedStyle(document.querySelector('[role="tab"][aria-selected="false"]').parentElement).backgroundColor`,
  );
  check(
    "文件名与关闭区域共享整标签 hover/focus 状态",
    beforeHover !== afterHover && afterHover === focusHover,
    JSON.stringify({ beforeHover, afterHover, focusHover }),
  );

  await clickSelector('[aria-label="关闭 文件资源管理器"]');
  check(
    "关闭目录不删除文件或文件标签",
    !(await hostState(`.tabs.some((tab) => tab.type === "explorer")`)) &&
      (await hostState(`.tabs.some((tab) => tab.type === "file")`)) &&
      existsSync(join(otherRoot, "nested", "deep.txt")),
  );
  await clickSelector('[aria-label="关闭全部标签"]');
  check(
    "关闭全部显示空态",
    (await hostState(".tabs.length === 0")) && (await evalJs(`document.body.textContent.includes("没有打开的标签")`)),
  );
  await evalJs(`(async () => {
    (await import("/src/store/file-workspace-store.ts")).useFileWorkspaceStore.getState().openFile("central", "central", ${JSON.stringify(otherRoot)}, { path: ${JSON.stringify(join(otherRoot, "nested", "deep.txt"))}, title: "deep.txt" });
  })()`);
  await waitFor(`document.querySelector('[data-region="file-preview"]')?.dataset.status === "ready"`, "直接重开文件");
  check(
    "直接打开文件不自动创建目录标签",
    !(await hostState(`.tabs.some((tab) => tab.type === "explorer")`)) &&
      (await evalJs(`document.querySelector('[data-region="file-preview"]')?.textContent.includes("deep-content")`)),
  );
  await refreshExplorer();
  await clickSelector('[aria-label^="更换预览目录"]');
  await clickText("恢复共享工作区");
  await waitFor(
    `(async () => (await import("/src/store/file-workspace-store.ts")).useFileWorkspaceStore.getState().hosts.central.rootResolved === ${JSON.stringify(root)})()`,
    "恢复共享根",
  );
  check(
    "恢复共享保留最近目录和其他根文件标签",
    await evalJs(`(async () => {
    const state = (await import("/src/store/file-workspace-store.ts")).useFileWorkspaceStore.getState();
    return state.recentRoots.central.includes(${JSON.stringify(otherRoot)}) && state.hosts.central.tabs.some((tab) => tab.rootResolved === ${JSON.stringify(otherRoot)} && tab.path === ${JSON.stringify(join(otherRoot, "nested", "deep.txt"))});
  })()`),
  );
  await clickText("deep.txt", '[role="tab"]');
  await waitFor(
    `document.querySelector('[data-region="file-preview"]')?.dataset.status === "ready" && document.querySelector('[data-region="file-preview"]')?.textContent.includes("deep-content")`,
    "跨根文件读取",
  );
  check(
    "跨根标签仍按各自根读取",
    await evalJs(`document.querySelector('[data-region="file-preview"]')?.textContent.includes("deep-content")`),
  );
  await clickSelector('[aria-label="收起文件工作区，返回对话"]');
  check(
    "工作区切换保留聊天 DOM 与草稿",
    await evalJs(
      `document.querySelector("textarea") === window.__directoryTextarea && document.querySelector("textarea").value === "directory-draft"`,
    ),
  );

  await clickSelector('[aria-label^="选择全局助手的任务工作区"]');
  await fillDirectory(otherRoot);
  await evalJs(`document.querySelector('input[name="workspace-mode"][value="once"]').click(); true`);
  await clickText("保存选择");
  check(
    "仅本次任务绑定宿主且不改预览根",
    await evalJs(
      `(async () => {
    const task = (await import("/src/store/task-workspace-store.ts"));
    const threadId = (await import("/src/store/chat-reader-store.ts")).useChatReaderStore.getState().currentThread?.id;
    const taskRoot = task.selectTaskWorkspaceRoot(task.useTaskWorkspaceStore.getState(), "central", threadId);
    const fileHost = (await import("/src/store/file-workspace-store.ts")).useFileWorkspaceStore.getState().hosts.central;
    return taskRoot === ${JSON.stringify(otherRoot)} && fileHost.rootResolved === ${JSON.stringify(root)};
  })()`,
      JSON.stringify({ otherRoot, root }),
    ),
  );
  await clickSelector('[aria-label="恢复共享工作区"]');
  check(
    "任务目录一键恢复共享",
    await evalJs(`(async () => {
    const task = (await import("/src/store/task-workspace-store.ts"));
    return !task.selectTaskWorkspaceRoot(task.useTaskWorkspaceStore.getState(), "central") && !(await import("/src/store/agent-settings-store.ts")).useAgentSettingsStore.getState().perAgentRoots.central;
  })()`),
  );
  await clickSelector('[aria-label^="选择全局助手的任务工作区"]');
  await fillDirectory(otherRoot);
  await evalJs(`document.querySelector('input[name="workspace-mode"][value="remember"]').click(); true`);
  await clickText("保存选择");
  check(
    "记住默认只影响当前助手",
    await evalJs(
      `(async () => (await import("/src/store/agent-settings-store.ts")).useAgentSettingsStore.getState().perAgentRoots.central === ${JSON.stringify(otherRoot)})()`,
    ),
  );
  await clickSelector('[aria-label="恢复共享工作区"]');
  check(
    "记住默认后也可恢复共享",
    await evalJs(
      `(async () => !(await import("/src/store/agent-settings-store.ts")).useAgentSettingsStore.getState().perAgentRoots.central)()`,
    ),
  );
} catch (error) {
  check("目录与标签验收执行异常", false, error instanceof Error ? error.stack : String(error));
} finally {
  await runNativePicker(true).catch((error) => console.warn("隔离目录选择器清理失败", error));
  await evalJs(`(async () => {
    const previous = window.__directoryPrevious;
    if (previous) {
      const agent = (await import("/src/store/agent-settings-store.ts")).useAgentSettingsStore.getState();
      agent.setWorkspaceRoot(previous.workspaceRoot);
      for (const scope of ["central", "reader", "paper"]) agent.setPerAgentRoot(scope, previous.perAgentRoots[scope] ?? null);
      agent.setSafetyMode(previous.safetyMode);
      agent.setDocumentToolMode(previous.documentToolMode);
      (await import("/src/store/file-workspace-store.ts")).useFileWorkspaceStore.setState({ hosts: previous.hosts, recentRoots: previous.recentRoots });
      (await import(${JSON.stringify(confirmationModule)})).useAgentConfirmStore.setState({ queue: previous.queue, sessionAllowlist: previous.sessionAllowlist, previewGrants: previous.previewGrants });
      (await import("/src/store/task-workspace-store.ts")).useTaskWorkspaceStore.setState(previous.task);
    }
    delete window.__directoryOriginalInvoke;
    delete window.__directoryOptions;
    delete window.__directoryPrevious;
    delete window.__directoryTextarea;
  })()`).catch(() => {});
  ws.close();
  rmSync(root, { recursive: true, force: true });
}
const report = {
  checks,
  directoryCalls,
  nativePickerEvidence,
  nativePickerCleanup,
  exceptions: exceptions.map((item) => item.exception?.description ?? item.text).filter(Boolean),
};
writeFileSync(`${outDir}/workspace-directory.json`, JSON.stringify(report, null, 2));
if (checks.some((item) => !item.pass) || report.exceptions.length) process.exit(1);
console.log(`\n${checks.filter((item) => item.pass).length}/${checks.length} PASS`);
