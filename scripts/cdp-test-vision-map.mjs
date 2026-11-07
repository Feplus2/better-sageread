// E2E 冒烟：J2 多模态能力枚举表（ai/providers/vision-map.ts）
// 断言各 provider+model 组合的图片放行/拦截（2026-08-24 调研枚举，见 docs/archive/vision-map-research.md）
// 运行：node scripts/cdp-test-vision-map.mjs（需 dev 实例 CDP 9223）
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
  const m = await import(origin + "/src/ai/providers/vision-map.ts?smoke=" + Date.now());
  const v = m.modelSupportsVision;

  // ---- 误拦修复：Kimi 现役全系多模态（原全线默认 false） ----
  check("moonshot kimi-k3 放行", v("moonshot", "kimi-k3") === true, "");
  check("moonshot kimi-k3.1-pro 放行", v("moonshot", "kimi-k3.1-pro") === true, "");
  check("openrouter moonshotai/kimi-k3.1-pro 放行", v("openrouter", "moonshotai/kimi-k3.1-pro") === true, "");
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
  check("dashscope qwen3.7-max-2026-12-01 放行（未收录的新快照按未知默认放行）", v("dashscope", "qwen3.7-max-2026-12-01") === true, "");
  // ---- Qwen 仍拦：文本系 ----
  check("dashscope qwen3-vl-plus 放行（旧 VL 系）", v("dashscope", "qwen3-vl-plus") === true, "");
  check("dashscope qvq-max 放行", v("dashscope", "qvq-max") === true, "");
  check("dashscope qwen3.5-omni-plus 放行", v("dashscope", "qwen3.5-omni-plus") === true, "");
  check("dashscope qwen3-max 拦截（官方警示仅文本）", v("dashscope", "qwen3-max") === false, "");
  check("dashscope qwen3.7-max-2026-05-20 拦截（早期快照）", v("dashscope", "qwen3.7-max-2026-05-20") === false, "");
  check("dashscope qwen3-coder-plus 拦截", v("dashscope", "qwen3-coder-plus") === false, "");
  check("dashscope qwen-plus 拦截", v("dashscope", "qwen-plus") === false, "");

  // ---- 智谱 GLM：仅 any-to-text 聊天模型；语音/图像生成不在本表范围 ----
  check("zhipu glm-5v-turbo 放行", v("zhipu", "glm-5v-turbo") === true, "");
  check("zhipu glm-4.6v 放行", v("zhipu", "glm-4.6v") === true, "");
  check("zhipu glm-4v-flash 放行", v("zhipu", "glm-4v-flash") === true, "");
  check("zhipu glm-5.3 拦截（官方明示仅文本）", v("zhipu", "glm-5.3") === false, "");

  // ---- 误放行修复：OpenAI 已知纯文本 ----
  check("openai o3-mini 拦截（官方 Image: Not supported）", v("openai", "o3-mini") === false, "");
  check("openai gpt-oss-120b 拦截", v("openai", "gpt-oss-120b") === false, "");
  check("openai gpt-3.5-turbo 拦截", v("openai", "gpt-3.5-turbo") === false, "");
  check("openai gpt-4-turbo 拦截（将停服保守拦）", v("openai", "gpt-4-turbo") === false, "");
  // ---- OpenAI 主线放行 ----
  check("openai gpt-5.2 放行", v("openai", "gpt-5.2") === true, "");
  check("openai gpt-4o 放行", v("openai", "gpt-4o") === true, "");
  check("openai gpt-4.1 放行", v("openai", "gpt-4.1") === true, "");
  check("openai o3 放行", v("openai", "o3") === true, "");
  check("openai o3-pro 放行", v("openai", "o3-pro") === true, "");
  check("openai o4-mini 放行", v("openai", "o4-mini") === true, "");

  // ---- DeepSeek：仅 vision 型号放行 ----
  check("deepseek v4-flash-vision-exp 放行", v("deepseek", "deepseek-v4-flash-vision-exp") === true, "");
  check("deepseek v4-flash 旧别名路由至多模态 V4.1 Flash", v("deepseek", "deepseek-v4-flash") === true, "");
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

  // ---- 小米 MiMo：V2.6 全系全模态（2026-09-22 官方模型页：输入 文本/图像/视频/音频） ----
  check("xiaomi mimo-v2.6-pro 放行", v("xiaomi", "mimo-v2.6-pro") === true, "");
  check("xiaomi mimo-v2.6-flash 放行", v("xiaomi", "mimo-v2.6-flash") === true, "");
  check("xiaomi mimo-v2.6-pro-ultraspeed 放行", v("xiaomi", "mimo-v2.6-pro-ultraspeed") === true, "");
  check("xiaomi mimo-v2.5 放行", v("xiaomi", "mimo-v2.5") === true, "");
  check("xiaomi mimo-7b 拦截（纯文本）", v("xiaomi", "mimo-7b") === false, "");

  // ---- 2026-09-23 批次：Opus 5.5 / GPT-6 Sol·Luna / Grok 4.7（官方型号页+OpenRouter 目录核实图像输入） ----
  check("anthropic claude-opus-5-5 放行", v("anthropic", "claude-opus-5-5") === true, "");
  check("openai gpt-6-sol 放行", v("openai", "gpt-6-sol") === true, "");
  check("openai gpt-6-luna 放行", v("openai", "gpt-6-luna") === true, "");
  check("grok grok-4.7 放行", v("grok", "grok-4.7") === true, "");

  // ---- 2026-10-14 批次：GPT-6.1 Sol / Sonnet 5.5 / Haiku 5.5 / Mistral Large 4 / Muse Wonder（OpenRouter 目录核实图像输入） ----
  check("openai gpt-6.1-sol 放行", v("openai", "gpt-6.1-sol") === true, "");
  check("openai gpt-6.1-sol-pro 前缀放行", v("openai", "gpt-6.1-sol-pro") === true, "");
  check("anthropic claude-sonnet-5-5 放行", v("anthropic", "claude-sonnet-5-5") === true, "");
  check("anthropic claude-haiku-5-5 放行", v("anthropic", "claude-haiku-5-5") === true, "");
  check("mistral mistral-large-4-0 前缀放行", v("mistral", "mistral-large-4-0") === true, "");
  check("custom muse-wonder 放行", v("custom", "muse-wonder") === true, "");

  // ---- 2026-10-20 批次：Gemini 4 Argon / MiniMax M3.1 Flash（官方文档 + SDK 核实多模态输入） ----
  check("google gemini-4-argon 放行", v("google", "gemini-4-argon") === true, "");
  check("openrouter google/gemini-4-argon 放行（作者前缀归一）", v("openrouter", "google/gemini-4-argon") === true, "");
  check("minimax MiniMax-M3.1-Flash 放行（大小写归一）", v("minimax", "MiniMax-M3.1-Flash") === true, "");
  check("openrouter minimax/minimax-m3.1-flash 放行", v("openrouter", "minimax/minimax-m3.1-flash") === true, "");

  check("腾讯 Hy4 正式版视觉放行", v("tencent", "hy4") === true, "https://cloud.tencent.com/document/product/1823/132252");
  check("腾讯 Hy4 preview 原有纯文本映射保留", v("tencent", "hy4-preview") === false, "https://cloud.tencent.com/document/product/1823/132252");

  // ---- 自定义/未知端点：默认放行（维持现状原则） ----
  check("custom 自定义端点默认放行", v("custom", "my-model") === true, "");
  check("未知型号命名启发式兜底（新视觉命名）", v("deepseek", "deepseek-v9-vision-x") === true, "");

  // 2026-10-25 独立核查的历史缺口；默认仍失败，只有显式允许才仅验收本批。
  gap("qwen3.7-max 无快照应与 2026-05-20 一样拦截", v("dashscope", "qwen3.7-max") === false, "https://help.aliyun.com/zh/model-studio/qwen3-7-max");
  gap("qwen3.8-2.4t-a95b 正式 ID 应有文本拦截行", v("dashscope", "qwen3.8-2.4t-a95b") === false, "https://help.aliyun.com/zh/model-studio/qwen3-8-2-4t-a95b");
  gap("gpt-4-0613 快照不应借用视觉放行", v("openai", "gpt-4-0613") === false, "https://developers.openai.com/api/docs/models/gpt-4");
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
