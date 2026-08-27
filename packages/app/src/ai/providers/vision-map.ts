/**
 * J2：模型多模态（图片）能力表 —— 纯静态枚举（2026-08-27 定稿）。
 *
 * 范围（用户裁定）：**能生成文本的聊天模型**——只回答"text-to-text 还是 any-to-text
 * （含图片输入）"；图像/视频生成、语音系不在本表范围。
 *
 * 形态：一张精确型号 → 布尔的表。每个型号独立成行、独立对照官方文档核实，无任何
 * 推断规则——不按产品线、不看命名、不按厂家兜底。厂家随时变卦（上一代多模态、
 * 下一代纯文本；coder 线哪天主打前端设计支持视觉）都不影响已核实的行，新型号
 * 核实后加行即可。
 *
 * 未收录型号（含一切未来新型号）：**默认放行**。代价不对称是这么裁定的依据——
 * 文本模型收到图，最坏是一次可见的 API 报错（信息明确、可恢复）；视觉模型被误拦，
 * 是无声的功能残废（用户不知道为什么加不了图）。漏收 DENY 行的代价 = 一次报错，
 * 漏收 ALLOW 行的代价 = 零（放行恰好正确）。
 *
 * 仅存的两条"身份归一"不是能力推断：① OpenRouter 的 "作者/" 前缀剥离（同一型号的
 * 聚合写法）；② 日期后缀剥离（厂商文档口径：日期 ID 是基名型号的快照别名，
 * gpt-4o-2024-11-20 就是 gpt-4o）——归一后仍查同一张表。
 *
 * 维护：新型号上线 → 查官方文档 → 表里加一行（DENY 侧优先级高：用户真在用的
 * 文本聊天型号收全，报错才少）。调研底稿与各家官方链接：docs/vision-map-research.md。
 */
export const VISION_NAME_RE = /vision|-vl|vlm|omni|multimodal|4v\b|\.?\d+v\b/;
// ↑ 不参与能力判定（本表已无规则层）——仅 factory.ts 的 DeepSeek 适配器分派在用
//（视觉型号需走 openai-compatible 通道，误路由无害：DeepSeek API 本就是 OpenAI 兼容格式）。

// ---------------------------------------------------------------------------
// 精确型号枚举表：true = 接受图片输入（any-to-text）；false = 纯文本（text-to-text）
// ---------------------------------------------------------------------------
const MODEL_VISION: Readonly<Record<string, boolean>> = {
  // ---- OpenAI（官方 Models 页 "All latest OpenAI models support text and image input"）----
  "gpt-5.6": true, "gpt-5.5": true, "gpt-5.4": true, "gpt-5.3-codex": true,
  "gpt-5.2": true, "gpt-5.1": true, "gpt-5.1-mini": true, "gpt-5.1-codex": true,
  "gpt-5": true, "gpt-5-pro": true, "gpt-5-mini": true, "gpt-5-nano": true, // 5 基础系 2026-12-11 停服
  "gpt-4.1": true, "gpt-4.1-mini": true, "gpt-4.1-nano": true,
  "gpt-4o": true, "gpt-4o-mini": true,
  "o4-mini": true, "o3": true, "o3-pro": true, "o1": true, "o1-pro": true, "o1-mini": true,
  "o3-mini": false, // 官方页明确 "Image: Not supported"
  "gpt-3.5-turbo": false, // 纯文本，2026-09/10 陆续停服
  "gpt-4": false, "gpt-4-turbo": false, // 旧快照系 2026-10-23 停服（turbo 历史有 vision，停服口径下拦了无害）
  "gpt-oss-120b": false, "gpt-oss-20b": false, // 开放权重，官方页仅文本/推理/工具

  // ---- Anthropic（官方 "All current Claude models support text and image input"；3.5-haiku 与远古系例外）----
  "claude-fable-5": true, "claude-mythos-5": true,
  "claude-opus-5": true, "claude-opus-4.8": true, "claude-opus-4.7": true,
  "claude-opus-4.6": true, "claude-opus-4.5": true,
  "claude-sonnet-5": true, "claude-sonnet-4.6": true, "claude-sonnet-4.5": true,
  "claude-haiku-4.5": true,
  "claude-3-7-sonnet": true, "claude-3-7-sonnet-latest": true,
  "claude-3-5-sonnet": true, "claude-3-5-sonnet-latest": true,
  "claude-3-opus": true, "claude-3-opus-latest": true, // 3.x 历史系有视觉（官方退役，Bedrock/Vertex 存量防御）
  "claude-3-sonnet": true, "claude-3-haiku": true,
  "claude-3-5-haiku": false, "claude-3-5-haiku-latest": false, // 历史著名的无视觉型号
  "claude-2.1": false, "claude-2.0": false, "claude-instant-1.2": false, // 远古系

  // ---- Google Gemini（2.5/3.x 文本主线全模态输入，OpenRouter 目录逐型号核过 input_modalities）----
  "gemini-3.7-flash": true, "gemini-3.6-flash": true,
  "gemini-3.5-flash": true, "gemini-3.5-flash-lite": true,
  "gemini-3.1-pro": true, "gemini-3.1-flash": true, "gemini-3.1-flash-lite": true,
  "gemini-3-pro": true, "gemini-3-flash": true,
  "gemini-2.5-pro": true, "gemini-2.5-flash": true, "gemini-2.5-flash-lite": true,
  "gemini-3.5-flash-cyber": false, // 2026-07 限量试点安全专用，二手称纯文本，无官方页可核（存疑拦截）

  // ---- xAI Grok（现役目录聊天型号全部 text+image；Oracle 合作页 + OpenRouter 目录交叉核实）----
  "grok-4.6": true, "grok-4.5": true, "grok-4.3": true, "grok-4": true,
  "grok-4-fast": true, "grok-4-1-fast": true, // 遗留 ID 已重定向到多模态 4.3
  "grok-3": true,
  "grok-build-0.1": true, "grok-code-fast-1": true, // 连代码专用型也吃图

  // ---- DeepSeek（官方 "Only vision models accept images; others return a 400 error"）----
  "deepseek-v4-flash-vision-exp": true, // 2026-08-21 上线，当前唯一视觉型号
  "deepseek-v4-flash": false, "deepseek-v4-pro": false,
  "deepseek-chat": false, "deepseek-reasoner": false, "deepseek-coder": false, // 已停用，防御残留配置

  // ---- 智谱 GLM（官方模型概览逐型号核实；glm-5.3-flash 事件实证：多模态命名无规律，逐行枚举）----
  "glm-5.3-flash": true, // 2026-08 末上线：GLM-5 系首个原生多模态（docs vlm/glm-5.3-flash，320B-A18B）
  "glm-5v-turbo": true, // 2026-04，多模态 Coding 基座
  "glm-4.6v": true, "glm-4.6v-flash": true, "glm-4.6v-flashx": true,
  "glm-4.5v": true, "glm-4.1v": true, "glm-4.1v-thinking": true,
  "glm-4v-flash": true, "glm-4v-plus": true,
  "glm-5.3": false, // 旗舰纯文本（原文"目前仅支持处理文本模态信息"）
  "glm-5.2": false, "glm-5.1": false, "glm-5": false, "glm-5-turbo": false,
  "glm-4.7": false, "glm-4.6": false, "glm-4.6-flash": false,
  "glm-4.5": false, "glm-4.5-air": false, "glm-4.5-flash": false,
  "glm-4-flash": false, "glm-4-plus": false, "glm-4-air": false, "glm-4-long": false,

  // ---- 阿里 Qwen/DashScope（官方视觉理解选型页 + 文本生成页；2026-02 起旗舰主线原生视觉）----
  "qwen3.8-max": true, "qwen3.8-27b": true, "qwen3.8-flash-next": true, // flash-next：Qwen4 架构实验预览、原生多模态（ModelScope 官方页）
  "qwen3.7-plus": true, "qwen3.7-flash": true,
  "qwen3.7-max-2026-06-08": true, // max 线自此快照起带视觉（官方明文）；更晚快照（如 -2026-07-15）是日期别名→归一到本行
  "qwen3.6-plus": true, "qwen3.6-flash": true,
  "qwen3.5-plus": true, "qwen3.5-flash": true, "qwen3.5-32b": true, "qwen3.5-72b": true,
  "qwen3.5-omni": true, "qwen3.5-ocr": true,
  "qwen3-vl-plus": true, "qwen3-vl-flash": true, // 旧 VL 系在售（"不再首选推荐"）；更多尺寸变体未收录→放行恰好正确
  "qvq-max": true, "qvq-plus": true, // 视觉推理"仅思考"系
  "qwen3.7-max": false, "qwen3.7-max-2026-05-20": false, // 无日期/更早快照：官方警示"仅支持文本接口"
  "qwen3.8-2.4t": false, // 2.4t 档为纯文本（官方文本生成页）
  "qwen3-max": false, "qwen3-max-preview": false,
  "qwen-plus": false, "qwen-flash": false, "qwen-turbo": false, // 商业文本系
  "qwen3-235b-a22b": false, "qwen3-30b-a3b": false, "qwen3-next-80b-a3b": false, // 老开源文本系（-next 纯文本预览）
  "qwen3-coder-plus": false, "qwen3-coder-flash": false, // 代码系：能力标签仅"文本生成"

  // ---- 月之暗面 Kimi/Moonshot（platform.kimi.com 模型列表；视觉已内嵌进主型号）----
  "kimi-k3": true, // 当前旗舰，原生视觉理解（图片+视频）
  "kimi-k2.7-code": true, "kimi-k2.7-code-highspeed": true, // 2026 Coding 型号，图片+视频
  "kimi-k2.6": true, "kimi-k2.5": true, // k2.5 至 2026-08-31 下线
  "moonshot-v1-8k-vision-preview": true, "moonshot-v1-32k-vision-preview": true,
  "moonshot-v1-128k-vision-preview": true, // 2026-08-31 下线
  "kimi-k2": false, "kimi-k2-thinking": false, "kimi-k2-turbo": false, // 已下线纯文本
  "moonshot-v1-8k": false, "moonshot-v1-32k": false, "moonshot-v1-128k": false,
};

/** 身份归一（非能力推断）：OpenRouter "作者/" 前缀剥离 + 日期快照别名剥离（厂商口径：日期 ID 是基名快照） */
function canonicalSlug(modelId: string): string[] {
  let slug = modelId.toLowerCase();
  if (slug.includes("/")) slug = slug.slice(slug.indexOf("/") + 1);
  const stripped = slug.replace(/-(\d{4}-\d{2}-\d{2}|\d{8})$/, "");
  return stripped === slug ? [slug] : [slug, stripped];
}

export function modelSupportsVision(_providerId: string | undefined, modelId: string | undefined): boolean {
  for (const slug of canonicalSlug(modelId ?? "")) {
    const known = MODEL_VISION[slug];
    if (known !== undefined) return known;
  }
  // 未收录（含未来新型号）：默认放行——文本模型收图最坏一次可见报错，误拦视觉模型是无声残废
  return true;
}
