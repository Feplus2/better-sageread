// MCP 图片链路 L1 单测（2026-10-23 口径）：MCP 图片落盘为带路径占位；当前轮可看图，
// 跨轮/历史不回灌（只留路径）；内置 readImage/viewImages 行为不变；文本型 MCP 零改动。
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
    `export { sanitizeMcpToolResultImages, stripToolImageBytes, collectToolImages, toolImageBytesFromNode, truncateToolResultsForStorage } from "${toPosix(join(src, "ai/utils/tool-result-slimming.ts"))}";`,
    `export { getCachedToolImages, cacheToolImages, clearToolImageCache } from "${toPosix(join(src, "ai/utils/tool-image-cache.ts"))}";`,
    `export { wrapToolsForNativeImages } from "${toPosix(join(src, "ai/providers/native-tool-output.ts"))}";`,
    `export { buildLazyToolset } from "${toPosix(join(src, "ai/tools/lazy-toolset.ts"))}";`,
    `export { wrapOpenAICompatToolImagesFetch } from "${toPosix(join(src, "ai/providers/tool-image-bridge.ts"))}";`,
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
const LIVE = b64("live-d");
const mcpImage = (data, mimeType) => ({ type: "image", data, mimeType });
const SAVE_ROOT = "/appdata/com.bettersageread.dev/image-cache/mcp";
const savedText = (path) => `[MCP 图片已落盘：${path}，需要重看时用 readImage(path=${path})]`;
const failedText = (seq) => `[MCP 图片 #${seq} 落盘失败已省略（字节不写入聊天记录）；需要重看时请重新调用该 MCP 工具]`;
const mcpPartOutput = (path) => JSON.stringify({ content: [{ type: "text", text: savedText(path) }] });
const toolMsg = (id, content) => ({ role: "tool", tool_call_id: id, content });
const assistantToolCalls = (id, name) => ({
  role: "assistant",
  content: "",
  tool_calls: [{ id, type: "function", function: { name, arguments: "{}" } }],
});

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
  const collected = pipeline.collectToolImages({ content: [{ type: "text", text: "t" }, mcpImage(PNG, "image/png")] });
  check("collectToolImages 收集顺序与 strip 的 #N 对齐", collected.length === 1 && collected[0].dataUrl.includes(PNG));
}

console.log("[2] MCP execute 收口：图片落盘为带路径占位；当轮缓存 origin=mcp；失败降级");
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
  const paths = [`${SAVE_ROOT}/img-1.png`, `${SAVE_ROOT}/img-2.jpg`];
  const saveCalls = [];
  const saveImage = async (image, seq) => {
    saveCalls.push({ image, seq });
    return paths[seq - 1];
  };
  const sanitized = await pipeline.sanitizeMcpToolResultImages(raw, "call-mcp-1", { saveImage });
  check(
    "saveImage 每图调用一次（顺序/媒体类型正确）",
    saveCalls.length === 2 && saveCalls[0].seq === 1 && saveCalls[1].image.mediaType === "image/jpeg",
  );
  check(
    "文本 part 原样保留",
    sanitized.content[0].text === "page 3 rendered" && sanitized.content[2].text === "page 4 rendered",
    sanitized.content,
  );
  check(
    "图片 part → 带落盘绝对路径的占位（含 readImage 指引）",
    sanitized.content[1].type === "text" &&
      sanitized.content[1].text === savedText(paths[0]) &&
      sanitized.content[3].text === savedText(paths[1]),
    sanitized.content,
  );
  check(
    "其余字段原样透传",
    sanitized.structuredContent.title === "figure" &&
      sanitized.structuredContent.page === 3 &&
      sanitized.isError === false,
  );
  check("原结果对象未被改写（不改原对象）", raw.content[1].data === PNG && raw.content[3].data === JPG);
  check(
    "结果 JSON 不含 base64 负载",
    !JSON.stringify(sanitized).includes(PNG) && !JSON.stringify(sanitized).includes(JPG),
  );
  const cached = pipeline.getCachedToolImages("call-mcp-1");
  check(
    "落盘成功的图按 toolCallId 缓存（origin=mcp，带路径）",
    cached?.length === 2 &&
      cached[0].origin === "mcp" &&
      cached[0].path === paths[0] &&
      cached[0].dataUrl === `data:image/png;base64,${PNG}` &&
      cached[1].mediaType === "image/jpeg",
    cached,
  );
  const again = await pipeline.sanitizeMcpToolResultImages(sanitized, "call-mcp-1", { saveImage });
  check("二次收口幂等（无图返回原引用，不再落盘）", again === sanitized && saveCalls.length === 2);

  // 落盘失败：纯占位降级，且不进入当轮缓存（避免"说省略却又看到图"）
  pipeline.clearToolImageCache();
  const partialPaths = [null, `${SAVE_ROOT}/img-2.jpg`];
  const partial = await pipeline.sanitizeMcpToolResultImages(
    { content: [mcpImage(PNG, "image/png"), mcpImage(JPG, "image/jpeg")] },
    "call-partial",
    { saveImage: async (_image, seq) => partialPaths[seq - 1] },
  );
  check(
    "落盘失败图 → 失败说明占位；成功图 → 路径占位",
    partial.content[0].text === failedText(1) && partial.content[1].text === savedText(partialPaths[1]),
    partial.content,
  );
  check("落盘失败的图不回灌模型（缓存只留成功图）", pipeline.getCachedToolImages("call-partial")?.length === 1);

  const textOnly = { content: [{ type: "text", text: "done" }] };
  let textSaveCalled = false;
  const same = await pipeline.sanitizeMcpToolResultImages(textOnly, "call-text", {
    saveImage: async () => {
      textSaveCalled = true;
      return null;
    },
  });
  check("文本型 MCP 结果引用相等（零改动、不触发落盘）", same === textOnly && !textSaveCalled);
  check("文本型结果不写缓存", pipeline.getCachedToolImages("call-text") === undefined);

  // 无 toolCallId：仍落盘并写路径占位，但无法当轮回灌
  pipeline.clearToolImageCache();
  const noId = await pipeline.sanitizeMcpToolResultImages({ content: [mcpImage(PNG, "image/png")] }, undefined, {
    saveImage: async () => `${SAVE_ROOT}/no-id.png`,
  });
  check(
    "无 toolCallId 仍落盘 + 路径占位（不把 base64 交给 UI/落库）",
    !JSON.stringify(noId).includes(PNG) && JSON.stringify(noId).includes("no-id.png"),
  );
}

console.log("[3] 目录牌 useTool 转发：MCP 图不落库但缓存标 origin=mcp；内置图标 builtin");
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
    readImage: {
      description: "内置看图",
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({ type: "text", text: "<path>C:/ws/a.png</path>" }),
    },
    readImageWithImage: {
      description: "内置看图（带图）",
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({
        type: "content",
        value: [{ type: "file", mediaType: "image/png", url: `data:image/png;base64,${WEBP}` }],
      }),
    },
  });
  const forwarded = await lazy.useTool.execute({ tool: "mcp_demo_render", args: {} }, { toolCallId: "call-lazy-mcp" });
  const forwardedJson = JSON.stringify(forwarded);
  check("MCP 转发结果不含 base64", !forwardedJson.includes(PNG) && !forwardedJson.includes(JPG));
  check("占位带 #1/#2 序号", forwardedJson.includes("图片 #1") && forwardedJson.includes("图片 #2"));
  check("同批文本保留", forwardedJson.includes("inner text"));
  const lazyCached = pipeline.getCachedToolImages("call-lazy-mcp");
  check(
    "MCP 转发缓存标 origin=mcp（兜底防跨轮回灌）",
    lazyCached?.length === 2 && lazyCached.every((image) => image.origin === "mcp"),
    lazyCached,
  );
  check("原结果对象未被改写", raw.content[0].data === PNG);

  await lazy.useTool.execute({ tool: "readImageWithImage", args: {} }, { toolCallId: "call-lazy-builtin" });
  const builtinCached = pipeline.getCachedToolImages("call-lazy-builtin");
  check(
    "内置图缓存标 origin=builtin（跨轮预算回灌不变）",
    builtinCached?.length === 1 && builtinCached[0].origin === "builtin",
    builtinCached,
  );
}

console.log("[4] 落库：历史只留带路径占位；MCP 大文本 L1 截断保留路径；内置图剥离不变");
{
  const bigText = "x".repeat(3000);
  const pathA = `${SAVE_ROOT}/hist-a.png`;
  const sanitizedRender = await pipeline.sanitizeMcpToolResultImages(
    { content: [{ type: "text", text: "page rendered" }, mcpImage(PNG, "image/png")] },
    "storage-1",
    { saveImage: async () => pathA },
  );
  // 图片 + 大文本：落盘占位在长文本之后，L1 截断后路径必须仍在预览里
  const sanitizedMixed = await pipeline.sanitizeMcpToolResultImages(
    { content: [{ type: "text", text: bigText }, mcpImage(JPG, "image/jpeg")] },
    "storage-2",
    { saveImage: async () => `${SAVE_ROOT}/mixed.jpg` },
  );
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
        { type: "tool-mcp_demo_render", toolCallId: "s2", state: "output-available", output: sanitizedRender },
        {
          type: "dynamic-tool",
          toolName: "mcp_demo_mixed",
          toolCallId: "s3",
          state: "output-available",
          output: sanitizedMixed,
        },
        {
          type: "tool-useTool",
          toolCallId: "s4",
          state: "output-available",
          input: { tool: "mcp_demo_text", args: {} },
          output: { content: [{ type: "text", text: bigText }] },
        },
        {
          type: "tool-readImage",
          toolCallId: "s5",
          state: "output-available",
          output: {
            type: "content",
            value: [{ type: "file", mediaType: "image/png", url: `data:image/png;base64,${PNG}` }],
          },
        },
        {
          type: "tool-useTool",
          toolCallId: "s6",
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
  check(
    "历史消息保留落盘路径占位（可 readImage 重看）",
    storedJson.includes(pathA) && storedJson.includes("hist-a.png"),
  );
  check("mcp_ 大文本走 L1 截断", parts[0].output.__slimPreview === true, parts[0].output);
  check(
    "图片 + 大文本：L1 截断后仍保留图片落盘路径",
    parts[2].output.__slimPreview === true && String(parts[2].output.preview).includes("mixed.jpg"),
  );
  check("useTool→mcp_ 大文本走 L1 截断", parts[3].output.__slimPreview === true);
  const builtinStored = JSON.stringify(parts[4].output);
  check(
    "内置 readImage 落库仍按原逻辑剥图为历史占位",
    !builtinStored.includes(PNG) && builtinStored.includes("历史图片未随本轮重发"),
    parts[4].output,
  );
  check("useTool→非内容型工具（getBooks）不动", parts[5].output === messages[0].parts[5].output);
  check("幂等：二次落库原引用返回", pipeline.truncateToolResultsForStorage(stored) === stored);
  check(
    "内存消息未被改写（原数组里的内置图 dataUrl 仍在）",
    messages[0].parts[4].output.value[0].url.includes(PNG) &&
      messages[0].parts[1].output.content[1].text === savedText(pathA),
  );
}

console.log("[5] native toModelOutput：历史 MCP 不回灌；当轮 live 可看；内置历史回灌不变");
{
  pipeline.clearToolImageCache();
  const nativeTools = {
    readImage: {
      description: "内置看图",
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({}),
    },
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
  };
  // 历史 = 请求开始时缓存里已有的条目（上一轮工具结果）。先在缓存里放好，再创建 native 包装
  // —— 真实链路 wrapToolsForNativeImages 在 sendMessages 组装工具面时创建、此刻冻结历史快照。
  pipeline.cacheToolImages("builtin-hist", [
    { dataUrl: `data:image/png;base64,${PNG}`, mediaType: "image/png", origin: "builtin" },
  ]);
  pipeline.cacheToolImages("mcp-hist", [
    { dataUrl: `data:image/jpeg;base64,${JPG}`, mediaType: "image/jpeg", origin: "mcp", path: `${SAVE_ROOT}/hist.jpg` },
  ]);
  const native = pipeline.wrapToolsForNativeImages(nativeTools);

  const histMcp = native.mcp_demo_render.toModelOutput({
    output: { content: [{ type: "text", text: savedText(`${SAVE_ROOT}/hist.jpg`) }] },
    toolCallId: "mcp-hist",
  });
  check(
    "历史 MCP 图不回灌（历史消息只有路径占位）",
    histMcp.type === "text" && !JSON.stringify(histMcp).includes(JPG),
    histMcp,
  );

  const histBuiltin = native.readImage.toModelOutput({
    output: { type: "text", text: "[历史图片未随本轮重发]" },
    toolCallId: "builtin-hist",
  });
  check(
    "内置 readImage 历史回灌不变（预算内仍给原图）",
    histBuiltin.type === "content" && histBuiltin.value.some((part) => part.type === "file" && part.data.data === PNG),
    histBuiltin,
  );

  // 快照之后出现的 MCP 图 = 当轮 live，允许回灌
  pipeline.cacheToolImages("mcp-live", [
    {
      dataUrl: `data:image/webp;base64,${LIVE}`,
      mediaType: "image/webp",
      origin: "mcp",
      path: `${SAVE_ROOT}/live.webp`,
    },
  ]);
  const liveMcp = native.mcp_demo_render.toModelOutput({
    output: { content: [{ type: "text", text: savedText(`${SAVE_ROOT}/live.webp`) }] },
    toolCallId: "mcp-live",
  });
  check(
    "当轮 live MCP 图仍回灌（模型看得到图）",
    liveMcp.type === "content" && liveMcp.value.some((part) => part.type === "file" && part.data.data === LIVE),
    liveMcp,
  );

  // 目录牌模式：模型实际调 useTool，mcp-manager 把缓存记在 useTool 的 toolCallId 上；
  // 原生协议下 useTool.toModelOutput 也必须把当轮 live MCP 图回灌（历史同样按 origin 跳过）
  const nativeDir = pipeline.wrapToolsForNativeImages({
    useTool: { description: "目录牌转发", inputSchema: { type: "object", properties: {} }, execute: async () => ({}) },
  });
  nativeDir.useTool.toModelOutput({ output: { type: "text", value: "snapshot" }, toolCallId: "dir-warmup" });
  pipeline.cacheToolImages("usetool-live", [
    {
      dataUrl: `data:image/webp;base64,${LIVE}`,
      mediaType: "image/webp",
      origin: "mcp",
      path: `${SAVE_ROOT}/live.webp`,
    },
  ]);
  const dirLive = nativeDir.useTool.toModelOutput({
    output: { type: "content", value: [{ type: "text", text: savedText(`${SAVE_ROOT}/live.webp`) }] },
    toolCallId: "usetool-live",
  });
  check(
    "目录牌 useTool 当轮 live MCP 图仍回灌（原生协议目录牌模式）",
    dirLive.type === "content" && dirLive.value.some((part) => part.type === "file" && part.data.data === LIVE),
    dirLive,
  );

  // 直接调用（原始 MCP image content，未落盘）时 walk 仍能识别 → 当轮可见
  const direct = native.mcp_demo_render.toModelOutput({
    output: { content: [{ type: "text", text: "rendered" }, mcpImage(PNG, "image/png")] },
    toolCallId: "native-direct",
  });
  check(
    "原始 MCP image content 直出仍转 native file part",
    direct.type === "content" && direct.value.some((part) => part.type === "file" && part.data.data === PNG),
    direct,
  );

  // 回归：会话里第一次看图（请求开始时缓存为空）——当时新产生的工具图必须算 live，
  // 不能被"历史快照"吞掉（快照在 wrapToolsForNativeImages 创建时冻结，不能用缓存命中时刻）。
  pipeline.clearToolImageCache();
  const coldNative = pipeline.wrapToolsForNativeImages({
    mcp_demo_render: {
      description: "渲染",
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({}),
    },
  });
  pipeline.cacheToolImages("cold-live", [
    { dataUrl: `data:image/png;base64,${PNG}`, mediaType: "image/png", origin: "mcp", path: `${SAVE_ROOT}/cold.png` },
  ]);
  const coldOut = coldNative.mcp_demo_render.toModelOutput({
    output: { content: [{ type: "text", text: savedText(`${SAVE_ROOT}/cold.png`) }] },
    toolCallId: "cold-live",
  });
  check(
    "会话首次工具图（请求开始缓存为空）仍算当轮 live 并回灌",
    coldOut.type === "content" && coldOut.value.some((part) => part.type === "file" && part.data.data === PNG),
    coldOut,
  );

  const textOut = native.mcp_demo_text.toModelOutput({
    output: { content: [{ type: "text", text: "hello" }] },
    toolCallId: "native-text",
  });
  check("文本型 MCP 工具沿用 SDK toModelOutput（行为不变）", textOut.value === "SDK:hello", textOut);
  check("非图片类普通工具不包装", native.getBooks.toModelOutput === undefined);
}

console.log("[6] chat 图片桥：MCP 图只在当前轮回灌；历史消息跳过；内置历史不变");
{
  pipeline.clearToolImageCache();
  pipeline.cacheToolImages("call-builtin-hist", [
    { dataUrl: `data:image/png;base64,${PNG}`, mediaType: "image/png", origin: "builtin" },
  ]);
  pipeline.cacheToolImages("call-mcp-hist", [
    { dataUrl: `data:image/jpeg;base64,${JPG}`, mediaType: "image/jpeg", origin: "mcp", path: `${SAVE_ROOT}/hist.jpg` },
  ]);
  pipeline.cacheToolImages("call-mcp-live", [
    {
      dataUrl: `data:image/webp;base64,${WEBP}`,
      mediaType: "image/webp",
      origin: "mcp",
      path: `${SAVE_ROOT}/live.webp`,
    },
  ]);

  async function transform(body) {
    const captured = { body: null };
    const fakeFetch = async (_input, init) => {
      captured.body = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const wrapped = pipeline.wrapOpenAICompatToolImagesFetch(fakeFetch);
    await wrapped("http://fake.local/chat/completions", { method: "POST", body: JSON.stringify(body) });
    return captured.body;
  }
  const imageUrls = (body) =>
    body.messages
      .filter((m) => m.role === "user" && Array.isArray(m.content))
      .flatMap((m) => m.content.filter((c) => c.type === "image_url").map((c) => c.image_url.url));

  // 上几轮（builtin + mcp 历史） → 当前轮（user → mcp live tool）
  const body = {
    model: "deepseek-chat",
    messages: [
      { role: "user", content: "第一轮" },
      assistantToolCalls("call-builtin-hist", "readImage"),
      toolMsg("call-builtin-hist", JSON.stringify({ type: "content", value: [{ type: "text", text: "历史图" }] })),
      assistantToolCalls("call-mcp-hist", "mcp_demo_render"),
      toolMsg("call-mcp-hist", mcpPartOutput(`${SAVE_ROOT}/hist.jpg`)),
      { role: "assistant", content: "上轮回答" },
      { role: "user", content: "这一轮看图" },
      assistantToolCalls("call-mcp-live", "mcp_demo_render"),
      toolMsg("call-mcp-live", mcpPartOutput(`${SAVE_ROOT}/live.webp`)),
    ],
  };
  const out = await transform(body);
  const urls = imageUrls(out);
  check(
    "内置历史图仍回灌（行为不变）",
    urls.some((url) => url.includes(PNG)),
    urls,
  );
  check(
    "当前轮 MCP live 图回灌给模型",
    urls.some((url) => url.includes(WEBP)),
    urls,
  );
  check(
    "历史 MCP 图不回灌",
    urls.every((url) => !url.includes(JPG)),
    urls,
  );
  check("历史 MCP 占位保留落盘路径", JSON.stringify(out).includes("hist.jpg"));
  check("tool 消息里无 MCP base64", !JSON.stringify(out.messages.filter((m) => m.role === "tool")).includes(JPG));

  // 同一轮多步：最后一条 user 之后的多个工具批都算 live
  const multiStep = {
    model: "deepseek-chat",
    messages: [
      { role: "user", content: "同轮多步" },
      assistantToolCalls("call-mcp-live", "mcp_demo_render"),
      toolMsg("call-mcp-live", mcpPartOutput(`${SAVE_ROOT}/live.webp`)),
      assistantToolCalls("call-builtin-hist", "readImage"),
      toolMsg("call-builtin-hist", JSON.stringify({ type: "content", value: [{ type: "text", text: "历史图" }] })),
    ],
  };
  const multiUrls = imageUrls(await transform(multiStep));
  check(
    "同轮多步：live MCP 图与内置图都在",
    multiUrls.some((u) => u.includes(WEBP)) && multiUrls.some((u) => u.includes(PNG)),
    multiUrls,
  );

  // 新的一轮（只有历史工具消息，最后一条 user 之后没有工具结果）→ 都不回灌 MCP
  const newTurn = {
    model: "deepseek-chat",
    messages: [
      { role: "user", content: "上一轮" },
      assistantToolCalls("call-mcp-hist", "mcp_demo_render"),
      toolMsg("call-mcp-hist", mcpPartOutput(`${SAVE_ROOT}/hist.jpg`)),
      { role: "assistant", content: "上轮回答" },
      { role: "user", content: "新问题" },
    ],
  };
  const newTurnUrls = imageUrls(await transform(newTurn));
  check(
    "新轮请求不重灌历史 MCP 图",
    newTurnUrls.every((url) => !url.includes(JPG)),
    newTurnUrls,
  );
}

console.log(`\n结果：${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("PASS mcp-image-pipeline L1");
