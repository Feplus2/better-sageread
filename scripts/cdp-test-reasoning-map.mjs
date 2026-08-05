// E2E 冒烟：P3 思考强度映射表（ai/providers/reasoning-map.ts）
// 断言各 provider+model+level 组合的 providerOptions / bodyPatch 输出（2026-08-05 调研参数面）
// 运行：node scripts/cdp-test-reasoning-map.mjs（需 dev 实例 CDP 9223）
const LIST_URL = "http://127.0.0.1:9223/json/list";

const pages = await (await fetch(LIST_URL)).json();
const page = pages.find((p) => p.type === "page" && p.url?.includes("localhost:1420"));
if (!page) throw new Error("找不到 SageRead 页面（9223 CDP 未连接或未以调试端口启动）");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let mid = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
function cdp(method, params = {}) {
  const id = ++mid;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve) => pending.set(id, resolve));
}

const expression = `
(async () => {
  const checks = [];
  const check = (name, pass, info) => checks.push({ name, pass: !!pass, info: info == null ? "" : String(info) });
  const origin = location.origin;
  const m = await import(origin + "/src/ai/providers/reasoning-map.ts");
  const po = m.chatReasoningProviderOptions;
  const bp = m.chatReasoningBodyPatch;
  const applyPatch = (p) => { const body = {}; if (p) p(body); return body; };

  // ---- 通道 A：providerOptions ----
  check("openai gpt-5 off→minimal", po("openai", "gpt-5.2", "off")?.openai?.reasoningEffort === "minimal", "");
  check("openai gpt-5 high→high", po("openai", "gpt-5.2", "high")?.openai?.reasoningEffort === "high", "");
  check("openai o3 off→low（无 off 档）", po("openai", "o3", "off")?.openai?.reasoningEffort === "low", "");
  check("openai gpt-4o 不下发", po("openai", "gpt-4o", "high") === undefined, "");
  check("gemini 2.5 off→budget 0", po("google", "gemini-2.5-flash", "off")?.google?.thinkingConfig?.thinkingBudget === 0, "");
  check("gemini 2.5 high→budget -1（动态）", po("google", "gemini-2.5-pro", "high")?.google?.thinkingConfig?.thinkingBudget === -1, "");
  check("gemini 3.5 flash off→minimal", po("google", "gemini-3.5-flash", "off")?.google?.thinkingConfig?.thinkingLevel === "minimal", "");
  check("gemini 3.1 pro off→low（不认 minimal）", po("google", "gemini-3.1-pro", "off")?.google?.thinkingConfig?.thinkingLevel === "low", "");
  check("gemini 3.x high→high", po("google", "gemini-3.5-flash", "high")?.google?.thinkingConfig?.thinkingLevel === "high", "");
  check("openrouter medium→effort medium", po("openrouter", "any-model", "medium")?.openrouter?.reasoning?.effort === "medium", "");
  check("openrouter off→low", po("openrouter", "any-model", "off")?.openrouter?.reasoning?.effort === "low", "");
  check("grok-3-mini high→high", po("grok", "grok-3-mini", "high")?.openai?.reasoningEffort === "high", "");
  check("grok-4 不下发（恒思考）", po("grok", "grok-4", "off") === undefined, "");
  check("anthropic 通道不下发（无实证）", po("anthropic", "claude-sonnet-5", "high") === undefined, "");

  // ---- 通道 B：请求体补丁 ----
  check("deepseek off→thinking.disabled", applyPatch(bp("deepseek", undefined, "deepseek-chat", "off")).thinking?.type === "disabled", "");
  check("deepseek low→disabled（无 low 档）", applyPatch(bp("deepseek", undefined, "deepseek-chat", "low")).thinking?.type === "disabled", "");
  check("deepseek medium→reasoning_effort high", applyPatch(bp("deepseek", undefined, "deepseek-chat", "medium")).reasoning_effort === "high", "");
  check("deepseek high→reasoning_effort max", applyPatch(bp("deepseek", undefined, "deepseek-chat", "high")).reasoning_effort === "max", "");
  check("GLM off→disabled", applyPatch(bp("custom", "https://open.bigmodel.cn/api", "glm-4.6", "off")).thinking?.type === "disabled", "");
  check("GLM medium→不下发", bp("custom", "https://open.bigmodel.cn/api", "glm-4.6", "medium") === null, "");
  check("Qwen off→enable_thinking false", applyPatch(bp("custom", "https://dashscope.aliyuncs.com", "qwen3-max", "off")).enable_thinking === false, "");
  check("Qwen high→不下发", bp("custom", "https://dashscope.aliyuncs.com", "qwen3-max", "high") === null, "");
  check("Kimi K3 low→reasoning_effort low", applyPatch(bp("custom", "https://api.moonshot.cn/v1", "kimi-k3", "low")).reasoning_effort === "low", "");
  check("Kimi K3 off→low（无 off 档）", applyPatch(bp("custom", "https://api.moonshot.cn/v1", "kimi-k3", "off")).reasoning_effort === "low", "");
  check("Kimi K3 high→max", applyPatch(bp("custom", "https://api.moonshot.cn/v1", "kimi-k3", "high")).reasoning_effort === "max", "");
  check("Kimi 思考专用型号→不下发", bp("custom", "https://api.moonshot.cn/v1", "kimi-k2-thinking", "off") === null, "");
  check("Kimi K2.x off→disabled", applyPatch(bp("custom", "https://api.moonshot.cn/v1", "kimi-k2.5", "off")).thinking?.type === "disabled", "");
  check("不认识端点→null", bp("custom", "https://example.com", "x", "off") === null, "");

  return checks;
})()
`;

const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
const checks = result.result?.result?.value;
if (!Array.isArray(checks)) {
  console.error("页面上下文执行失败:", JSON.stringify(result).slice(0, 800));
  process.exit(1);
}

let pass = 0;
for (const c of checks) {
  console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.info ? "  | " + c.info : ""}`);
  if (c.pass) pass++;
}
console.log(`\n${pass}/${checks.length} PASS`);
ws.close();
process.exit(pass === checks.length ? 0 : 1);
