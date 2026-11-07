// 用真实 provider 适配器捕获 Kimi K3.1 Pro 的出站请求；本地 400 在捕获后终止，不访问网络。
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const src = join(root, "packages/app/src");
const pnpmDir = join(root, "node_modules", ".pnpm");
const esbuildPkg = readdirSync(pnpmDir).find((d) => d.startsWith("esbuild@"));
if (!esbuildPkg) throw new Error("未找到 esbuild");
const esbuild = await import(
  pathToFileURL(join(pnpmDir, esbuildPkg, "node_modules", "esbuild", "lib", "main.js")).href
);
const outDir = mkdtempSync(join(tmpdir(), "kimi-k31-fetch-"));
const posix = (path) => path.replace(/\\/g, "/");
const httpStub = join(outDir, "http.ts");
const storeStub = join(outDir, "provider-store.ts");
const entry = join(outDir, "entry.ts");
const outfile = join(outDir, "probe.mjs");

writeFileSync(
  httpStub,
  `
const requests = [];
let nextResponse = null;
export function takeRequests() { return requests.splice(0); }
export function mockResponseOnce(response) { nextResponse = response; }
export async function fetch(input, init) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
  requests.push({ url, body });
  if (nextResponse) {
    const response = nextResponse;
    nextResponse = null;
    return response;
  }
  return new Response(JSON.stringify({ error: { message: "local request capture complete" } }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
}
`,
);
writeFileSync(
  storeStub,
  `
export const useProviderStore = { getState: () => ({ modelProviders: [], selectedModel: null }) };
`,
);
writeFileSync(
  entry,
  `
export { createProviderInstance, utilityTaskProviderOptions } from "${posix(join(src, "ai/providers/factory.ts"))}";
export { chatReasoningProviderOptions } from "${posix(join(src, "ai/providers/reasoning-map.ts"))}";
export { takeRequests, mockResponseOnce } from "${posix(httpStub)}";
`,
);
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "neutral",
  outfile,
  alias: { "@": src },
  loader: { ".json": "json" },
  plugins: [
    {
      name: "http-request-capture",
      setup(build) {
        build.onResolve({ filter: /^@tauri-apps\/plugin-http$/ }, () => ({ path: httpStub }));
        build.onResolve({ filter: /^@\/store\/provider-store$/ }, () => ({ path: storeStub }));
      },
    },
  ],
});
const lib = await import(pathToFileURL(outfile).href);
let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name} — ${JSON.stringify(detail)}`);
  }
}

async function probe(apiStyle, level, utility = false) {
  const baseUrl = apiStyle === "anthropic-messages" ? "https://open.cherryin.net/v1" : "https://open.cherryin.net/v1";
  const modelId = "moonshotai/kimi-k3.1-pro";
  const provider = lib.createProviderInstance({
    providerId: "custom-relay",
    apiKey: "test-only-not-a-secret",
    baseUrl,
    apiStyle,
    modelId,
    disableThinking: utility,
    reasoningLevelRef: utility ? undefined : () => level,
  });
  const model =
    apiStyle === "openai-responses" && typeof provider.responses === "function"
      ? provider.responses(modelId)
      : apiStyle === "openai-chat" && typeof provider.chat === "function"
        ? provider.chat(modelId)
        : provider(modelId);
  let error = "";
  try {
    await model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }] });
  } catch (caught) {
    error = String(caught);
  }
  return { requests: lib.takeRequests(), error };
}

async function probeOpenRouter(level, method = "doGenerate", utility = false, modelId = "moonshotai/kimi-k3.1-pro") {
  const provider = lib.createProviderInstance({
    providerId: "openrouter",
    apiKey: "test-only-not-a-secret",
    baseUrl: "https://openrouter.ai/api/v1",
    apiStyle: "openai-chat",
    modelId,
    disableThinking: utility,
    reasoningLevelRef: utility ? undefined : () => level,
  });
  const model = provider(modelId);
  const providerOptions = utility
    ? lib.utilityTaskProviderOptions("openrouter", modelId)
    : lib.chatReasoningProviderOptions("openrouter", modelId, level);
  let error = "";
  try {
    await model[method]({
      prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
      providerOptions,
    });
  } catch (caught) {
    error = String(caught);
  }
  return { requests: lib.takeRequests(), error };
}

function validShape(style, body, expected) {
  if (!body || body.model !== "moonshotai/kimi-k3.1-pro") return false;
  if (style === "openai-chat") {
    return (
      body.reasoning_effort === expected &&
      body.reasoning === undefined &&
      body.output_config === undefined &&
      body.thinking === undefined
    );
  }
  if (style === "openai-responses") {
    return (
      body.reasoning?.effort === expected &&
      body.reasoning_effort === undefined &&
      body.output_config === undefined &&
      body.thinking === undefined
    );
  }
  return (
    body.output_config?.effort === expected &&
    body.reasoning_effort === undefined &&
    body.reasoning === undefined &&
    body.thinking === undefined
  );
}

const styles = ["openai-chat", "openai-responses", "anthropic-messages"];
for (const [level, expected] of [
  ["high", "high"],
  ["off", "low"],
  ["none", "low"],
  ["on", "high"],
]) {
  for (const style of styles) {
    const result = await probe(style, level);
    const request = result.requests[0];
    check(
      `${style} ${level} → ${expected}`,
      result.requests.length === 1 && validShape(style, request?.body, expected),
      { requests: result.requests, error: result.error },
    );
  }
}
for (const style of styles) {
  const result = await probe(style, undefined, true);
  check(
    `${style} 轻量任务 off → low`,
    result.requests.length === 1 && validShape(style, result.requests[0]?.body, "low"),
    result,
  );
  const automatic = await probe(style, "auto");
  const body = automatic.requests[0]?.body;
  check(
    `${style} auto 不下发思考参数`,
    automatic.requests.length === 1 &&
      body &&
      !body.reasoning_effort &&
      !body.reasoning &&
      !body.output_config &&
      !body.thinking,
    automatic,
  );
}
for (const [level, expected] of [
  ["high", "high"],
  ["off", "low"],
  ["none", "low"],
  ["on", "high"],
]) {
  for (const method of ["doGenerate", "doStream"]) {
    const result = await probeOpenRouter(level, method);
    const body = result.requests[0]?.body;
    check(
      `OpenRouter ${method} ${level} 仅原生 reasoning=${expected}`,
      result.requests.length === 1 &&
        body?.model === "moonshotai/kimi-k3.1-pro" &&
        body?.reasoning?.effort === expected &&
        body.reasoning_effort === undefined &&
        body.output_config === undefined &&
        body.thinking === undefined,
      result,
    );
  }
}
const openrouterUtility = await probeOpenRouter("off", "doGenerate", true);
check(
  "OpenRouter 轻量任务不叠加 reasoning_effort",
  openrouterUtility.requests.length === 1 &&
    openrouterUtility.requests[0]?.body?.reasoning?.effort === "low" &&
    openrouterUtility.requests[0]?.body?.reasoning_effort === undefined,
  openrouterUtility,
);
const openrouterK3 = await probeOpenRouter("high", "doGenerate", false, "kimi-k3");
check(
  "OpenRouter K3 不叠加 reasoning_effort",
  openrouterK3.requests.length === 1 &&
    openrouterK3.requests[0]?.body?.model === "kimi-k3" &&
    openrouterK3.requests[0]?.body?.reasoning?.effort === "high" &&
    openrouterK3.requests[0]?.body?.reasoning_effort === undefined,
  openrouterK3,
);

async function probeMissingSignature(streaming, relay = false) {
  const prompt = [{ role: "user", content: [{ type: "text", text: "ping" }] }];
  const response = streaming
    ? new Response(
        new ReadableStream({
          start(controller) {
            const text = `event: message_start\ndata: {"type":"message_start","message":{"id":"chatcmpl-local","type":"message","role":"assistant","content":[],"model":"kimi-k3.1-pro","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"思考"}}\n\nevent: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"答"}}\n\nevent: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":1,"output_tokens":2}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`;
            const bytes = new TextEncoder().encode(text);
            for (let offset = 0; offset < bytes.length; offset += 7)
              controller.enqueue(bytes.slice(offset, offset + 7));
            controller.close();
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      )
    : new Response(
        JSON.stringify({
          id: "chatcmpl-local",
          type: "message",
          role: "assistant",
          content: [
            { type: "thinking", thinking: "思考" },
            { type: "text", text: "答" },
          ],
          model: "kimi-k3.1-pro",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        }),
        { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } },
      );
  lib.mockResponseOnce(response);
  const model = lib.createProviderInstance({
    providerId: relay ? "custom-relay" : "kimi",
    apiKey: "test-only-not-a-secret",
    baseUrl: relay ? "http://127.0.0.1:9" : "https://api.moonshot.cn/v1",
    apiStyle: "anthropic-messages",
    modelId: "kimi-k3.1-pro",
    reasoningLevelRef: () => "low",
  })("kimi-k3.1-pro");
  try {
    if (streaming) {
      const { stream } = await model.doStream({ prompt });
      const types = [];
      for await (const part of stream) types.push(part.type);
      return { types };
    }
    const result = await model.doGenerate({ prompt });
    return { content: result.content };
  } catch (error) {
    return { error: String(error), cause: String(error?.cause ?? "") };
  }
}

const missingSignature = await probeMissingSignature(false);
check(
  "Moonshot 缺省 signature 仍保留思考与正文",
  !missingSignature.error &&
    missingSignature.content?.some((part) => part.type === "reasoning" && part.text === "思考") &&
    missingSignature.content.some((part) => part.type === "text" && part.text === "答"),
  missingSignature,
);
const missingSignatureStream = await probeMissingSignature(true);
check(
  "Moonshot 流式缺省 signature 可按字块读取",
  !missingSignatureStream.error &&
    missingSignatureStream.types?.some((type) => type.includes("reasoning")) &&
    missingSignatureStream.types.some((type) => type.includes("text")),
  missingSignatureStream,
);
const relayMissingSignature = await probeMissingSignature(false, true);
check(
  "非 Moonshot 中继不擅自补 signature",
  relayMissingSignature.error?.includes("Invalid JSON response"),
  relayMissingSignature,
);

console.log(`\n结果：${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("PASS Kimi K3.1 Pro provider request capture");
