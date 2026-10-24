// 工具历史兼容 L1：direct↔directory 只改请求副本；未知/New/Legacy 工具证据保留；
// 旧 raw MCP 图片在请求开始前剥字节，路径与结构字段保留。真实 AI SDK convertToModelMessages 参与断言。
// 运行：node scripts/test-tool-history.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
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

const outDir = mkdtempSync(join(tmpdir(), "tool-history-"));
const entry = join(outDir, "entry.ts");
const posix = (path) => path.replace(/\\/g, "/");
writeFileSync(
  entry,
  [
    `export * as processor from "${posix(join(src, "ai/utils/message-processor.ts"))}";`,
    `export { convertToModelMessages } from "ai";`,
  ].join("\n"),
);
const outfile = join(outDir, "history.mjs");
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile,
  alias: { "@": src },
  nodePaths: [join(root, "packages/app/node_modules")],
  logLevel: "silent",
});
const { processor, convertToModelMessages } = await import(pathToFileURL(outfile).href);

let passed = 0;
let failed = 0;
async function test(name, run) {
  try {
    await run();
    passed += 1;
    console.log(`  PASS ${name}`);
  } catch (error) {
    failed += 1;
    const detail = error instanceof Error ? error.message : String(error);
    console.log(`  FAIL ${name} — ${detail.slice(0, 700)}`);
  }
}

const realTools = {
  readDocument: {},
  getDocumentInfo: {},
  readPaperSection: {},
  mcp_demo_render: {},
};
const outputSentinel = { sentinel: "OUTPUT-SENTINEL", nested: { keep: [1, 2, 3] } };
const argsSentinel = { doc: "paper:p1", heading: "Results" };
const approvalSentinel = { id: "approval-1", approved: true, reason: "approved in history" };
const callMetadata = { provider: { call: "metadata" } };
const resultMetadata = { provider: { result: "metadata" } };

console.log("[1] direct → directory：包装已知工具，保留结果/审批/元数据与原消息");
await test("static direct part 包装为 useTool，哨兵字段引用与原 UI 消息不变", () => {
  const part = {
    type: "tool-readDocument",
    toolCallId: "call-direct-static",
    state: "output-available",
    input: argsSentinel,
    output: outputSentinel,
    providerExecuted: true,
    approval: approvalSentinel,
    callProviderMetadata: callMetadata,
    resultProviderMetadata: resultMetadata,
    toolMetadata: { origin: "sentinel" },
  };
  const message = { id: "m1", role: "assistant", metadata: { createdAt: "sentinel" }, parts: [part] };
  const messages = [message];
  const adapted = processor.adaptToolHistoryForRequest(messages, { directoryMode: true, tools: realTools });
  const next = adapted[0].parts[0];
  assert.equal(next.type, "tool-useTool");
  assert.deepEqual(next.input, { tool: "readDocument", args: argsSentinel });
  assert.equal(next.toolCallId, part.toolCallId);
  assert.equal(next.output, outputSentinel);
  assert.equal(next.approval, approvalSentinel);
  assert.equal(next.providerExecuted, true);
  assert.equal(next.callProviderMetadata, callMetadata);
  assert.equal(next.resultProviderMetadata, resultMetadata);
  assert.deepEqual(next.toolMetadata, { origin: "sentinel" });
  assert.equal(adapted[0].metadata, message.metadata);
  assert.equal(part.type, "tool-readDocument");
  assert.equal(part.input, argsSentinel);
});

await test("dynamic direct part 保留 dynamic 形态与 toolMetadata，仅改请求工具名/入参", () => {
  const part = {
    type: "dynamic-tool",
    dynamic: true,
    toolName: "mcp_demo_render",
    toolCallId: "call-direct-dynamic",
    state: "output-available",
    input: { page: 3 },
    output: outputSentinel,
    toolMetadata: { mcp: { server: "demo" } },
  };
  const [adapted] = processor.adaptToolHistoryForRequest([{ id: "m2", role: "assistant", parts: [part] }], {
    directoryMode: true,
    tools: realTools,
  });
  const next = adapted.parts[0];
  assert.equal(next.type, "dynamic-tool");
  assert.equal(next.dynamic, true);
  assert.equal(next.toolName, "useTool");
  assert.deepEqual(next.input, { tool: "mcp_demo_render", args: { page: 3 } });
  assert.equal(next.output, outputSentinel);
  assert.deepEqual(next.toolMetadata, { mcp: { server: "demo" } });
  assert.equal(part.toolName, "mcp_demo_render");
});

console.log("[2] directory → direct：仅解包当前存在的转发目标");
await test("已知 useTool 目标解包为 static direct，output/approval 不变", () => {
  const part = {
    type: "tool-useTool",
    toolCallId: "call-directory-static",
    state: "output-available",
    input: { tool: "readDocument", args: argsSentinel },
    output: outputSentinel,
    approval: approvalSentinel,
    providerExecuted: false,
  };
  const [adapted] = processor.adaptToolHistoryForRequest([{ id: "m3", role: "assistant", parts: [part] }], {
    directoryMode: false,
    tools: realTools,
  });
  const next = adapted.parts[0];
  assert.equal(next.type, "tool-readDocument");
  assert.equal(next.input, argsSentinel);
  assert.equal(next.output, outputSentinel);
  assert.equal(next.approval, approvalSentinel);
  assert.equal(next.providerExecuted, false);
  assert.equal(part.type, "tool-useTool");
});

await test("dynamic useTool 解包后保留 dynamic 形态", () => {
  const part = {
    type: "dynamic-tool",
    dynamic: false,
    toolName: "useTool",
    toolCallId: "call-directory-dynamic",
    state: "output-available",
    input: { tool: "readPaperSection", args: { section: "abstract" } },
    output: outputSentinel,
  };
  const [adapted] = processor.adaptToolHistoryForRequest([{ id: "m4", role: "assistant", parts: [part] }], {
    directoryMode: false,
    tools: realTools,
  });
  const next = adapted.parts[0];
  assert.equal(next.type, "dynamic-tool");
  assert.equal(next.dynamic, false);
  assert.equal(next.toolName, "readPaperSection");
  assert.deepEqual(next.input, { section: "abstract" });
  assert.equal(next.output, outputSentinel);
});

await test("转发目标已下线时 useTool 原 part 保留，不猜替代工具", () => {
  const part = {
    type: "tool-useTool",
    toolCallId: "call-retired-target",
    state: "output-available",
    input: { tool: "deleteBook", args: { bookId: "b1" } },
    output: outputSentinel,
  };
  const messages = [{ id: "m5", role: "assistant", parts: [part] }];
  const adapted = processor.adaptToolHistoryForRequest(messages, { directoryMode: false, tools: realTools });
  assert.equal(adapted, messages);
  assert.equal(adapted[0].parts[0], part);
  assert.equal(adapted[0].parts[0].output, outputSentinel);
});

console.log("[3] New↔Legacy / 已下线工具：不按当前工具面删除历史");
await test("New 工具在 Legacy 工具面不存在时保持 direct 原 part", () => {
  const part = {
    type: "tool-readDocument",
    toolCallId: "call-new-in-legacy",
    state: "output-available",
    input: argsSentinel,
    output: outputSentinel,
  };
  const messages = [{ id: "m6", role: "assistant", parts: [part] }];
  const adapted = processor.adaptToolHistoryForRequest(messages, {
    directoryMode: true,
    tools: { readPaperSection: {} },
  });
  assert.equal(adapted, messages);
  assert.equal(adapted[0].parts[0], part);
});

await test("Legacy 工具在 New 工具面不存在时保持 direct 原 part", () => {
  const part = {
    type: "tool-readPaperSection",
    toolCallId: "call-legacy-in-new",
    state: "output-available",
    input: { section: "abstract" },
    output: outputSentinel,
  };
  const messages = [{ id: "m7", role: "assistant", parts: [part] }];
  const adapted = processor.adaptToolHistoryForRequest(messages, {
    directoryMode: true,
    tools: { readDocument: {} },
  });
  assert.equal(adapted, messages);
  assert.equal(adapted[0].parts[0], part);
});

await test("tool-only assistant 与未知工具 output 经真实 SDK 转换仍成对保留", async () => {
  const messages = [
    {
      id: "m8",
      role: "assistant",
      parts: [
        {
          type: "tool-deleteBook",
          toolCallId: "call-retired-only",
          state: "output-available",
          input: { bookId: "b1" },
          output: outputSentinel,
        },
      ],
    },
  ];
  const adapted = processor.adaptToolHistoryForRequest(messages, { directoryMode: true, tools: realTools });
  assert.equal(adapted.length, 1);
  assert.equal(adapted[0].parts.length, 1);
  const converted = await convertToModelMessages(adapted, { tools: {}, ignoreIncompleteToolCalls: true });
  assert.equal(converted.length, 2);
  assert.equal(converted[0].role, "assistant");
  assert.equal(converted[1].role, "tool");
  const call = converted[0].content.find((part) => part.type === "tool-call");
  const result = converted[1].content.find((part) => part.type === "tool-result");
  assert.equal(call.toolCallId, "call-retired-only");
  assert.equal(call.toolName, "deleteBook");
  assert.equal(result.toolCallId, "call-retired-only");
  assert.deepEqual(result.output, { type: "json", value: outputSentinel });
});

await test("dynamic:false 不可用历史用 conversion-only stub 保留原 output，stub 不进入 live 工具面", async () => {
  const messages = [
    {
      id: "m8-dynamic-unavailable",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          dynamic: false,
          toolName: "retiredDynamic",
          toolCallId: "call-retired-dynamic",
          state: "output-available",
          input: { legacy: true },
          output: outputSentinel,
        },
      ],
    },
  ];
  const liveTools = {};
  const adapted = processor.adaptToolHistoryForRequest(messages, { directoryMode: false, tools: liveTools });
  const withStubs = processor.withUnavailableDynamicHistoryStubs;
  const conversionTools = typeof withStubs === "function" ? withStubs(adapted, liveTools) : liveTools;
  const converted = await convertToModelMessages(adapted, {
    tools: conversionTools,
    ignoreIncompleteToolCalls: true,
  });
  const result = converted
    .flatMap((message) => (message.role === "tool" ? message.content : []))
    .find((part) => part.type === "tool-result" && part.toolCallId === "call-retired-dynamic");
  assert.deepEqual(result.output, { type: "json", value: outputSentinel });
  assert.equal(typeof withStubs, "function");
  assert.notEqual(conversionTools, liveTools);
  assert.equal(Object.prototype.hasOwnProperty.call(conversionTools, "retiredDynamic"), true);
  assert.equal(Object.prototype.hasOwnProperty.call(liveTools, "retiredDynamic"), false);
});

await test("providerExecuted + approval 经适配和真实 SDK 转换后 call/result/approval 不复制不丢失", async () => {
  const messages = [
    {
      id: "m9",
      role: "assistant",
      parts: [
        {
          type: "tool-readDocument",
          toolCallId: "call-provider-executed",
          state: "output-available",
          input: argsSentinel,
          output: outputSentinel,
          providerExecuted: true,
          approval: approvalSentinel,
          callProviderMetadata: callMetadata,
          resultProviderMetadata: resultMetadata,
        },
      ],
    },
  ];
  const adapted = processor.adaptToolHistoryForRequest(messages, { directoryMode: true, tools: realTools });
  const converted = await convertToModelMessages(adapted, {
    tools: { useTool: {} },
    ignoreIncompleteToolCalls: true,
  });
  const flat = converted.flatMap((message) => message.content);
  assert.equal(flat.filter((part) => part.type === "tool-call").length, 1);
  assert.equal(flat.filter((part) => part.type === "tool-result").length, 1);
  assert.equal(flat.filter((part) => part.type === "tool-approval-request").length, 1);
  assert.equal(flat.filter((part) => part.type === "tool-approval-response").length, 1);
  const call = flat.find((part) => part.type === "tool-call");
  const result = flat.find((part) => part.type === "tool-result");
  assert.equal(call.toolName, "useTool");
  assert.equal(call.providerExecuted, true);
  assert.deepEqual(call.providerOptions, callMetadata);
  assert.equal(result.toolCallId, "call-provider-executed");
  assert.deepEqual(result.providerOptions, resultMetadata);
  assert.deepEqual(result.output, { type: "json", value: outputSentinel });
});

console.log("[4] 请求开始前的 raw MCP 历史：先 sanitize，再适配；live 原输出不被改写");
const RAW = Buffer.from("legacy-raw-mcp-image").toString("base64");
await test("带路径 raw MCP 图片剥字节并保留路径/结构字段，随后可包装 useTool", () => {
  const rawOutput = {
    content: [
      { type: "text", text: "<path>C:/ws/legacy-mcp.png</path>" },
      { type: "image", data: RAW, mimeType: "image/png" },
    ],
    structuredContent: { page: 7 },
    isError: false,
    _meta: { source: "legacy" },
    customField: { keep: true },
  };
  const part = {
    type: "tool-mcp_demo_render",
    toolCallId: "call-legacy-path",
    state: "output-available",
    input: { page: 7 },
    output: rawOutput,
  };
  const messages = [{ id: "m10", role: "assistant", parts: [part] }];
  const sanitized = processor.sanitizeLegacyMcpHistoryImages(messages);
  const sanitizedJson = JSON.stringify(sanitized);
  assert.equal(sanitizedJson.includes(RAW), false);
  assert.equal(sanitizedJson.includes('"type":"image"'), false);
  assert.equal(sanitizedJson.includes("C:/ws/legacy-mcp.png"), true);
  assert.equal(sanitized[0].parts[0].output.structuredContent.page, 7);
  assert.equal(sanitized[0].parts[0].output.isError, false);
  assert.deepEqual(sanitized[0].parts[0].output._meta, { source: "legacy" });
  assert.deepEqual(sanitized[0].parts[0].output.customField, { keep: true });
  const adapted = processor.adaptToolHistoryForRequest(sanitized, { directoryMode: true, tools: realTools });
  assert.equal(adapted[0].parts[0].type, "tool-useTool");
  assert.deepEqual(adapted[0].parts[0].input, { tool: "mcp_demo_render", args: { page: 7 } });
  assert.equal(rawOutput.content[1].data, RAW);
});

await test("无路径官方 file-data 历史只留诚实重调占位，不编造缓存路径", () => {
  const rawOutput = {
    content: [
      {
        type: "file",
        mediaType: "image/png",
        data: { type: "data", data: RAW },
      },
    ],
    structuredContent: { legacy: true },
  };
  const messages = [
    {
      id: "m11",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "mcp_demo_render",
          toolCallId: "call-legacy-no-path",
          state: "output-available",
          input: {},
          output: rawOutput,
        },
      ],
    },
  ];
  const sanitized = processor.sanitizeLegacyMcpHistoryImages(messages);
  const json = JSON.stringify(sanitized);
  assert.equal(json.includes(RAW), false);
  assert.equal(json.includes('"type":"file"'), false);
  assert.equal(json.includes("重新调用该 MCP 工具"), true);
  assert.equal(json.includes("image-cache"), false);
  assert.equal(sanitized[0].parts[0].output.structuredContent.legacy, true);
  assert.equal(rawOutput.content[0].data.data, RAW);
});

await test("useTool→MCP 历史也 sanitize；普通内置工具原始图片不受该函数影响", () => {
  const mcpOutput = { content: [{ type: "image", data: RAW, mimeType: "image/png" }] };
  const builtinOutput = {
    type: "content",
    value: [{ type: "file", mediaType: "image/png", url: `data:image/png;base64,${RAW}` }],
  };
  const messages = [
    {
      id: "m12",
      role: "assistant",
      parts: [
        {
          type: "tool-useTool",
          toolCallId: "call-forwarded-legacy",
          state: "output-available",
          input: { tool: "mcp_demo_render", args: {} },
          output: mcpOutput,
        },
        {
          type: "tool-readImage",
          toolCallId: "call-builtin-untouched",
          state: "output-available",
          input: {},
          output: builtinOutput,
        },
      ],
    },
  ];
  const sanitized = processor.sanitizeLegacyMcpHistoryImages(messages);
  assert.equal(JSON.stringify(sanitized[0].parts[0]).includes(RAW), false);
  assert.equal(sanitized[0].parts[1].output, builtinOutput);
  assert.equal(sanitized[0].parts[1].output.value[0].url.includes(RAW), true);
});

console.log(`\n结果：${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("PASS tool-history L1");
