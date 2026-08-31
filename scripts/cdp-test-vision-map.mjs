// E2E 冒烟：J2 多模态能力枚举表（ai/providers/vision-map.ts）
// 断言各 provider+model 组合的图片放行/拦截（2026-08-24 调研枚举，见 docs/archive/vision-map-research.md）
// 运行：node scripts/cdp-test-vision-map.mjs（需 dev 实例 CDP 9223）
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
  const m = await import(origin + "/src/ai/providers/vision-map.ts?t=" + Date.now());
  const v = m.modelSupportsVision;

  // ---- 误拦修复：Kimi 现役全系多模态（原全线默认 false） ----
  check("moonshot kimi-k3 放行", v("moonshot", "kimi-k3") === true, "");
  check("moonshot kimi-k2.6 放行", v("moonshot", "kimi-k2.6") === true, "");
  check("moonshot kimi-k2.7-code 放行", v("moonshot", "kimi-k2.7-code") === true, "");
  check("moonshot kimi-k2.7-code-highspeed 放行", v("moonshot", "kimi-k2.7-code-highspeed") === true, "");
  check("moonshot kimi-k2.5 放行（至 2026-08-31）", v("moonshot", "kimi-k2.5") === true, "");
  check("moonshot v1-8k-vision-preview 放行", v("moonshot", "moonshot-v1-8k-vision-preview") === true, "");
  // ---- Kimi 仍拦：纯文本/已下线（勿 ^kimi-k2 一刀切） ----
  check("moonshot moonshot-v1-8k 拦截", v("moonshot", "moonshot-v1-8k") === false, "");
  check("moonshot kimi-k2 拦截（已下线纯文本）", v("moonshot", "kimi-k2") === false, "");
  check("moonshot kimi-k2-thinking 拦截", v("moonshot", "kimi-k2-thinking") === false, "");

  // ---- 误拦修复：Qwen 2026-02 起原生视觉主线 ----
  check("dashscope qwen3.5-plus 放行", v("dashscope", "qwen3.5-plus") === true, "");
  check("dashscope qwen3.6-flash 放行", v("dashscope", "qwen3.6-flash") === true, "");
  check("dashscope qwen3.7-plus 放行", v("dashscope", "qwen3.7-plus") === true, "");
  check("dashscope qwen3.8-max 放行", v("dashscope", "qwen3.8-max") === true, "");
  check("dashscope qwen3.8-27b 放行", v("dashscope", "qwen3.8-27b") === true, "");
  check("dashscope qwen3.5-ocr 放行", v("dashscope", "qwen3.5-ocr") === true, "");
  check("dashscope gui-plus 放行", v("dashscope", "gui-plus") === true, "");
  check("dashscope qwen3.7-max-2026-06-08 放行（快照起带视觉）", v("dashscope", "qwen3.7-max-2026-06-08") === true, "");
  check("dashscope qwen3.7-max-2026-12-01 放行（更晚快照）", v("dashscope", "qwen3.7-max-2026-12-01") === true, "");
  // ---- Qwen 仍拦：文本系 ----
  check("dashscope qwen3-vl-plus 放行（旧 VL 系）", v("dashscope", "qwen3-vl-plus") === true, "");
  check("dashscope qvq-max 放行", v("dashscope", "qvq-max") === true, "");
  check("dashscope qwen3.5-omni-plus 放行", v("dashscope", "qwen3.5-omni-plus") === true, "");
  check("dashscope qwen3-max 拦截（官方警示仅文本）", v("dashscope", "qwen3-max") === false, "");
  check("dashscope qwen3.7-max 拦截（无快照）", v("dashscope", "qwen3.7-max") === false, "");
  check("dashscope qwen3.7-max-2026-05-20 拦截（早期快照）", v("dashscope", "qwen3.7-max-2026-05-20") === false, "");
  check("dashscope qwen3.8-2.4t-xxx 拦截", v("dashscope", "qwen3.8-2.4t-xxx") === false, "");
  check("dashscope qwen3-coder-plus 拦截", v("dashscope", "qwen3-coder-plus") === false, "");
  check("dashscope qwen-plus 拦截", v("dashscope", "qwen-plus") === false, "");

  // ---- 智谱 GLM：5v/4.xv/4v 放行，文本系拦截 ----
  check("zhipu glm-5v-turbo 放行", v("zhipu", "glm-5v-turbo") === true, "");
  check("zhipu glm-4.6v 放行", v("zhipu", "glm-4.6v") === true, "");
  check("zhipu glm-4v-flash 放行", v("zhipu", "glm-4v-flash") === true, "");
  check("zhipu glm-5.3 拦截（官方明示仅文本）", v("zhipu", "glm-5.3") === false, "");
  check("zhipu glm-4-voice 拦截（语音系）", v("zhipu", "glm-4-voice") === false, "");
  check("zhipu cogview-4 拦截（生成系）", v("zhipu", "cogview-4") === false, "");

  // ---- 误放行修复：OpenAI 已知纯文本 ----
  check("openai o3-mini 拦截（官方 Image: Not supported）", v("openai", "o3-mini") === false, "");
  check("openai gpt-oss-120b 拦截", v("openai", "gpt-oss-120b") === false, "");
  check("openai gpt-3.5-turbo 拦截", v("openai", "gpt-3.5-turbo") === false, "");
  check("openai gpt-4-turbo 拦截（将停服保守拦）", v("openai", "gpt-4-turbo") === false, "");
  check("openai gpt-4-0613 拦截（旧快照）", v("openai", "gpt-4-0613") === false, "");
  // ---- OpenAI 主线放行 ----
  check("openai gpt-5.2 放行", v("openai", "gpt-5.2") === true, "");
  check("openai gpt-4o 放行", v("openai", "gpt-4o") === true, "");
  check("openai gpt-4.1 放行", v("openai", "gpt-4.1") === true, "");
  check("openai o3 放行", v("openai", "o3") === true, "");
  check("openai o3-pro 放行", v("openai", "o3-pro") === true, "");
  check("openai o4-mini 放行", v("openai", "o4-mini") === true, "");

  // ---- DeepSeek：仅 vision 型号放行 ----
  check("deepseek v4-flash-vision-exp 放行", v("deepseek", "deepseek-v4-flash-vision-exp") === true, "");
  check("deepseek v4-flash 拦截（传图 400）", v("deepseek", "deepseek-v4-flash") === false, "");
  check("deepseek v4-pro 拦截", v("deepseek", "deepseek-v4-pro") === false, "");
  check("deepseek deepseek-chat 拦截（已停用）", v("deepseek", "deepseek-chat") === false, "");

  // ---- Anthropic：现役全放行，历史无视觉型号拦截 ----
  check("anthropic claude-sonnet-5 放行", v("anthropic", "claude-sonnet-5") === true, "");
  check("anthropic claude-3-opus 放行（历史有视觉）", v("anthropic", "claude-3-opus-20240229") === true, "");
  check("anthropic claude-3-5-haiku 拦截（无视觉）", v("anthropic", "claude-3-5-haiku-20241022") === false, "");
  check("anthropic claude-2.1 拦截（远古）", v("anthropic", "claude-2.1") === false, "");

  // ---- Google / xAI：现役聊天型号全模态，默认放行 ----
  check("google gemini-3.5-flash 放行", v("google", "gemini-3.5-flash") === true, "");
  check("google gemini-2.5-pro 放行", v("google", "gemini-2.5-pro") === true, "");
  check("grok grok-4.3 放行", v("grok", "grok-4.3") === true, "");

  // ---- OpenRouter：剥作者前缀套家族枚举 ----
  check("openrouter deepseek/deepseek-v4-pro 拦截", v("openrouter", "deepseek/deepseek-v4-pro") === false, "");
  check("openrouter qwen/qwen3-max 拦截", v("openrouter", "qwen/qwen3-max") === false, "");
  check("openrouter openai/o3-mini 拦截", v("openrouter", "openai/o3-mini") === false, "");
  check("openrouter anthropic/claude-3-5-haiku 拦截", v("openrouter", "anthropic/claude-3-5-haiku") === false, "");
  check("openrouter moonshotai/kimi-k3 放行", v("openrouter", "moonshotai/kimi-k3") === true, "");
  check("openrouter z-ai/glm-4.6v 放行", v("openrouter", "z-ai/glm-4.6v") === true, "");
  check("openrouter openai/gpt-5.2 放行", v("openrouter", "openai/gpt-5.2") === true, "");
  check("openrouter 未知作者默认放行", v("openrouter", "someone/some-model") === true, "");

  // ---- 自定义/未知端点：默认放行（维持现状原则） ----
  check("custom 自定义端点默认放行", v("custom", "my-model") === true, "");
  check("未知型号命名启发式兜底（新视觉命名）", v("deepseek", "deepseek-v9-vision-x") === true, "");

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
  console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.info ? `  | ${c.info}` : ""}`);
  if (c.pass) pass++;
}
console.log(`\n${pass}/${checks.length} PASS`);
ws.close();
process.exit(pass === checks.length ? 0 : 1);
