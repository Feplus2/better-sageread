import { readImageAttachment } from "@/services/attachment-service";
import { useProviderStore } from "@/store/provider-store";
import { tool } from "ai";
import { z } from "zod";
import { modelSupportsVision } from "../providers/vision-map";
import { DEFAULT_TARGET_DATA_URL_CHARS, loadLocalImageAsDataUrl } from "../utils/local-image";
import { getToolImageBudgetChars } from "../utils/tool-image-budget";
import { collectImageTargets, imageEnvelope, isAbsoluteImagePath, readLocalImageBytes } from "./image-shared";
import type { ImageReadGrant, ImageRoots } from "./image-shared";

/**
 * 批量看图（2026-10-22）：一次工具调用返回多张图（同一 tool result 的多个 file part），
 * 让模型在"一次请求"里综合 >3 张图——单张 readImage 连续调用会跨越多步，
 * 每步都重发历史图片，既慢又容易只看到最后一张。
 *
 * 与 readImage 共用路径守卫/信封；每张图各自带 <path> 信封，图片桥按顺序配对，
 * 被预算省略时占位能指回具体文件。
 * 每张图的 dataUrl 目标体积按"本轮图片预算 / 张数"摊分，避免 4~6 张大图把请求体撑爆。
 */

const MAX_VIEW_IMAGES = 6;
/** 单图最低目标体积：再小就看不清图注/小字，宁可让图片桥按预算省略老图 */
const MIN_PER_IMAGE_CHARS = 40_000;

const errorText = (value: string) => ({ type: "error-text" as const, value });

export const viewImagesTool = tool({
  description:
    "一次查看多张图片（1–6 张），把多张图作为同一个工具结果返回——适合横向对比/综合多图（如论文多张 figure、多页截图）。\n\n📖 **使用场景**：\n• 需要同时理解 2 张以上图（模型只能靠一次工具结果综合跨图信息）\n• getFigures 返回多个 image_path，要对比它们的差异或趋势\n• 同一批截图/表格需要一起读\n\n📊 **返回内容**：每张图一条信封（顺序 + 路径 + 尺寸/体积）+ 图片本体（多模态通道）。\n\n⚠️ **成本**：图片会进入上下文并在后续每一步重复发送；单次最多 6 张，每张按本轮图片预算摊分压缩（长边默认 1024），超出请求预算的较早图片会被替换成带路径占位（可用 readImage 重看）。\n🚫 **相对路径不可用**：paths 必须是绝对路径（getFigures 的 image_path）。",
  inputSchema: z.object({
    paths: z
      .array(z.string().min(1))
      .max(MAX_VIEW_IMAGES)
      .optional()
      .describe("本地图片绝对路径数组（通常来自 getFigures 的 image_path），最多 6 个"),
    refs: z
      .array(z.string().min(1))
      .max(MAX_VIEW_IMAGES)
      .optional()
      .describe("聊天图片附件引用数组（attachment://…），最多 6 个"),
    maxEdge: z
      .number()
      .int()
      .min(512)
      .max(1536)
      .optional()
      .describe("单图长边像素上限，默认 1024、最大 1536；多图时建议保持默认以控制请求体"),
  }),
  execute: async ({
    paths,
    refs,
    maxEdge,
    imageRoots,
    imageGrants,
  }: {
    paths?: string[];
    refs?: string[];
    maxEdge?: number;
    imageRoots?: ImageRoots;
    imageGrants?: ImageReadGrant[];
  }) => {
    const targets = collectImageTargets(paths, refs);
    if (targets.length === 0) {
      return errorText("需要提供 paths（本地图片绝对路径数组）或 refs（聊天图片附件引用数组），至少 1 张、最多 6 张");
    }
    if (targets.length > MAX_VIEW_IMAGES) {
      return errorText(
        `一次最多查看 ${MAX_VIEW_IMAGES} 张图片（收到 ${targets.length} 张）。请拆成多次 viewImages，或先挑最关键的 ${MAX_VIEW_IMAGES} 张。`,
      );
    }

    const selected = useProviderStore.getState().selectedModel;
    if (selected && !modelSupportsVision(selected.providerId, selected.modelId)) {
      return errorText(
        `当前模型（${selected.modelName || selected.modelId}）不支持图片输入。请切换到视觉模型后再看图片，或只基于图注/正文回答并说明未看图。`,
      );
    }

    // 按张数摊分本轮工具图片预算：4 张时每张约 157k 字符，6 张约 105k，保证整批能进一次请求
    const perImageChars = Math.max(
      MIN_PER_IMAGE_CHARS,
      Math.min(DEFAULT_TARGET_DATA_URL_CHARS, Math.floor((getToolImageBudgetChars() * 0.9) / targets.length)),
    );

    const value: Array<Record<string, unknown>> = [];
    const failures: string[] = [];
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      const ordinal = `第 ${index + 1}/${targets.length} 张：`;
      try {
        if (target.kind === "ref") {
          const loaded = await readImageAttachment(target.value);
          if (!loaded) {
            failures.push(`${ordinal}${target.value}（附件不存在或已被清理）`);
            continue;
          }
          value.push({
            type: "text",
            text: imageEnvelope({
              label: target.value,
              mediaType: loaded.mediaType,
              payloadBytes: loaded.dataUrl.length,
              ordinal,
            }),
          });
          value.push({ type: "file", mediaType: loaded.mediaType, url: loaded.dataUrl });
          continue;
        }
        if (!isAbsoluteImagePath(target.value)) {
          failures.push(`${ordinal}${target.value}（需要绝对路径，不能传 Markdown 相对路径）`);
          continue;
        }
        const grant = imageGrants?.find((candidate) => candidate.path === target.value);
        const bytes = await readLocalImageBytes(target.value, { roots: imageRoots, grant });
        const loaded = await loadLocalImageAsDataUrl(bytes, {
          maxEdge,
          targetDataUrlChars: perImageChars,
        });
        value.push({
          type: "text",
          text: imageEnvelope({
            label: target.value,
            mediaType: loaded.mediaType,
            width: loaded.width,
            height: loaded.height,
            bytes: loaded.bytes,
            payloadBytes: loaded.payloadBytes,
            downscaled: loaded.downscaled,
            ordinal,
          }),
        });
        value.push({ type: "file", mediaType: loaded.mediaType, url: loaded.dataUrl });
      } catch (error) {
        failures.push(`${ordinal}${target.value}（${error instanceof Error ? error.message : String(error)}）`);
      }
    }

    if (value.length === 0) {
      return errorText(`全部图片读取失败：\n${failures.join("\n")}`);
    }
    if (failures.length > 0) {
      value.push({
        type: "text",
        text: `以下图片未能读取（其余图片已附上，请基于已附图片回答并说明缺哪张）：\n${failures.join("\n")}`,
      });
    }
    // 图片顺序 = 请求顺序：信封与 file part 交替，图片桥按同一顺序配对路径
    return { type: "content" as const, value };
  },
});

export { MAX_VIEW_IMAGES };

export default viewImagesTool;
