import { mkdirSync, writeFileSync } from "node:fs";

const cdpPort = process.env.CDP_PORT ?? "9224";
const appPort = process.env.APP_PORT ?? "1421";
const outDir = process.env.VERIFY_OUT ?? ".superpowers/sdd/kate-bishop-shadowcat-atom-smasher";
const requestedIds = (process.env.PROVIDERS ?? "deepseek,zhipu,kimi,xiaomi,qwen,doubao,minimax,stepfun")
  .split(",")
  .filter(Boolean);
const providerOverrides = JSON.parse(process.env.PROVIDER_OVERRIDES ?? "{}");
const injectedSecrets = Object.fromEntries(
  Object.entries({
    deepseek: process.env.DEEPSEEK_API_KEY,
    zhipu: process.env.ZAI_API_KEY,
    kimi: process.env.KIMI_API_KEY,
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
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP 超时: ${method}`));
    }, 120000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
await call("Runtime.enable");

async function probeCatalog(ids, overrides, injected) {
  const report = { kind: "provider-live-catalog", results: [] };
  let secrets = [];
  const safeText = (error) => {
    let text = String(error instanceof Error ? error.message : error);
    for (const secret of secrets) {
      text = text.replaceAll(secret, "[redacted]");
      text = text.replaceAll(encodeURIComponent(secret), "[redacted]");
    }
    return text.replace(/Bearer\s+\S+|sk-[A-Za-z0-9_-]+/gi, "[redacted]").slice(0, 1200);
  };
  const moduleUrl = (path) => {
    const urls = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((name) => new URL(name).pathname === path);
    return urls.at(-1) ?? path;
  };
  try {
    const storeUrl = moduleUrl("/src/store/provider-store.ts");
    const store = (await import(storeUrl)).useProviderStore;
    if (!store.persist.hasHydrated()) throw new Error("页面实际使用的提供商配置尚未加载完成");
    report.store = {
      hydrated: true,
      version: store.persist.getOptions().version,
      selectedModel: store.getState().selectedModel,
    };
    const state = store.getState();
    secrets = state.modelProviders.map((provider) => provider.apiKey).filter(Boolean);
    const secretsService = await import("/src/services/secret-service.ts");
    const http = await import("/@id/@tauri-apps/plugin-http");
    const providerService = await import("/src/services/provider-service.ts");
    const { predefinedProviders } = await import("/src/constants/predefined-providers.ts");
    for (const id of ids) {
      const existing = state.modelProviders.find((item) => item.provider === id);
      if (!existing) {
        report.results.push({ id, skipped: true, reason: "提供商不存在" });
        continue;
      }
      const provider = { ...existing, ...overrides[id], apiKey: injected[id] ?? existing.apiKey };
      const result = {
        id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        apiStyle: provider.apiStyle,
        pass: false,
        skipped: false,
      };
      try {
        if (injected[id]) await secretsService.secretSet("model-provider", id, injected[id]);
        if (provider.apiKey) secrets.push(provider.apiKey);
        result.keySaved = await secretsService.secretHas("model-provider", id);
        result.keyLoaded = Boolean(provider.apiKey?.trim());
        if (!result.keySaved || !result.keyLoaded) {
          result.skipped = true;
          result.reason = result.keySaved ? "已保存密钥尚未载入页面实际配置" : "没有已保存的 key，未发送请求";
          report.results.push(result);
          continue;
        }
        result.url = `${provider.baseUrl.replace(/\/+$/, "")}/models`;
        result.attempts = [];
        const endpointMap = provider.endpoints ?? predefinedProviders.find((preset) => preset.provider === provider.provider)?.endpoints ?? {};
        const baseUrls = [
          provider.baseUrl,
          endpointMap["openai-chat"],
          endpointMap["openai-responses"],
        ]
          .filter((baseUrl) => typeof baseUrl === "string" && baseUrl.trim())
          .map((baseUrl) => baseUrl.replace(/\/+$/, ""));
        for (const baseUrl of [...new Set(baseUrls)]) {
          const url = `${baseUrl}/models`;
          const attempt = { url, pass: false };
          result.attempts.push(attempt);
          try {
            const response = await http.fetch(url, {
              method: "GET",
              headers: {
                "Content-Type": "application/json",
                "x-api-key": provider.apiKey,
                Authorization: `Bearer ${provider.apiKey}`,
              },
              signal: AbortSignal.timeout(30000),
            });
            const body = await response.text();
            attempt.status = response.status;
            attempt.bodyBytes = new TextEncoder().encode(body).length;
            result.status ??= response.status;
            let payload;
            try {
              payload = JSON.parse(body);
            } catch {}
            const records = Array.isArray(payload) ? payload : (payload?.data ?? payload?.models);
            attempt.responseKeys = payload && typeof payload === "object" ? Object.keys(payload).slice(0, 20) : [];
            const modelIds = Array.isArray(records)
              ? records.map((item) => (typeof item === "string" ? item : (item?.id ?? item?.name))).filter(Boolean)
              : [];
            attempt.modelCount = modelIds.length;
            attempt.returnedModelIds = modelIds.slice(0, 80);
            if (!response.ok) {
              attempt.error = safeText(
                payload?.error?.message ??
                  (body.trim() ? body.slice(0, 800) : `HTTP ${response.status} ${response.statusText}`),
              );
              continue;
            }
            attempt.pass = modelIds.length > 0;
            if (!attempt.pass) attempt.error = "HTTP 成功，但没有返回可识别的模型 ID";
            const catalog = await providerService.fetchModelCatalog(provider);
            result.catalogUrl = url;
            result.usedFallback = url !== result.url;
            result.serviceModelCount = catalog.length;
            result.catalog = catalog.slice(0, 80);
            result.sameOrder = catalog.every((entry, index) => entry.id === modelIds[index]);
            result.pass =
              attempt.pass &&
              catalog.length === modelIds.length &&
              new Set(catalog.map((entry) => entry.id)).size === catalog.length &&
              new Set(modelIds).size === modelIds.length &&
              catalog.every((entry) => modelIds.includes(entry.id));
            if (result.usedFallback) result.warning = "当前聊天路径无模型目录；应用使用已配置的备用目录路径";
            if (result.pass && !result.sameOrder)
              result.warning = [result.warning, "两次读取顺序不同，但模型 ID 集合一致"].filter(Boolean).join("；");
            if (!result.pass) result.error = "应用模型目录解析结果与真实返回的模型 ID 集合不一致";
            break;
          } catch (error) {
            attempt.error = safeText(error);
          }
        }
        if (!result.pass && !result.error) result.error = "所有已配置目录路径均未返回可用模型列表";
      } catch (error) {
        result.error = safeText(error);
      }
      report.results.push(result);
    }
  } catch (error) {
    report.fatal = safeText(error);
  }
  return report;
}

let output;
try {
  const result = await call("Runtime.evaluate", {
    expression: `(${probeCatalog.toString()})(${JSON.stringify(requestedIds)}, ${JSON.stringify(providerOverrides)}, ${JSON.stringify(injectedSecrets)})`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.result?.exceptionDetails) {
    output = { fatal: "页面执行异常；详细内容未回传，以免带出密钥", results: [] };
  } else {
    output = result.result?.result?.value;
  }
} finally {
  ws.close();
}
const report = { ...output, exceptions };
writeFileSync(`${outDir}/provider-live-catalog.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (!output || output.fatal || exceptions.length || output.results?.some((result) => !result.skipped && !result.pass))
  process.exit(1);
