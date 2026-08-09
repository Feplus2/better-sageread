/**
 * J2：模型多模态（图片）能力表。
 *
 * 原则与 reasoning-map 一致：只拦"确定不支持图片"的已知组合；未知/自定义端点
 * 默认视为支持（用户自建端点可能支持视觉，误拦比误发更伤体验）。
 * 两道闸：① 输入时（非视觉模型拒绝添加图片并提示）；② 请求时（transport 把历史
 * 与当前的 file part 全部剔除，纯文本模型只是"看不到图"，绝不因图片报错——
 * 场景：上一轮多模态模型带图问答，下一轮换纯文本模型续聊）。
 */
export function modelSupportsVision(providerId: string | undefined, modelId: string | undefined): boolean {
  const pid = (providerId ?? "").toLowerCase();
  const mid = (modelId ?? "").toLowerCase();

  switch (pid) {
    case "deepseek":
      // DeepSeek 开放 API 无视觉模型
      return false;
    case "moonshot":
    case "kimi":
      // moonshot-v1 / kimi-k2 均为纯文本
      return false;
    case "zhipu":
    case "bigmodel":
      // 仅 glm-4v / glm-4.5v 系列支持视觉
      return /4[.\d]*v/.test(mid);
    case "dashscope":
    case "qwen":
      // 仅 qwen-vl / qvq 系列支持视觉
      return /-vl|qvq/.test(mid);
    case "openai":
      return !mid.startsWith("gpt-3.5");
    default:
      // openrouter / google / anthropic / 自定义兼容端点：默认放行
      return true;
  }
}
