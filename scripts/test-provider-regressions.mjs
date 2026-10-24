// Provider 持久化迁移、转换器端点、模型目录协议与视觉图片桥门控回归测试。
// 运行：node scripts/test-provider-regressions.mjs
import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const src = join(root, "packages/app/src");
const pnpmDir = join(root, "node_modules", ".pnpm");
const esbuildPkg = readdirSync(pnpmDir).find((d) => d.startsWith("esbuild@"));
if (!esbuildPkg) {
  console.error("FAIL 未找到 esbuild");
  process.exit(1);
}
const esbuild = await import(
  pathToFileURL(join(pnpmDir, esbuildPkg, "node_modules", "esbuild", "lib", "main.js")).href
);

const outDir = mkdtempSync(join(tmpdir(), "provider-regressions-"));
const entry = join(outDir, "entry.ts");
const posix = (p) => p.replace(/\\/g, "/");
writeFileSync(
  entry,
  [
    `export { useProviderStore } from "${posix(join(src, "store/provider-store.ts"))}";`,
    `export { resolveLlmParams } from "${posix(join(src, "services/converter-service.ts"))}";`,
    `export { fetchModelCatalog } from "${posix(join(src, "services/provider-service.ts"))}";`,
    `export { createProviderInstance } from "${posix(join(src, "ai/providers/factory.ts"))}";`,
  ].join("\n"),
);

const providerStub = (exportName, kind) => `
export function ${exportName}(options) {
  const provider = (modelId) => ({ modelId, provider: ${JSON.stringify(kind)} });
  provider.chat = provider;
  provider.responses = provider;
  (globalThis.__providerFactoryCaptures ??= []).push({ kind: ${JSON.stringify(kind)}, options });
  return provider;
}
`;
const stubs = new Map([
  [
    "@/lib/tauri-storage",
    `export const tauriStorage = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    };`,
  ],
  ["@/services/book-service", "export async function uploadBook() {}"],
  ["@/services/secret-service", "export async function secretDelete() {}"],
  [
    "@/store/converter-store",
    `export const useConverterStore = { getState: () => ({ engine: "mineru", mineruToken: "", paddleocrToken: "" }) };`,
  ],
  ["@tauri-apps/api/core", "export async function invoke() {}"],
  ["@tauri-apps/api/event", "export async function listen() { return () => {}; }"],
  ["@tauri-apps/plugin-fs", "export async function readFile() { return new Uint8Array(); }"],
  [
    "@tauri-apps/plugin-http",
    `export async function fetch(input, init) {
      const call = { url: typeof input === "string" ? input : input.url, init };
      (globalThis.__providerHttpCalls ??= []).push(call);
      const responder = globalThis.__providerHttpResponder;
      if (responder) return responder(call);
      return new Response(JSON.stringify({ data: [{ id: "fixture-model" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }`,
  ],
  ["@ai-sdk/anthropic", providerStub("createAnthropic", "anthropic")],
  ["@ai-sdk/deepseek", providerStub("createDeepSeek", "deepseek")],
  ["@ai-sdk/google", providerStub("createGoogleGenerativeAI", "google")],
  ["@ai-sdk/openai", providerStub("createOpenAI", "openai")],
  ["@ai-sdk/openai-compatible", providerStub("createOpenAICompatible", "openai-compatible")],
  ["@openrouter/ai-sdk-provider", providerStub("createOpenRouter", "openrouter")],
]);
const stubPlugin = {
  name: "provider-regression-stubs",
  setup(build) {
    build.onResolve({ filter: /^@\/(.*)/ }, (args) => {
      if (stubs.has(args.path)) return { path: args.path, namespace: "provider-stub" };
      const base = join(src, args.path.slice(2));
      for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, join(base, "index.ts")]) {
        if (existsSync(candidate) && statSync(candidate).isFile()) return { path: candidate };
      }
      return { path: `${base}.ts` };
    });
    build.onResolve({ filter: /^(?:@ai-sdk|@openrouter|@tauri-apps)\// }, (args) =>
      stubs.has(args.path) ? { path: args.path, namespace: "provider-stub" } : undefined,
    );
    build.onLoad({ filter: /.*/, namespace: "provider-stub" }, (args) => ({
      contents: stubs.get(args.path),
      loader: "js",
    }));
  },
};

const outfile = join(outDir, "provider-regressions.mjs");
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "neutral",
  outfile,
  loader: { ".json": "json" },
  plugins: [stubPlugin],
});
const { useProviderStore, resolveLlmParams, fetchModelCatalog, createProviderInstance } = await import(
  pathToFileURL(outfile).href
);

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  PASS ${name}`);
  } else {
    failed += 1;
    console.log(
      `  FAIL ${name}${detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`,
    );
  }
}

const ZHIPU_CHAT = "https://open.bigmodel.cn/api/paas/v4";
const ZHIPU_ANTHROPIC = "https://open.bigmodel.cn/api/anthropic/v1";
const selectedModel = {
  modelId: "glm-custom",
  providerId: "zhipu",
  providerName: "智谱 GLM",
  modelName: "用户模型",
};
const utilityModel = {
  modelId: "glm-utility",
  providerId: "zhipu",
  providerName: "智谱 GLM",
  modelName: "辅助模型",
};
const models = [
  { id: "glm-custom", name: "用户模型", active: true, contextWindow: 123_456 },
  { id: "glm-utility", name: "辅助模型", active: true, maxOutputTokens: 8_192 },
];
const makeProvider = (provider, apiStyle, baseUrl, extra = {}) => ({
  name: provider,
  active: true,
  provider,
  apiStyle,
  apiKey: "test-key",
  baseUrl,
  models: structuredClone(models),
  ...extra,
});
const makeState = (provider) => ({
  modelProviders: [provider],
  selectedModel: structuredClone(selectedModel),
  utilityModel: structuredClone(utilityModel),
});
const migrate = useProviderStore.persist.getOptions().migrate;
const migrateState = async (state, version) => migrate(structuredClone(state), version);
const providerFrom = (state, id = "zhipu") => state.modelProviders.find((p) => p.provider === id);
const selectionPreserved = (state, id = "zhipu") => {
  const provider = providerFrom(state, id);
  return (
    JSON.stringify(provider?.models) === JSON.stringify(models) &&
    JSON.stringify(state.selectedModel) === JSON.stringify(selectedModel) &&
    JSON.stringify(state.utilityModel) === JSON.stringify(utilityModel)
  );
};

console.log("[1] Zustand persist v0–v10 智谱迁移");
check(
  "persist 版本升至 v10 以触发落盘修复",
  useProviderStore.persist.getOptions().version === 10,
  useProviderStore.persist.getOptions().version,
);
for (let version = 0; version <= 5; version += 1) {
  const state = await migrateState(makeState(makeProvider("zhipu", undefined, ZHIPU_CHAT)), version);
  const provider = providerFrom(state);
  check(
    `v${version} 智谱最终为 openai-chat + paas/v4`,
    provider?.apiStyle === "openai-chat" && provider?.baseUrl === ZHIPU_CHAT,
    { apiStyle: provider?.apiStyle, baseUrl: provider?.baseUrl },
  );
  check(`v${version} 迁移保留 models/selectedModel/utilityModel`, selectionPreserved(state));
}

const missingBaseUrlCases = [
  {
    label: "缺失",
    makeProvider: () => {
      const provider = makeProvider("zhipu", undefined, undefined);
      Reflect.deleteProperty(provider, "baseUrl");
      return provider;
    },
  },
  { label: "空字符串", makeProvider: () => makeProvider("zhipu", undefined, "") },
];
for (const testCase of missingBaseUrlCases) {
  for (let version = 0; version <= 5; version += 1) {
    const state = await migrateState(makeState(testCase.makeProvider()), version);
    const provider = providerFrom(state);
    check(
      `v${version} 智谱 baseUrl ${testCase.label}时补齐 paas/v4`,
      provider?.apiStyle === "openai-chat" && provider?.baseUrl === ZHIPU_CHAT,
      { apiStyle: provider?.apiStyle, baseUrl: provider?.baseUrl },
    );
    check(`v${version} baseUrl ${testCase.label}迁移保留模型选择`, selectionPreserved(state));
  }
}

const mismatchCases = [];
for (let version = 5; version <= 8; version += 1) {
  mismatchCases.push(
    { version, apiStyle: "openai-chat", baseUrl: ZHIPU_ANTHROPIC, wantStyle: "openai-chat", wantUrl: ZHIPU_CHAT },
    { version, apiStyle: "anthropic-messages", baseUrl: ZHIPU_CHAT, wantStyle: "openai-chat", wantUrl: ZHIPU_CHAT },
  );
}
mismatchCases.push(
  { version: 9, apiStyle: "openai-chat", baseUrl: ZHIPU_ANTHROPIC, wantStyle: "openai-chat", wantUrl: ZHIPU_CHAT },
  {
    version: 9,
    apiStyle: "anthropic-messages",
    baseUrl: ZHIPU_CHAT,
    wantStyle: "anthropic-messages",
    wantUrl: ZHIPU_ANTHROPIC,
  },
);
for (const testCase of mismatchCases) {
  const state = await migrateState(
    makeState(makeProvider("zhipu", testCase.apiStyle, testCase.baseUrl)),
    testCase.version,
  );
  const provider = providerFrom(state);
  const name = `v${testCase.version} ${testCase.apiStyle} + ${testCase.baseUrl === ZHIPU_CHAT ? "paas/v4" : "anthropic/v1"} 错位修复`;
  check(name, provider?.apiStyle === testCase.wantStyle && provider?.baseUrl === testCase.wantUrl, {
    actual: { apiStyle: provider?.apiStyle, baseUrl: provider?.baseUrl },
    expected: { apiStyle: testCase.wantStyle, baseUrl: testCase.wantUrl },
  });
  check(`${name}且不丢模型选择`, selectionPreserved(state));
}

for (const host of ["open.bigmodel.cn", "api.z.ai"]) {
  const codingPlan = makeProvider("zhipu", "anthropic-messages", `https://${host}/api/anthropic/v1`);
  const before = makeState(codingPlan);
  const state = await migrateState(before, 9);
  check(
    `v9 已主动选择的 Coding Plan（${host}）完全不变`,
    JSON.stringify(providerFrom(state)) === JSON.stringify(codingPlan),
    providerFrom(state),
  );
  check(`v9 Coding Plan（${host}）保留模型选择`, selectionPreserved(state));
}

const proxyCases = [
  {
    version: 9,
    provider: makeProvider("zhipu", "openai-chat", "https://relay.example.com/api/anthropic/v1"),
  },
  {
    version: 8,
    provider: makeProvider(
      "zhipu",
      "anthropic-messages",
      "https://relay.example.com/open.bigmodel.cn/api/anthropic/v1",
    ),
  },
];
for (const { version, provider } of proxyCases) {
  const state = await migrateState(makeState(provider), version);
  check(
    `v${version} 自定义代理不被官方端点迁移覆盖`,
    JSON.stringify(providerFrom(state)) === JSON.stringify(provider),
    providerFrom(state),
  );
}

const deepseekChat = makeProvider("deepseek", "openai-chat", "https://api.deepseek.com/v1");
const deepseekState = await migrateState(makeState(deepseekChat), 6);
check(
  "v6→v7 不改写显式 OpenAI chat 的 DeepSeek 地址",
  providerFrom(deepseekState, "deepseek")?.baseUrl === "https://api.deepseek.com/v1",
  providerFrom(deepseekState, "deepseek"),
);

console.log("[2] 转换器只接受真实 OpenAI 兼容端点");
const converterModel = (providerId, modelId = "fixture-model") => ({
  modelId,
  providerId,
  providerName: providerId,
  modelName: modelId,
});
const useUtilityProvider = (provider) => {
  const selected = converterModel(provider.provider);
  useProviderStore.setState({ modelProviders: [provider], selectedModel: selected, utilityModel: selected });
};
const llmError = (provider) => {
  useUtilityProvider(provider);
  try {
    resolveLlmParams();
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};
check(
  "Anthropic native-only 抛出可操作错误",
  llmError(
    makeProvider("anthropic", "anthropic-messages", "https://api.anthropic.com/v1", {
      endpoints: { "anthropic-messages": "https://api.anthropic.com/v1" },
    }),
  ).includes("没有 OpenAI 兼容端点"),
);
check(
  "自定义 Gemini native-only 抛出可操作错误",
  llmError(
    makeProvider("custom-1", "gemini", "https://relay.example.com/v1beta", {
      endpoints: { gemini: "https://relay.example.com/v1beta" },
    }),
  ).includes("没有 OpenAI 兼容端点"),
);
useUtilityProvider(makeProvider("custom-1", "openai-chat", "https://relay.example.com/v1", { endpoints: {} }));
const explicitChatParams = resolveLlmParams();
check(
  "显式 OpenAI chat 自定义端点仍可用于转换器",
  explicitChatParams.llmBaseUrl === "https://relay.example.com/v1" &&
    explicitChatParams.llmApiKey === "test-key" &&
    explicitChatParams.llmModel === "fixture-model",
  explicitChatParams,
);
useUtilityProvider(
  makeProvider("deepseek", "anthropic-messages", "https://api.deepseek.com/anthropic/v1", { endpoints: undefined }),
);
check(
  "native 主协议仍可复用预置 OpenAI chat endpoint",
  resolveLlmParams().llmBaseUrl === "https://api.deepseek.com/v1",
);

console.log("[3] 模型目录按 resolved protocol 发请求");
const catalogRequest = async (provider, modelId) => {
  globalThis.__providerHttpCalls = [];
  globalThis.__providerHttpResponder = () =>
    new Response(JSON.stringify({ data: [{ id: "fixture-model" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  try {
    await fetchModelCatalog(provider, modelId);
  } finally {
    globalThis.__providerHttpResponder = undefined;
  }
  return globalThis.__providerHttpCalls;
};

const geminiChatCalls = await catalogRequest(
  makeProvider("gemini", "openai-chat", "https://generativelanguage.googleapis.com/v1beta/openai"),
  "gemini-2.5-flash",
);
check(
  "Gemini openai-chat 请求 /v1beta/openai/models + Bearer",
  geminiChatCalls.length === 1 &&
    geminiChatCalls[0].url === "https://generativelanguage.googleapis.com/v1beta/openai/models" &&
    geminiChatCalls[0].init.headers.Authorization === "Bearer test-key" &&
    geminiChatCalls[0].init.headers["x-goog-api-key"] === undefined,
  geminiChatCalls,
);
const customGeminiCalls = await catalogRequest(
  makeProvider("custom-1", "gemini", "https://relay.example.com/v1beta"),
  "gemini-2.5-flash",
);
check(
  "custom Gemini 原生请求 /v1beta/models?key + x-goog-api-key",
  customGeminiCalls.length === 1 &&
    customGeminiCalls[0].url === "https://relay.example.com/v1beta/models?key=test-key" &&
    customGeminiCalls[0].init.headers["x-goog-api-key"] === "test-key" &&
    customGeminiCalls[0].init.headers.Authorization === undefined,
  customGeminiCalls,
);
const inferredGeminiCalls = await catalogRequest(
  makeProvider("custom-1", "auto", "https://open.cherryin.net/v1beta"),
  "google/gemini-3-pro",
);
check(
  "modelId 参与 custom auto 的 Gemini 原生协议解析",
  inferredGeminiCalls.length === 1 &&
    inferredGeminiCalls[0].url === "https://open.cherryin.net/v1beta/models?key=test-key" &&
    inferredGeminiCalls[0].init.headers["x-goog-api-key"] === "test-key",
  inferredGeminiCalls,
);
const fallbackGeminiProvider = makeProvider("custom-1", "auto", "https://open.cherryin.net/v1beta", {
  models: [
    { id: "acme/inactive-first", name: "Inactive", active: false },
    { id: "google/gemini-3-pro", name: "Gemini", active: true },
  ],
});
const fallbackGeminiCalls = await catalogRequest(fallbackGeminiProvider);
check(
  "无第二 arg 时服务按 provider 首个 active 模型回退 Gemini 协议",
  fallbackGeminiCalls.length === 1 &&
    fallbackGeminiCalls[0].url === "https://open.cherryin.net/v1beta/models?key=test-key" &&
    fallbackGeminiCalls[0].init.headers["x-goog-api-key"] === "test-key" &&
    fallbackGeminiCalls[0].init.headers.Authorization === undefined,
  fallbackGeminiCalls,
);
const conservativeAutoCalls = await catalogRequest(
  makeProvider("custom-1", "auto", "https://relay.example.com/v1beta"),
  "acme/unknown-model",
);
check(
  "未知 custom auto 仍保守使用 OpenAI 兼容模型列表",
  conservativeAutoCalls.length === 1 &&
    conservativeAutoCalls[0].url === "https://relay.example.com/v1beta/models" &&
    conservativeAutoCalls[0].init.headers.Authorization === "Bearer test-key" &&
    conservativeAutoCalls[0].init.headers["x-goog-api-key"] === undefined,
  conservativeAutoCalls,
);

console.log("[4] custom/Gemini chat 的视觉图片桥门控");
const imageDataUrl = `data:image/png;base64,${"A".repeat(64)}`;
const toolImageRequest = () =>
  JSON.stringify({
    messages: [
      {
        role: "tool",
        tool_call_id: "call-image",
        content: JSON.stringify({
          type: "content",
          value: [{ type: "file", mediaType: "image/png", url: imageDataUrl }],
        }),
      },
    ],
  });
const dispatchToolImage = async (config) => {
  globalThis.__providerFactoryCaptures = [];
  globalThis.__providerHttpCalls = [];
  createProviderInstance({ apiKey: "test-key", ...config });
  const capture = globalThis.__providerFactoryCaptures.at(-1);
  if (!capture?.options?.fetch) throw new Error("factory 未提供可捕获的 fetch");
  await capture.options.fetch("https://unit.test/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: toolImageRequest(),
  });
  const sent = globalThis.__providerHttpCalls.at(-1);
  return JSON.parse(sent.init.body);
};
const bridgeAddedUserImage = (body) =>
  body.messages.length === 2 &&
  body.messages[1].role === "user" &&
  body.messages[1].content.some((part) => part.type === "image_url" && part.image_url?.url === imageDataUrl) &&
  !body.messages[0].content.includes("data:image/");
const bridgeLeftBodyUntouched = (body) =>
  body.messages.length === 1 && body.messages[0].role === "tool" && body.messages[0].content.includes(imageDataUrl);

const customTextBody = await dispatchToolImage({
  providerId: "custom-1",
  apiStyle: "openai-chat",
  baseUrl: "https://relay.example.com/v1",
  modelId: "deepseek-chat",
});
check("custom chat 已知纯文本模型不挂图片桥", bridgeLeftBodyUntouched(customTextBody), customTextBody);
const customVisionBody = await dispatchToolImage({
  providerId: "custom-1",
  apiStyle: "openai-chat",
  baseUrl: "https://relay.example.com/v1",
  modelId: "gpt-4o",
});
check("custom chat 视觉模型挂图片桥", bridgeAddedUserImage(customVisionBody), customVisionBody);
const customUnknownBody = await dispatchToolImage({
  providerId: "custom-1",
  apiStyle: "openai-chat",
  baseUrl: "https://relay.example.com/v1",
  modelId: "acme/future-unknown-model",
});
check("custom chat 未知模型保持默认放行图片桥", bridgeAddedUserImage(customUnknownBody), customUnknownBody);
const geminiTextBody = await dispatchToolImage({
  providerId: "gemini",
  apiStyle: "openai-chat",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  modelId: "gemini-3.5-flash-cyber",
});
check("Gemini chat 已知纯文本模型不挂图片桥", bridgeLeftBodyUntouched(geminiTextBody), geminiTextBody);
const geminiVisionBody = await dispatchToolImage({
  providerId: "gemini",
  apiStyle: "openai-chat",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  modelId: "gemini-2.5-flash",
});
check("Gemini chat 视觉模型挂图片桥", bridgeAddedUserImage(geminiVisionBody), geminiVisionBody);

console.log(`\n结果：${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("PASS provider-regressions");
