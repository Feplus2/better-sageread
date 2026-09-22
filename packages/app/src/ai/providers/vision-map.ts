/**
 * J2：模型多模态（图片）能力表 —— 纯静态枚举（2026-08-27 定稿，最近更新 2026-09-22）。
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
 * gpt-4o-2024-11-20 就是 gpt-4o；豆包用六位式 -260628，同理）——归一后仍查同一张表。
 *
 * 维护：新型号上线 → 查官方文档 → 表里加一行（DENY 侧优先级高：用户真在用的
 * 文本聊天型号收全，报错才少）。调研底稿与各家官方链接：docs/archive/vision-map-research.md。
 *
 * 表体已迁至 maps/vision-map.json（本文件 import 打包为兜底；site/maps/vision-map.json
 * 随站点部署，客户端启动后远程拉取热更新，见 maps/map-runtime.ts 与
 * services/model-maps-service.ts）。改表 = 改 JSON 并递增 updatedAt。
 */
import { createMapRuntime } from "./maps/map-runtime";
import bundledVisionMap from "./maps/vision-map.json";

export const VISION_NAME_RE = /vision|-vl|vlm|omni|multimodal|4v\b|\.?\d+v\b/;
// ↑ 不参与能力判定（本表已无规则层）——仅 factory.ts 的 DeepSeek 适配器分派在用，
// 且 2026-09-10 起与 modelSupportsVision 精确表并用（deepseek-flash/V4.1 原生多模态但命名
// 无 vision 字样，单靠本正则会误路由；误路由无害：DeepSeek API 本就是 OpenAI 兼容格式）。

// ---------------------------------------------------------------------------
// 精确型号枚举表：true = 接受图片输入（any-to-text）；false = 纯文本（text-to-text）。
// 唯一事实源 = maps/vision-map.json；runtime 启动用打包表/缓存表，远程更晚则热替换
// ---------------------------------------------------------------------------
function validateVisionModels(u: unknown): Record<string, boolean> | null {
  if (!u || typeof u !== "object" || Array.isArray(u)) return null;
  for (const v of Object.values(u)) if (typeof v !== "boolean") return null;
  return u as Record<string, boolean>;
}

const runtime = createMapRuntime<boolean>({
  cacheKey: "visionMapCache",
  bundled: bundledVisionMap,
  validateModels: validateVisionModels,
});

/** 远程热更新入口（services/model-maps-service 调用）：形状校验+版本比较在运行时内 */
export function adoptRemoteVisionMap(raw: unknown): boolean {
  return runtime.adopt(raw);
}

/** 身份归一（非能力推断）：OpenRouter "作者/" 前缀剥离 + 日期快照别名剥离（厂商口径：日期 ID 是基名快照；\d{6} 为豆包式 -260628） */
function canonicalSlug(modelId: string): string[] {
  let slug = modelId.toLowerCase();
  if (slug.includes("/")) slug = slug.slice(slug.indexOf("/") + 1);
  const stripped = slug.replace(/-(\d{4}-\d{2}-\d{2}|\d{8}|\d{6})$/, "");
  return stripped === slug ? [slug] : [slug, stripped];
}

export function modelSupportsVision(_providerId: string | undefined, modelId: string | undefined): boolean {
  const table = runtime.current();
  for (const slug of canonicalSlug(modelId ?? "")) {
    const known = table[slug];
    if (known !== undefined) return known;
  }
  // 未收录（含未来新型号）：默认放行——文本模型收图最坏一次可见报错，误拦视觉模型是无声残废
  return true;
}
