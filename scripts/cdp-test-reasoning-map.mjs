// E2E 冒烟：P3 思考强度映射表（ai/providers/reasoning-map.ts）
// 断言各 provider+model+level 组合的 providerOptions / bodyPatch 输出（2026-08-05 调研参数面）
// 运行：node scripts/cdp-test-reasoning-map.mjs（需 dev 实例 CDP 9223）
const cdpPort = process.env.CDP_PORT ?? "9223";
const appPort = process.env.APP_PORT ?? "1420";
const pages = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
const page = pages.find((p) => p.type === "page" && p.url?.includes(`localhost:${appPort}`));
if (!page) throw new Error(`找不到 SageRead 页面（${cdpPort}/${appPort}）`);

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
  const gaps = [];
  const check = (name, pass, info) => checks.push({ name, pass: !!pass, info: info == null ? "" : String(info) });
  const gap = (name, holds, source) => gaps.push({ name, holds: !!holds, source });
  const origin = location.origin;
  const m = await import(origin + "/src/ai/providers/reasoning-map.ts?smoke=" + Date.now());
  const po = m.chatReasoningProviderOptions;
  const bp = m.chatReasoningBodyPatch;
  const applyPatch = (p) => { const body = {}; if (p) p(body); return body; };

  // ---- 通道 A：providerOptions ----
  check("openai gpt-5 high→high", po("openai", "gpt-5.2", "high")?.openai?.reasoningEffort === "high", "");
  check("gemini 2.5 off→budget 0", po("google", "gemini-2.5-flash", "off")?.google?.thinkingConfig?.thinkingBudget === 0, "");
  check("gemini 2.5 high→budget -1（动态）", po("google", "gemini-2.5-pro", "high")?.google?.thinkingConfig?.thinkingBudget === -1, "");
  check("gemini 3.1 pro off→low（不认 minimal）", po("google", "gemini-3.1-pro", "off")?.google?.thinkingConfig?.thinkingLevel === "low", "");
  check("gemini 3.7 flash off→low（不认 minimal）", po("google", "gemini-3.7-flash", "off")?.google?.thinkingConfig?.thinkingLevel === "low", "");
  check("gemini 3-pro off→low（不可关）", po("google", "gemini-3-pro", "off")?.google?.thinkingConfig?.thinkingLevel === "low", "");
  check("gemini 3.x high→high", po("google", "gemini-3.5-flash", "high")?.google?.thinkingConfig?.thinkingLevel === "high", "");
  check("openrouter medium→effort medium", po("openrouter", "openai/o3", "medium")?.openrouter?.reasoning?.effort === "medium", "");
  check("openrouter o3 off→low", po("openrouter", "openai/o3", "off")?.openrouter?.reasoning?.effort === "low", "");
  check("openrouter 未收录型号不下发", po("openrouter", "any-model", "medium") === undefined && po("openrouter", "any-model", "off") === undefined, "");
  check("grok-3-mini high→high", po("grok", "grok-3-mini", "high")?.openai?.reasoningEffort === "high", "");
  check("anthropic 通道不下发（无实证）", po("anthropic", "claude-sonnet-5", "high") === undefined, "");

  // ---- 通道 B：请求体补丁 ----
  check("deepseek off→thinking.disabled", applyPatch(bp("deepseek", undefined, "deepseek-chat", "off")).thinking?.type === "disabled", "");
  check("deepseek low→reasoning_effort low（2026-08-13 起三档）", applyPatch(bp("deepseek", undefined, "deepseek-v4-flash", "low")).reasoning_effort === "low", "");
  check("deepseek high→reasoning_effort high", applyPatch(bp("deepseek", undefined, "deepseek-flash", "high")).reasoning_effort === "high", "");
  check("GLM off→disabled", applyPatch(bp("custom", "https://open.bigmodel.cn/api", "glm-4.6", "off")).thinking?.type === "disabled", "");
  check("GLM medium→不下发", bp("custom", "https://open.bigmodel.cn/api", "glm-4.6", "medium") === null, "");
  check("Qwen off→enable_thinking false", applyPatch(bp("custom", "https://dashscope.aliyuncs.com", "qwen3-max", "off")).enable_thinking === false, "");
  check("Qwen high→旧枚举映射 32768 budget", applyPatch(bp("custom", "https://dashscope.aliyuncs.com", "qwen3-max", "high")).enable_thinking === true && applyPatch(bp("custom", "https://dashscope.aliyuncs.com", "qwen3-max", "high")).thinking_budget === 32768, "");
  check("Kimi K3 low→reasoning_effort low", applyPatch(bp("custom", "https://api.moonshot.cn/v1", "kimi-k3", "low")).reasoning_effort === "low", "");
  check("Kimi K3 off→low（无 off 档）", applyPatch(bp("custom", "https://api.moonshot.cn/v1", "kimi-k3", "off")).reasoning_effort === "low", "");
  check("Kimi K3 high→high（官方档位不提升为 max）", applyPatch(bp("custom", "https://api.moonshot.cn/v1", "kimi-k3", "high")).reasoning_effort === "high", "");
  check("Kimi K3.1 Pro 档位 low/high/max", JSON.stringify(m.getReasoningOptions("kimi-k3.1-pro")) === JSON.stringify(["low", "high", "max"]), "");
  check("Kimi K3.1 Pro high→reasoning_effort high", applyPatch(bp("custom", "https://api.moonshot.cn/v1", "kimi-k3.1-pro", "high")).reasoning_effort === "high", "");
  check("Kimi K3.1 Pro off→low（恒思考）", applyPatch(bp("custom", "https://api.moonshot.cn/v1", "kimi-k3.1-pro", "off")).reasoning_effort === "low", "");
  check("Kimi K3.1 Pro Messages off→output_config.effort=low", applyPatch(m.anthropicThinkingBodyPatch("kimi", "https://api.moonshot.cn/anthropic/v1", "kimi-k3.1-pro", "off")).output_config?.effort === "low" && !applyPatch(m.anthropicThinkingBodyPatch("kimi", "https://api.moonshot.cn/anthropic/v1", "kimi-k3.1-pro", "off")).thinking, "");
  check("Kimi K3.1 Pro Responses high→reasoning.effort=high", applyPatch(m.responsesReasoningBodyPatch("kimi", "https://api.moonshot.cn/v1", "kimi-k3.1-pro", "high")).reasoning?.effort === "high" && !applyPatch(m.responsesReasoningBodyPatch("kimi", "https://api.moonshot.cn/v1", "kimi-k3.1-pro", "high")).reasoning_effort, "");
  check("Kimi 思考专用型号→不下发", bp("custom", "https://api.moonshot.cn/v1", "kimi-k2-thinking", "off") === null, "");
  check("Kimi k2.7-code 思考常开→不下发（传 disabled 400）", bp("custom", "https://api.moonshot.cn/v1", "kimi-k2.7-code", "off") === null, "");
  check("Kimi k2.7-code-highspeed→不下发", bp("custom", "https://api.kimi.com/v1", "kimi-k2.7-code-highspeed", "high") === null, "");
  check("Kimi K2.x off→disabled", applyPatch(bp("custom", "https://api.moonshot.cn/v1", "kimi-k2.5", "off")).thinking?.type === "disabled", "");
  // ---- MiMo（api.xiaomimimo.com）：官方深度思考文档 thinking:{type} 开关，默认开启 ----
  check("MiMo V2.6 off→thinking.disabled", applyPatch(bp("xiaomi", "https://api.xiaomimimo.com/v1", "mimo-v2.6-pro", "off")).thinking?.type === "disabled", "");
  check("MiMo V2.6 on→thinking.enabled", applyPatch(bp("xiaomi", "https://api.xiaomimimo.com/v1", "mimo-v2.6-flash", "on")).thinking?.type === "enabled", "");
  check("MiMo V2.6 off→不再发 enable_thinking", applyPatch(bp("xiaomi", "https://api.xiaomimimo.com/v1", "mimo-v2.6-pro-ultraspeed", "off")).enable_thinking === undefined, "");
  check("MiMo V2.6 UI 档位 off/on", JSON.stringify(m.getReasoningOptions("mimo-v2.6-pro")) === JSON.stringify(["off", "on"]), "");
  check("MiMo v2.5 存量 budget 行数字档保留", applyPatch(bp("xiaomi", "https://api.xiaomimimo.com/v1", "mimo-v2.5", "8192")).thinking_budget === 8192, "");
  // ---- 2026-09-23 批次：GPT-6 Sol/Luna（effort 六档含 none/max）、Grok 4.7（五档） ----
  check("openai gpt-6-sol max→max", po("openai", "gpt-6-sol", "max")?.openai?.reasoningEffort === "max", "");
  check("openai gpt-6-luna none→none", po("openai", "gpt-6-luna", "none")?.openai?.reasoningEffort === "none", "");
  check("gpt-6-sol 档位六档含 none/max", JSON.stringify(m.getReasoningOptions("gpt-6-sol")) === JSON.stringify(["none", "low", "medium", "high", "xhigh", "max"]), "");
  check("grok-4.7 xhigh→xhigh", po("grok", "grok-4.7", "xhigh")?.openai?.reasoningEffort === "xhigh", "");
  check("grok-4.7 档位五档", JSON.stringify(m.getReasoningOptions("grok-4.7")) === JSON.stringify(["none", "low", "medium", "high", "xhigh"]), "");
  check("claude-opus-5-5 无思考行（anthropic 通道未分派，不加行防死档位）", m.getReasoningOptions("claude-opus-5-5").length === 0 && po("anthropic", "claude-opus-5-5", "high") === undefined, "");
  // ---- 2026-10-14 批次：GPT-6.1 Sol（恒思考五档，none/minimal 不支持——OpenAI 型号页+官方 reasoning 指南） ----
  check("openai gpt-6.1-sol max→max", po("openai", "gpt-6.1-sol", "max")?.openai?.reasoningEffort === "max", "");
  check("openai gpt-6.1-sol low→low", po("openai", "gpt-6.1-sol", "low")?.openai?.reasoningEffort === "low", "");
  check("gpt-6.1-sol 档位五档无 none", JSON.stringify(m.getReasoningOptions("gpt-6.1-sol")) === JSON.stringify(["low", "medium", "high", "xhigh", "max"]), "");
  check("gpt-6.1-sol-pro 前缀命中同行", JSON.stringify(m.getReasoningOptions("gpt-6.1-sol-pro")) === JSON.stringify(["low", "medium", "high", "xhigh", "max"]), "");
  check("mistral-large-4/muse-wonder 无思考行（未核实型号不加行防死档位）",
    m.getReasoningOptions("mistral-large-4").length === 0 && m.getReasoningOptions("muse-wonder").length === 0, "");
  check("Step 5 Preview 支持 low/medium/high 三档", JSON.stringify(m.getReasoningOptions("step-5-preview")) === JSON.stringify(["low", "medium", "high"]), "");
  check("Step 5 Messages off→output_config.effort=low", applyPatch(m.anthropicThinkingBodyPatch("stepfun", "https://api.stepfun.com/v1", "step-5-preview", "off")).output_config?.effort === "low", "");
  check("Step 5 Responses off→reasoning.effort=low", applyPatch(m.responsesReasoningBodyPatch("stepfun", "https://api.stepfun.com/v1", "step-5-preview", "off")).reasoning?.effort === "low", "");
  check("Step 3.7 Chat high→reasoning_effort=high", applyPatch(bp("stepfun", "https://api.stepfun.com/v1", "step-3.7-flash", "high")).reasoning_effort === "high", "");
  // ---- 2026-10-20 批次：Gemini 4 Argon（恒思考三档 low/medium/high；不接受 minimal，不给 thinkingBudget） ----
  check("google gemini-4-argon high→high", po("google", "gemini-4-argon", "high")?.google?.thinkingConfig?.thinkingLevel === "high", "");
  check("google gemini-4-argon medium→medium", po("google", "gemini-4-argon", "medium")?.google?.thinkingConfig?.thinkingLevel === "medium", "");
  check("google gemini-4-argon off→low（不可关）", po("google", "gemini-4-argon", "off")?.google?.thinkingConfig?.thinkingLevel === "low", "");
  check("gemini-4-argon 档位三档", JSON.stringify(m.getReasoningOptions("gemini-4-argon")) === JSON.stringify(["low", "medium", "high"]), "");
  // ---- 2026-10-20 批次：MiniMax M3.1 Flash（2026-10-19；恒思考，reasoning_effort low~max；补 minimax 分派） ----
  check("minimax m3.1-flash high→reasoning_effort high", applyPatch(bp("custom", "https://api.minimax.io/v1", "MiniMax-M3.1-Flash", "high")).reasoning_effort === "high", "");
  check("minimax m3.1-flash max→max", applyPatch(bp("custom", "https://api.minimaxi.com/v1", "minimax-m3.1-flash", "max")).reasoning_effort === "max", "");
  check("minimax m3.1-flash off→low 且不发 thinking.disabled（传 disabled 会 400）",
    applyPatch(bp("custom", "https://api.minimax.io/v1", "MiniMax-M3.1-Flash", "off")).reasoning_effort === "low"
      && applyPatch(bp("custom", "https://api.minimax.io/v1", "MiniMax-M3.1-Flash", "off")).thinking === undefined, "");
  check("minimax m3.1-flash OpenRouter 作者前缀可命中", applyPatch(bp("openrouter", "https://openrouter.ai/api/v1", "minimax/minimax-m3.1-flash", "medium")).reasoning_effort === "medium" || po("openrouter", "minimax/minimax-m3.1-flash", "medium")?.openrouter?.reasoning?.effort === "medium", "");
  check("minimax-m3.1-flash 档位五档", JSON.stringify(m.getReasoningOptions("minimax-m3.1-flash")) === JSON.stringify(["low", "medium", "high", "xhigh", "max"]), "");
  check("minimax m3 存量 switch 行 off→thinking.disabled（分派补齐后行为不变）", applyPatch(bp("custom", "https://api.minimax.io/v1", "minimax-m3", "off")).thinking?.type === "disabled", "");
  check("不认识端点→null", bp("custom", "https://example.com", "x", "off") === null, "");
  check("腾讯 Hy4 正式版 low/high 两档", JSON.stringify(m.getReasoningOptions("hy4")) === JSON.stringify(["low", "high"]), "https://cloud.tencent.com/document/product/1823/132252");
  check("腾讯 Hy4 high→reasoning_effort high", applyPatch(bp("tencent", "https://tokenhub.tencentmaas.com/v1", "hy4", "high")).reasoning_effort === "high", "https://cloud.tencent.com/document/product/1823/132252");
  check("腾讯 Hy4 off 恒思考钳到 low，不发 disabled", applyPatch(bp("tencent", "https://tokenhub.tencentmaas.com/v1", "hy4", "off")).reasoning_effort === "low" && applyPatch(bp("tencent", "https://tokenhub.tencentmaas.com/v1", "hy4", "off")).thinking === undefined, "https://cloud.tencent.com/document/product/1823/132252");

  // 旧映射回归必须全部通过，不再用跳过开关掩盖历史缺口。
  check("GPT-5.2 off 应使用 none 地板", po("openai", "gpt-5.2", "off")?.openai?.reasoningEffort === "none", "https://developers.openai.com/api/docs/models/gpt-5.2");
  check("o3 off 应使用 low 地板", po("openai", "o3", "off")?.openai?.reasoningEffort === "low", "mapped offParam=low；docs/model-maps-maintenance.md");
  check("GPT-4o 不应下发推理参数或显示思考档位", po("openai", "gpt-4o", "high") === undefined && m.getReasoningOptions("gpt-4o").length === 0, "https://developers.openai.com/api/docs/models/gpt-4o");
  check("Gemini 3.5 Flash off 应使用 minimal 地板", po("google", "gemini-3.5-flash", "off")?.google?.thinkingConfig?.thinkingLevel === "minimal", "https://openrouter.ai/docs/guides/best-practices/reasoning-tokens");
  check("Gemini 3 Pro 仅 low/high，旧 medium 应钳到 low", JSON.stringify(m.getReasoningOptions("gemini-3-pro")) === JSON.stringify(["low", "high"]) && po("google", "gemini-3-pro", "medium")?.google?.thinkingConfig?.thinkingLevel === "low", "https://ai-sdk.dev/providers/ai-sdk-providers/google");
  check("legacy grok-4 不应继承新版 effort 或显示思考档位", po("grok", "grok-4", "off") === undefined && po("grok", "grok-4", "high") === undefined && m.getReasoningOptions("grok-4").length === 0, "https://www.promptfoo.dev/docs/providers/xai/");
  check("DeepSeek medium 应进入 high 强度", applyPatch(bp("deepseek", undefined, "deepseek-flash", "medium")).reasoning_effort === "high", "https://api-docs.deepseek.com/guides/thinking_mode/");
  return { checks, gaps };
})()
`;

const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
const { checks, gaps } = result.result?.result?.value ?? {};
if (!Array.isArray(checks) || !Array.isArray(gaps)) {
  console.error("页面上下文执行失败:", JSON.stringify(result).slice(0, 800));
  process.exit(1);
}

let pass = 0;
for (const c of checks) {
  console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.info ? `  | ${c.info}` : ""}`);
  if (c.pass) pass++;
}
const openGaps = gaps.filter((g) => !g.holds);
for (const g of gaps) console.log(`${g.holds ? "RESOLVED" : "GAP"}  ${g.name}  | ${g.source}`);
console.log(`\n${pass}/${checks.length} PASS; ${openGaps.length} 个历史映射缺口`);
if (openGaps.length && process.env.ALLOW_PREEXISTING_MAP_GAPS !== "1") {
  console.log("历史缺口仍失败；只验收本批时设 ALLOW_PREEXISTING_MAP_GAPS=1（不会把缺口计为通过）。");
}
ws.close();
const failed = checks.some((c) => !c.pass);
process.exit(failed || (openGaps.length > 0 && process.env.ALLOW_PREEXISTING_MAP_GAPS !== "1") ? 1 : 0);
