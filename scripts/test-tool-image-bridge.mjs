// L1 单测：工具图片桥的「按字节预算保留 + 最新工具批优先」。
// 运行：node scripts/test-tool-image-bridge.mjs
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = "F:/MyProjects/SageRead";
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

const outDir = mkdtempSync(join(tmpdir(), "tool-image-bridge-"));
const entry = join(outDir, "entry.ts");
writeFileSync(
  entry,
  [
    `export { wrapOpenAICompatToolImagesFetch, selectKeptIndexes } from "${join(src, "ai/providers/tool-image-bridge.ts").replace(/\\/g, "/")}";`,
    `export { cacheToolImages, clearToolImageCache } from "${join(src, "ai/utils/tool-image-cache.ts").replace(/\\/g, "/")}";`,
    `export { truncateToolResultsForStorage } from "${join(src, "ai/utils/tool-result-slimming.ts").replace(/\\/g, "/")}";`,
  ].join("\n"),
);
const outfile = join(outDir, "bridge.mjs");
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "neutral",
  outfile,
  alias: { "@": src },
});
const bridge = await import(pathToFileURL(outfile).href);

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

/** 构造 dataUrl：长度精确可控（"data:image/jpeg;base64," 固定 23 字符） */
const dataUrl = (chars) => `data:image/jpeg;base64,${"A".repeat(Math.max(0, chars - 23))}`;

/** 单条 tool 消息内容：viewImages 风格的「信封 + file part」交替 */
function toolContent(files) {
  return JSON.stringify({
    type: "content",
    value: files.flatMap(([path, chars]) => [
      { type: "text", text: `<path>${path}</path><type>image</type><content>image/jpeg 1024x768 px</content>` },
      { type: "file", mediaType: "image/jpeg", url: dataUrl(chars) },
    ]),
  });
}

async function transform(body) {
  const captured = { body: null };
  const fakeFetch = async (_input, init) => {
    captured.body = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const wrapped = bridge.wrapOpenAICompatToolImagesFetch(fakeFetch);
  await wrapped("http://fake.local/chat/completions", { method: "POST", body: JSON.stringify(body) });
  return captured.body;
}

const userImageMessages = (body) =>
  body.messages.filter(
    (m) => m.role === "user" && Array.isArray(m.content) && m.content.some((c) => c.type === "image_url"),
  );
const imageUrls = (body) =>
  userImageMessages(body).flatMap((m) => m.content.filter((c) => c.type === "image_url").map((c) => c.image_url.url));
const toolTexts = (body) => body.messages.filter((m) => m.role === "tool").map((m) => String(m.content));

console.log("[1] 选图核心：最新优先 + 预算 + 至少 1 张");
{
  const all = bridge.selectKeptIndexes([10, 10, 10, 10], 100);
  check(
    "预算充足时 4 张全保留（旧版 keep-last-3 会砍第 1 张）",
    all.size === 4 && [0, 1, 2, 3].every((i) => all.has(i)),
    [...all],
  );

  const trim = bridge.selectKeptIndexes([100, 100, 100, 100], 250);
  check(
    "预算 250/4x100 只保留最新 2 张",
    trim.size === 2 && trim.has(3) && trim.has(2) && !trim.has(0) && !trim.has(1),
    [...trim],
  );

  const minOne = bridge.selectKeptIndexes([1000], 10);
  check("单张超预算仍至少保留 1 张", minOne.size === 1 && minOne.has(0), [...minOne]);

  const hugeNewest = bridge.selectKeptIndexes([100, 1000], 700);
  check("最新一张超预算时不被更老的小图挤掉", hugeNewest.size === 1 && hugeNewest.has(1), [...hugeNewest]);
}

console.log("[2] 请求体：4 图同批 + 2 张旧图（预算充足）");
{
  const body = {
    model: "deepseek-chat",
    messages: [
      { role: "user", content: "看图" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call-old-a", type: "function", function: { name: "readImage", arguments: "{}" } },
          { id: "call-old-b", type: "function", function: { name: "readImage", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call-old-a", content: toolContent([["C:/ws/old-a.png", 1200]]) },
      { role: "tool", tool_call_id: "call-old-b", content: toolContent([["C:/ws/old-b.png", 1200]]) },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call-4", type: "function", function: { name: "viewImages", arguments: "{}" } }],
      },
      {
        role: "tool",
        tool_call_id: "call-4",
        content: toolContent([
          ["C:/ws/img-1.png", 1200],
          ["C:/ws/img-2.png", 1200],
          ["C:/ws/img-3.png", 1200],
          ["C:/ws/img-4.png", 1200],
        ]),
      },
    ],
  };
  const out = await transform(body);
  const urls = imageUrls(out);
  check("6 张图全部改挂到 user 消息（旧版 keep-last-3 只会留 3 张）", urls.length === 6, urls.length);
  check("图片按旧→新顺序", urls[0] === dataUrl(1200) && urls[5] === dataUrl(1200) && urls.length === 6, "order");
  const texts = toolTexts(out);
  check(
    "tool 内容里不再残留 base64",
    texts.every((t) => !t.includes("data:image/")),
    "base64 leaked",
  );
  check(
    "无省略占位",
    texts.every((t) => !t.includes("图片已省略")),
    texts.map((t) => t.slice(-80)),
  );
  const toolIndexes = out.messages.map((m, i) => (m.role === "tool" ? i : -1)).filter((i) => i >= 0);
  check("同一轮两条 tool 消息仍相邻（user 图消息不夹在中间）", toolIndexes[1] - toolIndexes[0] === 1, toolIndexes);
  const oldGroupLast = out.messages[toolIndexes[1]];
  const oldGroupNext = out.messages[toolIndexes[1] + 1];
  check(
    "旧一轮的图消息紧跟在旧 tool 组之后",
    oldGroupLast?.role === "tool" && oldGroupNext?.role === "user" && Array.isArray(oldGroupNext.content),
    oldGroupNext?.role,
  );
  const lastTool = out.messages[toolIndexes[2]];
  const after = out.messages[toolIndexes[2] + 1];
  check(
    "最新一批图片紧跟在该组最后一条 tool 之后",
    lastTool?.role === "tool" && after?.role === "user" && Array.isArray(after.content),
    after?.role,
  );
  const noteText = String(after?.content?.[0]?.text ?? "");
  check(
    "附图提示按图逐条带路径",
    ["img-1.png", "img-2.png", "img-3.png", "img-4.png"].every((p) => noteText.includes(p)),
    noteText,
  );
}

console.log("[3] 请求体：预算 75k 时最新批优先、老图先省略、占位带路径");
// 预算下限 60k（见 tool-image-budget），测试用 25k/张的 dataUrl 放大到可触发的规模
const BIG = 25_000;
globalThis.__SAGEREAD_IMAGE_BUDGET_CHARS__ = 75_000;
{
  const body = {
    model: "deepseek-chat",
    messages: [
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call-old", type: "function", function: { name: "readImage", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call-old", content: toolContent([["C:/ws/old.png", BIG]]) },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call-4", type: "function", function: { name: "viewImages", arguments: "{}" } }],
      },
      {
        role: "tool",
        tool_call_id: "call-4",
        content: toolContent([
          ["C:/ws/img-1.png", BIG],
          ["C:/ws/img-2.png", BIG],
          ["C:/ws/img-3.png", BIG],
          ["C:/ws/img-4.png", BIG],
        ]),
      },
    ],
  };
  const out = await transform(body);
  const urls = imageUrls(out);
  check("预算 75k / 5x25k 保留最新 3 张", urls.length === 3, urls.length);
  const texts = toolTexts(out);
  const joined = texts.join("\n");
  check(
    "最新 3 张所在批次的第 1 张被省略（路径 img-1.png）",
    joined.includes("图片已省略：C:/ws/img-1.png"),
    joined.slice(-300),
  );
  check("更老的单图被省略（路径 old.png）", joined.includes("图片已省略：C:/ws/old.png"), joined.slice(-300));
  check("占位带 readImage 提示", joined.includes("readImage(path=C:/ws/img-1.png)"), joined.slice(-300));
  check("占位也提到 viewImages", joined.includes("viewImages"), joined.slice(-300));
  check(
    "被省略的图片没进 user 消息（只发 3 张）",
    urls.length === 3 && urls.every((u) => u.length === BIG),
    urls.map((u) => u.length),
  );
}
globalThis.__SAGEREAD_IMAGE_BUDGET_CHARS__ = undefined;

console.log("[4] 目录牌缓存：toolCallId → 缓存图片（内容已 sanitize）");
{
  bridge.clearToolImageCache();
  bridge.cacheToolImages("call-cache", [
    { dataUrl: dataUrl(1500), mediaType: "image/jpeg", path: "C:/ws/cache-1.png" },
    { dataUrl: dataUrl(1500), mediaType: "image/jpeg", path: "C:/ws/cache-2.png" },
  ]);
  const body = {
    model: "deepseek-chat",
    messages: [
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call-cache", type: "function", function: { name: "viewImages", arguments: "{}" } }],
      },
      {
        role: "tool",
        tool_call_id: "call-cache",
        content: JSON.stringify({
          type: "content",
          value: [{ type: "text", text: "图片 #1 内容已交给模型，base64 不写入聊天记录" }],
        }),
      },
    ],
  };
  const out = await transform(body);
  const urls = imageUrls(out);
  check("缓存图片被恢复到 user 消息", urls.length === 2 && urls[0] === dataUrl(1500), urls.length);
  const texts = toolTexts(out);
  check(
    "sanitize 内容保留（无 base64）",
    texts.every((t) => !t.includes("data:image/")),
    "base64 leaked",
  );
  check(
    "缓存图片不产生省略占位",
    texts.every((t) => !t.includes("图片已省略")),
    texts,
  );
  bridge.clearToolImageCache();
}

console.log("[5] 缓存图片按预算省略时，占位使用各自路径（而不是第一条）");
globalThis.__SAGEREAD_IMAGE_BUDGET_CHARS__ = 60_000;
{
  bridge.clearToolImageCache();
  bridge.cacheToolImages("call-cache2", [
    { dataUrl: dataUrl(BIG), mediaType: "image/jpeg", path: "C:/ws/first.png" },
    { dataUrl: dataUrl(BIG), mediaType: "image/jpeg", path: "C:/ws/second.png" },
    { dataUrl: dataUrl(BIG), mediaType: "image/jpeg", path: "C:/ws/third.png" },
  ]);
  const body = {
    model: "deepseek-chat",
    messages: [
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call-cache2", type: "function", function: { name: "viewImages", arguments: "{}" } }],
      },
      {
        role: "tool",
        tool_call_id: "call-cache2",
        content: JSON.stringify({ type: "content", value: [{ type: "text", text: "sanitized" }] }),
      },
    ],
  };
  const out = await transform(body);
  const joined = toolTexts(out).join("\n");
  check("预算 60k / 3x25k 保留最新 2 张", imageUrls(out).length === 2, imageUrls(out).length);
  check("被省略的是 first.png 且路径正确", joined.includes("图片已省略：C:/ws/first.png"), joined.slice(-240));
  check(
    "second/third 未被误标省略",
    !joined.includes("图片已省略：C:/ws/second.png") && !joined.includes("图片已省略：C:/ws/third.png"),
    joined.slice(-240),
  );
  bridge.clearToolImageCache();
}
globalThis.__SAGEREAD_IMAGE_BUDGET_CHARS__ = undefined;

console.log("[6] 非 JSON / 无图片请求原样透传");
{
  const captured = [];
  const wrapped = bridge.wrapOpenAICompatToolImagesFetch(async (_input, init) => {
    captured.push(init.body);
    return { ok: true };
  });
  await wrapped("http://fake.local", { method: "POST", body: '{"messages":[{"role":"user","content":"hi"}]}' });
  await wrapped("http://fake.local", { method: "POST", body: "not-json" });
  check("无 tool 消息不进入桥接", captured[0] === '{"messages":[{"role":"user","content":"hi"}]}', captured[0]);
  check("非 JSON body 原样透传", captured[1] === "not-json", captured[1]);
}

console.log("[7] 落库 sanitize：图片字节不写进线程（内存消息不动）");
{
  const big = dataUrl(5000);
  const envelope = (path) => ({
    type: "text",
    text: `<path>${path}</path><type>image</type><content>image/jpeg 1024x768 px</content>`,
  });
  const filePart = { type: "file", mediaType: "image/jpeg", url: big };
  const imageOutput = {
    type: "content",
    value: [envelope("C:/ws/a.png"), filePart, envelope("C:/ws/b.png"), filePart],
  };
  const imagePart = (type, extra = {}) => ({
    type,
    toolCallId: type,
    state: "output-available",
    output: imageOutput,
    ...extra,
  });
  const messages = [
    {
      role: "assistant",
      parts: [
        imagePart("tool-viewImages"),
        imagePart("tool-readImage"),
        imagePart("tool-useTool", { input: { tool: "viewImages", args: {} } }),
        { type: "tool-webSearch", toolCallId: "w1", state: "output-available", output: "short result" },
        { type: "tool-webSearch", toolCallId: "w2", state: "output-available", output: "x".repeat(3000) },
      ],
    },
  ];
  const stripped = bridge.truncateToolResultsForStorage(messages);
  const json = JSON.stringify(stripped);
  check("落库副本不含 base64", !json.includes("data:image/"), json.slice(0, 120));
  check("信封路径保留", json.includes("C:/ws/a.png") && json.includes("C:/ws/b.png"), "paths");
  check(
    "图片字节换成诚实文本占位（不谎称仍在线程里）",
    json.includes("历史图片未随本轮重发") && json.includes("readImage"),
    "placeholder",
  );
  check(
    "useTool 转发的 viewImages 同样被摘",
    !JSON.stringify(stripped[0].parts[2]).includes("data:image/"),
    "forwarded",
  );
  check("非图片短结果不动", stripped[0].parts[3].output === "short result", stripped[0].parts[3].output);
  check(
    "非图片长结果仍走 L1 预览截断",
    stripped[0].parts[4].output && stripped[0].parts[4].output.__slimPreview === true,
    stripped[0].parts[4].output,
  );
  const again = bridge.truncateToolResultsForStorage(stripped);
  check("幂等：二次落库不重复改写（原引用返回）", again === stripped, again === stripped);
  check("内存消息未被改写", messages[0].parts[0].output.value[1].url === big, "memory mutated");
}

console.log(`\n结果：${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("PASS tool-image-bridge L1");
