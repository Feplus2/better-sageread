import { mkdirSync, writeFileSync } from "node:fs";

const cdpPort = process.env.CDP_PORT ?? "9224";
const appPort = process.env.APP_PORT ?? "1421";
const outDir = process.env.VERIFY_OUT ?? ".superpowers/sdd/2026-11-06-user-acceptance-followup/real-game";
const workspace = `${process.cwd().replace(/\\/g, "/")}/.superpowers/sdd/2026-11-06-user-acceptance-followup/real-game-workspace`;
mkdirSync(outDir, { recursive: true });
mkdirSync(workspace, { recursive: true });
const pages = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
const page = pages.find((target) => target.type === "page" && target.url?.includes(`localhost:${appPort}`));
if (!page) throw new Error("找不到隔离 Preview");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let seq = 0;
const pending = new Map();
const contexts = new Map();
const exceptions = [];
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
  if (message.method === "Runtime.executionContextCreated")
    contexts.set(message.params.context.id, message.params.context);
  if (message.method === "Runtime.executionContextDestroyed") contexts.delete(message.params.executionContextId);
  if (message.method === "Runtime.executionContextsCleared") contexts.clear();
  if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails);
};
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP 超时：${method}`));
    }, 240000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression, contextId) => {
  const result = await call("Runtime.evaluate", { expression, contextId, awaitPromise: true, returnByValue: true });
  if (result.result?.exceptionDetails)
    throw new Error(result.result.exceptionDetails.exception?.description ?? result.result.exceptionDetails.text);
  return result.result?.result?.value;
};
const evalHtmlFrame = async (expression) => {
  const document = await call("DOM.getDocument", { depth: 0, pierce: true });
  const query = await call("DOM.querySelector", {
    nodeId: document.result.root.nodeId,
    selector: 'iframe[title="game.html"]',
  });
  if (!query.result.nodeId) throw new Error("找不到 game.html iframe");
  const owner = await call("DOM.describeNode", { nodeId: query.result.nodeId });
  const tree = await call("Page.getFrameTree");
  const outer = tree.result.frameTree.childFrames?.find((frame) => frame.frame.id === owner.result.node.frameId);
  const frameId = outer?.childFrames?.[0]?.frame?.id ?? owner.result.node.frameId;
  const context = Array.from(contexts.values()).find(
    (item) => item.auxData?.frameId === frameId && item.auxData?.isDefault === true,
  );
  if (!context) throw new Error("找不到 game.html 的主沙箱执行上下文");
  return evaluate(expression, context.id);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (expression, label, attempts = 120) => {
  for (let index = 0; index < attempts; index += 1) {
    if (await evaluate(`(async () => Boolean(await (${expression})))()`)) return;
    await sleep(150);
  }
  throw new Error(`等待超时：${label}`);
};
const waitForHtmlFrame = async (expression, label, attempts = 120) => {
  let lastError;
  for (let index = 0; index < attempts; index += 1) {
    try {
      if (await evalHtmlFrame(`Boolean(${expression})`)) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(150);
  }
  throw new Error(`等待超时：${label}${lastError ? `；${String(lastError)}` : ""}`);
};
const selectGlobalThread = async (threadId) => {
  const title = await evaluate(
    `(async () => (await (await import("/src/services/thread-service.ts")).getThreadById(${JSON.stringify(threadId)}))?.title)()`,
  );
  if (typeof title !== "string") throw new Error("历史对话不存在");
  await evaluate(`(() => {
    if (!document.querySelector('[data-panel-viewport] [data-region="assistant-history-panel"]')) {
      const button = document.querySelector('[data-panel-viewport] button:has(svg.lucide-history)');
      if (!button) throw new Error("找不到全局历史对话按钮");
      button.click();
    }
    return true;
  })()`);
  await waitFor(
    `Array.from(document.querySelectorAll('[data-panel-viewport] .chat-thread-card h3')).some((item) => item.textContent === ${JSON.stringify(title)})`,
    "目标历史对话可见",
  );
  await evaluate(`(() => {
    const heading = Array.from(document.querySelectorAll('[data-panel-viewport] .chat-thread-card h3')).find((item) => item.textContent === ${JSON.stringify(title)});
    const button = heading?.closest(".chat-thread-card");
    if (!button) throw new Error("找不到目标历史对话卡片");
    button.click();
    return true;
  })()`);
  await waitFor(
    `(async () => (await import("/src/store/chat-reader-store.ts")).useChatReaderStore.getState().currentThread?.id === ${JSON.stringify(threadId)})() && !document.querySelector('[data-panel-viewport] [data-region="assistant-history-panel"]')`,
    "历史对话已选中并返回正文",
  );
};
const checks = [];
const check = (name, pass, detail = "") => {
  checks.push({ name, pass: Boolean(pass), detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` | ${detail}` : ""}`);
};
const shot = async (name) => {
  await evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))");
  const image = await call("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${outDir}/${name}.png`, Buffer.from(image.result.data, "base64"));
};
let previous;
let report = {};
try {
  await call("Runtime.enable");
  await call("DOM.enable");
  await call("Page.enable");
  const previewDataDir = await evaluate(`(async () => (await import("/@id/@tauri-apps/api/path")).appDataDir())()`);
  if (!previewDataDir.includes("com.bettersageread.preview") && process.env.ALLOW_DAILY !== "1") {
    throw new Error(`拒绝在非隔离数据目录运行真实交付探针：${previewDataDir}`);
  }
  const model = await evaluate(`(async () => {
    const store = (await import("/src/store/provider-store.ts")).useProviderStore.getState();
    const selected = store.selectedModel;
    const provider = store.modelProviders.find((item) => item.provider === selected?.providerId);
    const declared = provider?.models.find((item) => item.id === selected?.modelId)?.maxOutputTokens;
    const { resolveMaxOutputTokens } = await import("/src/ai/providers/context-window.ts");
    return { selected, declared, maxOutputTokens: resolveMaxOutputTokens(selected?.providerId ?? "", declared) };
  })()`);
  check(
    "真实 DeepSeek 输出预算已接入",
    model.selected?.providerId === "deepseek" && model.maxOutputTokens > 4096,
    JSON.stringify(model),
  );
  previous = await evaluate(`(async () => {
    const agent = (await import("/src/store/agent-settings-store.ts")).useAgentSettingsStore.getState();
    const files = (await import("/src/store/file-workspace-store.ts")).useFileWorkspaceStore.getState();
    const layout = (await import("/src/store/layout-store.ts")).useLayoutStore.getState();
    const thread = (await import("/src/store/chat-reader-store.ts")).useChatReaderStore.getState().currentThread;
    return {
      agent: { workspaceRoot: agent.workspaceRoot, perAgentRoots: agent.perAgentRoots, safetyMode: agent.safetyMode },
      fileWorkspace: { hosts: files.hosts, recentRoots: files.recentRoots },
      layout: { tabs: layout.tabs, activeTabId: layout.activeTabId, isHomeActive: layout.isHomeActive, isChatVisible: layout.isChatVisible, isNotepadVisible: layout.isNotepadVisible, tabOrientation: layout.tabOrientation, isVerticalTabCollapsed: layout.isVerticalTabCollapsed },
      thread,
    };
  })()`);
  await evaluate(`(async () => {
    const agent = (await import("/src/store/agent-settings-store.ts")).useAgentSettingsStore.getState();
    agent.setWorkspaceRoot(${JSON.stringify(workspace)});
    agent.setSafetyMode("strict");
    (await import("/src/store/file-workspace-store.ts")).useFileWorkspaceStore.getState().closeWorkspace("central");
    const layout = (await import("/src/store/layout-store.ts")).useLayoutStore.getState();
    layout.navigateToHome();
    location.hash = "#/chat";
    return true;
  })()`);
  const replayThreadId = process.env.REPLAY_THREAD_ID;
  if (replayThreadId) {
    await waitFor(
      `(() => {
      const input = document.querySelector('[data-panel-viewport] textarea');
      return input && getComputedStyle(input).visibility === "visible" && !input.closest("[inert]");
    })()`,
      "全局对话初始化完成",
    );
    await selectGlobalThread(replayThreadId);
    report = await evaluate(`(async () => {
      const thread = (await import("/src/store/chat-reader-store.ts")).useChatReaderStore.getState().currentThread;
      const last = thread?.messages?.at(-1);
      if (thread?.id !== ${JSON.stringify(replayThreadId)} || last?.role !== "assistant" || !last.metadata?.finishReason) {
        throw new Error("历史对话没有加载出原真实回答的完成元数据");
      }
      return {
        threadId: thread.id,
        messageId: last.id,
        finishReason: last.metadata.finishReason,
        interrupted: last.metadata.interrupted === true,
        usage: last.metadata.totalUsage,
        replayed: true,
      };
    })()`);
    await waitFor(
      `document.querySelector('[data-panel-viewport] [data-message-files="${report.messageId}"]')`,
      "原真实回答与交付卡已加载",
    );
  } else {
    await waitFor(
      `(() => {
      const input = document.querySelector('[data-panel-viewport] textarea');
      return input && getComputedStyle(input).visibility === "visible" && !input.closest("[inert]");
    })()`,
      "可见且可交互的全局对话输入框",
    );
    await evaluate(`(() => {
      const root = document.querySelector('[data-panel-viewport]');
      const button = Array.from(root?.querySelectorAll("button") ?? []).find((item) =>
        item.querySelector("svg.lucide-message-circle-plus") && getComputedStyle(item).visibility === "visible"
      );
      if (!button) throw new Error("找不到全局新对话按钮");
      button.click();
      return true;
    })()`);
    await waitFor(
      `(() => {
      const input = document.querySelector('[data-panel-viewport] textarea');
      return input && !input.value && getComputedStyle(input).visibility === "visible" && !input.closest("[inert]");
    })()`,
      "全局空白新对话",
    );
    await evaluate(`(() => {
      const input = document.querySelector('[data-panel-viewport] textarea');
      input.focus();
      input.select();
      if (document.activeElement !== input) throw new Error("全局输入框没有获得焦点");
      return true;
    })()`);
    await call("Input.insertText", {
      text: '请在当前工作区用 writeFile 创建 game.html 和 README.md。game.html 是一个完全离线的中文点击计分小游戏，内联 CSS 和 JavaScript，不使用任何外部资源。必须包含 id="score" 的按钮，初始只显示数字 0，每次点击数字加 1；另外显示简短玩法提示。README.md 简要说明玩法。完成后用 present 把 game.html 作为本轮交付物附上描述，再用 present 把 README.md 作为使用说明交付。不要运行命令，不要创建测试脚本或其他文件。',
    });
    await waitFor(
      `document.querySelector('[data-panel-viewport] textarea')?.value.includes("game.html")`,
      "原生输入已进入可见的全局输入框",
    );
    await waitFor(
      `(() => {
      const input = document.querySelector('[data-panel-viewport] textarea');
      return input?.closest(".cursor-text")?.querySelector("button:has(svg.lucide-arrow-up):not([disabled])");
    })()`,
      "实际发送按钮可用",
    );
    await evaluate(`(() => {
      const input = document.querySelector('[data-panel-viewport] textarea');
      const button = input?.closest(".cursor-text")?.querySelector("button:has(svg.lucide-arrow-up):not([disabled])");
      if (!button) throw new Error("输入后发送按钮仍不可用");
      button.click();
      return true;
    })()`);
    report = await evaluate(`(async () => {
      const store = (await import("/src/store/chat-reader-store.ts")).useChatReaderStore;
      const started = Date.now();
      while (Date.now() - started < 220000) {
        const thread = store.getState().currentThread;
        const last = thread?.messages?.at(-1);
        if (last?.role === "assistant" && last.metadata?.finishReason) {
          return {
            threadId: thread.id,
            messageId: last.id,
            finishReason: last.metadata.finishReason,
            interrupted: last.metadata.interrupted === true,
            usage: last.metadata.totalUsage,
          };
        }
        const error = document.querySelector('[role="alert"]')?.textContent;
        if (error) return { error };
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return { error: "真实 DeepSeek 在限定时间内没有完成" };
    })()`);
    if (report.error) throw new Error(report.error);
  }
  check(
    "真实模型完整结束而不是预算截断",
    report.finishReason !== "length" && !report.interrupted,
    JSON.stringify(report),
  );
  const cards = await evaluate(`(() => {
    const card = document.querySelector('[data-panel-viewport] [data-message-files="${report.messageId}"]');
    card?.scrollIntoView({ block: "nearest", behavior: "instant" });
    const content = card?.parentElement;
    const rect = card?.getBoundingClientRect();
    const toggle = card?.querySelector('[aria-label^="已编辑"]');
    const presented = Array.from(card?.querySelectorAll('[data-region="presented-files"] [data-file-path]') ?? []).map((item) => ({
      path: item.getAttribute("data-file-path").replace(/\\\\/g, "/"),
      text: item.textContent,
    }));
    return {
      messageId: ${JSON.stringify(report.messageId)},
      changedLabel: toggle?.getAttribute("aria-label"),
      changedExpanded: toggle?.getAttribute("aria-expanded"),
      presented,
      hasNewFileLabel: card?.textContent.includes("本次新建") ?? false,
      insideInput: Boolean(document.querySelector('[data-panel-viewport] .cursor-text [data-message-files]')),
      visibleAtMessageEnd: Boolean(card && content?.dataset.messageId === ${JSON.stringify(report.messageId)} &&
        content.lastElementChild === card && getComputedStyle(card).visibility === "visible" &&
        !card.closest("[inert]") && rect.width > 0 && rect.top >= 0 && rect.bottom <= window.innerHeight),
    };
  })()`);
  check(
    "编辑清单按轮默认折叠",
    cards.changedLabel === "已编辑 2 个文件" && cards.changedExpanded === "false",
    JSON.stringify(cards),
  );
  check(
    "game.html 与 README.md 由 present 显式交付",
    cards.presented.length === 2 &&
      cards.presented.some((item) => item.path.endsWith("/game.html")) &&
      cards.presented.some((item) => item.path.endsWith("/README.md")),
    JSON.stringify(cards.presented),
  );
  check("新建文件不冒充交付物，卡片不放进输入框", !cards.hasNewFileLabel && !cards.insideInput, JSON.stringify(cards));
  check("交付卡真实可见且在对应回答正文尾部", cards.visibleAtMessageEnd, JSON.stringify(cards));
  await shot("real-game-delivery");
  await evaluate(`(() => {
    const item = Array.from(document.querySelectorAll('[data-panel-viewport] [data-region="presented-files"] [data-file-path]')).find((el) => el.getAttribute("data-file-path").replace(/\\\\/g, "/").endsWith("/game.html"));
    if (!item) throw new Error("找不到 game.html 交付卡");
    item.click();
    return true;
  })()`);
  await waitFor(`document.querySelector('[data-region="file-preview"] iframe[title="game.html"]')`, "HTML 隔离预览");
  await evaluate(`document.querySelector('[aria-label="查看 HTML 代码"]').click(); true`);
  await waitFor(`document.querySelector('[data-region="file-preview"]').textContent.includes("score")`, "游戏源码");
  check(
    "代码视图可查看真实游戏源码",
    await evaluate(
      `!document.querySelector('[data-region="file-preview"] iframe') && document.querySelector('[data-region="file-preview"]').textContent.includes("score")`,
    ),
  );
  await evaluate(`document.querySelector('[aria-label="预览 HTML"]').click(); true`);
  await waitFor(`document.querySelector('[data-region="file-preview"] iframe[title="game.html"]')`, "返回游戏预览");
  await waitForHtmlFrame(
    `document.readyState === "complete" && document.querySelector("#score")?.textContent === "0"`,
    "新游戏文档加载与初始分数",
  );
  const initialScore = await evalHtmlFrame(`document.querySelector("#score")?.textContent`);
  await evalHtmlFrame(`document.querySelector("#score").click(); true`);
  const gameScore = await evalHtmlFrame(`document.querySelector("#score")?.textContent`);
  check(
    "真实小游戏在隔离预览中可玩",
    initialScore === "0" && gameScore === "1",
    JSON.stringify({ initialScore, afterClick: gameScore }),
  );
  report.game = { initialScore, afterClick: gameScore };
  const outerBounds = await evaluate(
    `document.querySelector('[data-region="file-preview"] iframe[title="game.html"]')?.getBoundingClientRect().toJSON()`,
  );
  const innerBounds = await evalHtmlFrame(
    `({ height: window.innerHeight, button: document.querySelector("#score")?.getBoundingClientRect().toJSON() })`,
  );
  const geometry = { outerHeight: outerBounds?.height, innerHeight: innerBounds?.height, button: innerBounds?.button };
  check(
    "隔离壳占满预览区域且游戏按钮完整可见",
    geometry.outerHeight >= 400 &&
      Math.abs(geometry.innerHeight - geometry.outerHeight) <= 1 &&
      geometry.button?.top >= 0 &&
      geometry.button?.bottom <= geometry.innerHeight,
    JSON.stringify(geometry),
  );
  report.game.geometry = geometry;
  const sandbox = await evaluate(`(() => {
    const frame = document.querySelector('[data-region="file-preview"] iframe[title="game.html"]');
    return { sandbox: frame?.getAttribute("sandbox"), referrer: frame?.referrerPolicy };
  })()`);
  check(
    "HTML 仅 allow-scripts，不开放同源权限",
    sandbox.sandbox === "allow-scripts" && !sandbox.sandbox.includes("allow-same-origin"),
    JSON.stringify(sandbox),
  );
  await shot("real-game-html-preview");
  report.cards = cards;
  report.sandbox = sandbox;
} catch (error) {
  check("真实 DeepSeek 验收执行异常", false, error instanceof Error ? error.stack : String(error));
} finally {
  try {
    if (previous?.thread && !previous.thread.book_id) await selectGlobalThread(previous.thread.id);
    if (previous?.thread === null) {
      await evaluate(
        `document.querySelector('[data-panel-viewport] button:has(svg.lucide-message-circle-plus)').click(); true`,
      );
    }
    await evaluate(`(async () => {
      const previous = ${JSON.stringify(previous ?? {})};
      if (previous.agent) {
        const agent = (await import("/src/store/agent-settings-store.ts")).useAgentSettingsStore.getState();
        agent.setWorkspaceRoot(previous.agent.workspaceRoot);
        agent.setSafetyMode(previous.agent.safetyMode);
        for (const scope of ["central", "reader", "paper"]) agent.setPerAgentRoot(scope, previous.agent.perAgentRoots?.[scope] ?? null);
      }
      if (previous.thread?.book_id) (await import("/src/store/chat-reader-store.ts")).useChatReaderStore.getState().setCurrentThread(previous.thread);
      if (previous.fileWorkspace) (await import("/src/store/file-workspace-store.ts")).useFileWorkspaceStore.setState(previous.fileWorkspace);
      if (previous.layout) (await import("/src/store/layout-store.ts")).useLayoutStore.setState(previous.layout);
      return true;
    })()`);
  } catch (error) {
    check("预览状态恢复异常", false, error instanceof Error ? error.stack : String(error));
  }
  ws.close();
}
report.exceptions = exceptions.map((item) => item.exception?.description ?? item.text).filter(Boolean);
writeFileSync(`${outDir}/report.json`, JSON.stringify(report, null, 2));
if (checks.some((item) => !item.pass) || report.exceptions.length) process.exit(1);
console.log(`${checks.length}/${checks.length} PASS`);
