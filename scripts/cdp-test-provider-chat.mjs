import { mkdirSync, writeFileSync } from "node:fs";

const cdpPort = process.env.CDP_PORT ?? "9224";
const appPort = process.env.APP_PORT ?? "1421";
const outDir = process.env.VERIFY_OUT ?? ".superpowers/sdd/kate-bishop-shadowcat-atom-smasher";
const requestedIds = (process.env.PROVIDERS ?? "deepseek,zhipu,kimi,xiaomi,qwen,doubao,minimax,stepfun")
  .split(",")
  .filter(Boolean);
const requestedModels = JSON.parse(process.env.MODEL_IDS ?? "{}");
const providerOverrides = JSON.parse(process.env.PROVIDER_OVERRIDES ?? "{}");
const kimiCredential = process.env.KIMI_KEY_SLOT === "2" ? process.env.KIMI_API_KEY_2 : process.env.KIMI_API_KEY;
const injectedSecrets = Object.fromEntries(
  Object.entries({
    deepseek: process.env.DEEPSEEK_API_KEY,
    zhipu: process.env.ZAI_API_KEY,
    kimi: kimiCredential,
    xiaomi: process.env.MIMO_API_KEY,
    qwen: process.env.DASHSCOPE_API_KEY,
    doubao: process.env.ARK_API_KEY,
    minimax: process.env.MINIMAX_API_KEY,
    stepfun: process.env.STEP_API_KEY,
    tencent: process.env.TENCENT_API_KEY ?? process.env.HUNYUAN_API_KEY,
    cherryin: process.env.CHERRYIN_API_KEY,
  }).filter(([, value]) => Boolean(value)),
);
mkdirSync(outDir, { recursive: true });

const pages = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
const page = pages.find((target) => target.type === "page" && target.url?.includes(`localhost:${appPort}`));
if (!page) throw new Error(`找不到隔离 SageRead 页面（${cdpPort}/${appPort}）`);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let seq = 0;
const pending = new Map();
const exceptions = [];
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
  if (message.method === "Runtime.exceptionThrown") {
    exceptions.push({ type: message.method, lineNumber: message.params.exceptionDetails.lineNumber });
  }
};
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(
      () => {
        pending.delete(id);
        reject(new Error(`CDP 超时: ${method}`));
      },
      Number(process.env.PROVIDER_CDP_TIMEOUT_MS ?? 600000),
    );
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
await call("Runtime.enable");

async function probeChat(ids, modelIds, overrides, injected) {
  const report = { kind: "provider-live-chat", generatedAt: new Date().toISOString(), results: [], progress: [] };
  window.__providerLiveProgress = report.progress;
  let secrets = [];
  const safeText = (error) => {
    let text = String(error instanceof Error ? error.message : error);
    for (const secret of secrets) {
      text = text.replaceAll(secret, "[redacted]");
      text = text.replaceAll(encodeURIComponent(secret), "[redacted]");
    }
    return text.replace(/Bearer\s+\S+|sk-[A-Za-z0-9_-]+/gi, "[redacted]").slice(0, 1600);
  };
  const moduleUrl = (path) => {
    const urls = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((name) => new URL(name).pathname === path);
    return urls.at(-1) ?? path;
  };
  try {
    const store = (await import(moduleUrl("/src/store/provider-store.ts"))).useProviderStore;
    if (!store.persist.hasHydrated()) throw new Error("页面实际使用的提供商配置尚未加载完成");
    const initialState = store.getState();
    secrets = initialState.modelProviders.map((provider) => provider.apiKey).filter(Boolean);
    const initialTheme = document.documentElement.className;
    const [http, ai, factory, protocolModule, providerService, secretsService, vision, processor, threadTools] =
      await Promise.all([
        import("/@id/@tauri-apps/plugin-http"),
        import("/@id/ai"),
        import(`/src/ai/providers/factory.ts?live-probe=${Date.now()}`),
        import("/src/ai/providers/protocol.ts"),
        import("/src/services/provider-service.ts"),
        import("/src/services/secret-service.ts"),
        import("/src/ai/providers/vision-map.ts"),
        import("/src/ai/utils/message-processor.ts"),
        import("/src/ai/tools/central/manage-threads.ts"),
      ]);
    report.factoryObservationSupported = factory.createProviderInstance.toString().includes("config.fetch");
    if (!report.factoryObservationSupported) throw new Error("当前模型工厂未启用观测入口，未向模型提供商发请求");
    const visionTable = (await import("/src/ai/providers/maps/vision-map.json")).default.models;
    const observer = (() => {
      const records = [];
      const measurements = new Set();
      const encoder = new TextEncoder();
      const track = (promise) => {
        measurements.add(promise);
        promise.then(() => measurements.delete(promise));
      };
      const safeUrl = (value) => {
        try {
          const url = new URL(value, location.href);
          url.username = "";
          url.password = "";
          url.search = "";
          url.hash = "";
          return safeText(url.toString());
        } catch {
          return safeText(value);
        }
      };
      const requestBytes = (body) => {
        if (typeof body === "string") return encoder.encode(body).byteLength;
        if (body instanceof Blob) return body.size;
        if (body instanceof ArrayBuffer) return body.byteLength;
        if (ArrayBuffer.isView(body)) return body.byteLength;
        if (body instanceof URLSearchParams) return encoder.encode(body.toString()).byteLength;
        return null;
      };
      const requestShape = (value, key = "") => {
        if (Array.isArray(value)) return value.map((item) => requestShape(item));
        if (value && typeof value === "object")
          return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, requestShape(item, name)]));
        if (value === null || value === undefined) return { type: String(value) };
        if (typeof value === "string" && !["type", "role", "name"].includes(key)) return { type: "string" };
        return value;
      };
      const fetchObserved = async (input, init) => {
        const record = {
          url: safeUrl(typeof input === "string" ? input : input instanceof URL ? input.href : input.url),
          method: init?.method ?? (input instanceof Request ? input.method : "GET"),
          requestBodyBytes: requestBytes(init?.body),
          status: null,
          bodyBytes: null,
          complete: false,
        };
        if (typeof init?.body === "string" && record.url.endsWith("/responses")) {
          try {
            record.requestShape = requestShape(JSON.parse(init.body));
          } catch {
            record.requestShapeError = "请求体不是 JSON";
          }
        }
        records.push(record);
        if (input instanceof Request && init?.body === undefined) {
          track(
            input
              .clone()
              .arrayBuffer()
              .then(
                (buffer) => {
                  record.requestBodyBytes = buffer.byteLength;
                },
                (error) => {
                  record.requestError = safeText(error);
                },
              ),
          );
        }
        try {
          const response = await http.fetch(input, init);
          record.status = response.status;
          record.responseUrl = safeUrl(response.url);
          const measurement = response
            .clone()
            .arrayBuffer()
            .then(
              (buffer) => {
                record.bodyBytes = buffer.byteLength;
                record.complete = true;
              },
              (error) => {
                record.error = safeText(error);
              },
            );
          track(measurement);
          return response;
        } catch (error) {
          record.error = safeText(error);
          throw error;
        }
      };
      return {
        records,
        fetch: fetchObserved,
        settle: () => Promise.all([...measurements]),
      };
    })();
    const localResponse = await observer.fetch(new URL("/", location.href).href);
    const localBody = await localResponse.text();
    await observer.settle();
    const localRecord = observer.records[0];
    report.observerSelfTest = {
      pass:
        localResponse.status === 200 &&
        localRecord.status === 200 &&
        localRecord.complete &&
        localRecord.bodyBytes === new TextEncoder().encode(localBody).byteLength,
      request: localRecord,
    };
    if (!report.observerSelfTest.pass) throw new Error("网络观测自检失败，未向模型提供商发请求");

    for (const id of ids) {
      const existing = initialState.modelProviders.find((item) => item.provider === id);
      if (!existing) {
        report.results.push({ id, skipped: true, pass: false, reason: "提供商不存在" });
        continue;
      }
      const provider = { ...existing, ...overrides[id], apiKey: injected[id] ?? existing.apiKey };
      const result = {
        id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        apiStyle: provider.apiStyle,
        modelId: modelIds[id] ?? null,
        keySaved: false,
        keyLoaded: Boolean(provider.apiKey?.trim()),
        checks: {},
        pass: false,
        skipped: false,
      };
      report.results.push(result);
      report.progress.push({ id, stage: "provider-start" });
      try {
        if (injected[id]) await secretsService.secretSet("model-provider", id, injected[id]);
        if (provider.apiKey) secrets.push(provider.apiKey);
        result.keySaved = await secretsService.secretHas("model-provider", id);
        if (!result.keySaved || !result.keyLoaded) {
          result.skipped = true;
          result.reason = result.keySaved ? "密钥尚未载入页面实际配置" : "没有已保存的 key，未发送请求";
          continue;
        }
        if (!result.modelId) {
          result.skipped = true;
          result.reason = "尚未明确选择真实目录返回的型号";
          continue;
        }
        const catalog = await providerService.fetchModelCatalog(provider);
        result.catalogModelPresent = catalog.some((entry) => entry.id === result.modelId);
        if (!result.catalogModelPresent) throw new Error(`真实目录中没有选定型号 ${result.modelId}，未改换其他型号`);
        result.protocol = protocolModule.resolveProviderProtocol({
          providerId: provider.provider,
          baseUrl: provider.baseUrl,
          modelId: result.modelId,
          apiStyle: provider.apiStyle,
        });
        const providerInstance = factory.createProviderInstance({
          providerId: provider.provider,
          apiKey: provider.apiKey,
          baseUrl: provider.baseUrl,
          apiStyle: provider.apiStyle,
          modelId: result.modelId,
          fetch: observer.fetch,
        });
        const model =
          result.protocol === "openai-responses" && typeof providerInstance.responses === "function"
            ? providerInstance.responses(result.modelId)
            : result.protocol === "openai-chat" && typeof providerInstance.chat === "function"
              ? providerInstance.chat(result.modelId)
              : providerInstance(
                  result.protocol === "gemini" && result.modelId.includes("/") && !result.modelId.startsWith("models/")
                    ? `models/${result.modelId}`
                    : result.modelId,
                );
        const providerOptions = factory.withResponsesProviderOptions(provider.provider);
        const runCheck = async (name, check) => {
          const requestStart = observer.records.length;
          const evidence = { pass: false, skipped: false };
          result.checks[name] = evidence;
          const bounded = async (promise, label) => {
            let timer;
            try {
              return await Promise.race([
                promise,
                new Promise((_, reject) => {
                  timer = setTimeout(() => reject(new Error(label)), 120000);
                }),
              ]);
            } finally {
              clearTimeout(timer);
            }
          };
          let semanticPass = false;
          try {
            semanticPass = (await bounded(check(evidence), `${id}/${name} 响应超时`)) === true;
          } catch (error) {
            evidence.error = safeText(error);
            if (typeof error?.statusCode === "number") evidence.statusCode = error.statusCode;
            if (typeof error?.responseBody === "string") evidence.responseBody = safeText(error.responseBody);
          }
          try {
            await bounded(observer.settle(), `${id}/${name} 网络读取超时`);
          } catch (error) {
            evidence.error ??= safeText(error);
          }
          evidence.requests = observer.records.slice(requestStart).map((record) => ({ ...record }));
          evidence.networkPass =
            evidence.requests.length > 0 &&
            evidence.requests.every(
              (request) =>
                request.status >= 200 &&
                request.status < 300 &&
                request.complete &&
                request.bodyBytes > 0 &&
                !request.error,
            );
          evidence.pass = semanticPass && evidence.networkPass;
          report.progress.push({
            id,
            check: name,
            pass: evidence.pass,
            error: evidence.error,
            statusCode: evidence.statusCode,
            requests: evidence.requests,
          });
          return evidence;
        };
        await runCheck("text", async (evidence) => {
          const response = await ai.generateText({
            model,
            prompt: "请只回答 17+25 的结果，不要解释。",
            maxOutputTokens: 512,
            providerOptions,
            maxRetries: 0,
            abortSignal: AbortSignal.timeout(90000),
          });
          evidence.reply = safeText(response.text);
          evidence.finishReason = response.finishReason;
          evidence.expected = "42";
          return response.text.trim().length > 0 && response.text.includes("42");
        });

        const executions = [];
        const readOnlyThreads = {
          ...threadTools.manageThreadsTool,
          description: "只读列出对话总数。唯一允许 action=list 且 starredOnly=false，禁止任何写、删、改名或导出。",
          inputSchema: ai.jsonSchema({
            type: "object",
            properties: {
              reasoning: { type: "string", minLength: 1 },
              action: { type: "string", enum: ["list"] },
              starredOnly: { type: "boolean", enum: [false] },
            },
            required: ["reasoning", "action", "starredOnly"],
            additionalProperties: false,
          }),
          execute: async (input, options) => {
            const keys = Object.keys(input).sort();
            if (
              input.action !== "list" ||
              input.starredOnly !== false ||
              keys.join(",") !== "action,reasoning,starredOnly"
            )
              throw new Error("只读验收拒绝了非 list 参数");
            executions.push({ action: input.action, starredOnly: input.starredOnly });
            return threadTools.manageThreadsTool.execute(
              { ...input, limit: 20, format: "markdown", merge: false },
              options,
            );
          },
        };
        const toolset = { manageThreads: readOnlyThreads };
        const streamEvidence = await runCheck("stream", async (evidence) => {
          evidence.initialToolChoice = "auto";
          const streamResult = ai.streamText({
            model,
            instructions: "这是隔离只读验收。只允许 manageThreads 的 list 操作，不得写入、删除或修改任何数据。",
            messages: [
              {
                role: "user",
                content:
                  "请调用 manageThreads，action=list、starredOnly=false，reasoning 填“只读验收”。随后只根据工具结果回答对话总数，使用阿拉伯数字。",
              },
            ],
            tools: toolset,
            toolChoice: "auto",
            prepareStep: ({ stepNumber }) => (stepNumber === 0 ? { toolChoice: "auto" } : { toolChoice: "none" }),
            stopWhen: ai.stepCountIs(3),
            maxOutputTokens: 512,
            providerOptions,
            maxRetries: 0,
            onError: ({ error }) => {
              evidence.providerError = {
                message: safeText(error),
                statusCode: typeof error?.statusCode === "number" ? error.statusCode : null,
                responseBody: typeof error?.responseBody === "string" ? safeText(error.responseBody) : null,
              };
            },
            abortSignal: AbortSignal.timeout(90000),
          });
          const stream = ai.toUIMessageStream({ stream: streamResult.stream, tools: toolset, sendReasoning: true });
          let message;
          let textUpdates = 0;
          let previousLength = 0;
          let revisions = 0;
          for await (const next of ai.readUIMessageStream({ stream })) {
            message = next;
            revisions += 1;
            const text = (message.parts ?? [])
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("");
            if (text.length > previousLength) textUpdates += 1;
            previousLength = text.length;
          }
          if (!message) throw new Error("流式调用没有产生 UI message");
          Object.defineProperty(evidence, "message", { value: message, enumerable: false });
          const parts = message.parts ?? [];
          const toolPart = parts.find((part) => part.type === "tool-manageThreads");
          const total = toolPart?.output?.results?.total;
          const reply = parts
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("");
          Object.assign(evidence, {
            uiUpdates: revisions,
            textUpdates,
            reply: safeText(reply),
            tool: {
              action: toolPart?.input?.action,
              starredOnly: toolPart?.input?.starredOnly,
              success: toolPart?.output?.results?.success,
              total,
            },
            executionCount: executions.length,
          });
          return (
            executions.length === 1 &&
            executions.every((input) => input.action === "list" && input.starredOnly === false) &&
            toolPart?.output?.results?.success === true &&
            Number.isInteger(total) &&
            textUpdates > 0 &&
            reply.trim().length > 0 &&
            reply.includes(String(total))
          );
        });
        if (streamEvidence.message && streamEvidence.tool?.success === true) {
          await runCheck("history", async (evidence) => {
            const adapted = processor.adaptToolHistoryForRequest([streamEvidence.message], {
              directoryMode: false,
              tools: toolset,
            });
            const history = await ai.convertToModelMessages(adapted, {
              tools: toolset,
              ignoreIncompleteToolCalls: true,
            });
            const assistantParts = history
              .filter((message) => message.role === "assistant")
              .flatMap((message) => (Array.isArray(message.content) ? message.content : []));
            const toolParts = history
              .filter((message) => message.role === "tool")
              .flatMap((message) => (Array.isArray(message.content) ? message.content : []));
            const call = assistantParts.find((part) => part.type === "tool-call");
            const toolResult = toolParts.find((part) => part.type === "tool-result");
            const preserved =
              call?.toolName === "manageThreads" &&
              call?.input?.action === "list" &&
              toolResult?.toolName === "manageThreads" &&
              toolResult?.toolCallId === call?.toolCallId &&
              toolResult?.output != null &&
              adapted[0]?.parts?.length === streamEvidence.message.parts.length;
            evidence.structure = {
              toolCalls: assistantParts.filter((part) => part.type === "tool-call").length,
              toolResults: toolParts.filter((part) => part.type === "tool-result").length,
              matchingIds: toolResult?.toolCallId === call?.toolCallId,
              hasOutput: toolResult?.output != null,
              uiPartsPreserved: adapted[0]?.parts?.length === streamEvidence.message.parts.length,
            };
            if (!preserved) return false;
            const replay = await ai.generateText({
              model,
              messages: [
                ...history,
                { role: "user", content: "请只根据已有工具结果回答对话总数，使用阿拉伯数字，不要解释。" },
              ],
              tools: toolset,
              toolChoice: "none",
              maxOutputTokens: 256,
              providerOptions,
              maxRetries: 0,
              abortSignal: AbortSignal.timeout(90000),
            });
            evidence.reply = safeText(replay.text);
            evidence.expectedTotal = streamEvidence.tool.total;
            evidence.executionCountAfterReplay = executions.length;
            return (
              replay.text.trim().length > 0 &&
              replay.text.includes(String(streamEvidence.tool.total)) &&
              executions.length === 1
            );
          });
        } else {
          result.checks.history = { pass: false, skipped: true, reason: "真实只读工具流未成功，未伪造历史回放" };
        }
        const knownVision = visionTable[result.modelId.toLowerCase()];
        if (knownVision === true && vision.modelSupportsVision(provider.provider, result.modelId)) {
          await runCheck("image", async (evidence) => {
            const canvas = document.createElement("canvas");
            canvas.width = 160;
            canvas.height = 80;
            const context = canvas.getContext("2d");
            context.fillStyle = "#ffffff";
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.fillStyle = "#111111";
            context.font = "bold 52px sans-serif";
            context.fillText("7391", 14, 58);
            const dataUrl = canvas.toDataURL("image/png");
            const binary = atob(dataUrl.split(",")[1]);
            const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
            evidence.png = {
              byteLength: bytes.byteLength,
              validSignature: [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte),
              expectedDigits: "7391",
            };
            const response = await ai.generateText({
              model,
              messages: [
                {
                  role: "user",
                  content: [
                    { type: "text", text: "请只回答图片中的四位数字；如果看不到图片，请明确说明。" },
                    { type: "image", image: dataUrl },
                  ],
                },
              ],
              maxOutputTokens: 256,
              providerOptions,
              maxRetries: 0,
              abortSignal: AbortSignal.timeout(90000),
            });
            evidence.reply = safeText(response.text);
            return evidence.png.validSignature && response.text.includes("7391");
          });
        } else {
          result.checks.image = {
            skipped: true,
            pass: null,
            reason: knownVision === false ? "能力表标为纯文本，不发送图片" : "没有已确认的图片能力，未发送图片",
          };
        }
        result.pass =
          ["text", "stream", "history"].every((name) => result.checks[name]?.pass === true) &&
          (result.checks.image?.skipped || result.checks.image?.pass === true);
      } catch (error) {
        result.error = safeText(error);
      }
    }
    const finalState = store.getState();
    report.configurationPreserved = {
      providers: finalState.modelProviders === initialState.modelProviders,
      selectedModel: finalState.selectedModel === initialState.selectedModel,
      utilityModel: finalState.utilityModel === initialState.utilityModel,
      theme: document.documentElement.className === initialTheme,
    };
  } catch (error) {
    report.fatal = safeText(error);
  }
  return report;
}

let output;
try {
  const result = await call("Runtime.evaluate", {
    expression: `(${probeChat.toString()})(${JSON.stringify(requestedIds)}, ${JSON.stringify(requestedModels)}, ${JSON.stringify(providerOverrides)}, ${JSON.stringify(injectedSecrets)})`,
    awaitPromise: true,
    returnByValue: true,
  });
  output = result.result?.exceptionDetails
    ? { fatal: "页面执行异常；详细内容未回传，以免带出密钥", results: [] }
    : result.result?.result?.value;
} catch (error) {
  const progress = await call("Runtime.evaluate", {
    expression: "window.__providerLiveProgress ?? []",
    returnByValue: true,
  }).catch(() => null);
  output = {
    fatal: String(error instanceof Error ? error.message : error),
    progress: progress?.result?.result?.value ?? [],
  };
} finally {
  ws.close();
}
const report = { ...output, exceptions };
writeFileSync(`${outDir}/provider-live-chat.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (
  !output ||
  output.fatal ||
  exceptions.length ||
  Object.values(output.configurationPreserved ?? {}).some((preserved) => !preserved) ||
  output.results?.some((result) => !result.skipped && !result.pass)
)
  process.exit(1);
