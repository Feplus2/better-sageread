/**
 * J2：模型多模态（图片）能力表 —— 枚举制（2026-08-24 调研 docs/vision-map-research.md，
 * 2026-08-27 由"家族命名启发式"重构为显式枚举——glm-5.3-flash 事件实证家族规律已不可靠：
 * GLM-5 系首个原生多模态不带 v 后缀，差点被误杀）。
 *
 * 分层判定（每层都只做"已核实"的事，不再有命名猜测）：
 *   1. 显式枚举表 VISION_ALLOW / VISION_DENY：按官方产品线逐条列出的型号前缀，
 *      每条带官方依据（docs/vision-map-research.md 汇总了 URL 与原文）。
 *      DENY 先查（更特异的例外条目排在宽条目前面生效）。
 *   2. 快照归一：`model-YYYY-MM-DD` / `-YYYYMMDD` 剥日期后按基名查表
 *      （同产品线的快照继承模态，机制而非猜测）。
 *   3. 明文文档规则（各厂家写在文档里的型号线约定，非启发式）：
 *      -vl / omni / qvq / -ocr / gui- = 视觉线；-coder- / -mt- = 纯文本代码/翻译线。
 *   4. qwen3.7-max 快照日期规则（官方按快照逐步开放视觉，有明文）。
 *   5. 家族兜底拦截：仅限官方文档明确"文本为主、传图报错"的七家（见 TEXT_DEFAULT_PROVIDERS）
 *      ——枚举表未覆盖的这些家的新型号先拦（历史规律：新文本型号远多于新视觉型号），
 *      待核实后补进枚举表。
 *   6. 其余未知（openai/anthropic/google/grok/openrouter/自定义端点）默认放行：
 *      纯文本模型收到图只会被 transport 剔图不报错，视觉模型被误拦则功能残废
 *      ——误拦比误发更伤体验，方向性安全默认。
 *
 * 维护：新型号上线时查官方文档补进枚举表（一行一个产品线前缀 + 依据注释）。
 * 建议0 定期用 OpenRouter 目录 API（architecture.input_modalities 含 "image"）交叉校验。
 */
export const VISION_NAME_RE = /vision|-vl|vlm|omni|multimodal|4v\b|\.?\d+v\b/;

// ---------------------------------------------------------------------------
// 枚举表：型号前缀 = 官方产品线（一条注释一句依据；细节证据见 docs/vision-map-research.md）
// ---------------------------------------------------------------------------

/** 确定支持图片输入的型号线（前缀匹配，按官方产品线粒度） */
const VISION_ALLOW: readonly string[] = [
  // ---- OpenAI：官方 Models 页 "All latest OpenAI models support text and image input" ----
  "gpt-5", // 5/5-mini/5-nano/5-pro/5.1+/5.3-codex 全系（5 基础系 2026-12-11 停服）
  "gpt-4.1", // 4.1/4.1-mini/4.1-nano（nano 2026-10-23 停服）
  "gpt-4o",
  "o1", // o1/o1-pro/o1-mini
  "o3", // o3/o3-pro（o3-mini 在 DENY 先查拦下）
  "o4-mini",
  // ---- Anthropic：官方 "All current Claude models support text and image input"，无纯文本在售 ----
  "claude-fable-", "claude-mythos-", "claude-opus-", "claude-sonnet-", "claude-haiku-", // 5/4.x 在售全族
  "claude-3", // 3/3.5 历史系有视觉（官方退役，Bedrock/Vertex 直调存量防御）；3-5-haiku 在 DENY
  // ---- Google：2.5/3.x 文本主线全模态输入（OpenRouter 目录逐型号核过 input_modalities）----
  "gemini-2.5", "gemini-3", // 3-flash/3-pro/3.1/3.5/3.6/3.7 系；3.5-flash-cyber 在 DENY（存疑拦截）
  // ---- xAI：现役 API 目录聊天型号全部 text+image（Oracle 合作页 + OpenRouter 目录交叉核实）----
  "grok-4", "grok-3", "grok-2-vision", "grok-build", "grok-code-fast", // 4 系遗留 ID 已重定向到多模态 4.3
  // ---- DeepSeek：官方 "Only vision models accept images; others return a 400 error" ----
  "deepseek-v4-flash-vision-exp", // 2026-08-21 上线，当前唯一视觉型号；未来 vision 新型号走明文规则层
  // ---- 智谱 GLM：官方模型概览逐型号核实（枚举制：不依赖"版本号后 v"规律）----
  "glm-5v-", // glm-5v-turbo（2026-04，多模态 Coding 基座）
  "glm-5.3-flash", // 2026-08 末上线：GLM-5 系首个原生多模态（docs vlm/glm-5.3-flash）——不带 v，枚举显式放行
  "glm-4.6v", "glm-4.5v", "glm-4.1v", "glm-4v-", // 4 系视觉线（4v-flash 免费图像理解）
  "glm-ocr", // 走专用 layout_parsing 接口（聊天链路用不上，列出备自洽）
  // ---- 阿里 Qwen/DashScope：官方视觉理解选型页（2026-02 起旗舰主线即"原生视觉语言系列"）----
  "qwen3.5-omni", "qwen3-omni", "qwen-omni", // 全模态系
  "qwen3.5-ocr", "qwen-vl-ocr", "gui-", // OCR / GUI 截图专用视觉
  "qwen3.5-plus", "qwen3.5-flash", "qwen3.5-32b", "qwen3.5-72b", // 3.5 原生视觉主线
  "qwen3.6-", // 3.6 plus/flash/开源尺寸
  "qwen3.7-plus", "qwen3.7-flash", // 3.7 原生视觉主线（max 走快照日期规则层）
  "qwen3.8-max", "qwen3.8-27b", "qwen3.8-flash-next", // 3.8 原生视觉主线；flash-next（2026-08 末，
  // Qwen4 架构实验预览、原生多模态 MoE，ModelScope 官方页）——next 后缀历史是纯文本，此处例外
  // ---- Kimi/Moonshot：视觉已内嵌进主型号（platform.kimi.com 模型列表）----
  "kimi-k3", // 当前旗舰，原生视觉理解（图片+视频）
  "kimi-k2.7-code", // 2026 Coding 型号，图片+视频
  "kimi-k2.6", "kimi-k2.5", // k2.5 至 2026-08-31 下线
  "moonshot-v1-8k-vision-preview", "moonshot-v1-32k-vision-preview", "moonshot-v1-128k-vision-preview", // 2026-08-31 下线
];

/** 确定不支持图片的型号线（先于 ALLOW 查询——承载更特异的例外） */
const VISION_DENY: readonly string[] = [
  // OpenAI：官方页明确无视觉 / 已停服纯文本
  "o3-mini", // 官方页 "Image: Not supported"
  "gpt-3.5", // 纯文本，2026-09/10 停服
  "gpt-oss-", // 开放权重，仅文本/推理/工具
  "gpt-4-turbo", "gpt-4-06", // 旧快照/turbo，2026-10-23 停服（turbo 历史有 vision，停服口径下保守拦截无害）
  // Anthropic：历史无视觉型号（官方退役，防御存量配置）
  "claude-3-5-haiku", "claude-2", "claude-1", "claude-instant",
  // Google：限量试点安全专用，二手称纯文本，无官方页可核（存疑拦截）
  "gemini-3.5-flash-cyber",
  // DeepSeek：传图 400（chat/reasoner/coder 已停用，防御残留配置）
  "deepseek-v4-flash", "deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner", "deepseek-coder",
  // Qwen：官方文本生成页明确警示"仅支持文本接口，直接替换模型会导致报错"
  "qwen3.8-2.4t-", "qwen3.7-max-2026-05-20", // 3.7-max 更早快照在快照规则层拦
  "qwen3-max", "qwen-plus", "qwen-flash", "qwen-turbo",
  "qwen3-235b", "qwen3-30b", "qwen3-next", // 老开源文本系（-next 纯文本预览的常态）
  "qwen-coder", "qwen3-coder",
  // GLM：文本系（GLM-5.3 原文"目前仅支持处理文本模态信息"）；生成系/语音系
  "glm-5.3", // 旗舰纯文本（GLM-5.3 原文"目前仅支持处理文本模态信息"）；5.3-flash 由最长前缀规则放行
  "glm-z1", "glm-4-voice", "cogview", "cogvideox",
  // Kimi：已下线纯文本（k2 生命周期内纯文本；勿一刀切 ^kimi-k2——带点的 2.5/2.6/2.7-code 是多模态）
  "kimi-k2-thinking", "kimi-k2-turbo",
  "moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k", // 无 -vision-preview 后缀者纯文本
];

/** 文档明文规则（厂家写在文档里的型号线约定；每条带依据，非启发式） */
const DOC_RULE_ALLOW = [
  /-vl/, // Qwen VL 系列（qwen-vl/qwen2.5-vl/qwen3-vl，官方视觉理解页在售）
  /^qvq-/, // Qwen 视觉推理"仅思考"系（qvq-max/plus）
  /omni/, // 全模态系命名（qwen3.5-omni 等）
];
const DOC_RULE_DENY = [
  /-coder-/, // Qwen 代码系：官方能力标签仅"文本生成"
  /-mt-/, // 多语言翻译系：纯文本
];

/** 快照归一：同产品线的日期快照继承基名模态（gpt-4o-2024-11-20 → gpt-4o） */
function stripSnapshotDate(slug: string): string {
  return slug.replace(/-(\d{4}-\d{2}-\d{2}|\d{8})$/, "");
}

function enumLookup(slug: string): boolean | undefined {
  // 两张表取"最长命中前缀"定胜负：宽条目（glm-5.3 拦）让位给更特异的条目（glm-5.3-flash 放）
  let best = "";
  let verdict: boolean | undefined;
  for (const p of VISION_ALLOW) {
    if (slug.startsWith(p) && p.length > best.length) {
      best = p;
      verdict = true;
    }
  }
  for (const p of VISION_DENY) {
    if (slug.startsWith(p) && p.length > best.length) {
      best = p;
      verdict = false;
    }
  }
  return verdict;
}

/** qwen3.7-max 快照日期规则：官方按快照逐步开放视觉——2026-06-08 起带视觉，更早/无日期仅文本 */
function qwen37MaxSnapshot(slug: string): boolean | undefined {
  const m = /^qwen3\.7-max-(\d{4}-\d{2}-\d{2})$/.exec(slug);
  if (!m) return undefined;
  return m[1] >= "2026-06-08"; // ISO 日期可按字符串比较
}

/**
 * 已知型号的确定性判定；返回 undefined 表示"不认识"，交给明文规则与 provider 默认。
 * slug 为型号小写 ID（OpenRouter 场景已剥去 "作者/" 前缀）。
 */
function knownModelVision(slug: string): boolean | undefined {
  // 枚举表（含快照归一共两轮：原样 + 剥日期）
  const direct = enumLookup(slug) ?? enumLookup(stripSnapshotDate(slug));
  if (direct !== undefined) return direct;
  // qwen3.7-max 快照规则（枚举表刻意不收 max 线，统一走这里）
  const snap = qwen37MaxSnapshot(slug);
  if (snap !== undefined) return snap;
  // 明文文档规则
  if (DOC_RULE_DENY.some((r) => r.test(slug))) return false;
  if (DOC_RULE_ALLOW.some((r) => r.test(slug))) return true;
  return undefined;
}

/** 文本为主的厂家：型号不认识时默认拦截（官方文档明确"文本为主/传图报错"的七家；
 * 新型号先拦、核实后补枚举表——历史规律：这些家新文本型号远多于新视觉型号） */
const TEXT_DEFAULT_PROVIDERS = new Set(["deepseek", "moonshot", "kimi", "zhipu", "bigmodel", "dashscope", "qwen"]);

export function modelSupportsVision(providerId: string | undefined, modelId: string | undefined): boolean {
  const pid = (providerId ?? "").toLowerCase();
  const mid = (modelId ?? "").toLowerCase();

  // OpenRouter：剥 "作者/" 前缀后套同一份枚举（未知作者/型号保持默认放行，维持现状原则）
  const slug = pid === "openrouter" && mid.includes("/") ? mid.slice(mid.indexOf("/") + 1) : mid;

  // 1. 已知型号枚举 + 明文规则
  const known = knownModelVision(slug);
  if (known !== undefined) return known;
  // 2. provider 默认：文本为主七家默认拦；openai/anthropic/google/grok/openrouter/自定义端点默认放行
  return !TEXT_DEFAULT_PROVIDERS.has(pid);
}
