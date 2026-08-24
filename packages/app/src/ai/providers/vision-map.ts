/**
 * J2：模型多模态（图片）能力表 —— 枚举式（2026-08-24 调研落地，依据见 docs/vision-map-research.md）。
 *
 * 原则与 reasoning-map 同一：只拦"确定不支持图片"的已知组合；未知型号/自定义端点默认放行
 * （误拦比误发更伤体验——纯文本模型收到图只是被 transport 剔图不报错，视觉模型被误拦则功能残废）。
 * 注意与 reasoning-map 的不对称：vision 侧未知默认放行（剔图兜底），reasoning 侧未知默认不下发
 * （防 400）——方向不同、原则同一（已知才做确定性处理，未知走保守安全默认）。
 * 两道闸：① 输入时（非视觉模型拒绝添加图片并提示）；② 请求时（transport 把历史与当前的
 * file part 全部剔除，纯文本模型只是"看不到图"，绝不因图片报错——场景：上一轮多模态模型带图
 * 问答，下一轮换纯文本模型续聊）。
 *
 * 判定优先级（2026-08-24 起由"启发式最优先"反转为枚举优先）：
 *   已知家族枚举（拦/放） > 命名启发式（兜底未知新命名） > provider 默认
 * 维护格式：型号族正则 + 一句官方依据。模型生命周期极快（本次调研即发现 Kimi 全线换血、
 * DeepSeek 视觉型号 3 天前才上线），建议定期用 OpenRouter 目录 API 实测校验本表。
 *
 * TODO(openrouter 运行时枚举)：OpenRouter 可升级为真枚举——GET https://openrouter.ai/api/v1/models
 * 的 architecture.input_modalities 含 "image" 即放行（可缓存，顺带可缓存 reasoning 元数据）。
 * 需把 modelSupportsVision 异步化并处理缓存/离线兜底，改动面大，暂用下方"剥作者前缀套家族枚举"
 * 的静态方案（2026-08-24 调研路径 2）。
 */
export const VISION_NAME_RE = /vision|-vl|vlm|omni|multimodal|4v\b|\.?\d+v\b/;

/**
 * 已知型号族的确定性判定；返回 undefined 表示"不认识的型号"，交给启发式与 provider 默认。
 * slug 为型号小写 ID（OpenRouter 场景已剥去 "作者/" 前缀，目录前缀与官方 ID 基本一致，
 * 如 deepseek/deepseek-v4-flash-vision-exp、z-ai/glm-4.6v）。
 */
function knownFamilyVision(slug: string): boolean | undefined {
  // ---- OpenAI 族：官方 Models 页"All latest OpenAI models support text and image input" ----
  if (/^(gpt-|o1|o3|o4|chatgpt-)/.test(slug)) {
    if (/^gpt-3\.5/.test(slug)) return false; // 纯文本，2026-09/10 陆续停服
    if (/^o3-mini/.test(slug)) return false; // 官方页明确 "Image: Not supported"
    if (/^gpt-oss-/.test(slug)) return false; // 开放权重，官方页仅文本/推理/工具
    if (/^gpt-4$|^gpt-4-\d|^gpt-4-turbo/.test(slug)) return false; // 旧快照/turbo 2026-10-23 停服，保守拦截无害
    return true; // gpt-5 全系 / gpt-4.1 / gpt-4o / o1 / o3 / o3-pro / o4-mini 等均支持图片
  }
  // ---- DeepSeek 族：官方"Only vision models accept images; other models return a 400 error" ----
  if (slug.startsWith("deepseek")) {
    // 当前唯一视觉型号：deepseek-v4-flash-vision-exp（2026-08-21 上线）；启发式兜底未来新视觉命名
    return VISION_NAME_RE.test(slug);
  }
  // ---- Anthropic 族：官方"All current Claude models support text and image input"，无纯文本在售 ----
  if (slug.startsWith("claude-")) {
    // 历史无视觉型号：3.5 Haiku 与远古系（官方平台已退役，拦截仅防御存量配置与 Bedrock/Vertex 直调）
    if (/^claude-3-5-haiku|^claude-(2|1|instant)/.test(slug)) return false;
    return true;
  }
  // ---- Google Gemini 族：2.5/3.x 文本主线均为全模态输入，无纯文本聊天型号 ----
  if (slug.startsWith("gemini-")) return true;
  // ---- xAI Grok 族：现役 API 目录聊天型号全部 text+image→text（含 grok-build/code-fast） ----
  if (slug.startsWith("grok-")) return true;
  // ---- 智谱 GLM 族：版本号后紧跟 v = 视觉理解（Flash/FlashX/AirX 只是档位标记，与模态无关） ----
  if (/^(glm-|autoglm|chatglm|cogview|cogvideox)/.test(slug)) {
    if (/^glm-5v-/.test(slug)) return true; // glm-5v-turbo（2026-04 上线，多模态 Coding 基座）
    if (/^glm-4\.\d+v|^glm-4v-/.test(slug)) return true; // 4.6v/4.5v/4.1v-thinking 全系、glm-4v-flash
    if (VISION_NAME_RE.test(slug)) return true; // 兜底未来新视觉命名
    return false; // 其余 glm 文本系各详情页明确"仅文本"（GLM-5.3 原文"目前仅支持处理文本模态信息"）、
    // glm-z1（已弃用）、glm-4-voice（语音）、cogview/cogvideox（生成系）
  }
  // ---- 阿里 Qwen 族：2026-02 起旗舰主线为"原生视觉语言系列"，"-vl/omni 才看图"的规律已失效 ----
  if (/^(qwen|qvq|gui-)/.test(slug)) {
    if (/-vl|omni/.test(slug)) return true; // qwen-vl/qwen2.5-vl/qwen3-vl 系、qwen3.5-omni 全模态系
    if (/^qvq-/.test(slug)) return true; // 视觉推理"仅思考"系（qvq-max/plus）
    if (/-ocr|^gui-/.test(slug)) return true; // OCR / GUI 截图专用视觉型号
    if (/^qwen3\.[56]-(plus|flash|\d+b)/.test(slug)) return true; // 3.5/3.6 原生视觉主线（plus/flash/开源尺寸）
    if (/^qwen3\.7-(plus|flash)/.test(slug)) return true; // 3.7 原生视觉主线
    if (/^qwen3\.8-(max|27b)/.test(slug)) return true; // 3.8 原生视觉主线
    // max 线按快照逐步开放视觉：qwen3.7-max 自 2026-06-08 快照起带视觉（ISO 日期可按字符串比较）；
    // 无日期/更早快照落入下方 false（官方文本生成页警示"仅支持文本接口"）
    const maxSnap = /^qwen3\.7-max-(\d{4}-\d{2}-\d{2})$/.exec(slug);
    if (maxSnap) return maxSnap[1] >= "2026-06-08";
    if (VISION_NAME_RE.test(slug)) return true; // 兜底未来新视觉命名
    return false; // qwen3-max(-preview)、-coder-、qwen-plus/flash、qwen3-235b/30b/next、-mt- 等纯文本
  }
  // ---- 月之暗面 Kimi 族：视觉已内嵌进主型号，无独立 vision 型号路线 ----
  if (/^(kimi-|moonshot-)/.test(slug)) {
    if (/^kimi-k3/.test(slug)) return true; // 当前旗舰，原生视觉理解（图片+视频输入）
    if (/^kimi-k2\.7-code(-highspeed)?$/.test(slug)) return true; // 2026 Coding 型号，图片+视频
    if (/^kimi-k2\.[56]$/.test(slug)) return true; // k2.6 视觉+视频；k2.5 至 2026-08-31 下线
    if (/^moonshot-v1-(8k|32k|128k)-vision-preview$/.test(slug)) return true; // 至 2026-08-31 下线
    if (VISION_NAME_RE.test(slug)) return true; // 兜底未来新视觉命名
    return false; // moonshot-v1 无 -vision-preview 后缀者纯文本；kimi-k2(-thinking/-turbo) 已下线纯文本
    // 易踩坑：勿用 ^kimi-k2 一刀切——带点的 kimi-k2.5/2.6/2.7-code 是多模态
  }
  return undefined;
}

/** 文本为主的厂家：型号不认识时默认拦截（多模态新型号由家族枚举/命名启发式接住） */
const TEXT_DEFAULT_PROVIDERS = new Set(["deepseek", "moonshot", "kimi", "zhipu", "bigmodel", "dashscope", "qwen"]);

export function modelSupportsVision(providerId: string | undefined, modelId: string | undefined): boolean {
  const pid = (providerId ?? "").toLowerCase();
  const mid = (modelId ?? "").toLowerCase();

  // OpenRouter：剥 "作者/" 前缀后套同一份家族枚举（未知作者/型号保持默认放行，维持现状原则）
  const slug = pid === "openrouter" && mid.includes("/") ? mid.slice(mid.indexOf("/") + 1) : mid;

  // 1. 已知家族枚举（含家族内的已知拦截与放行）
  const known = knownFamilyVision(slug);
  if (known !== undefined) return known;
  // 2. 命名启发式：兜底未知新视觉命名（各家带 vision/-vl/omni 等关键词的均为真视觉，调研未见反例）
  if (VISION_NAME_RE.test(slug)) return true;
  // 3. provider 默认：文本为主厂家默认拦；openai/anthropic/google/grok/openrouter/自定义端点默认放行
  return !TEXT_DEFAULT_PROVIDERS.has(pid);
}
