// MCP 图片链路 L1 单测（2026-10-22 图片收口）：形状识别 / execute 收口+缓存+占位 /
// 目录牌转发 / 落库剥离 + L1 截断 / native toModelOutput 回灌。
// 运行：node scripts/test-mcp-image-pipeline.mjs
import assert from "node:assert";
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

const toPosix = (p) => p.replace(/\\/g, "/");
const outDir = mkdtempSync(join(tmpdir(), "mcp-image-"));
const entry = join(outDir, "entry.ts");
writeFileSync(
  entry,
  [
    `export { sanitizeMcpToolResultImages, stripToolImageBytes, toolImageBytesFromNode, truncateToolResultsForStorage } from "${toPosix(join(src, "ai/utils/tool-result-slimming.ts"))}";`,
    `export { getCachedToolImages, clearToolImageCache } from "${toPosix(join(src, "ai/utils/tool-image-cache.ts"))}";`,
    `export { wrapToolsForNativeImages } from "${toPosix(join(src, "ai/providers/native-tool-output.ts"))}";`,
    `export { buildLazyToolset } from "${toPosix(join(src, "ai/tools/lazy-toolset.ts"))}";`,
  ].join("\n"),
);
const outfile = join(outDir, "pipeline.mjs");
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile,
  logLevel: "silent",
});
const pipeline = await import(pathToFileURL(outfile).href);

// 目录牌 useTool 会调 tool-catalog-audit 写审计日志（Tauri invoke）；node 环境没有 window，
// 给一个最小空实现，避免测试输出被“写审计日志失败”噪声污染（真实 App 中此路径正常）。
globalThis.window ??= { __TAURI_INTERNALS__: { invoke: async () => undefined } };

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

const b64 = (label) => Buffer.from(`sageread-image-${label}`).toString("base64");
const PNG = b64("png-a");
const JPG = b64("jpg-b");
const WEBP = b64("webp-c");
const OFFICIAL = b64("official-d");
const PLACEHOLDER = (seq) => `[图片 #${seq} 内容已交给模型，base64 不写入聊天记录]`;
const mcpImage = (data, mimeType) => ({ type: "image", data, mimeType });

console.log("[1] 图片形状识别：MCP image / 官方 file-data / 旧 file-url / 误判防护");
{
  const mcp = pipeline.toolImageBytesFromNode(mcpImage(PNG, "image/png"));
  check(
    "MCP {type:image,data,mimeType} → dataUrl + mediaType",
    mcp?.mediaType === "image/png" && mcp.dataUrl === `data:image/png;base64,${PNG}`,
    mcp,
  );
  const official = pipeline.toolImageBytesFromNode({
    type: "file",
    mediaType: "image/webp",
    data: { type: "data", data: WEBP },
  });
  check(
    "AI SDK v7 官方 file-data → dataUrl",
    official?.mediaType === "image/webp" && official.dataUrl === `data:image/webp;base64,${WEBP}`,
    official,
  );
  const legacy = pipeline.toolImageBytesFromNode({
    type: "file",
    mediaType: "image/jpeg",
    url: `data:image/jpeg;base64,${JPG}`,
  });
  check("旧 file-url → dataUrl", legacy?.mediaType === "image/jpeg" && legacy.dataUrl.includes(JPG), legacy);
  check(
    "文本/结构/非图片 file part 不误判",
    pipeline.toolImageBytesFromNode({ type: "text", text: "hi" }) === null &&
      pipeline.toolImageBytesFromNode({ content: [] }) === null &&
      pipeline.toolImageBytesFromNode({
        type: "file",
        mediaType: "application/pdf",
        data: { type: "data", data: PNG },
      }) === null,
  );
}

console.log("[2] MCP execute 收口：图片→占位+缓存，文本型零改动");
{
  pipeline.clearToolImageCache();
  const raw = {
    content: [
      { type: "text", text: "page 3 rendered" },
      mcpImage(PNG, "image/png"),
      { type: "text", text: "page 4 rendered" },
      mcpImage(JPG, "image/jpeg"),
    ],
    structuredContent: { title: "figure", page: 3 },
    isError: false,
  };
  const sanitized = pipeline.sanitizeMcpToolResultImages(raw, "call-mcp-1");
  check(
    "文本 part 原样保留",
    sanitized.content[0].text === "page 3 rendered" && sanitized.content[2].text === "page 4 rendered",
    sanitized.content,
  );
  check(
    "图片 part 换成带序号占位",
    sanitized.content[1].type === "text" &&
      sanitized.content[1].text === PLACEHOLDER(1) &&
      sanitized.content[3].text === PLACEHOLDER(2),
    sanitized.content,
  );
  check(
    "其余字段原样透传",
    sanitized.structuredContent.title === "figure" &&
      sanitized.structuredContent.page === 3 &&
      sanitized.isError === false,
  );
  check("原结果对象未被改写（不改原对象）", raw.content[1].data === PNG && raw.content[3].data === JPG);
  const sanitizedJson = JSON.stringify(sanitized);
  check("结果 JSON 不含 base64 负载", !sanitizedJson.includes(PNG) && !sanitizedJson.includes(JPG));
  const cached = pipeline.getCachedToolImages("call-mcp-1");
  check(
    "按 toolCallId 缓存两张图（MIME 正确）",
    cached?.length === 2 &&
      cached[0].dataUrl === `data:image/png;base64,${PNG}` &&
      cached[0].mediaType === "image/png" &&
      cached[1].mediaType === "image/jpeg",
    cached,
  );
  check("二次收口幂等（无图返回原引用）", pipeline.sanitizeMcpToolResultImages(sanitized, "call-mcp-1") === sanitized);

  const textOnly = { content: [{ type: "text", text: "done" }] };
  const same = pipeline.sanitizeMcpToolResultImages(textOnly, "call-text");
  check("文本型 MCP 结果引用相等（零改动）", same === textOnly);
  check("文本型结果不写缓存", pipeline.getCachedToolImages("call-text") === undefined);

  const noId = pipeline.sanitizeMcpToolResultImages({ content: [mcpImage(PNG, "image/png")] }, undefined);
  check("无 toolCallId 仍剥离图片（不把 base64 交给 UI/落库）", !JSON.stringify(noId).includes(PNG));
}

console.log("[3] 目录牌 useTool 转发：原始 MCP 形状 + 裸 dataUrl 字符串");
{
  pipeline.clearToolImageCache();
  const raw = {
    content: [mcpImage(PNG, "image/png"), { type: "text", text: "inner text" }, mcpImage(JPG, "image/jpeg")],
  };
  const lazy = pipeline.buildLazyToolset({
    mcp_demo_render: {
      description: "渲染 PDF 页（返回图片）",
      inputSchema: { type: "object", properties: {} },
      execute: async () => raw,
    },
    mcp_demo_webp: {
      description: "返回裸 dataUrl 字符串",
      inputSchema: { type: "object", properties: {} },
      execute: async () => `data:image/webp;base64,${WEBP}`,
    },
  });
  const forwarded = await lazy.useTool.execute({ tool: "mcp_demo_render", args: {} }, { toolCallId: "call-lazy" });
  const forwardedJson = JSON.stringify(forwarded);
  check(
    "转发结果不含 base64",
    !forwardedJson.includes(PNG) && !forwardedJson.includes(JPG),
    forwardedJson.slice(0, 120),
  );
  check("占位带 #1/#2 序号", forwardedJson.includes("图片 #1") && forwardedJson.includes("图片 #2"));
  check("同批文本保留", forwardedJson.includes("inner text"));
  const lazyCached = pipeline.getCachedToolImages("call-lazy");
  check(
    "转发图片进缓存（图片桥/native 按 toolCallId 回灌）",
    lazyCached?.length === 2 && lazyCached[0].mediaType === "image/png" && lazyCached[1].mediaType === "image/jpeg",
    lazyCached,
  );
  check("原结果对象未被改写", raw.content[0].data === PNG);

  const bare = await lazy.useTool.execute({ tool: "mcp_demo_webp", args: {} }, { toolCallId: "call-bare" });
  check("裸 dataUrl 字符串同样摘成占位", typeof bare === "string" && !bare.includes(WEBP) && bare.includes("图片 #1"));
  check(
    "裸 dataUrl 的 MIME 从 dataUrl 头读取（不再写死 jpeg）",
    pipeline.getCachedToolImages("call-bare")?.[0]?.mediaType === "image/webp",
    pipeline.getCachedToolImages("call-bare"),
  );
}

console.log("[4] 落库：MCP 图片剥离 + mcp_/dynamic-tool L1 截断");
{
  const bigText = "x".repeat(3000);
  const messages = [
    {
      role: "assistant",
      parts: [
        {
          type: "tool-mcp_demo_text",
          toolCallId: "s1",
          state: "output-available",
          output: { content: [{ type: "text", text: bigText }] },
        },
        {
          type: "tool-mcp_demo_render",
          toolCallId: "s2",
          state: "output-available",
          output: { content: [mcpImage(PNG, "image/png"), { type: "text", text: "page rendered" }] },
        },
        {
          type: "dynamic-tool",
          toolName: "mcp_demo_mixed",
          toolCallId: "s3",
          state: "output-available",
          output: { content: [mcpImage(JPG, "image/jpeg"), { type: "text", text: bigText }] },
        },
        {
          type: "tool-useTool",
          toolCallId: "s4",
          state: "output-available",
          input: { tool: "mcp_demo_text", args: {} },
          output: { content: [{ type: "text", text: bigText }] },
        },
        {
          type: "tool-useTool",
          toolCallId: "s5",
          state: "output-available",
          input: { tool: "getBooks", args: {} },
          output: { books: ["a"] },
        },
      ],
    },
  ];
  const stored = pipeline.truncateToolResultsForStorage(messages);
  const parts = stored[0].parts;
  const storedJson = JSON.stringify(stored);
  check("落库副本不含 MCP base64", !storedJson.includes(PNG) && !storedJson.includes(JPG));
  check("落库图片换历史占位（不复述成仍在线程里）", storedJson.includes("历史图片未随本轮重发"));
  check("mcp_ 大文本走 L1 截断", parts[0].output.__slimPreview === true, parts[0].output);
  check(
    "图片 + 大文本的 MCP 结果：先摘图再 L1 截断",
    parts[2].output.__slimPreview === true && !JSON.stringify(parts[2]).includes(JPG),
    parts[2].output,
  );
  check("useTool→mcp_ 大文本走 L1 截断", parts[3].output.__slimPreview === true);
  check("useTool→非内容型工具（getBooks）不动", parts[4].output === messages[0].parts[4].output);
  check("幂等：二次落库原引用返回", pipeline.truncateToolResultsForStorage(stored) === stored);
  check("内存消息未被改写（原数组图片仍在）", messages[0].parts[1].output.content[0].data === PNG);
}

console.log("[5] native toModelOutput：MCP 图片转官方 file part + 缓存回灌 + 文本行为不变");
{
  pipeline.clearToolImageCache();
  const native = pipeline.wrapToolsForNativeImages({
    mcp_demo_render: {
      description: "渲染",
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({}),
    },
    mcp_demo_text: {
      description: "文本",
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({}),
      toModelOutput: ({ output }) => ({ type: "text", value: `SDK:${output.content[0].text}` }),
    },
    getBooks: { description: "查书", inputSchema: { type: "object", properties: {} }, execute: async () => ({}) },
  });
  const direct = native.mcp_demo_render.toModelOutput({
    output: { content: [{ type: "text", text: "rendered" }, mcpImage(PNG, "image/png")] },
    toolCallId: "native-direct",
  });
  check(
    "MCP 原始图片 part → 官方 file-data part",
    direct.type === "content" &&
      direct.value[0].text.includes("rendered") &&
      direct.value[1].type === "file" &&
      direct.value[1].mediaType === "image/png" &&
      direct.value[1].data.type === "data" &&
      direct.value[1].data.data === PNG,
    direct,
  );
  const officialDirect = native.mcp_demo_render.toModelOutput({
    output: { content: [{ type: "file", mediaType: "image/webp", data: { type: "data", data: OFFICIAL } }] },
    toolCallId: "native-official",
  });
  check(
    "官方 file-data 直出同样转 native file part",
    officialDirect.type === "content" &&
      officialDirect.value[1].mediaType === "image/webp" &&
      officialDirect.value[1].data.data === OFFICIAL,
    officialDirect,
  );

  // 模拟 mcp-manager 收口后的占位输出：图片在缓存里，按 toolCallId 回灌
  const cachedRaw = { content: [{ type: "text", text: "page rendered" }, mcpImage(PNG, "image/png")] };
  const stripped = pipeline.sanitizeMcpToolResultImages(cachedRaw, "native-cached");
  const recovered = native.mcp_demo_render.toModelOutput({ output: stripped, toolCallId: "native-cached" });
  check(
    "缓存回灌：占位输出 + toolCallId → 图片重新进 native 请求",
    recovered.type === "content" && recovered.value[1]?.type === "file" && recovered.value[1].data.data === PNG,
    recovered,
  );

  const textOut = native.mcp_demo_text.toModelOutput({
    output: { content: [{ type: "text", text: "hello" }] },
    toolCallId: "native-text",
  });
  check("文本型 MCP 工具沿用 SDK toModelOutput（行为不变）", textOut.value === "SDK:hello", textOut);
  check("非图片类普通工具不包装", native.getBooks.toModelOutput === undefined);
}

console.log(`\n结果：${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("PASS mcp-image-pipeline L1");
