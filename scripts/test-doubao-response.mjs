import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
globalThis.window = dom.window;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
dom.window.__TAURI_INTERNALS__ = {
  invoke: async (command) => {
    if (command.includes("app_data_dir") || command === "plugin:path|resolve_directory") return "F:/default";
    if (command === "plugin:fs|exists") return false;
    if (command.startsWith("plugin:store|")) return null;
    return null;
  },
};

const root = fileURLToPath(new URL("../", import.meta.url));
const src = join(root, "packages/app/src");
const esbuildPkg = readdirSync(join(root, "node_modules", ".pnpm")).find((name) => name.startsWith("esbuild@"));
assert.ok(esbuildPkg);
const esbuild = await import(
  pathToFileURL(join(root, "node_modules", ".pnpm", esbuildPkg, "node_modules", "esbuild", "lib", "main.js")).href
);
const outDir = mkdtempSync(join(tmpdir(), "doubao-response-"));
const entry = join(outDir, "entry.ts");
const outfile = join(outDir, "bundle.mjs");
const posix = (path) => path.replace(/\\/g, "/");
writeFileSync(
  entry,
  `export { createProviderInstance, utilityTaskProviderOptions } from "${posix(join(src, "ai/providers/factory.ts"))}";
   export { useProviderStore } from "${posix(join(src, "store/provider-store.ts"))}";
   export { normalizeDoubaoResponsePayload } from "${posix(join(src, "ai/providers/doubao-response.ts"))}";
   export { generateText, streamText, jsonSchema, stepCountIs } from "ai";`,
);
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile,
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  alias: { "@": src },
  nodePaths: [join(root, "packages/app/node_modules")],
  logLevel: "silent",
});
const {
  createProviderInstance,
  utilityTaskProviderOptions,
  useProviderStore,
  normalizeDoubaoResponsePayload,
  generateText,
  streamText,
  jsonSchema,
  stepCountIs,
} = await import(pathToFileURL(outfile).href);

const responseBody = {
  created_at: 1793097601,
  id: "resp_fixture",
  object: "response",
  model: "doubao-seed-2-1-pro-260915",
  output: [
    {
      id: "rs_fixture",
      type: "reasoning",
      summary: [{ type: "summary_text", text: "简短思考" }],
      status: "completed",
      encrypted_content: "encrypted-fixture",
    },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "42" }],
      status: "completed",
      id: "msg_fixture",
    },
  ],
  service_tier: "default",
  status: "completed",
  usage: {
    input_tokens: 61,
    output_tokens: 21,
    total_tokens: 82,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 19 },
  },
  caching: { type: "disabled" },
  store: true,
  expire_at: 1793356801,
};

const bodyWithExistingArguments = {
  type: "response.output_item.added",
  item: { type: "function_call", call_id: "keep-id", name: "keep-name", arguments: '{"action":"list"}' },
};
const normalizedBody = normalizeDoubaoResponsePayload(responseBody);
assert.deepEqual(normalizedBody.output[1].content[0].annotations, []);
assert.equal(responseBody.output[1].content[0].annotations, undefined, "不得修改原始响应对象");
assert.deepEqual(normalizedBody.caching, responseBody.caching);
assert.deepEqual(normalizeDoubaoResponsePayload(bodyWithExistingArguments), bodyWithExistingArguments);

const factory = createProviderInstance({
  providerId: "doubao",
  apiKey: "fixture-not-a-secret",
  baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
  apiStyle: "openai-responses",
  modelId: "doubao-seed-2-1-pro-260915",
  fetch: async () =>
    new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
});
const model = factory.responses("doubao-seed-2-1-pro-260915");
const text = await generateText({ model, prompt: "只回答 17+25", maxOutputTokens: 512, maxRetries: 0 });
assert.equal(text.text, "42");

const event = (type, data) =>
  `event: ${type}\r\ndata: ${JSON.stringify({ type, sequence_number: 1, ...data })}\r\n\r\n`;
const firstMessage = {
  type: "message",
  role: "assistant",
  content: [],
  status: "in_progress",
  id: "msg_gate",
};
const completedMessage = {
  ...firstMessage,
  content: [{ type: "output_text", text: "先到" }],
  status: "completed",
};
const earlyPrefix = `${event("response.output_item.added", {
  output_index: 0,
  item: firstMessage,
})}${event("response.output_text.delta", {
  output_index: 0,
  item_id: "msg_gate",
  delta: "先到",
})}`;
const delayedSuffix = `${event("response.output_text.done", {
  output_index: 0,
  item_id: "msg_gate",
  text: "先到",
})}${event("response.output_item.done", {
  output_index: 0,
  item: completedMessage,
})}${event("response.completed", {
  response: {
    id: "resp_gate",
    created_at: 1793097602,
    model: "doubao-seed-2-1-pro-260915",
    status: "completed",
    output: [completedMessage],
  },
})}data: [DONE]\r\n\r\n`;
let releaseGate;
const gate = new Promise((resolve) => {
  releaseGate = resolve;
});
const gatedFactory = createProviderInstance({
  providerId: "doubao",
  apiKey: "fixture-not-a-secret",
  baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
  apiStyle: "openai-responses",
  modelId: "doubao-seed-2-1-pro-260915",
  fetch: async () =>
    new Response(
      new ReadableStream({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode(earlyPrefix));
          await gate;
          controller.enqueue(new TextEncoder().encode(delayedSuffix));
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ),
});
const gatedStream = streamText({
  model: gatedFactory.responses("doubao-seed-2-1-pro-260915"),
  prompt: "分段回答",
  maxOutputTokens: 256,
  maxRetries: 0,
});
const firstText = (async () => {
  for await (const part of gatedStream.fullStream) {
    if (part.type === "text-delta") return part;
  }
  throw new Error("没有文本增量");
})();
let firstTimer;
const early = await Promise.race([
  firstText.then(
    (value) => ({ value }),
    (error) => ({ error }),
  ),
  new Promise((resolve) => {
    firstTimer = setTimeout(() => resolve({ timeout: true }), 200);
  }),
]);
clearTimeout(firstTimer);
releaseGate();
assert.equal(early.timeout, undefined, "第一段文本必须在整个 SSE 响应结束前到达");
assert.equal(early.error, undefined);
assert.equal(early.value?.text, "先到");
assert.equal(await gatedStream.text, "先到");

const streamBody = `${event("response.output_item.added", {
  output_index: 0,
  item: {
    type: "function_call",
    id: "fc_fixture",
    call_id: "call_fixture",
    name: "manageThreads",
    status: "in_progress",
  },
})}${event("response.function_call_arguments.done", {
  output_index: 0,
  item_id: "fc_fixture",
  arguments: '{"action":"list","starredOnly":false,"reasoning":"只读"}',
})}${event("response.output_item.done", {
  output_index: 0,
  item: {
    type: "function_call",
    id: "fc_fixture",
    call_id: "call_fixture",
    name: "manageThreads",
    arguments: '{"action":"list","starredOnly":false,"reasoning":"只读"}',
    status: "completed",
  },
})}${event("response.completed", {
  response: {
    id: "resp_fixture_stream",
    created_at: 1793097602,
    model: "doubao-seed-2-1-pro-260915",
    status: "completed",
    output: [
      {
        type: "function_call",
        id: "fc_fixture",
        call_id: "call_fixture",
        name: "manageThreads",
        arguments: '{"action":"list","starredOnly":false,"reasoning":"只读"}',
        status: "completed",
      },
    ],
  },
})}data: [DONE]\r\n\r\n`;
const streamFactory = createProviderInstance({
  providerId: "doubao",
  apiKey: "fixture-not-a-secret",
  baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
  apiStyle: "openai-responses",
  modelId: "doubao-seed-2-1-pro-260915",
  fetch: async () => new Response(streamBody, { status: 200, headers: { "content-type": "text/event-stream" } }),
});
const streamModel = streamFactory.responses("doubao-seed-2-1-pro-260915");
const errors = [];
const calls = [];
const stream = streamText({
  model: streamModel,
  messages: [{ role: "user", content: "请调用 manageThreads 的 list" }],
  tools: {
    manageThreads: {
      description: "只读列出对话",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          action: { type: "string", enum: ["list"] },
          starredOnly: { type: "boolean" },
          reasoning: { type: "string" },
        },
        required: ["action", "starredOnly", "reasoning"],
        additionalProperties: false,
      }),
      execute: async (input) => {
        calls.push(input);
        return { results: { success: true, total: 0 } };
      },
    },
  },
  toolChoice: "auto",
  stopWhen: stepCountIs(1),
  maxOutputTokens: 256,
  maxRetries: 0,
  onError: ({ error }) => errors.push(String(error)),
});
for await (const part of stream.fullStream) {
  if (part.type === "tool-call") {
    assert.equal(part.toolName, "manageThreads");
    assert.equal(part.input.action, "list");
    assert.equal(part.input.reasoning, "只读");
  }
}
assert.deepEqual(errors, []);
assert.equal(calls.length, 1);

let replayBody;
const replayFactory = createProviderInstance({
  providerId: "doubao",
  apiKey: "fixture-not-a-secret",
  baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
  apiStyle: "openai-responses",
  modelId: "doubao-seed-2-1-pro-260915",
  fetch: async (_input, init) => {
    replayBody = JSON.parse(init.body);
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
});
const originalProviders = useProviderStore.getState().modelProviders;
const doubaoPreset = originalProviders.find((provider) => provider.provider === "doubao");
useProviderStore.setState({
  modelProviders: originalProviders.map((provider) =>
    provider.provider === "doubao"
      ? { ...provider, apiStyle: "openai-responses", baseUrl: "https://ark.cn-beijing.volces.com/api/v3" }
      : provider,
  ),
});
const doubaoOptions = utilityTaskProviderOptions("doubao", "doubao-seed-2-1-pro-260915");
useProviderStore.setState({ modelProviders: originalProviders });
assert.ok(doubaoPreset);
assert.equal(doubaoOptions?.openai?.store, false, "官方豆包 Responses 使用 SDK 原生的完整历史回传");
await generateText({
  model: replayFactory.responses("doubao-seed-2-1-pro-260915"),
  messages: [
    {
      role: "assistant",
      content: [
        {
          type: "reasoning",
          text: "",
          providerOptions: { openai: { itemId: "rs_fixture", reasoningEncryptedContent: "encrypted-fixture" } },
        },
        {
          type: "tool-call",
          toolCallId: "call_fixture",
          toolName: "manageThreads",
          input: { action: "list" },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_fixture",
          toolName: "manageThreads",
          output: { type: "json", value: { results: { success: true, total: 42 } } },
        },
      ],
    },
  ],
  toolChoice: "none",
  providerOptions: doubaoOptions,
  maxOutputTokens: 256,
  maxRetries: 0,
});
assert.equal(
  replayBody.input.some((item) => item.type === "item_reference"),
  false,
  `豆包不接受 item_reference：${JSON.stringify({ store: replayBody.store, types: replayBody.input.map((item) => item.type) })}`,
);
assert.equal(replayBody.store, false, "仅遇到引用记录时改为直接回传完整内容");
assert.equal(replayBody.input[0].type, "reasoning");
assert.equal(replayBody.input[0].id, "rs_fixture");
assert.equal(replayBody.input[0].encrypted_content, "encrypted-fixture");
assert.equal(replayBody.input[1].type, "function_call");
assert.equal(replayBody.input[2].type, "function_call_output");
assert.equal(replayBody.input[2].call_id, replayBody.input[1].call_id);
console.log("PASS 豆包 Responses 非流式 annotations、流式 function_call.arguments 与工具历史兼容");
dom.window.close();
