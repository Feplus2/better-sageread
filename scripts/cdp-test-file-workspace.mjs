import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const cdpPort = process.env.CDP_PORT ?? "9224";
const appPort = process.env.APP_PORT ?? "1421";
const workspaceFilesModule = "/src/services/agent-workspace-files.ts";
const toolGuardSource = await (await fetch(`http://127.0.0.1:${appPort}/src/ai/utils/tool-guard.ts`)).text();
const confirmationModule = toolGuardSource
  .split("\n")
  .find((line) => line.includes("agent-confirm-store"))
  ?.match(/["']([^"']+)["']/)?.[1];
if (!confirmationModule) throw new Error("无法匹配应用实际使用的确认 store 模块");
const outDir = process.env.VERIFY_OUT ?? ".tmp-agent-followup";
mkdirSync(outDir, { recursive: true });
const modelRequests = [];
const modelServer = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "workspace-fixture", context_length: 32768 }] }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unexpected fixture route" }));
      return;
    }
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    modelRequests.push({
      model: body.model,
      tools: (body.tools ?? []).map((tool) => tool.function?.name),
      roles: (body.messages ?? []).map((message) => message.role),
    });
    const direct = body.tools?.some((tool) => tool.function?.name === "writeFile");
    const directory = body.tools?.some((tool) => tool.function?.name === "useTool");
    const toolArgs = (name, args) => (direct ? args : { tool: name, args });
    const writeArgs = (path, content, reasoning) => toolArgs("writeFile", { path, content, reasoning });
    const calls = [
      {
        id: "call_csv",
        name: direct ? "writeFile" : "useTool",
        arguments: writeArgs("report.csv", "name,value\nfoo,42\n", "创建真实 CSV 验收产物"),
      },
      {
        id: "call_txt",
        name: direct ? "runCommand" : "useTool",
        arguments: toolArgs("runCommand", {
          command:
            "python -c \"from pathlib import Path; import time; time.sleep(2); Path('note.txt').write_text('hello workspace', encoding='utf-8')\"",
          reasoning: "用真实延时命令生成 TXT，观察两个工具的运行状态",
          artifactPaths: ["note.txt"],
        }),
      },
    ];
    const hasToolResult = body.messages?.some((message) => message.role === "tool");
    const events =
      hasToolResult || (!direct && !directory)
        ? [
            {
              delta: {
                role: "assistant",
                content: `完成\n[打开 CSV](<${pathToFileURL(join(root, "report.csv")).href}>)\n[相对笔记](note.txt)\n[敏感文件](.env)\n[越界](../outside.txt)\n[危险](javascript:alert(1))`,
              },
              finish_reason: null,
            },
            { delta: {}, finish_reason: "stop" },
          ]
        : [
            {
              delta: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    index: 0,
                    id: calls[0].id,
                    type: "function",
                    function: { name: calls[0].name, arguments: JSON.stringify(calls[0].arguments) },
                  },
                ],
              },
              finish_reason: null,
            },
            { delta: { content: "我先创建 CSV，再创建 TXT。" }, finish_reason: null },
            {
              delta: {
                tool_calls: [
                  {
                    index: 1,
                    id: calls[1].id,
                    type: "function",
                    function: { name: calls[1].name, arguments: JSON.stringify(calls[1].arguments) },
                  },
                ],
              },
              finish_reason: null,
            },
            { delta: {}, finish_reason: "tool_calls" },
          ];
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
    for (const event of events) {
      response.write(
        `data: ${JSON.stringify({ id: "workspace-fixture", object: "chat.completion.chunk", created: 1, model: "workspace-fixture", choices: [{ index: 0, ...event }] })}\n\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    response.end("data: [DONE]\n\n");
  } catch (error) {
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
});
await new Promise((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
const fixtureBaseUrl = `http://127.0.0.1:${modelServer.address().port}/v1`;
const root = mkdtempSync(join(tmpdir(), "file-workspace-ui-"));
const defaultRoot = mkdtempSync(join(tmpdir(), "file-workspace-default-"));
const outside = mkdtempSync(join(tmpdir(), "file-workspace-outside-"));
const readerRoot = mkdtempSync(join(tmpdir(), "file-workspace-reader-"));
const paperRoot = mkdtempSync(join(tmpdir(), "file-workspace-paper-"));
writeFileSync(join(root, ".env"), "placeholder-not-a-secret");
writeFileSync(join(root, "big.txt"), `BEGIN\n${"x".repeat(600000)}\nEND`);
writeFileSync(join(outside, "outside.txt"), "outside-ok");
writeFileSync(join(outside, "reject.txt"), "reject");
writeFileSync(join(readerRoot, "reader.txt"), "reader-root");
writeFileSync(join(paperRoot, "paper.txt"), "paper-root");
writeFileSync(join(root, "code.ts"), "export const answer: number = 42;\n");

const pages = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
const page = pages.find((target) => target.type === "page" && target.url?.includes(`localhost:${appPort}`));
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
    }, 20000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      pending.delete(id);
      if (msg.error) reject(new Error(`${method}: ${JSON.stringify(msg.error)}`));
      else resolve(msg);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
await call("Runtime.enable");
const evalJs = async (expression) => {
  try {
    const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.result?.exceptionDetails)
      throw new Error(result.result.exceptionDetails.exception?.description ?? result.result.exceptionDetails.text);
    return result.result?.result?.value;
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n表达式：${expression.slice(0, 360)}`, {
      cause: error,
    });
  }
};
const pageModuleUrl = async (path) =>
  evalJs(`(() => {
    const urls = performance.getEntriesByType("resource").map((entry) => entry.name)
      .filter((name) => new URL(name).pathname === ${JSON.stringify(path)});
    const timestamped = urls.filter((url) => new URL(url).searchParams.has("t"));
    return timestamped.at(-1) ?? urls.find((url) => !new URL(url).search) ?? urls.at(-1) ?? ${JSON.stringify(path)};
  })()`);
const previewDataDir = await evalJs(`(async () => {
  const pathApi = await import("/@id/@tauri-apps/api/path");
  return pathApi.appDataDir();
})()`);
if (!previewDataDir.includes("com.bettersageread.preview") && process.env.ALLOW_DAILY !== "1") {
  throw new Error(`拒绝在非隔离数据目录运行文件工作区探针：${previewDataDir}`);
}
const providerStoreModule = await pageModuleUrl("/src/store/provider-store.ts");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = [];
const check = (name, pass, detail = "") => {
  checks.push({ name, pass: !!pass, detail: String(detail) });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` | ${String(detail)}` : ""}`);
};
const clickButton = (selector, text) =>
  evalJs(`(() => {
  const buttons = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
  const button = buttons.find((item) => item.textContent.includes(${JSON.stringify(text)}));
  if (!button) throw new Error("找不到按钮：" + ${JSON.stringify(selector)} + " / " + ${JSON.stringify(text)});
  button.click();
  return true;
})()`);
const previewText = () =>
  evalJs(`(() => {
  const preview = document.querySelector('[data-region="file-preview"]');
  const rows = Array.from(preview?.querySelectorAll("[data-region='csv-preview'] tr") ?? []);
  if (rows.length > 0) return rows.map((row) => Array.from(row.children).map((cell) => cell.textContent).join(",")).join(String.fromCharCode(10));
  return preview?.textContent ?? "";
})()`);
const tabsText = () =>
  evalJs(
    `Array.from(document.querySelectorAll('[data-region="file-workspace"] [role="tab"]:not([data-tab-id="explorer"])')).map((item) => item.textContent)`,
  );
const waitFor = async (expression, description, attempts = 100) => {
  for (let i = 0; i < attempts; i++) {
    if (await evalJs(`(async () => Boolean(await (${expression})))()`)) return;
    await sleep(100);
  }
  throw new Error(`等待超时：${description}`);
};
const globalHistoryOpenSource = `(() => {
  const panel = document.querySelector('[data-panel-viewport] [data-region="assistant-history-panel"]');
  return !!panel && !panel.closest("[inert]") && panel.getBoundingClientRect().width > 0;
})()`;
const closeGlobalHistory = async () => {
  if (!(await evalJs(globalHistoryOpenSource))) return;
  await evalJs(
    `document.querySelector('[data-panel-viewport] [data-region="assistant-history-panel"] h2')?.parentElement?.querySelector("button:has(svg.lucide-arrow-left)")?.click(); true`,
  );
  await waitFor(`!(${globalHistoryOpenSource})`, "关闭历史覆盖层");
};
const refreshExplorer = async () => {
  await evalJs(`(() => {
    if (!document.querySelector('[data-region="file-explorer"]')) document.querySelector('[aria-label="打开文件资源管理器标签"]')?.click();
    return true;
  })()`);
  await waitFor(`!!document.querySelector('[data-region="file-explorer"]')`, "目录标签可见");
  await clickButton('[aria-label="刷新目录"]', "");
  await waitFor(`!document.querySelector('[data-region="file-explorer"] .animate-spin')`, "目录刷新完成");
};
const openFileFromExplorer = async (name) => {
  await refreshExplorer();
  const clicked = await clickButton('[data-region="file-explorer"] button', name);
  if (!clicked) throw new Error(`目录中找不到 ${name}`);
  await waitFor(
    `document.querySelector('[role="tab"][aria-selected="true"]')?.textContent === ${JSON.stringify(name)} && document.querySelector('[data-region="file-preview"]')?.dataset.status === "ready"`,
    `${name} 预览就绪`,
  );
  return true;
};
let previousSettings;
try {
  previousSettings = await evalJs(`(async () => {
    const providers = (await import("${providerStoreModule}")).useProviderStore;
    for (let i = 0; i < 100 && !providers.persist.hasHydrated(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    if (!providers.persist.hasHydrated()) throw new Error("模型提供商水合超时");
    const agentStore = (await import("/src/store/agent-settings-store.ts")).useAgentSettingsStore;
    const fileStore = (await import("/src/store/file-workspace-store.ts")).useFileWorkspaceStore;
    for (let i = 0; i < 100 && (!agentStore.persist.hasHydrated() || !fileStore.persist.hasHydrated()); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    if (!agentStore.persist.hasHydrated() || !fileStore.persist.hasHydrated()) throw new Error("工作区设置水合超时");
    const agent = agentStore.getState();
    const files = fileStore.getState();
    const confirmations = (await import(${JSON.stringify(confirmationModule)})).useAgentConfirmStore.getState();
    const tasks = (await import("/src/store/task-workspace-store.ts")).useTaskWorkspaceStore.getState();
    const previous = {
      workspaceRoot: agent.workspaceRoot,
      perAgentRoots: agent.perAgentRoots,
      safetyMode: agent.safetyMode,
      documentToolMode: agent.documentToolMode,
      historyOpen: ${globalHistoryOpenSource},
      hosts: files.hosts,
      recentRoots: files.recentRoots,
      queue: confirmations.queue,
      sessionAllowlist: confirmations.sessionAllowlist,
      previewGrants: confirmations.previewGrants,
      pendingRoots: tasks.pendingRoots,
      threadRoots: tasks.threadRoots,
    };
    window.__workspaceTestPrevious = previous;
    return previous;
  })()`);
  await evalJs(`(async () => {
    const root = ${JSON.stringify(root)};
    const readerRoot = ${JSON.stringify(readerRoot)};
    const paperRoot = ${JSON.stringify(paperRoot)};
    const agentModule = await import("/src/store/agent-settings-store.ts");
    const agent = agentModule.useAgentSettingsStore.getState();
    window.__workspaceDirectoryPrevious = window.__SAGEREAD_DISABLE_DIRECTORY__;
    window.__SAGEREAD_DISABLE_DIRECTORY__ = ${JSON.stringify(process.env.WORKSPACE_DIRECT === "1")};
    agent.setWorkspaceRoot(${JSON.stringify(defaultRoot)});
    agent.setPerAgentRoot("reader", readerRoot);
    agent.setPerAgentRoot("paper", paperRoot);
    agent.setPerAgentRoot("central", null);
    agent.setSafetyMode("full");
    agent.setDocumentToolMode(${JSON.stringify(process.env.WORKSPACE_DOC_MODE ?? "new")});
    (await import("/src/store/file-workspace-store.ts")).useFileWorkspaceStore.setState({ hosts: {}, recentRoots: {} });
    const providers = (await import("${providerStoreModule}")).useProviderStore;
    window.__workspaceProviderPrevious = {
      providers: providers.getState().modelProviders,
      selected: providers.getState().selectedModel,
      utility: providers.getState().utilityModel,
    };
    const fixtureProvider = {
      provider: "custom-workspace-fixture",
      name: "隔离工作区模型",
      active: true,
      baseUrl: ${JSON.stringify(fixtureBaseUrl)},
      apiKey: "local-test-only",
      apiStyle: "openai-chat",
      models: [{ id: "workspace-fixture", name: "工作区工具流", active: true, contextWindow: 32768 }],
    };
    providers.getState().setModelProviders([...providers.getState().modelProviders, fixtureProvider]);
    providers.getState().setSelectedModel({ providerId: fixtureProvider.provider, modelId: "workspace-fixture", providerName: fixtureProvider.name, modelName: "工作区工具流" });
    (await import("/src/store/layout-store.ts")).useLayoutStore.getState().navigateToHome();
    location.hash = "#/chat";
    await new Promise((resolve) => setTimeout(resolve, 800));
    return true;
  })()`);
  await waitFor(
    `(() => {
    const button = document.querySelector('[data-panel-viewport] button:has(svg.lucide-message-circle-plus)');
    return button && !button.closest("[inert]") && getComputedStyle(button).visibility === "visible";
  })()`,
    "可见的全局新对话按钮",
  );
  await evalJs(`(() => {
    const button = document.querySelector('[data-panel-viewport] button:has(svg.lucide-message-circle-plus)');
    if (!button) throw new Error("找不到全局新对话按钮");
    button.click();
    return new Promise((resolve) => setTimeout(resolve, 300));
  })()`);
  await closeGlobalHistory();
  const modelProbe = await evalJs(`(async () => {
    const store = (await import("${providerStoreModule}")).useProviderStore.getState();
    try {
      const factory = await import(${JSON.stringify(await pageModuleUrl("/src/ai/providers/factory.ts"))});
      const instance = factory.createModelInstance("custom-workspace-fixture", "workspace-fixture");
      return { pass: instance?.modelId === "workspace-fixture", instance: instance?.modelId, selected: store.selectedModel };
    } catch (error) {
      const provider = store.modelProviders.find((item) => item.provider === "custom-workspace-fixture");
      return { pass: false, error: String(error), selected: store.selectedModel, provider: provider && { active: provider.active, models: provider.models, baseUrl: provider.baseUrl } };
    }
  })()`);
  check("隔离模型已选中且可实例化", modelProbe.pass, JSON.stringify(modelProbe));
  if (!modelProbe.pass) throw new Error("隔离模型实例创建失败，已停止发送验收");
  check(
    "全局空对话内容在可用区域垂直居中",
    await evalJs(`(() => {
      const heading = Array.from(document.querySelectorAll("h1")).find((item) => item.textContent === "How can I help you today?");
      const viewport = heading?.closest(".flex.h-full");
      const content = viewport?.firstElementChild;
      if (!viewport || !content) return false;
      const outer = viewport.getBoundingClientRect();
      const inner = content.getBoundingClientRect();
      return Math.abs((inner.top + inner.height / 2) - (outer.top + outer.height / 2)) <= 2;
    })()`),
  );
  await waitFor(`!!document.querySelector('[aria-label^="选择全局助手的任务工作区"]')`, "首轮任务工作区入口");
  await clickButton('[aria-label^="选择全局助手的任务工作区"]', "");
  await evalJs(`(() => {
    const input = document.querySelector("#workspace-directory-path");
    if (!input) throw new Error("任务工作区对话框未打开");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(root)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const once = document.querySelector('input[name="workspace-mode"][value="once"]');
    if (!once) throw new Error("缺少仅本次任务选项");
    once.click();
    return true;
  })()`);
  await clickButton("button", "保存选择");
  await waitFor(
    `(async () => (await import("/src/store/task-workspace-store.ts")).useTaskWorkspaceStore.getState().pendingRoots.central?.replaceAll(String.fromCharCode(92), "/") === ${JSON.stringify(root.replace(/\\/g, "/"))})()`,
    "首轮仅本次任务根已生效",
  );
  await evalJs(`(() => {
    const textarea = document.querySelector('[data-panel-viewport] textarea');
    if (!textarea) throw new Error("找不到全局聊天输入框");
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(textarea, "请依次实际调用 writeFile 两次：1）path=report.csv，内容 name,value\\nfoo,42\\n；2）path=note.txt，内容 hello workspace。不要调用其他工具，最后只回复“完成”。");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    const buttons = textarea.closest(".cursor-text").querySelectorAll("button");
    buttons.item(buttons.length - 1).click();
    return { value: textarea.value, buttonCount: buttons.length };
  })()`);
  await sleep(1500);
  if (modelRequests.length === 0) {
    console.error(
      "提交诊断",
      await evalJs(`(async () => {
        const providers = (await import("${providerStoreModule}")).useProviderStore.getState();
        return JSON.stringify({ selected: providers.selectedModel, text: document.body.textContent.slice(-2500), textarea: document.querySelector("textarea")?.value, path: location.hash });
      })()`),
    );
  }
  let changedCount = 0;
  let runningSeen = false;
  for (let i = 0; i < 120; i++) {
    changedCount = await evalJs(`(() => {
      const label = document.querySelector('[data-panel-viewport] [data-region="changed-files"] > button[aria-label^="已编辑"]')?.getAttribute("aria-label") ?? "";
      return Number(label.match(/已编辑 (\\d+) 个文件/)?.[1] ?? 0);
    })()`);
    if (!runningSeen) {
      const expanded = await evalJs(`(() => {
        const button = Array.from(document.querySelectorAll("button[aria-expanded]")).find((item) => item.textContent.includes("正在调用"));
        if (!button) return null;
        window.__runningToolGroup = button;
        window.__runningToolText = button.textContent;
        return button.getAttribute("aria-expanded");
      })()`);
      if (expanded !== null) {
        runningSeen = true;
        check("两个工具执行中默认折叠", expanded === "false", expanded);
        if (expanded === "false") {
          await evalJs("window.__runningToolGroup.click(); true");
          await sleep(150);
          check(
            "手动展开不被后续工具进度覆盖",
            await evalJs(
              `window.__runningToolGroup.isConnected && window.__runningToolGroup.getAttribute("aria-expanded") === "true"`,
            ),
          );
        }
      }
    }
    if (changedCount >= 2 && modelRequests.some((request) => request.roles.includes("tool"))) break;
    await sleep(250);
  }
  if (runningSeen)
    await waitFor(`window.__runningToolGroup?.textContent.includes("已调用 2 个工具")`, "真实工具组执行结束");
  else check("真实工具组执行结束", false, JSON.stringify(modelRequests));
  check(
    "真实 Agent 生成 CSV/TXT 后出现两个变更条目",
    changedCount === 2,
    JSON.stringify({ changedCount, modelRequests }),
  );
  check(
    "真实模型经过工具结果后继续回答",
    modelRequests.some((request) => request.tools.length > 0 && request.roles.includes("tool")),
    JSON.stringify(modelRequests),
  );
  check(
    "本轮编辑默认折叠、跟在回答尾部且不冒充显式交付",
    await evalJs(`(() => {
      const section = document.querySelector('[data-panel-viewport] [data-region="changed-files"]');
      const content = section?.parentElement;
      const toggle = section?.querySelector(':scope > button[aria-expanded]');
      return toggle?.getAttribute("aria-expanded") === "false" &&
        toggle.getAttribute("aria-label") === "已编辑 2 个文件" &&
        content?.dataset.messageId === section.dataset.messageFiles &&
        content.lastElementChild === section &&
        !section.closest(".cursor-text") &&
        !section.querySelector('[data-region="new-files"], [data-region="presented-files"]');
    })()`),
  );
  const measureChangedMessageWidth = `(() => {
    const section = document.querySelector('[data-panel-viewport] [data-region="changed-files"]');
    const content = section?.parentElement;
    const sectionRect = section?.getBoundingClientRect();
    const contentRect = content?.getBoundingClientRect();
    return {
      pass: !!section && !!content && content.lastElementChild === section &&
        !section.closest(".cursor-text") && Math.abs(sectionRect.width - contentRect.width) < 1,
      sectionRect: sectionRect?.toJSON(),
      contentRect: contentRect?.toJSON(),
      inInput: !!section?.closest(".cursor-text"),
    };
  })()`;
  const widthBeforeToggle = await evalJs(measureChangedMessageWidth);
  check("编辑清单跟随本轮正文限宽而非输入框", widthBeforeToggle.pass, JSON.stringify(widthBeforeToggle));
  const previousLayout = await evalJs(
    `document.querySelector('button[title="切换到宽版布局"], button[title="切换到标准布局"]')?.title`,
  );
  await evalJs(
    `document.querySelector('button[title="切换到宽版布局"], button[title="切换到标准布局"]')?.click(); true`,
  );
  await sleep(100);
  const widthAfterToggle = await evalJs(measureChangedMessageWidth);
  check("切换宽版后编辑清单仍跟随本轮正文", widthAfterToggle.pass, JSON.stringify(widthAfterToggle));
  const restoreLayout = previousLayout === "切换到宽版布局" ? "切换到标准布局" : "切换到宽版布局";
  await evalJs(`document.querySelector('button[title=${JSON.stringify(restoreLayout)}]')?.click(); true`);
  await sleep(100);
  const changedMessageShot = await call("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${outDir}/changed-files-message.png`, Buffer.from(changedMessageShot.result.data, "base64"));
  await clickButton('[aria-label^="选择全局助手的任务工作区"]', "");
  check(
    "真实工作区弹窗具有水平与底部留白",
    await evalJs(`(() => {
      const form = document.querySelector('[role="dialog"] form');
      if (!form) return false;
      const style = getComputedStyle(form);
      return Number.parseFloat(style.paddingLeft) >= 16 && Number.parseFloat(style.paddingRight) >= 16 && Number.parseFloat(style.paddingBottom) >= 16;
    })()`),
  );
  await clickButton('[role="dialog"] button', "取消");
  check(
    "工具执行中确实出现且包含两个调用",
    runningSeen && (await evalJs(`window.__runningToolText?.includes("2 个工具")`)),
    await evalJs(`window.__runningToolText ?? "未捕获运行态"`),
  );
  check(
    "真实命令产物完成后才进入下一轮模型请求",
    modelRequests.some((request) => request.roles.filter((role) => role === "tool").length === 2),
    JSON.stringify(modelRequests),
  );
  if (process.env.WORKSPACE_DIRECT === "1") {
    check(
      "direct 工具面直接暴露 writeFile/runCommand，不改为目录牌",
      modelRequests.some(
        (request) =>
          request.tools.includes("writeFile") &&
          request.tools.includes("runCommand") &&
          !request.tools.includes("useTool"),
      ),
      JSON.stringify(modelRequests),
    );
  }
  check(
    "首轮仅本次任务真实写入 A 且不污染默认目录 B",
    existsSync(join(root, "report.csv")) &&
      readFileSync(join(root, "report.csv"), "utf8").includes("foo,42") &&
      existsSync(join(root, "note.txt")) &&
      !existsSync(join(defaultRoot, "report.csv")) &&
      !existsSync(join(defaultRoot, "note.txt")),
    JSON.stringify({ taskRoot: root, defaultRoot }),
  );
  await evalJs(
    `document.querySelector('[data-panel-viewport] [data-region="changed-files"] > button[aria-label="已编辑 2 个文件"]').click(); true`,
  );
  await waitFor(
    `document.querySelectorAll('[data-panel-viewport] [data-region="changed-files"] [data-file-path]').length === 2`,
    "展开本轮两个编辑文件",
  );
  check(
    "展开的变更清单不混入读取或其他旧文件",
    await evalJs(`(() => {
      const items = Array.from(document.querySelectorAll('[data-panel-viewport] [data-region="changed-files"] [data-file-path]'));
      return items.length === 2 && items.every((item) => /report\\.csv|note\\.txt/.test(item.dataset.filePath));
    })()`),
  );
  check(
    "CSV 工具结果和磁盘内容一致",
    await evalJs(`(async () => {
    const files = await import("${workspaceFilesModule}");
    const chunk = await files.readWorkspaceChunk("central", ${JSON.stringify(join(root, "report.csv"))});
    return chunk.content.includes("foo,42");
  })()`),
  );

  await clickButton('[data-panel-viewport] [data-region="changed-files"] [data-file-path]', "report.csv");
  await sleep(400);
  check("点击 CSV 在同栏打开正确预览", (await previewText()).includes("foo,42"), await previewText());
  const globalHeaderMeasurement = await evalJs(`(() => {
    const header = document.querySelector('button:has(svg.lucide-history)')?.closest(".relative.flex.h-10");
    const tabs = document.querySelector('[role="tablist"][aria-label="工作区标签"]');
    return {
      pass: !!header && !!tabs && getComputedStyle(header).visibility === "visible" && Math.abs(header.getBoundingClientRect().bottom - tabs.getBoundingClientRect().top) <= 0.5,
      gap: header && tabs ? tabs.getBoundingClientRect().top - header.getBoundingClientRect().bottom : null,
      header: header?.getBoundingClientRect().toJSON(),
      tabs: tabs?.getBoundingClientRect().toJSON(),
      fileWorkspace: !!document.querySelector('[data-region="file-workspace"]'),
    };
  })()`);
  check("全局工作区顶栏不遮挡原助手工具栏", globalHeaderMeasurement.pass, JSON.stringify(globalHeaderMeasurement));
  await openFileFromExplorer("code.ts");
  await waitFor(`!!document.querySelector(".workspace-code-preview > pre")`, "代码着色预览就绪");
  check(
    "真实代码预览使用紧凑行高",
    await evalJs(`(() => {
      const pre = document.querySelector(".workspace-code-preview > pre");
      if (!pre) return false;
      const style = getComputedStyle(pre);
      return Math.abs(Number.parseFloat(style.lineHeight) / Number.parseFloat(style.fontSize) - 1.45) < 0.025;
    })()`),
    await evalJs(`(() => {
      const pre = document.querySelector(".workspace-code-preview > pre");
      if (!pre) return "";
      const style = getComputedStyle(pre);
      return JSON.stringify({ lineHeight: style.lineHeight, fontSize: style.fontSize, ratio: Number.parseFloat(style.lineHeight) / Number.parseFloat(style.fontSize) });
    })()`),
  );
  const closeFilesForLink = async () => {
    await evalJs(`document.querySelector('[aria-label="收起文件工作区，返回对话"]')?.click(); true`);
    await waitFor(`!document.querySelector('[data-region="file-workspace"]')`, "链接测试前返回对话");
  };
  await closeFilesForLink();
  await clickButton("[data-local-file-path]", "相对笔记");
  await waitFor(`document.querySelector('[data-region="file-preview"]')?.dataset.status === "ready"`, "相对链接已打开");
  check("聊天相对路径链接打开当前工作区文件", (await previewText()).includes("hello workspace"), await previewText());
  await closeFilesForLink();
  await clickButton("[data-local-file-path]", "打开 CSV");
  await waitFor(
    `document.querySelector('[data-region="file-preview"]')?.dataset.status === "ready"`,
    "file 链接已打开",
  );
  check("聊天 file:// 链接打开真实 CSV", (await previewText()).includes("foo,42"), await previewText());
  await closeFilesForLink();
  for (const label of ["敏感文件", "越界"]) {
    await clickButton("[data-local-file-path]", label);
    await sleep(350);
    check(
      `聊天链接拒绝${label}并留在对话`,
      await evalJs(
        `!document.querySelector('[data-region="file-workspace"]') && !!document.querySelector('[aria-label="打开文件工作区"]')`,
      ),
    );
  }
  await waitFor(`document.querySelectorAll("[data-sonner-toast]").length === 0`, "提示层退出后再测键盘聚焦和指针命中");
  check(
    "危险协议没有链接或文件打开动作",
    await evalJs(
      `!document.querySelector('a[href^="javascript:"]') && !Array.from(document.querySelectorAll('[data-local-file-path]')).some((item) => item.textContent === "危险")`,
    ),
  );
  await evalJs(`(async () => {
    (await import("/src/store/file-workspace-store.ts")).useFileWorkspaceStore.getState().openFile("central", "central", ${JSON.stringify(root)}, { path: ${JSON.stringify(join(root, "code.ts"))} });
  })()`);
  await waitFor(`!!document.querySelector(".workspace-code-preview > pre")`, "恢复代码预览");
  check(
    "文件刷新不使用原生 title",
    (await evalJs(`document.querySelector('[aria-label="重新读取文件"]')?.title`)) === "",
  );
  await evalJs(`(() => {
    if (!document.querySelector('[aria-label="重新读取文件"]')) throw new Error("找不到刷新按钮");
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    return true;
  })()`);
  for (let i = 0; i < 80; i++) {
    if (await evalJs(`document.activeElement?.getAttribute("aria-label") === "重新读取文件"`)) break;
    await call("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Tab",
      code: "Tab",
      windowsVirtualKeyCode: 9,
      nativeVirtualKeyCode: 9,
    });
    await call("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Tab",
      code: "Tab",
      windowsVirtualKeyCode: 9,
      nativeVirtualKeyCode: 9,
    });
  }
  let refreshTooltip = false;
  for (let i = 0; i < 30; i++) {
    refreshTooltip = await evalJs(
      `Array.from(document.querySelectorAll('[role="tooltip"]')).some((item) => item.textContent === "重新读取文件" && item.getBoundingClientRect().width > 0)`,
    );
    if (refreshTooltip) break;
    await sleep(100);
  }
  const refreshFocusDetail = await evalJs(`(() => {
    const button = document.querySelector('[aria-label="重新读取文件"]');
    return {
      focused: document.activeElement === button,
      focusVisible: button?.matches(":focus-visible"),
      inert: !!button?.closest("[inert]"),
      triggerState: button?.getAttribute("data-state"),
      activeElement: document.activeElement?.outerHTML.slice(0, 240),
    };
  })()`);
  check("文件刷新聚焦后显示主题 Tooltip", refreshTooltip, JSON.stringify(refreshFocusDetail));
  await evalJs("document.activeElement?.blur(); true");
  await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
  await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
  for (let i = 0; i < 30; i++) {
    const openTooltips = await evalJs(
      `document.querySelectorAll('[data-slot="tooltip-content"]:not([data-state="closed"])').length`,
    );
    if (openTooltips === 0) break;
    await sleep(100);
  }
  const closingTooltipState = await evalJs(`(() => {
    const tooltips = Array.from(document.querySelectorAll('[data-slot="tooltip-content"][data-state="closed"]'));
    const pointerEvents = tooltips.map((item) => getComputedStyle(item).pointerEvents);
    return { count: tooltips.length, pointerEvents, pass: pointerEvents.every((value) => value === "none") };
  })()`);
  check("关闭中的 Tooltip 不拦截指针", closingTooltipState.pass, JSON.stringify(closingTooltipState));
  const toolbarHits = await evalJs(`(() => {
    const decoration = document.querySelector('[data-panel-viewport] .bg-gradient-to-b.blur-sm');
    const toggle = document.querySelector('[aria-label="收起文件工作区，返回对话"]');
    const toolbar = toggle?.closest(".relative.flex.h-10");
    const buttons = [
      ...Array.from(toolbar?.querySelectorAll("button") ?? []),
      ...Array.from(document.querySelectorAll('[data-region="file-workspace"] [role="tab"], [data-region="file-workspace"] [aria-label="关闭 report.csv"]')),
    ];
    const misses = [];
    for (const button of buttons) {
      const rect = button.getBoundingClientRect();
      for (const fx of [0.2, 0.5, 0.8]) for (const fy of [0.2, 0.5, 0.8]) {
        const x = rect.left + rect.width * fx;
        const y = rect.top + rect.height * fy;
        const hit = document.elementFromPoint(x, y);
        if (!hit || (hit !== button && !button.contains(hit))) misses.push({ button: button.getAttribute("aria-label") ?? button.textContent, x, y, hit: hit?.outerHTML?.slice(0, 180) ?? null });
      }
    }
    const popper = Array.from(document.querySelectorAll('[data-radix-popper-content-wrapper]')).map((el) => ({
      state: el.firstElementChild?.getAttribute('data-state'),
      pointerEvents: getComputedStyle(el).pointerEvents,
      childPointerEvents: el.firstElementChild ? getComputedStyle(el.firstElementChild).pointerEvents : null,
      text: el.textContent?.slice(0, 100),
    }));
    return { count: buttons.length, misses, popper, pointerEvents: decoration ? getComputedStyle(decoration).pointerEvents : null, ariaHidden: decoration?.getAttribute("aria-hidden") ?? null };
  })()`);
  check(
    "消息与文件标签存在时顶栏装饰不拦截真实命中",
    toolbarHits.pointerEvents === "none" &&
      toolbarHits.ariaHidden === "true" &&
      toolbarHits.count >= 6 &&
      toolbarHits.misses.length === 0,
    JSON.stringify(toolbarHits),
  );
  await clickButton('[aria-label="关闭 code.ts"]', "");
  await openFileFromExplorer("report.csv");
  const fileTogglePoint = await evalJs(`(() => {
    const button = document.querySelector('[aria-label="收起文件工作区，返回对话"]');
    if (!button) return null;
    const rect = button.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (fileTogglePoint) {
    await call("Input.dispatchMouseEvent", { type: "mousePressed", ...fileTogglePoint, button: "left", clickCount: 1 });
    await call("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      ...fileTogglePoint,
      button: "left",
      clickCount: 1,
    });
    await waitFor(`!document.querySelector('[data-region="file-workspace"]')`, "真实指针收起工作区");
  }
  const reopenPoint = await evalJs(`(() => {
    const button = document.querySelector('[aria-label="打开文件工作区"]');
    if (!button) return null;
    const rect = button.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (reopenPoint) {
    await call("Input.dispatchMouseEvent", { type: "mousePressed", ...reopenPoint, button: "left", clickCount: 1 });
    await call("Input.dispatchMouseEvent", { type: "mouseReleased", ...reopenPoint, button: "left", clickCount: 1 });
    await waitFor(
      `document.querySelector('[data-region="file-preview"][data-status="ready"]')`,
      "真实指针重开文件预览",
    );
  }
  check(
    "真实指针可收起并重开文件工作区",
    !!fileTogglePoint && !!reopenPoint && (await previewText()).includes("foo,42"),
  );
  await clickButton('[aria-label="收起文件工作区，返回对话"]', "");
  await clickButton('[data-region="changed-files"] [data-file-path]', "note.txt");
  await sleep(300);
  check(
    "TXT 成为第二个独立标签",
    (await tabsText()).join("|").includes("report.csv") && (await tabsText()).join("|").includes("note.txt"),
    await tabsText(),
  );
  check("TXT 预览内容正确", (await previewText()).includes("hello workspace"), await previewText());
  const shot = await call("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${outDir}/file-workspace-tabs.png`, Buffer.from(shot.result.data, "base64"));

  await evalJs(`(() => {
    const textarea = document.querySelector("textarea");
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(textarea, "draft-preserve");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    const log = document.querySelector("[role='log']");
    window.__workspaceScroll = { element: log, top: log?.scrollTop ?? 0 };
    return true;
  })()`);
  await clickButton('[aria-label="收起文件工作区，返回对话"]', "");
  await sleep(200);
  check(
    "返回后原聊天 DOM 与滚动位置保留",
    await evalJs(
      `window.__workspaceScroll.element === document.querySelector("[role='log']") && (document.querySelector("[role='log']")?.scrollTop ?? 0) === window.__workspaceScroll.top`,
    ),
  );
  check("返回后输入草稿保留", await evalJs(`document.querySelector("textarea")?.value === "draft-preserve"`));
  await clickButton('[aria-label="打开文件工作区"]', "");
  await sleep(250);
  check("重开工作区保留原标签", (await tabsText()).length === 2, await tabsText());

  await clickButton('[aria-label="关闭 note.txt"]', "");
  await sleep(200);
  check(
    "关闭活动标签后选中邻居",
    (await tabsText()).length === 1 && (await previewText()).includes("foo,42"),
    await tabsText(),
  );
  await clickButton('[aria-label="收起文件工作区，返回对话"]', "");
  await clickButton('[data-region="changed-files"] [data-file-path]', "note.txt");
  await sleep(200);
  check("关闭的标签可从清单重开", (await tabsText()).length === 2, await tabsText());

  await clickButton('[role="tab"]', "report.csv");
  await sleep(400);
  writeFileSync(join(root, "report.csv"), "name,value\nbar,99\n");
  await evalJs(`window.dispatchEvent(new Event("focus")); true`);
  await sleep(250);
  check("外部修改出现陈旧提示", await evalJs(`document.body.textContent.includes("磁盘内容已变化")`));
  await clickButton("button", "重新加载");
  await sleep(350);
  check("手动刷新后读取外部新内容", (await previewText()).includes("bar,99"), await previewText());

  await clickButton('[role="tab"]', "note.txt");
  rmSync(join(root, "note.txt"));
  await clickButton('[aria-label="重新读取文件"]', "");
  await sleep(400);
  check(
    "删除文件有明确状态",
    await evalJs(`document.querySelector('[data-region="file-preview"]')?.dataset.status === "deleted"`),
  );

  await openFileFromExplorer("big.txt");
  await sleep(400);
  const initialLength = (await previewText()).length;
  check("大文件首段限制在 256KiB 左右", initialLength < 300000, initialLength);
  check("大文件不会首段就包含末尾", !(await previewText()).includes("END"));
  for (let i = 0; i < 4; i++) {
    if ((await previewText()).includes("END")) break;
    await clickButton("button", "加载下一段");
    await sleep(250);
  }
  check("大文件分段续读可到达末尾", (await previewText()).includes("END"), (await previewText()).length);

  writeFileSync(join(root, "unicode.txt"), `前缀${"界".repeat(100000)}${"🙂".repeat(10)}END`);
  await refreshExplorer();
  await openFileFromExplorer("unicode.txt");
  await sleep(400);
  check(
    "UTF-8 跨分块字符不误判为二进制",
    await evalJs(`document.querySelector('[data-region="file-preview"]')?.dataset.status === "ready"`),
    (await previewText()).slice(0, 180),
  );
  for (let i = 0; i < 4; i++) {
    if ((await previewText()).includes("END")) break;
    await clickButton("button", "加载下一段");
    await sleep(250);
  }
  check(
    "多字节字符跨段后仍完整到达末尾",
    (await previewText()).includes("END") && !(await previewText()).includes("此格式暂不支持"),
    (await previewText()).slice(-120),
  );

  writeFileSync(join(root, "versioned.txt"), `BEGIN\n${"x".repeat(600000)}\nEND`);
  await refreshExplorer();
  await openFileFromExplorer("versioned.txt");
  await sleep(350);
  writeFileSync(join(root, "versioned.txt"), `BEGIN\n${"y".repeat(600000)}\nEND`);
  await clickButton("button", "加载下一段");
  await sleep(300);
  check(
    "分页中发现文件变化时保留旧版并提示",
    (await evalJs(`document.body.textContent.includes("磁盘内容已变化")`)) && !(await previewText()).includes("yyyy"),
    (await previewText()).slice(0, 180),
  );
  await clickButton("button", "重新加载");
  await sleep(350);
  for (let i = 0; i < 4; i++) {
    if ((await previewText()).includes("END")) break;
    await clickButton("button", "加载下一段");
    await sleep(250);
  }
  check(
    "重新加载后分页不混入旧版本",
    !(await previewText()).includes("BEGIN\nxxx") && (await previewText()).includes("END"),
    (await previewText()).slice(-120),
  );

  writeFileSync(
    join(root, "invalid-late.txt"),
    Buffer.concat([Buffer.from(`BEGIN\n${"x".repeat(600000)}`), Buffer.from([255])]),
  );
  await refreshExplorer();
  if (!(await openFileFromExplorer("invalid-late.txt"))) {
    throw new Error("目录中找不到 invalid-late.txt");
  }
  let invalidReady = false;
  for (let i = 0; i < 30; i++) {
    invalidReady = await evalJs(
      `document.querySelector('[data-region="file-preview"]')?.dataset.status === "ready" && document.querySelector('[role="tab"][aria-selected="true"]')?.textContent === "invalid-late.txt"`,
    );
    if (invalidReady) break;
    await sleep(100);
  }
  if (!invalidReady) throw new Error("invalid-late.txt 预览未就绪");
  for (let i = 0; i < 4; i++) {
    await clickButton("button", "加载下一段");
    await sleep(300);
    if ((await previewText()).includes("UTF-8")) break;
  }
  check(
    "后段异常二进制会显示错误而不是静默停止",
    (await previewText()).includes("UTF-8"),
    (await previewText()).slice(-180),
  );

  check(
    "reader 使用独立生效根",
    await evalJs(`(async () => {
    const files = await import("${workspaceFilesModule}");
    const root = await files.resolveAgentWorkspaceRoot("reader");
    const chunk = await files.readWorkspaceChunk("reader", ${JSON.stringify(join(readerRoot, "reader.txt"))});
    return chunk.content === "reader-root" && root.resolved === ${JSON.stringify(readerRoot)};
  })()`),
  );
  check(
    "paper 使用独立生效根",
    await evalJs(`(async () => {
    const files = await import("${workspaceFilesModule}");
    const root = await files.resolveAgentWorkspaceRoot("paper");
    const chunk = await files.readWorkspaceChunk("paper", ${JSON.stringify(join(paperRoot, "paper.txt"))});
    return chunk.content === "paper-root" && root.resolved === ${JSON.stringify(paperRoot)};
  })()`),
  );

  await evalJs(
    `(async () => (await import("/src/store/agent-settings-store.ts")).useAgentSettingsStore.getState().setSafetyMode("strict"))()`,
  );
  await evalJs(`(async () => {
    const files = await import("${workspaceFilesModule}");
    window.__sensitivePreview = files.statWorkspaceFile("central", ${JSON.stringify(join(root, ".env"))})
      .then((value) => ({ value }))
      .catch((error) => ({ error: String(error) }))
      .then((outcome) => {
        window.__sensitiveOutcome = outcome;
        return outcome;
      });
    return true;
  })()`);
  await waitFor(
    `(async () => (await import(${JSON.stringify(confirmationModule)})).useAgentConfirmStore.getState().queue.some((item) => item.detail.includes(".env")) || !!window.__sensitiveOutcome)()`,
    "敏感文件确认或拒绝",
  );
  if (
    await evalJs(
      `(async () => (await import(${JSON.stringify(confirmationModule)})).useAgentConfirmStore.getState().queue.length > 0)()`,
    )
  ) {
    await clickButton("button", "允许");
  }
  const sensitive = await evalJs("window.__sensitivePreview");
  check("敏感文件名即使给出授权也不能读取", sensitive?.error?.includes("凭据"), JSON.stringify(sensitive));

  await evalJs(`(() => {
    const historyOpen = ${globalHistoryOpenSource};
    if (!historyOpen) document.querySelector('[data-panel-viewport] button:has(svg.lucide-history)')?.click();
    return true;
  })()`);
  await waitFor(`${globalHistoryOpenSource}`, "历史面板真实可见");
  await evalJs(`(async () => {
    const files = await import("${workspaceFilesModule}");
    window.__outsideAbort = new AbortController();
    window.__outsidePreview = files.readWorkspaceChunk("central", ${JSON.stringify(join(outside, "outside.txt"))}, 0, 64, { abortSignal: window.__outsideAbort.signal })
      .then((value) => ({ value }))
      .catch((error) => ({ error: String(error) }));
    return true;
  })()`);
  let queued = false;
  for (let i = 0; i < 30; i++) {
    queued = await evalJs(
      `(async () => (await import(${JSON.stringify(confirmationModule)})).useAgentConfirmStore.getState().queue.length === 1)()`,
    );
    if (queued) break;
    await sleep(100);
  }
  check("界外 strict 读取先弹确认而不直接返回内容", queued);
  const allowed = await clickButton("button", "允许");
  check("历史面板中确认卡仍然可见", allowed);
  if (!allowed) await evalJs("window.__outsideAbort.abort()");
  const outsideResult = await evalJs("(async () => await window.__outsidePreview)()");
  check("用户允许后界外内容才可读取", outsideResult?.value?.content === "outside-ok", JSON.stringify(outsideResult));

  await evalJs(`(async () => {
    const files = await import("${workspaceFilesModule}");
    window.__rejectAbort = new AbortController();
    window.__rejectPreview = files.readWorkspaceChunk("central", ${JSON.stringify(join(outside, "reject.txt"))}, 0, 64, { abortSignal: window.__rejectAbort.signal })
      .then((value) => ({ value }))
      .catch((error) => ({ error: String(error) }));
    return true;
  })()`);
  await waitFor(
    `(async () => (await import(${JSON.stringify(confirmationModule)})).useAgentConfirmStore.getState().queue.length > 0)()`,
    "界外拒绝确认卡",
  );
  const rejectBefore = await evalJs(
    `(async () => (await import(${JSON.stringify(confirmationModule)})).useAgentConfirmStore.getState().queue.map((item) => ({ title: item.title, detail: item.detail })))()`,
  );
  const rejectClick = await evalJs(`(() => {
    const button = Array.from(document.querySelectorAll("button")).find((item) => item.textContent.trim() === "拒绝" && item.offsetParent !== null && !item.disabled && !item.closest("[inert]"));
    if (!button) return { clicked: false, buttons: Array.from(document.querySelectorAll("button")).filter((item) => /拒绝|允许/.test(item.textContent)).map((item) => ({ text: item.textContent, disabled: item.disabled, inert: !!item.closest("[inert]"), visible: item.offsetParent !== null })) };
    button.click();
    return { clicked: true };
  })()`);
  await sleep(100);
  const rejectQueueAfter = await evalJs(
    `(async () => (await import(${JSON.stringify(confirmationModule)})).useAgentConfirmStore.getState().queue.length)()`,
  );
  check(
    "拒绝按钮真实解除确认",
    rejectClick.clicked && rejectQueueAfter === 0,
    JSON.stringify({ rejectBefore, rejectClick, rejectQueueAfter }),
  );
  if (rejectQueueAfter !== 0) {
    await evalJs("window.__rejectAbort.abort(); true");
    throw new Error("拒绝按钮未解除确认");
  }
  const rejectResult = await evalJs("(async () => await window.__rejectPreview)()");
  check("用户拒绝后不读取界外文件", rejectResult?.error?.includes("用户已拒绝"), JSON.stringify(rejectResult));

  const commandResult = await evalJs(`(async () => {
    const guard = await import("/src/ai/utils/tool-guard.ts");
    const command = await import("/src/ai/tools/central/run-command.ts");
    const tools = guard.wrapToolsWithGuard({ runCommand: command.runCommandTool }, "central");
    window.__commandPreview = tools.runCommand.execute({ reasoning: "验收命令产物", command: "python -c \\"from pathlib import Path; Path('cmd.txt').write_text('command-output', encoding='utf-8')\\"", artifactPaths: ["cmd.txt"] }, { toolCallId: "workspace-command", messages: [], context: undefined });
    return true;
  })()`);
  await sleep(300);
  await clickButton("button", "允许");
  const command = await evalJs("(async () => await window.__commandPreview)()");
  check(
    "命令实际产物带 verified changes",
    command?.results?.changes?.[0]?.verified === true && command?.results?.changes?.[0]?.path?.endsWith("cmd.txt"),
    JSON.stringify(command),
  );
} catch (error) {
  checks.push({ name: "验收执行异常", pass: false, detail: error instanceof Error ? error.stack : String(error) });
} finally {
  await evalJs(`(async () => {
    window.__rejectAbort?.abort();
    window.__outsideAbort?.abort();
    delete window.__rejectAbort;
    delete window.__outsideAbort;
    delete window.__sensitivePreview;
    delete window.__sensitiveOutcome;
    const previous = window.__workspaceTestPrevious ?? ${JSON.stringify(previousSettings)};
    delete window.__workspaceTestPrevious;
    if (previous) {
      const agent = (await import("/src/store/agent-settings-store.ts")).useAgentSettingsStore.getState();
      agent.setWorkspaceRoot(previous.workspaceRoot);
      agent.setPerAgentRoot("reader", previous.perAgentRoots.reader ?? null);
      agent.setPerAgentRoot("paper", previous.perAgentRoots.paper ?? null);
      agent.setPerAgentRoot("central", previous.perAgentRoots.central ?? null);
      agent.setSafetyMode(previous.safetyMode);
      agent.setDocumentToolMode(previous.documentToolMode);
      (await import("/src/store/file-workspace-store.ts")).useFileWorkspaceStore.setState({ hosts: previous.hosts, recentRoots: previous.recentRoots });
      (await import(${JSON.stringify(confirmationModule)})).useAgentConfirmStore.setState({ queue: previous.queue, sessionAllowlist: previous.sessionAllowlist, previewGrants: previous.previewGrants });
      const historyOpen = ${globalHistoryOpenSource};
      if (previous.historyOpen !== historyOpen) {
        document.querySelector('[data-panel-viewport] button:has(svg.lucide-history)')?.click();
        for (let i = 0; i < 50 && (${globalHistoryOpenSource}) !== previous.historyOpen; i++) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    }
    const providers = (await import("${providerStoreModule}")).useProviderStore;
    const saved = window.__workspaceProviderPrevious;
    if (saved) {
      providers.getState().setModelProviders(saved.providers);
      providers.getState().setSelectedModel(saved.selected);
      providers.getState().setUtilityModel(saved.utility);
      delete window.__workspaceProviderPrevious;
    }
    if (previous) {
      (await import("/src/store/task-workspace-store.ts")).useTaskWorkspaceStore.setState({ pendingRoots: previous.pendingRoots, threadRoots: previous.threadRoots });
    }
    if (window.__workspaceDirectoryPrevious === undefined) delete window.__SAGEREAD_DISABLE_DIRECTORY__;
    else window.__SAGEREAD_DISABLE_DIRECTORY__ = window.__workspaceDirectoryPrevious;
    delete window.__workspaceDirectoryPrevious;
    delete window.__runningToolGroup;
    delete window.__runningToolText;
    delete window.__workspaceScroll;
    return true;
  })()`).catch(() => {});
  ws.close();
  modelServer.closeAllConnections();
  await new Promise((resolve) => modelServer.close(resolve));
  rmSync(root, { recursive: true, force: true });
  rmSync(defaultRoot, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  rmSync(readerRoot, { recursive: true, force: true });
  rmSync(paperRoot, { recursive: true, force: true });
}
const report = {
  checks,
  modelRequests,
  exceptions: exceptions.map((item) => item.exception?.description ?? item.text).filter(Boolean),
};
writeFileSync(`${outDir}/file-workspace-ui.json`, JSON.stringify(report, null, 2));
for (const item of checks)
  console.log(`${item.pass ? "PASS" : "FAIL"} ${item.name}${item.detail ? ` | ${item.detail}` : ""}`);
if (report.exceptions.length) console.log("页面异常:", report.exceptions);
if (checks.some((item) => !item.pass) || report.exceptions.length) process.exit(1);
console.log(`\n${checks.filter((item) => item.pass).length}/${checks.length} PASS`);
