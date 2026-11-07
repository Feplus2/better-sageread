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
    `export { chatReasoningBodyPatch } from "${posix(join(src, "ai/providers/reasoning-map.ts"))}";`,
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
const { useProviderStore, resolveLlmParams, fetchModelCatalog, createProviderInstance, chatReasoningBodyPatch } = await import(
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

console.log("[1] Zustand persist v0–v14 智谱迁移、官方 Responses 与腾讯预置");
check(
  "persist 版本升至 v14 以非破坏合并腾讯预置",
  useProviderStore.persist.getOptions().version === 14,
  useProviderStore.persist.getOptions().version,
);
const tencentLegacy = await migrateState(makeState(makeProvider("zhipu", "openai-chat", ZHIPU_CHAT)), 13);
const tencentPreset = providerFrom(tencentLegacy, "tencent");
check(
  "v13 老配置只追加腾讯 Hy4 官方预算、协议与视觉型号，默认未启用",
  tencentPreset?.active === false &&
    tencentPreset.apiStyle === "openai-chat" &&
    tencentPreset.baseUrl === "https://tokenhub.tencentmaas.com/v1" &&
    tencentPreset.endpoints?.["openai-chat"] === tencentPreset.baseUrl &&
    tencentPreset.models?.some((model) =>
      model.id === "hy4" && model.contextWindow === 1_024_000 && model.maxOutputTokens === 64_000 && model.active === true
    ),
  tencentPreset,
);
check("新增腾讯不覆盖旧提供商模型与两个模型选择", selectionPreserved(tencentLegacy), tencentLegacy);
const customTencent = makeProvider("tencent", "anthropic-messages", "https://relay.example/v1", { active: false });
const preservedTencent = await migrateState(makeState(customTencent), 13);
check(
  "已有同 id 腾讯代理、协议、Key 和模型完全保留",
  JSON.stringify(providerFrom(preservedTencent, "tencent")) === JSON.stringify(customTencent) &&
    JSON.stringify(preservedTencent.selectedModel) === JSON.stringify(selectedModel) &&
    JSON.stringify(preservedTencent.utilityModel) === JSON.stringify(utilityModel),
  providerFrom(preservedTencent, "tencent"),
);
for (const providerId of ["qwen", "doubao"]) {
  const preset = providerFrom(useProviderStore.getState(), providerId);
  check(
    `${providerId} 新预置默认 Responses，保留国内地址与备选协议`,
    preset?.apiStyle === "openai-responses" &&
      preset.endpoints?.["openai-chat"] === preset.baseUrl &&
      preset.endpoints?.["openai-responses"] === preset.baseUrl,
    preset,
  );
  const legacy = await migrateState(makeState(makeProvider(providerId, "auto", preset.baseUrl)), 12);
  const migrated = providerFrom(legacy, providerId);
  check(
    `v12 ${providerId} 官方旧默认升级 Responses，不改模型与选择`,
    migrated?.apiStyle === "openai-responses" && selectionPreserved(legacy, providerId),
    migrated,
  );
  const explicitChat = makeProvider(providerId, "openai-chat", preset.baseUrl);
  const preservedExplicitChat = await migrateState(makeState(explicitChat), 12);
  check(
    `v12 ${providerId} 显式 openai-chat 不被迁移覆盖`,
    providerFrom(preservedExplicitChat, providerId)?.apiStyle === "openai-chat" &&
      selectionPreserved(preservedExplicitChat, providerId),
    providerFrom(preservedExplicitChat, providerId),
  );
  const custom = makeProvider(providerId, "openai-chat", "https://relay.example.com/v1", { active: false });
  const preserved = await migrateState(makeState(custom), 12);
  check(
    `v12 ${providerId} 自定义代理协议、地址和 active 完全保留`,
    JSON.stringify(providerFrom(preserved, providerId)) === JSON.stringify(custom),
    providerFrom(preserved, providerId),
  );
}
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

const stepPreset = providerFrom(useProviderStore.getState(), "stepfun");
check(
  "StepFun 预置默认未启用、Responses、完整普通 API 端点与动态模型列表",
  stepPreset?.active === false &&
    stepPreset.apiStyle === "openai-responses" &&
    stepPreset.name === "阶跃星辰 StepFun" &&
    stepPreset.baseUrl === "https://api.stepfun.com/v1" &&
    stepPreset.endpoints?.["openai-chat"] === "https://api.stepfun.com/v1" &&
    stepPreset.endpoints?.["openai-responses"] === "https://api.stepfun.com/v1" &&
    stepPreset.endpoints?.["anthropic-messages"] === "https://api.stepfun.com/v1" &&
    stepPreset.models.length === 0 &&
    !JSON.stringify(stepPreset).includes("step_plan"),
  stepPreset,
);
const stepMigrationState = await migrateState(makeState(makeProvider("zhipu", "openai-chat", ZHIPU_CHAT)), 10);
check(
  "v10 老配置补一次 StepFun 且保留原选择",
  stepMigrationState.modelProviders.filter((provider) => provider.provider === "stepfun").length === 1 &&
    selectionPreserved(stepMigrationState),
  stepMigrationState,
);
const legacyStepState = await migrateState(
  makeState(makeProvider("stepfun", "openai-chat", "https://api.stepfun.com/v1", { active: false })),
  11,
);
check(
  "v11 官方 Step 默认升级 Responses，保留普通 API 三协议",
  providerFrom(legacyStepState, "stepfun")?.apiStyle === "openai-responses" &&
    providerFrom(legacyStepState, "stepfun")?.endpoints?.["anthropic-messages"] === "https://api.stepfun.com/v1" &&
    selectionPreserved(legacyStepState, "stepfun"),
  providerFrom(legacyStepState, "stepfun"),
);
const customStep = makeProvider("stepfun", "openai-chat", "https://api.stepfun.ai/step_plan/v1", {
  active: false,
});
const customStepState = await migrateState(makeState(customStep), 10);
check(
  "已有 StepFun 不重复、不改自定义 host、协议或 active",
  customStepState.modelProviders.filter((provider) => provider.provider === "stepfun").length === 1 &&
    JSON.stringify(providerFrom(customStepState, "stepfun")) === JSON.stringify(customStep),
  providerFrom(customStepState, "stepfun"),
);
const legacyMinimaxState = await migrateState(
  makeState(makeProvider("minimax", "anthropic-messages", "https://api.minimaxi.com/anthropic/v1", { active: false })),
  11,
);
check(
  "v11 MiniMax 保留既有主机并补国内 Responses，不改模型选择",
  providerFrom(legacyMinimaxState, "minimax")?.baseUrl === "https://api.minimaxi.com/anthropic/v1" &&
    providerFrom(legacyMinimaxState, "minimax")?.endpoints?.["openai-responses"] === "https://api.minimax.cn/v1" &&
    selectionPreserved(legacyMinimaxState, "minimax"),
  providerFrom(legacyMinimaxState, "minimax"),
);
const customMinimax = makeProvider("minimax", "openai-chat", "https://relay.example.com/v1", { active: false });
const customMinimaxState = await migrateState(makeState(customMinimax), 11);
check(
  "v11 MiniMax 自定义代理完全保留",
  JSON.stringify(providerFrom(customMinimaxState, "minimax")) === JSON.stringify(customMinimax),
  providerFrom(customMinimaxState, "minimax"),
);
const minimaxBefore = providerFrom(useProviderStore.getState(), "minimax");
const minimaxState = await migrateState(makeState(makeProvider("zhipu", "openai-chat", ZHIPU_CHAT)), 10);
check(
  "StepFun 合并不重复或改写 MiniMax",
  minimaxState.modelProviders.filter((provider) => provider.provider === "minimax").length === 1 &&
    JSON.stringify(providerFrom(minimaxState, "minimax")) === JSON.stringify(minimaxBefore),
  providerFrom(minimaxState, "minimax"),
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

console.log("[5] StepFun 模型目录与工厂契约");
const stepCatalogCalls = await catalogRequest(makeProvider("stepfun", "openai-chat", "https://api.stepfun.com/v1"));
check(
  "StepFun 模型列表只请求官方 /models",
  stepCatalogCalls.length === 1 &&
    stepCatalogCalls[0].url === "https://api.stepfun.com/v1/models" &&
    stepCatalogCalls[0].init.method === "GET" &&
    stepCatalogCalls[0].init.headers.Authorization === "Bearer test-key",
  stepCatalogCalls.map((call) => ({
    url: call.url,
    method: call.init.method,
    authorized: call.init.headers.Authorization === "Bearer test-key",
  })),
);
const stepModel = createProviderInstance({
  providerId: "stepfun",
  apiKey: "test-key",
  baseUrl: "https://api.stepfun.ai/v1",
  apiStyle: "openai-chat",
  disableThinking: false,
  modelId: "step-3.7-flash",
})("step-3.7-flash");
const stepFactoryCapture = globalThis.__providerFactoryCaptures.at(-1);
check(
  "StepFun 使用 OpenAI-compatible 且保留国际 host",
  stepModel.provider === "openai-compatible" && stepFactoryCapture?.options.baseURL === "https://api.stepfun.ai/v1",
  { provider: stepModel.provider, baseURL: stepFactoryCapture?.options.baseURL },
);
const observedStepCalls = [];
const observedStepFetch = async (input, init) => {
  observedStepCalls.push({ url: typeof input === "string" ? input : input.url, method: init?.method ?? "GET" });
  return new Response("{}", { status: 200 });
};
createProviderInstance({
  providerId: "stepfun",
  apiKey: "test-key",
  baseUrl: "https://api.stepfun.com/v1",
  apiStyle: "openai-chat",
  modelId: "step-3.7-flash",
  fetch: observedStepFetch,
});
const observedStepCapture = globalThis.__providerFactoryCaptures.at(-1);
globalThis.__providerHttpCalls = [];
await observedStepCapture.options.fetch("https://unit.test/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ messages: [] }),
});
check(
  "工厂保留可选 fetch 观测入口且不改变默认请求",
  observedStepCalls.length === 1 &&
    observedStepCalls[0].url === "https://unit.test/chat/completions" &&
    observedStepCalls[0].method === "POST" &&
    globalThis.__providerHttpCalls.length === 0,
  { observedStepCalls, defaultCalls: globalThis.__providerHttpCalls.length },
);
const stepPlanModel = createProviderInstance({
  providerId: "stepfun",
  apiKey: "test-key",
  baseUrl: "https://api.stepfun.ai/step_plan/v1",
  apiStyle: "openai-chat",
  disableThinking: false,
  modelId: "step-3.7-flash",
});
const stepPlanCapture = globalThis.__providerFactoryCaptures.at(-1);
check(
  "StepFun 自定义套餐 host 不被替换",
  stepPlanModel("step-3.7-flash").provider === "openai-compatible" &&
    stepPlanCapture?.options.baseURL === "https://api.stepfun.ai/step_plan/v1",
  stepPlanCapture?.options.baseURL,
);

console.log("[6] 腾讯 Hy4 协议、视觉图片桥与恒思考档位");
const tencentVisionBody = await dispatchToolImage({
  providerId: "tencent",
  apiStyle: "openai-chat",
  baseUrl: "https://tokenhub.tencentmaas.com/v1",
  modelId: "hy4",
});
check("腾讯 Hy4 正式版允许视觉图片桥", bridgeAddedUserImage(tencentVisionBody), tencentVisionBody);
const tencentPreviewBody = await dispatchToolImage({
  providerId: "tencent",
  apiStyle: "openai-chat",
  baseUrl: "https://tokenhub.tencentmaas.com/v1",
  modelId: "hy4-preview",
});
check("hy4-preview 原有纯文本映射不被正式版覆盖", bridgeLeftBodyUntouched(tencentPreviewBody), tencentPreviewBody);
const tencentModel = createProviderInstance({
  providerId: "tencent",
  apiKey: "test-key",
  baseUrl: "https://tokenhub.tencentmaas.com/v1",
  apiStyle: "openai-chat",
  disableThinking: true,
  modelId: "hy4",
})("hy4");
const tencentFactoryCapture = globalThis.__providerFactoryCaptures.at(-1);
check(
  "腾讯默认走 OpenAI-compatible 与国内 /v1 地址",
  tencentModel.provider === "openai-compatible" && tencentFactoryCapture?.options.baseURL === "https://tokenhub.tencentmaas.com/v1",
  tencentFactoryCapture?.options,
);
globalThis.__providerHttpCalls = [];
await tencentFactoryCapture.options.fetch("https://unit.test/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ model: "hy4", messages: [] }),
});
const tencentUtilityBody = JSON.parse(globalThis.__providerHttpCalls.at(-1).init.body);
check("轻量任务对恒思考 Hy4 降到 low 而不是发 disabled", tencentUtilityBody.reasoning_effort === "low" && tencentUtilityBody.thinking === undefined, tencentUtilityBody);
const highPatch = chatReasoningBodyPatch("tencent", "https://tokenhub.tencentmaas.com/v1", "hy4", "high");
const highBody = {};
highPatch?.(highBody);
const offPatch = chatReasoningBodyPatch("tencent", "https://tokenhub.tencentmaas.com/v1", "hy4", "off");
const offBody = {};
offPatch?.(offBody);
check("Hy4 聊天档位支持 high 且 off 钳到 low", highBody.reasoning_effort === "high" && offBody.reasoning_effort === "low", { highBody, offBody });

console.log(`\n结果：${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("PASS provider-regressions");
