/**
 * J2：模型多模态（图片）能力表。
 *
 * 原则与 reasoning-map 一致：只拦"确定不支持图片"的已知组合；未知/自定义端点
 * 默认视为支持（用户自建端点可能支持视觉，误拦比误发更伤体验）。
 * 两道闸：① 输入时（非视觉模型拒绝添加图片并提示）；② 请求时（transport 把历史
 * 与当前的 file part 全部剔除，纯文本模型只是"看不到图"，绝不因图片报错——
 * 场景：上一轮多模态模型带图问答，下一轮换纯文本模型续聊）。
 *
 * 2026-08-22：新增命名启发式前置判断（vision/-vl/vlm/omni 等关键词直接放行）——
 * 各家新视觉模型命名高度规律，启发式可覆盖发布节奏领先于本表更新的型号
 * （实测踩坑：deepseek-v4-flash-vision-exp 被旧表误拦）。已知纯文本系列仍显式拦截。
 */
const VISION_NAME_RE = /vision|-vl|vlm|omni|multimodal|4v\b|\.?\d+v\b/;

export function modelSupportsVision(providerId: string | undefined, modelId: string | undefined): boolean {
  const pid = (providerId ?? "").toLowerCase();
  const mid = (modelId ?? "").toLowerCase();

  // 命名启发式：任何提供商，型号名带视觉关键词即放行（优先于各家的保守默认）
  if (VISION_NAME_RE.test(mid)) return true;

  switch (pid) {
    case "deepseek":
      // DeepSeek 视觉型号走上方命名启发式（*vision*）；其余（deepseek-chat/reasoner/v4 系）纯文本
      return false;
    case "moonshot":
    case "kimi":
      // moonshot-v1 / kimi-k2 均为纯文本；视觉型号（如有）由命名启发式放行
      return false;
    case "zhipu":
    case "bigmodel":
      // 仅 glm-4v / glm-4.5v 系列支持视觉（4v 命中启发式）
      return /4[.\d]*v/.test(mid);
    case "dashscope":
    case "qwen":
      // 仅 qwen-vl / qvq 系列支持视觉（-vl/qvq 命中启发式）
      return /-vl|qvq/.test(mid);
    case "openai":
      return !mid.startsWith("gpt-3.5");
    default:
      // openrouter / google / anthropic / 自定义兼容端点：默认放行
      return true;
  }
}
