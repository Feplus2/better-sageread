// 上下文预算单测：模型窗口解析 / 水位公式 / token 估算补齐 / 活塞触发
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = "F:/MyProjects/SageRead";
const src = join(root, "packages/app/src");
const pnpmDir = join(root, "node_modules", ".pnpm");
const esbuildPkg = readdirSync(pnpmDir).find((d) => d.startsWith("esbuild@"));
const esbuild = await import(pathToFileURL(join(pnpmDir, esbuildPkg, "node_modules", "esbuild", "lib", "main.js")).href);

const outDir = mkdtempSync(join(tmpdir(), "context-budget-"));
const entry = join(outDir, "entry.ts");
const posix = (p) => p.replace(/\\/g, "/");
writeFileSync(
  entry,
  [
    `export { resolveContextWindow, resolveContextBudget, DEFAULT_CONTEXT_WINDOW } from "${posix(join(src, "ai/providers/context-window.ts"))}";`,
    `export { estimateTokens, estimateTextTokensFull, estimateMessageTokens, estimateMessagesTokens, IMAGE_PART_TOKENS } from "${posix(join(src, "ai/utils/token-estimator.ts"))}";`,
    `export { selectMessagesWithinBudget } from "${posix(join(src, "ai/utils/message-selector.ts"))}";`,
  ].join("\n"),
);
const outfile = join(outDir, "budget.mjs");
await esbuild.build({ entryPoints: [entry], bundle: true, format: "esm", platform: "neutral", outfile, alias: { "@": src } });
const lib = await import(pathToFileURL(outfile).href);

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log("  PASS " + name); }
  else { failed++; console.log("  FAIL " + name + (detail === undefined ? "" : " — " + JSON.stringify(detail))); }
}

console.log("[1] 窗口解析与水位公式");
const explicit = lib.resolveContextBudget("whatever", 200_000);
check("显式窗口优先", explicit.contextWindow === 200_000 && explicit.source === "model", explicit);
check("触发线=窗口×80%", explicit.highWater === 160_000, explicit.highWater);
check("保留线≈输入预算×30%", explicit.lowWater === 60_000, explicit.lowWater);
const deepseek = lib.resolveContextBudget("deepseek-flash");
check("DeepSeek 家族窗口 1M（官方 /models 实测）", deepseek.contextWindow === 1_048_576 && deepseek.source === "family", deepseek);
check("DeepSeek 触发线 838860（80% 窗口，旧 256k 会过早压缩）", deepseek.highWater === 838_860, deepseek.highWater);
const deepseekOut = lib.resolveContextBudget("deepseek-flash", 1_048_576, 393_216);
check("输出预留生效（DSH 公式 min(0.8W, W-O-B)）", deepseekOut.highWater === 591_360 && deepseekOut.outputReserve === 393_216, deepseekOut);
const unknown = lib.resolveContextBudget("some-unknown-model");
check("未知模型保守默认 128k", unknown.contextWindow === lib.DEFAULT_CONTEXT_WINDOW && unknown.source === "default", unknown);
check("未知模型触发线 102400 / 保留 38400", unknown.highWater === 102_400 && unknown.lowWater === 38_400, unknown);
const tiny = lib.resolveContextBudget("x", 10_000);
check("极小窗口有历史下限", tiny.highWater === 24_000 && tiny.lowWater === 12_000, tiny);

console.log("[2] token 估算补齐");
const bigAscii = "a".repeat(40_000);
check("超长字符串按采样密度外推（不再被 10k 截断）", lib.estimateTextTokensFull(bigAscii) > 8_000, lib.estimateTextTokensFull(bigAscii));
const imageMsg = { id: "u1", role: "user", parts: [{ type: "file", mediaType: "image/png", url: "data:image/png;base64," + "A".repeat(400_000) }] };
check("图片 part 按固定经验值估算（不按 base64 长度爆算）", lib.estimateMessageTokens(imageMsg) >= lib.IMAGE_PART_TOKENS && lib.estimateMessageTokens(imageMsg) < 5_000, lib.estimateMessageTokens(imageMsg));
const dynMsg = { id: "a1", role: "assistant", parts: [{ type: "dynamic-tool", toolName: "mcp_x_y", input: { q: "x" }, output: { text: "z".repeat(20_000) } }] };
check("dynamic-tool（MCP）输出计入估算", lib.estimateMessageTokens(dynMsg) > 1_000, lib.estimateMessageTokens(dynMsg));

console.log("[3] 活塞按模型窗口触发（旧 256k 口径会漏压的 150k 线程）");
function textMsg(id, role, chars) {
  return { id, role, parts: [{ type: "text", text: "a".repeat(chars) }] };
}
const pairs = 6;
const msgs = [];
for (let i = 0; i < pairs; i++) {
  msgs.push(textMsg("u" + i, "user", 40_000));
  msgs.push(textMsg("a" + i, "assistant", 40_000));
}
const total = lib.estimateMessagesTokens ? null : null;
const budget = lib.resolveContextBudget("test-model", 128_000);
const sel = lib.selectMessagesWithinBudget(msgs, budget);
check("120k 线程在 128k 模型上会触发压缩", sel.dropped.length > 0, { dropped: sel.dropped.length, kept: sel.kept.length });
check("压缩后保留段落回触发线内（floor 自动缩小）", lib.estimateMessagesTokens(sel.kept) <= budget.highWater, { keptTokens: lib.estimateMessagesTokens(sel.kept), high: budget.highWater });
check("保留段仍以 user 开头", sel.kept.length > 0 && sel.kept[0].role === "user");
check("最后一条消息保留", sel.kept[sel.kept.length - 1].id === "a" + (pairs - 1));
const small = [textMsg("u0", "user", 1_000), textMsg("a0", "assistant", 1_000)];
check("小线程不压缩", lib.selectMessagesWithinBudget(small, budget).dropped.length === 0);

console.log("[4] transport 映射口径（P0 回归：ContextBudget 不能被当成 number 误用）");
function tokensMsg(id, role, estTokens) {
  // 1 token/4 ascii chars 的估算器口径；按目标 token 反推字符数
  return { id, role, parts: [{ type: "text", text: "a".repeat(estTokens * 4) }] };
}
const bigThread = [];
for (let i = 0; i < 5; i++) {
  bigThread.push(tokensMsg("bu" + i, "user", 20_000));
  bigThread.push(tokensMsg("ba" + i, "assistant", 20_000));
}
const million = lib.resolveContextBudget("deepseek-flash", 1_000_000, 0);
const mappedMillion = lib.selectMessagesWithinBudget(bigThread, { budget: million.highWater, lowWater: million.lowWater, floor: million.floor });
check("1M 窗口下 200k 线程不压缩（映射正确才会发生）", mappedMillion.dropped.length === 0, { dropped: mappedMillion.dropped.length, high: million.highWater });
const smallWindow = lib.resolveContextBudget("test", 128_000);
const wrongShape = lib.selectMessagesWithinBudget(bigThread, smallWindow);
check("把 ContextBudget 当 number 误用时确实会误压（迁移前 bug）", wrongShape.dropped.length > 0, { dropped: wrongShape.dropped.length });
const mappedSmall = lib.selectMessagesWithinBudget(bigThread, { budget: smallWindow.highWater, lowWater: smallWindow.lowWater, floor: smallWindow.floor });
check("128k 窗口下 200k 线程会压缩", mappedSmall.dropped.length > 0, { dropped: mappedSmall.dropped.length });

console.log("\n结果：" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
console.log("PASS context budget");