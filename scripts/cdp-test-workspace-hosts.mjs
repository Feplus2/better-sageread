import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cdpPort = process.env.CDP_PORT ?? "9224";
const appPort = process.env.APP_PORT ?? "1421";
const outDir = process.env.VERIFY_OUT ?? ".superpowers/sdd/devil-dinosaur-aquaman-riri-williams/hosts";
mkdirSync(outDir, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "workspace-hosts-")).replace(/\\/g, "/");
const readerRoot = mkdtempSync(join(tmpdir(), "workspace-host-reader-")).replace(/\\/g, "/");
const paperRoot = mkdtempSync(join(tmpdir(), "workspace-host-paper-")).replace(/\\/g, "/");
writeFileSync(join(readerRoot, "reader.txt"), "reader-root");
writeFileSync(join(paperRoot, "paper.txt"), "paper-root");
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
let activeContextId = 0;
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
  if (message.method === "Runtime.executionContextCreated") {
    const context = message.params.context;
    if (context.auxData?.isDefault && context.origin === new URL(page.url).origin) activeContextId = context.id;
  }
  if (message.method === "Runtime.executionContextDestroyed" && message.params.executionContextId === activeContextId)
    activeContextId = 0;
  if (message.method === "Runtime.executionContextsCleared") activeContextId = 0;
  if (
    message.method === "Runtime.exceptionThrown" &&
    message.params.exceptionDetails.executionContextId === activeContextId
  ) {
    exceptions.push(message.params.exceptionDetails);
  }
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
const evalJs = async (expression) => {
  const response = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.result?.exceptionDetails)
    throw new Error(response.result.exceptionDetails.exception?.description ?? response.result.exceptionDetails.text);
  return response.result?.result?.value;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (expression, description, root = "") => {
  for (let i = 0; i < 100; i++) {
    if (await evalJs(`(async () => Boolean(await (${expression})))()`)) return;
    await sleep(100);
  }
  throw new Error(`等待超时：${description}${root ? `；${await evalJs(root)}` : ""}`);
};
const checks = [];
const check = (name, pass, detail = "") => {
  checks.push({ name, pass: !!pass, detail: String(detail) });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` | ${String(detail).slice(0, 400)}` : ""}`);
};
let previous;
try {
  previous = await evalJs(`(async () => {
    const agentStore = (await import("/src/store/agent-settings-store.ts")).useAgentSettingsStore;
    const fileStore = (await import("/src/store/file-workspace-store.ts")).useFileWorkspaceStore;
    for (let i = 0; i < 100 && (!agentStore.persist.hasHydrated() || !fileStore.persist.hasHydrated()); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    const agent = agentStore.getState();
    const files = fileStore.getState();
    const previous = { workspaceRoot: agent.workspaceRoot, perAgentRoots: agent.perAgentRoots, safetyMode: agent.safetyMode, documentToolMode: agent.documentToolMode, hosts: files.hosts, recentRoots: files.recentRoots };
    window.__hostsPrevious = previous;
    agent.setWorkspaceRoot(${JSON.stringify(root)});
    agent.setPerAgentRoot("central", null);
    agent.setPerAgentRoot("reader", ${JSON.stringify(readerRoot)});
    agent.setPerAgentRoot("paper", ${JSON.stringify(paperRoot)});
    agent.setSafetyMode("strict");
    agent.setDocumentToolMode("new");
    fileStore.setState({ hosts: {}, recentRoots: {} });
    const configuredRoots = agentStore.getState().perAgentRoots;
    if (configuredRoots.reader !== ${JSON.stringify(readerRoot)} || configuredRoots.paper !== ${JSON.stringify(paperRoot)}) {
      throw new Error("宿主 fixture 根初始化失败：" + JSON.stringify(configuredRoots));
    }
    return true;
  })()`);
  await evalJs(`(async () => {
    (await import("/src/store/layout-store.ts")).useLayoutStore.getState().navigateToHome();
    location.hash = "#/chat";
    document.querySelector('[data-panel-viewport] [data-region="assistant-history-panel"] button:has(svg.lucide-arrow-left)')?.click();
    return true;
  })()`);
  await waitFor(
    `(() => {
      const button = document.querySelector("button:has(svg.lucide-message-circle-plus)");
      return !!button && !button.closest("[inert]") && getComputedStyle(button).visibility === "visible";
    })()`,
    "可见的全局新对话按钮",
  );
  await evalJs(`(() => {
    const button = document.querySelector("button:has(svg.lucide-message-circle-plus)");
    if (!button) throw new Error("找不到全局新对话按钮");
    button.click();
    return true;
  })()`);
  await waitFor(
    `Array.from(document.querySelectorAll("h1")).some((item) => item.textContent === "How can I help you today?")`,
    "全局空对话",
  );
  const centralChip = await evalJs(`(() => {
    const button = document.querySelector('[aria-label^="选择全局助手的任务工作区"]');
    if (!button) return { pass: false, reason: "空状态没有任务工作区入口" };
    const rect = button.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return { pass: rect.width > 0 && rect.height > 0 && (hit === button || button.contains(hit)), rect: rect.toJSON(), hit: hit?.outerHTML?.slice(0, 180) };
  })()`);
  check("全局空对话可在首轮前选择任务工作区", centralChip.pass, JSON.stringify(centralChip));
  await evalJs(`(async () => {
    const hookSource = await (await fetch("/src/hooks/use-stream-reveal.ts")).text();
    const mainSource = await (await fetch("/src/main.tsx")).text();
    const chatSource = await (await fetch("/src/hooks/use-chat-state.ts")).text();
    const moduleUrl = (source, marker) => {
      const start = source.indexOf('"' + marker);
      if (start < 0) throw new Error("找不到模块 " + marker);
      const end = source.indexOf('"', start + 1);
      return source.slice(start + 1, end);
    };
    const reactUrl = moduleUrl(hookSource, "/node_modules/.vite/deps/react.js");
    const domUrl = moduleUrl(mainSource, "/node_modules/.vite/deps/react-dom_client.js");
    const queryUrl = moduleUrl(chatSource, "/node_modules/.vite/deps/@tanstack_react-query.js");
    if (!reactUrl || !domUrl || !queryUrl) throw new Error("React 或 React Query 模块 URL 解析失败");
    const reactMod = await import(reactUrl);
    const domMod = await import(domUrl);
    const { QueryClient, QueryClientProvider } = await import(queryUrl);
    const { ReaderProvider } = await import("/src/pages/reader/components/reader-provider.tsx");
    const { createReaderStore } = await import("/src/pages/reader/store/create-reader-store.ts");
    const { default: ChatContent } = await import("/src/components/side-chat/index.tsx");
    const { PaperChatPanel } = await import("/src/pages/papers/paper-chat-panel.tsx");
    const React = reactMod.default ?? reactMod;
    const createRoot = (domMod.default ?? domMod).createRoot;
    window.__workspaceHosts = { React, createRoot, QueryClient, QueryClientProvider, ReaderProvider, createReaderStore, ChatContent, PaperChatPanel, mounted: [] };
  })()`);

  for (const scope of ["reader", "paper"]) {
    const expectedRoot = scope === "reader" ? readerRoot : paperRoot;
    const hostId = `${scope}:workspace-fixture`;
    await evalJs(`(async () => {
      const fixture = window.__workspaceHosts;
      const { React, createRoot, QueryClient, QueryClientProvider, ReaderProvider, createReaderStore, ChatContent, PaperChatPanel } = fixture;
      const host = document.createElement("div");
      host.dataset.workspaceFixture = ${JSON.stringify(scope)};
      host.style.cssText = "position:fixed;left:-10000px;top:0;width:480px;height:800px;display:flex;";
      document.body.appendChild(host);
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const readerStore = ${JSON.stringify(scope)} === "reader" ? createReaderStore("workspace-fixture") : null;
      const panel = ${JSON.stringify(scope)} === "reader"
        ? React.createElement(ReaderProvider, { store: readerStore }, React.createElement(ChatContent, { bookId: "workspace-fixture" }))
        : React.createElement(PaperChatPanel, { paperId: "workspace-fixture", paperTitle: "隔离论文" });
      const root = createRoot(host);
      root.render(React.createElement(QueryClientProvider, { client: queryClient }, panel));
      fixture.mounted.push({ host, root, queryClient });
      await new Promise((resolve) => setTimeout(resolve, 500));
    })()`);
    const hostSelector = `[data-workspace-fixture="${scope}"]`;
    const mainSelector = `${hostSelector} main`;
    check(
      `${scope} 保留新对话后接历史按钮的位置`,
      await evalJs(`(() => {
        const main = document.querySelector(${JSON.stringify(mainSelector)});
        const newer = main.querySelector("button:has(svg.lucide-message-circle-plus)");
        const history = main.querySelector("button:has(svg.lucide-history)");
        return !!(newer.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING);
      })()`),
    );
    const center = await evalJs(`(() => {
      const main = document.querySelector(${JSON.stringify(mainSelector)});
      const heading = main.querySelector("h3");
      const body = main.querySelector(".relative.min-h-0.flex-1");
      const headingGroup = heading?.parentElement?.parentElement;
      const suggestions = headingGroup?.nextElementSibling;
      if (!headingGroup || !suggestions || !body) return { pass: false, text: main.textContent.slice(0, 500) };
      const outer = body.getBoundingClientRect();
      const top = headingGroup.getBoundingClientRect().top;
      const bottom = suggestions.getBoundingClientRect().bottom;
      return { pass: Math.abs((top + bottom) / 2 - (outer.top + outer.height / 2)) <= 2, outer: outer.toJSON(), top, bottom };
    })()`);
    check(`${scope} 空对话内容垂直居中`, center.pass, JSON.stringify(center));
    await evalJs(`(() => {
      const textarea = document.querySelector(${JSON.stringify(mainSelector)}).querySelector("textarea");
      window.__hostTextarea = textarea;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      setter.call(textarea, ${JSON.stringify(`${scope}-draft`)});
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await evalJs(
      `document.querySelector(${JSON.stringify(mainSelector)}).querySelector('[aria-label="打开文件工作区"]').click(); true`,
    );
    await waitFor(
      `document.querySelector(${JSON.stringify(mainSelector)}).querySelector('[data-region="file-workspace"]')`,
      `${scope} 工作区`,
    );
    check(
      `${scope} 工作区顶栏不遮挡原助手工具栏`,
      await evalJs(`(() => {
        const main = document.querySelector(${JSON.stringify(mainSelector)});
        const header = main.querySelector('button:has(svg.lucide-history)')?.closest(".flex.h-8");
        const tabs = main.querySelector('[role="tablist"][aria-label="工作区标签"]');
        if (!header || !tabs) return false;
        const headerRect = header.getBoundingClientRect();
        const tabsRect = tabs.getBoundingClientRect();
        return getComputedStyle(header).visibility === "visible" && headerRect.bottom <= tabsRect.top + 0.5;
      })()`),
    );
    const hostDetails = await evalJs(`(async () => {
      const agent = (await import("/src/store/agent-settings-store.ts")).useAgentSettingsStore.getState();
      const host = (await import("/src/store/file-workspace-store.ts")).useFileWorkspaceStore.getState().hosts[${JSON.stringify(hostId)}];
      const panel = document.querySelector(${JSON.stringify(mainSelector)});
      return { host, perAgentRoots: agent.perAgentRoots, panelCount: panel.querySelectorAll('[data-region="file-workspace"] [role="tabpanel"]').length };
    })()`);
    check(
      `${scope} 使用各自目录与单页文件标签`,
      hostDetails.host?.rootResolved?.replaceAll(String.fromCharCode(92), "/") === expectedRoot &&
        hostDetails.host.scope === scope &&
        hostDetails.panelCount === 1,
      JSON.stringify(hostDetails),
    );
    await waitFor(
      `Array.from(document.querySelector(${JSON.stringify(mainSelector)}).querySelectorAll('[data-region="file-explorer"] button')).some((item) => item.textContent === ${JSON.stringify(`${scope}.txt`)})`,
      `${scope} 文件列表`,
      `document.querySelector(${JSON.stringify(mainSelector)}).textContent`,
    );
    await evalJs(`(() => {
      const button = Array.from(document.querySelector(${JSON.stringify(mainSelector)}).querySelectorAll('[data-region="file-explorer"] button')).find((item) => item.textContent === ${JSON.stringify(`${scope}.txt`)});
      if (!button) throw new Error("找不到宿主文件：" + ${JSON.stringify(scope)});
      button.click();
    })()`);
    await waitFor(
      `document.querySelector(${JSON.stringify(mainSelector)}).querySelector('[data-region="file-preview"][data-status="ready"]')`,
      `${scope} 文件预览`,
    );
    check(
      `${scope} 文件内容正确且目录不与文件并排`,
      await evalJs(`(() => {
        const main = document.querySelector(${JSON.stringify(mainSelector)});
        return main.querySelector('[data-region="file-preview"]').textContent.includes(${JSON.stringify(`${scope}-root`)}) && !main.querySelector('[data-region="file-explorer"]');
      })()`),
    );
    await evalJs(
      `document.querySelector(${JSON.stringify(mainSelector)}).querySelector('[aria-label="关闭 文件资源管理器"]').click(); true`,
    );
    await waitFor(
      `(async () => !(await import("/src/store/file-workspace-store.ts")).useFileWorkspaceStore.getState().hosts[${JSON.stringify(hostId)}].tabs.some((tab) => tab.type === "explorer"))()`,
      `${scope} 目录关闭`,
    );
    check(
      `${scope} 关闭目录不关闭文件标签`,
      await evalJs(`(async () => {
        const host = (await import("/src/store/file-workspace-store.ts")).useFileWorkspaceStore.getState().hosts[${JSON.stringify(hostId)}];
        return !host.tabs.some((tab) => tab.type === "explorer") && host.tabs.some((tab) => tab.rootResolved.replaceAll(String.fromCharCode(92), "/") === ${JSON.stringify(expectedRoot)});
      })()`),
    );
    await evalJs(
      `document.querySelector(${JSON.stringify(mainSelector)}).querySelector('[aria-label="收起文件工作区，返回对话"]').click(); true`,
    );
    check(
      `${scope} 切换工作区保留聊天 DOM 和草稿`,
      await evalJs(
        `document.querySelector(${JSON.stringify(mainSelector)}).querySelector("textarea") === window.__hostTextarea && window.__hostTextarea.value === ${JSON.stringify(`${scope}-draft`)}`,
      ),
    );
    await evalJs(
      `document.querySelector(${JSON.stringify(mainSelector)}).querySelector("button:has(svg.lucide-history)").click(); true`,
    );
    await waitFor(
      `document.querySelector(${JSON.stringify(mainSelector)}).querySelector('[data-region="assistant-history-panel"]')`,
      `${scope} 历史面板`,
    );
    check(
      `${scope} 历史面板与聊天 DOM 共存`,
      await evalJs(
        `document.querySelector(${JSON.stringify(mainSelector)}).querySelector("textarea") === window.__hostTextarea`,
      ),
    );
    await evalJs(
      `document.querySelector(${JSON.stringify(mainSelector)}).querySelector('[data-region="assistant-history-panel"] button:has(svg.lucide-arrow-left)').click(); true`,
    );
    await waitFor(
      `!document.querySelector(${JSON.stringify(mainSelector)}).querySelector('[data-region="assistant-history-panel"]')`,
      `${scope} 历史退出`,
    );
    await evalJs(`(() => {
      const fixture = window.__workspaceHosts.mounted.at(-1);
      fixture.root.unmount();
      fixture.queryClient.clear();
      fixture.host.remove();
    })()`);
    await evalJs("delete window.__hostTextarea; true");
  }
} catch (error) {
  check("书籍/论文宿主验收执行异常", false, error instanceof Error ? error.stack : String(error));
} finally {
  await evalJs(`(async () => {
    for (const fixture of window.__workspaceHosts?.mounted ?? []) {
      try {
        if (fixture.host.isConnected) fixture.root.unmount();
        fixture.queryClient.clear();
        fixture.host.remove();
      } catch {}
    }
    delete window.__workspaceHosts;
    delete window.__hostTextarea;
    const previous = window.__hostsPrevious;
    if (previous) {
      const agent = (await import("/src/store/agent-settings-store.ts")).useAgentSettingsStore.getState();
      agent.setWorkspaceRoot(previous.workspaceRoot);
      for (const scope of ["central", "reader", "paper"]) agent.setPerAgentRoot(scope, previous.perAgentRoots[scope] ?? null);
      agent.setSafetyMode(previous.safetyMode);
      agent.setDocumentToolMode(previous.documentToolMode);
      (await import("/src/store/file-workspace-store.ts")).useFileWorkspaceStore.setState({ hosts: previous.hosts, recentRoots: previous.recentRoots });
    }
    delete window.__hostsPrevious;
  })()`).catch(() => {});
  ws.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(readerRoot, { recursive: true, force: true });
  rmSync(paperRoot, { recursive: true, force: true });
}
const report = {
  checks,
  exceptions: exceptions.map((item) => item.exception?.description ?? item.text).filter(Boolean),
};
writeFileSync(`${outDir}/workspace-hosts.json`, JSON.stringify(report, null, 2));
if (checks.some((item) => !item.pass) || report.exceptions.length) process.exit(1);
console.log(`\n${checks.filter((item) => item.pass).length}/${checks.length} PASS`);
