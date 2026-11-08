import { mkdirSync, writeFileSync } from "node:fs";

const cdpPort = process.env.CDP_PORT ?? "9223";
const appPort = process.env.APP_PORT ?? "1420";
const mode = process.argv[2] ?? "tools";
const directory = process.argv[3] ?? "direct";
const outDir = process.env.VERIFY_OUT ?? ".tmp-agent-followup";
mkdirSync(outDir, { recursive: true });

const pages = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
const page = pages.find((target) => target.type === "page" && target.url?.includes(`localhost:${appPort}`));
if (!page) throw new Error(`找不到 SageRead 页面（CDP ${cdpPort} / app ${appPort}）`);
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
    }, 300000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
await call("Runtime.enable");
await call("Page.enable");
const evalJs = async (expression) => {
  const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.result?.exceptionDetails) {
    throw new Error(result.result.exceptionDetails.exception?.description ?? result.result.exceptionDetails.text);
  }
  return result.result?.result?.value;
};

const expression = `
(async () => {
  const mode = ${JSON.stringify(mode)};
  const directory = ${JSON.stringify(directory)};
  const requestedChannel = ${JSON.stringify(process.env.KIMI_CHANNEL ?? "auto")};
  const factory = await import("/src/ai/providers/factory.ts");
  const transportModule = await import("/src/ai/custom-chat-transport.ts");
  const providerStore = await import("/src/store/provider-store.ts");
  const ai = await import("/@id/ai");
  const chatModule = await import("/src/components/side-chat/chat-messages.tsx");
  const containerModule = await import("/src/components/prompt-kit/chat-container.tsx");
  const names = performance.getEntriesByType("resource").map((entry) => entry.name);
  const reactUrl = names.filter((name) => name.includes("deps/react.js")).at(-1);
  const domUrl = names.filter((name) => name.includes("deps/react-dom_client.js")).at(-1);
  const reactMod = await import(reactUrl);
  const domMod = await import(domUrl);
  const React = reactMod.default ?? reactMod;
  const createRoot = (domMod.default ?? domMod).createRoot;
  let selected = null;
  for (let i = 0; i < 30; i++) {
    selected = providerStore.useProviderStore.getState().selectedModel;
    if (selected) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  let selectionRestore = null;
  let selectionRestored;
  if (!selected || requestedChannel !== "auto") {
    await (await import("/src/services/secret-init.ts")).initSecrets();
    const providers = providerStore.useProviderStore.getState().modelProviders;
    const provider = requestedChannel === "cherry"
      ? providers.find((item) => item.baseUrl?.includes("cherryin") && item.apiKey)
      : providers.find((item) => item.provider === "kimi" && item.apiKey);
    if (provider) {
      selectionRestore = { providers, selected: providerStore.useProviderStore.getState().selectedModel };
      const modelId = provider.provider === "kimi" ? "kimi-k3.1-pro" : "moonshotai/kimi-k3.1-pro";
      const nextProvider = {
        ...provider,
        active: true,
        models: [
          { id: modelId, name: "Kimi K3.1 Pro", active: true, description: "", capabilities: [], manual: false },
          ...provider.models.filter((model) => model.id !== modelId),
        ],
      };
      providerStore.useProviderStore.getState().setModelProviders(providers.map((item) => item.provider === provider.provider ? nextProvider : item));
      selected = { providerId: provider.provider, modelId, providerName: provider.name, modelName: "Kimi K3.1 Pro" };
      providerStore.useProviderStore.getState().setSelectedModel(selected);
    }
  }
  if (!selected) return { error: \`未选中模型（\${requestedChannel}）\` };
  const previousDisable = globalThis.__SAGEREAD_DISABLE_DIRECTORY__;
  globalThis.__SAGEREAD_DISABLE_DIRECTORY__ = directory !== "directory";
  const results = [];
  const oldTime = new Date(Date.now() - 3600000).getTime();
  const history = [
    { id: "probe-old-user", role: "user", metadata: { createdAt: oldTime }, parts: [{ type: "text", text: "之前的普通问题" }] },
    { id: "probe-old-assistant", role: "assistant", metadata: { createdAt: oldTime + 1000 }, parts: [{ type: "text", text: "之前的普通回答" }] },
  ];
  const timestampPattern = /\\[\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}\\]/;
  const cleanText = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();
  const comparable = (value) => cleanText(String(value ?? "").replace(/[*\`]/g, ""));

  async function renderMessage(message, keepMounted) {
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;inset:24px;z-index:99999;overflow:auto;background:var(--background,#fff);color:var(--foreground,#222);padding:20px;border:1px solid #999;border-radius:12px;";
    document.body.appendChild(host);
    const root = createRoot(host);
    root.render(React.createElement(containerModule.ChatContainerRoot, { autoScroll: false, resize: "instant" },
      React.createElement(chatModule.ChatMessages, { messages: [message], status: "ready", error: null })));
    await new Promise((resolve) => setTimeout(resolve, 400));
    const groupButtons = Array.from(host.querySelectorAll("button")).filter((button) => button.textContent.includes("已调用"));
    const groups = [];
    for (const button of groupButtons) {
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 80));
      groups.push({
        summary: button.textContent,
        expanded: button.getAttribute("aria-expanded"),
        content: button.nextElementSibling?.textContent ?? "",
      });
    }
    const output = {
      text: host.textContent,
      groups,
      groupCount: groupButtons.length,
    };
    if (keepMounted) {
      globalThis.__followupProbeCleanup = () => {
        root.unmount();
        host.remove();
        delete globalThis.__followupProbeCleanup;
      };
    } else {
      root.unmount();
      host.remove();
    }
    return output;
  }

  async function run(prompt, render) {
    const base = factory.createModelInstance(selected.providerId, selected.modelId);
    let promptEvidence = {};
    const model = new Proxy(base, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === "doStream") {
          return async (options) => {
            const serialized = JSON.stringify(options.prompt ?? []);
            promptEvidence = {
              hasHistoryTimestamp:
                timestampPattern.test(serialized) &&
                serialized.includes("之前的普通问题") &&
                serialized.includes("之前的普通回答"),
              hasReadOnlyRule: serialized.includes("只读元数据") && serialized.includes("Thought"),
              hasCurrentTime: serialized.includes("【当前时间】"),
            };
            return value.call(target, options);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const transport = new transportModule.CustomChatTransport(model, { scopeHint: "central" });
    const stream = await transport.sendMessages({
      chatId: "followup-" + mode + "-" + Date.now(),
      messages: [...history, { id: "probe-current-" + Date.now(), role: "user", parts: [{ type: "text", text: prompt }] }],
      abortSignal: new AbortController().signal,
      trigger: "submit-message",
      messageId: undefined,
      body: { chatContext: { agentScope: "central", threadId: "followup-probe" } },
    });
    const [chunkStream, messageStream] = stream.tee();
    const chunkPromise = (async () => {
      const chunks = [];
      const reader = chunkStream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const chunk of Array.isArray(value) ? value : [value]) chunks.push(chunk);
      }
      return chunks;
    })();
    let message = null;
    for await (const snapshot of ai.readUIMessageStream({ stream: messageStream })) message = snapshot;
    const chunks = await chunkPromise;
    if (!message) throw new Error("模型流没有产生 UI message");
    const dom = render ? await renderMessage(message, mode === "tools") : null;
    return { message, chunks, promptEvidence, dom };
  }

  function slimMessage(message) {
    return {
      id: message.id,
      parts: message.parts.map((part) => ({
        type: part.type,
        toolCallId: part.toolCallId,
        state: part.state,
        text: part.text,
        input: part.input,
        success: part.output?.results?.success,
      })),
    };
  }

  try {
    if (mode === "tools") {
      const runResult = await run("请严格按顺序执行：1）实际调用 manageThreads（action=list，starredOnly=false）；2）拿到结果后只说一句短评论“我先核对对话，再核对技能。”；3）实际调用 manageSkill（action=toggle，不传 skillName，只读列出技能）；4）最后写至少80字总结。不要伪造工具结果。", true);
      const parts = runResult.message.parts;
      const toolParts = parts.filter((part) => String(part.type).startsWith("tool-"));
      const effectiveName = (part) => part.type === "tool-useTool" ? part.input?.tool : String(part.type).replace(/^tool-/, "");
      const lastToolIndex = parts.findLastIndex((part) => String(part.type).startsWith("tool-"));
      const finalText = parts.slice(lastToolIndex + 1).filter((part) => part.type === "text").map((part) => part.text).join("").trim();
      const interstitialText = parts.slice(0, lastToolIndex).filter((part) => part.type === "text").map((part) => part.text).join("");
      const rawTimestamp = parts.filter((part) => (part.type === "text" || part.type === "reasoning") && timestampPattern.test(part.text ?? ""));
      const group = runResult.dom.groups[0];
      const finalMarker = comparable(finalText.split("\\n").find((line) => line.trim()) ?? finalText).slice(0, 80);
      results.push({
        scenario: "tools-" + directory,
        pass: toolParts.length >= 2 && effectiveName(toolParts.find((part) => effectiveName(part) === "manageThreads") ?? {}) === "manageThreads" && toolParts.some((part) => effectiveName(part) === "manageSkill") && interstitialText.includes("我先核对对话，再核对技能") && finalText.length >= 80 && rawTimestamp.length === 0 && runResult.dom.groupCount === 1 && group?.summary.includes("已调用 " + toolParts.length + " 个工具") && group?.expanded === "true" && group?.content.includes("我先核对对话，再核对技能") && !comparable(group?.content).includes(finalMarker) && comparable(runResult.dom.text).includes(finalMarker),
        selected: selected.providerId + "/" + selected.modelId,
        toolCount: toolParts.length,
        tools: toolParts.map(effectiveName),
        interstitialText,
        finalText,
        rawTimestampCount: rawTimestamp.length,
        promptEvidence: runResult.promptEvidence,
        dom: runResult.dom,
        chunks: runResult.chunks.filter((chunk) => ["text-delta", "reasoning-delta", "error"].includes(chunk.type)),
        message: slimMessage(runResult.message),
      });
    } else {
      const scenarios = [
        ["ordinary", "用两句话说明为什么阅读时要定期回顾旧笔记。"],
        ["current", "请根据系统注入的当前时间，告诉我今天几号、现在几点、昨天几号。回答简洁。"],
        ["explicit", "请附上当前时间，严格只输出一行实际时间，格式为 [YYYY-MM-DD HH:mm]。"],
      ];
      for (const [name, prompt] of scenarios) {
        const runResult = await run(prompt, true);
        const textParts = runResult.message.parts.filter((part) => part.type === "text" || part.type === "reasoning");
        const reply = textParts.map((part) => part.text ?? "").join("\\n").trim();
        const timestampCount = textParts.filter((part) => timestampPattern.test(part.text ?? "")).length;
        const finalTimestampCount = textParts.filter((part) => part.type === "text" && timestampPattern.test(part.text ?? "")).length;
        const timestampIsRecent = (match) => {
          const [year, month, day, hour, minute] = match[0].slice(1, -1).split(/[- :]/).map(Number);
          return Math.abs(new Date(year, month - 1, day, hour, minute).getTime() - Date.now()) < 300000;
        };
        const timestampsValid = textParts.every((part) =>
          Array.from(String(part.text ?? "").matchAll(new RegExp(timestampPattern.source, "g"))).every(timestampIsRecent),
        );
        let semantics = true;
        if (name === "current") {
          const now = new Date();
          const yesterday = new Date(now.getTime() - 86400000);
          const forms = (date) => {
            const y = date.getFullYear();
            const month = date.getMonth() + 1;
            const day = date.getDate();
            const m = String(month).padStart(2, "0");
            const d = String(day).padStart(2, "0");
            return [
              y + "-" + m + "-" + d,
              y + "/" + m + "/" + d,
              y + "年" + month + "月" + day + "日",
              y + "年" + m + "月" + d + "日",
              month + "月" + day + "日",
              m + "月" + d + "日",
              m + "-" + d,
              m + "/" + d,
            ];
          };
          const allowedYears = new Set([now.getFullYear(), yesterday.getFullYear()]);
          const mentionedYears = Array.from(reply.matchAll(/([0-9]{4})(?=[年/-])/g), (match) => Number(match[1]));
          const normalizedReply = reply.replaceAll(" ", "");
          semantics = forms(now).slice(0, 4).some((value) => normalizedReply.includes(value.replaceAll(" ", ""))) && forms(yesterday).some((value) => normalizedReply.includes(value.replaceAll(" ", ""))) && mentionedYears.every((year) => allowedYears.has(year)) && /\\d{1,2}:\\d{2}/.test(reply);
        }
        if (name === "explicit") {
          const answer = textParts.filter((part) => part.type === "text").map((part) => part.text ?? "").join(String.fromCharCode(10)).trim();
          const match = answer.match(timestampPattern);
          semantics = !!match && match[0] === answer && timestampIsRecent(match) && timestampsValid;
        }
        if (name === "explicit" && globalThis.__followupProbeCleanup) globalThis.__followupProbeCleanup();
        results.push({
          scenario: name,
          pass:
            semantics &&
            (name === "explicit" ? finalTimestampCount === 1 : timestampCount === 0) &&
            comparable(runResult.dom.text).includes(
              comparable(reply.split("\\n").find((line) => line.trim()) ?? reply).slice(0, 80),
            ),
          selected: selected.providerId + "/" + selected.modelId,
          reply,
          timestampCount,
          finalTimestampCount,
          timestampsValid,
          promptEvidence: runResult.promptEvidence,
          domText: runResult.dom.text,
          chunks: runResult.chunks.filter((chunk) => ["text-delta", "reasoning-delta", "error"].includes(chunk.type)),
          message: slimMessage(runResult.message),
        });
        if (globalThis.__followupProbeCleanup) globalThis.__followupProbeCleanup();
      }
    }
  } finally {
    if (previousDisable === undefined) delete globalThis.__SAGEREAD_DISABLE_DIRECTORY__;
    else globalThis.__SAGEREAD_DISABLE_DIRECTORY__ = previousDisable;
    if (selectionRestore) {
      providerStore.useProviderStore.getState().setModelProviders(selectionRestore.providers);
      providerStore.useProviderStore.getState().setSelectedModel(selectionRestore.selected);
      selectionRestored = providerStore.useProviderStore.getState().modelProviders === selectionRestore.providers && providerStore.useProviderStore.getState().selectedModel === selectionRestore.selected;
    }
  }
  return { selected: selected.providerId + "/" + selected.modelId, results, restored: selectionRestored };
})()
`;

let output;
try {
  output = await evalJs(expression);
  if (mode === "tools" && output?.results?.[0]) {
    const screenshot = await call("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${outDir}/tool-group-${directory}.png`, Buffer.from(screenshot.result.data, "base64"));
  }
} finally {
  await evalJs("globalThis.__followupProbeCleanup?.(); true").catch(() => {});
  ws.close();
}
const report = {
  ...output,
  exceptions: exceptions.map((item) => item.exception?.description ?? item.text).filter(Boolean),
};
writeFileSync(`${outDir}/${mode}-${directory}.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (
  !output ||
  output.error ||
  output.restored === false ||
  output.results?.some((result) => !result.pass) ||
  report.exceptions.length
)
  process.exit(1);
