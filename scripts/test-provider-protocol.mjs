// 协议路由 + Anthropic 兼容端点 + native 历史图回灌预算 单测。
// 运行：node scripts/test-provider-protocol.mjs
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

const outDir = mkdtempSync(join(tmpdir(), "provider-protocol-"));
const entry = join(outDir, "entry.ts");
const posix = (p) => p.replace(/\\/g, "/");
writeFileSync(
  entry,
  [
    `export { resolveProviderProtocol, resolveAnthropicCompatibleBaseUrl, normalizeAnthropicBaseUrl, normalizeOpenAIBaseUrl, normalizeGeminiBaseUrl } from "${posix(join(src, "ai/providers/protocol.ts"))}";`,
    `export { wrapToolsForNativeImages } from "${posix(join(src, "ai/providers/native-tool-output.ts"))}";`,
    `export { cacheToolImages, clearToolImageCache } from "${posix(join(src, "ai/utils/tool-image-cache.ts"))}";`,
    `export { anthropicThinkingBodyPatch } from "${posix(join(src, "ai/providers/reasoning-map.ts"))}";`,
  ].join("\n"),
);
const outfile = join(outDir, "protocol.mjs");
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "neutral",
  outfile,
  alias: { "@": src },
  loader: { ".json": "json" },
});
const lib = await import(pathToFileURL(outfile).href);

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  PASS ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
  }
}

const { cacheToolImages, clearToolImageCache } = lib;
const rp = (input) => lib.resolveProviderProtocol(input);
console.log("[1] 显式 apiStyle 优先");
check("openai + openai-chat 显式", rp({ providerId: "openai", baseUrl: "https://api.openai.com/v1", apiStyle: "openai-chat" }) === "openai-chat");
check("openai + openai-responses 显式", rp({ providerId: "openai", baseUrl: "https://api.openai.com/v1", apiStyle: "openai-responses" }) === "openai-responses");
check("custom + openai-responses 显式", rp({ providerId: "custom-1", baseUrl: "https://relay.example.com/v1", apiStyle: "openai-responses" }) === "openai-responses");
check("custom + anthropic-messages 显式", rp({ providerId: "custom-1", baseUrl: "https://relay.example.com", apiStyle: "anthropic-messages" }) === "anthropic-messages");
check("custom + gemini 显式", rp({ providerId: "custom-1", baseUrl: "https://relay.example.com", apiStyle: "gemini" }) === "gemini");

console.log("[2] 官方 host / 代理 fallback");
check("openai 官方 → responses", rp({ providerId: "openai", baseUrl: "https://api.openai.com/v1" }) === "openai-responses");
check("openai 代理 → chat", rp({ providerId: "openai", baseUrl: "https://relay.example.com/v1" }) === "chat");
check("anthropic 官方 → messages", rp({ providerId: "anthropic", baseUrl: "https://api.anthropic.com/v1" }) === "anthropic-messages");
check("gemini 官方 → gemini", rp({ providerId: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta" }) === "gemini");
check("deepseek 官方 → messages", rp({ providerId: "deepseek", baseUrl: "https://api.deepseek.com/anthropic/v1" }) === "anthropic-messages");
check("deepseek 官方根地址 → messages", rp({ providerId: "deepseek", baseUrl: "https://api.deepseek.com" }) === "anthropic-messages");
check("deepseek 代理 → chat", rp({ providerId: "deepseek", baseUrl: "https://relay.example.com/v1" }) === "chat");
check("kimi 官方 → messages", rp({ providerId: "kimi", baseUrl: "https://api.moonshot.cn/anthropic/v1" }) === "anthropic-messages");
check("grok → chat", rp({ providerId: "grok", baseUrl: "https://api.x.ai/v1" }) === "openai-chat");
check("cherryin openai/* → responses", rp({ providerId: "custom-1", baseUrl: "https://open.cherryin.net/v1", modelId: "openai/gpt-5.6-luna" }) === "openai-responses");
check("cherryin anthropic/* → messages", rp({ providerId: "custom-1", baseUrl: "https://open.cherryin.net/v1", modelId: "anthropic/claude-sonnet-5.5" }) === "anthropic-messages");
check("cherryin 其它 → chat", rp({ providerId: "custom-1", baseUrl: "https://open.cherryin.net/v1", modelId: "acme/foo" }) === "chat");

console.log("[3] Anthropic 兼容 baseURL 必须带 /v1（AI SDK 追加 /messages）");
const rb = (id, baseUrl) => lib.resolveAnthropicCompatibleBaseUrl(id, baseUrl);
check("kimi 官方 → /anthropic/v1", rb("kimi", "https://api.moonshot.cn/anthropic/v1") === "https://api.moonshot.cn/anthropic/v1");
check("kimi 旧短地址 → /anthropic/v1", rb("kimi", "https://api.moonshot.cn/anthropic") === "https://api.moonshot.cn/anthropic/v1");
check("zhipu 官方 → /api/anthropic/v1", rb("zhipu", "https://open.bigmodel.cn/api/anthropic") === "https://open.bigmodel.cn/api/anthropic/v1");
check("minimax 官方 → /anthropic/v1", rb("minimax", "https://api.minimaxi.com/anthropic") === "https://api.minimaxi.com/anthropic/v1");
check("minimax .io → /anthropic/v1", rb("minimax", "https://api.minimax.io/anthropic") === "https://api.minimax.io/anthropic/v1");
check("deepseek 官方 → /anthropic/v1", rb("deepseek", "https://api.deepseek.com/anthropic") === "https://api.deepseek.com/anthropic/v1");
check("anthropic 官方 → /v1", rb("anthropic", "https://api.anthropic.com/v1") === "https://api.anthropic.com/v1");
check("自定义代理根 → 补 /v1", lib.normalizeAnthropicBaseUrl("https://relay.example.com") === "https://relay.example.com/v1");
check("自定义代理已带 /v1 不变", lib.normalizeAnthropicBaseUrl("https://relay.example.com/v1") === "https://relay.example.com/v1");

console.log("[4] Anthropic 原生通道 thinking 补丁（P0-2）");
const DS = "https://api.deepseek.com/anthropic/v1";
const KM = "https://api.moonshot.cn/anthropic/v1";
const applyThinking = (providerId, baseUrl, modelId, level) => {
  const patch = lib.anthropicThinkingBodyPatch(providerId, baseUrl, modelId, level);
  if (!patch) return null;
  const body = {};
  patch(body);
  return body;
};
const dsOff = applyThinking("deepseek", DS, "deepseek-flash", "off");
check("DeepSeek off → thinking disabled", JSON.stringify(dsOff?.thinking) === JSON.stringify({ type: "disabled" }));
const dsHigh = applyThinking("deepseek", DS, "deepseek-flash", "high");
check(
  "DeepSeek high → output_config.effort（不吃 budget_tokens）",
  JSON.stringify(dsHigh?.output_config) === JSON.stringify({ effort: "high" }) && !dsHigh?.thinking,
);
check("DeepSeek auto → 不下发", applyThinking("deepseek", DS, "deepseek-flash", "auto") === null);
const kimiK3Off = applyThinking("kimi", KM, "kimi-k3", "off");
check("Kimi K3 恒思考 off → 最低档 enabled（不 400）", kimiK3Off?.thinking?.type === "enabled" && kimiK3Off?.thinking?.budget_tokens === 1024);
const kimiOn = applyThinking("kimi", KM, "kimi-k2.6", "on");
check("Kimi K2.6 on → enabled", kimiOn?.thinking?.type === "enabled");
const kimiMax = applyThinking("kimi", KM, "kimi-k2.6", "max");
const rawMax = { max_tokens: 4096 };
lib.anthropicThinkingBodyPatch("kimi", KM, "kimi-k2.6", "max")(rawMax);
check("budget 注入会抬高 max_tokens（防严格端点 400）", rawMax.max_tokens === 8192 + 2048);
check("未知型号 off → disabled（可关优先）", applyThinking("anthropic", "https://api.anthropic.com/v1", "some-unknown-model", "off")?.thinking?.type === "disabled");

console.log("[5] native 历史图回灌预算（最近 6 张 / 2 批 + 当轮 live 6 张）");
const dataUrl = (tag, chars = 64) => `data:image/png;base64,${tag}${"A".repeat(chars)}`;
const contentPart = (tag) => ({ type: "content", value: [{ type: "text", text: tag }, { type: "file", mediaType: "image/png", url: dataUrl(tag) }] });
clearCache();
// 3 批历史：每批 6 张
for (const batch of ["b1", "b2", "b3"]) {
  cacheToolImages(`call-${batch}`, Array.from({ length: 6 }, (_, i) => ({ dataUrl: dataUrl(`${batch}-${i}`), mediaType: "image/png" })));
}
const tool = {
  readImage: {
    execute: async () => ({}),
    toModelOutput: ({ output }) => output,
  },
};
const tools = lib.wrapToolsForNativeImages(tool);
const textOnly = { type: "content", value: [{ type: "text", text: "sanitized" }] };
const out = (id) => tools.readImage.toModelOutput({ output: textOnly, toolCallId: id });
const countImages = (o) => (o.type === "content" ? o.value.filter((p) => p.type === "file").length : 0);
// 历史转换顺序：旧→新
const oldOut = out("call-b1");
const midOut = out("call-b2");
const newOut = out("call-b3");
check("最老一批不再重发图片", countImages(oldOut) === 0, countImages(oldOut));
check("中间一批不重发（预算给最新批）", countImages(midOut) === 0, countImages(midOut));
check("最新一批重发 6 张", countImages(newOut) === 6, countImages(newOut));

// 当轮 live：快照之后新增的缓存条目仍可回灌（目录牌 useTool）
cacheToolImages("call-live", Array.from({ length: 3 }, (_, i) => ({ dataUrl: dataUrl(`live-${i}`), mediaType: "image/png" })));
const liveOut = out("call-live");
check("当轮新工具结果可回灌", countImages(liveOut) === 3, countImages(liveOut));
// 直接输出（当轮 readImage 原生输出）不走缓存预算
const directOut = tools.readImage.toModelOutput({ output: contentPart("direct"), toolCallId: undefined });
check("直接输出图片照常转换", countImages(directOut) === 1, countImages(directOut));
const filePart = directOut.value.find((p) => p.type === "file");
check("file part 为官方 data 形态", filePart?.mediaType === "image/png" && filePart?.data?.type === "data", filePart);

console.log(`\n结果：${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("PASS provider-protocol");

function clearCache() {
  clearToolImageCache();
}