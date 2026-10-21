import { readImageAttachment } from "@/services/attachment-service";
import { useAgentSettingsStore } from "@/store/agent-settings-store";
import { useProviderStore } from "@/store/provider-store";
import { appDataDir } from "@tauri-apps/api/path";
import { tool } from "ai";
import { z } from "zod";
import { modelSupportsVision } from "../providers/vision-map";
import { MAX_IMAGE_BYTES, MAX_IMAGE_EDGE, loadLocalImageAsDataUrl } from "../utils/local-image";

/**
 * P0：readImage 从「只看聊天附件」升级为通用看图片原语。
 * - attachment:// 引用：保持原有重看能力；
 * - 本地绝对路径：文献库插图（getFigures 的 image_path）、工作区图片；
 * - 魔数嗅探 + 20MB/2048px 限制 + 非视觉模型明确报错（不静默丢图）。
 */

const errorText = (value: string) => ({ type: "error-text" as const, value });

const normalizePath = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

async function allowedRoots(): Promise<string[]> {
  const roots: string[] = [];
  try {
    roots.push(await appDataDir());
  } catch {
    // appDataDir 不可用时只校验工作区根
  }
  const settings = useAgentSettingsStore.getState();
  if (settings.workspaceRoot) roots.push(settings.workspaceRoot);
  for (const value of Object.values(settings.perAgentRoots)) {
    if (value) roots.push(value);
  }
  return roots.map(normalizePath);
}

async function assertAllowedPath(filePath: string): Promise<void> {
  const target = normalizePath(filePath);
  const roots = await allowedRoots();
  const allowed = roots.some((root) => target === root || target.startsWith(`${root}/`));
  if (!allowed) {
    throw new Error("只能查看文献库或工作区内的图片；界外路径请用户确认后用 readLocalFile/导入到工作区");
  }
}

function imageEnvelope(params: {
  label: string;
  mediaType: string;
  width: number;
  height: number;
  bytes: number;
  downscaled: boolean;
}): string {
  const sizeMb = (params.bytes / 1048576).toFixed(2);
  const downsample = params.downscaled ? " (downscaled)" : "";
  return `<path>${params.label}</path><type>image</type><content>${params.mediaType} ${params.width}x${params.height} px, ${sizeMb} MB${downsample}</content>\n请基于图片内容回答；引用时说明图号/所在小节，不要编造图中不存在的细节。`;
}

export const readImageTool = tool({
  description:
    "查看图片内容：支持聊天图片附件（attachment:// 引用）与本地绝对路径（文献库插图、工作区图片）。\n\n📖 **使用场景**：\n• 用户问「图 3 说明了什么」「这张图里有什么」\n• getFigures 返回了 image_path，需要真正看图而不是只读图注\n• 历史消息里的图片存根（⟦可用 readImage 重看⟧）需要重新查看\n\n📊 **返回内容**：图片本体（多模态通道）+ 信封（路径/类型/尺寸/是否降采样）。\n\n⚠️ **成本**：图片会进入上下文并在后续每一步重复发送。先读图注/正文，确需视觉细节时再看图；看完立即作答，不要在多步之间反复看图。\n⚠️ **限制**：单图 ≤20MB；长边默认压到 1024px（maxEdge 可调到 2048，但更贵）；当前模型不支持视觉时返回明确错误。\n\n🚫 **相对路径不可用**：请使用 getFigures 返回的 image_path（绝对路径）。",
  inputSchema: z.object({
    ref: z.string().min(1).optional().describe("聊天图片附件引用，形如 attachment://img-xxx.png"),
    path: z.string().min(1).optional().describe("本地图片绝对路径；通常直接来自 getFigures 的 image_path"),
    maxEdge: z
      .number()
      .int()
      .min(512)
      .max(2048)
      .optional()
      .describe("长边像素上限，默认 1024；只有小字/细节看不清时才升到 1536-2048（更贵）"),
  }),
  execute: async ({ ref, path, maxEdge }: { ref?: string; path?: string; maxEdge?: number }) => {
    const target = path ?? ref;
    if (!target) {
      return errorText("需要提供 ref（聊天附件引用）或 path（本地图片绝对路径）之一");
    }

    const selected = useProviderStore.getState().selectedModel;
    if (selected && !modelSupportsVision(selected.providerId, selected.modelId)) {
      return errorText(
        `当前模型（${selected.modelName || selected.modelId}）不支持图片输入。请切换到视觉模型后再看图片，或只基于图注/正文回答并说明未看图。`,
      );
    }

    if (target.startsWith("attachment://")) {
      const loaded = await readImageAttachment(target);
      if (!loaded) {
        return errorText(`图片附件不存在或已被清理：${target}`);
      }
      return {
        type: "content" as const,
        value: [
          { type: "text" as const, text: `图片 ${target}（已从附件库取回，请基于图片内容回答）：` },
          { type: "file" as const, mediaType: loaded.mediaType, url: loaded.dataUrl },
        ],
      };
    }

    const isAbsolute = /^[A-Za-z]:[\\/]/.test(target) || target.startsWith("/");
    if (!isAbsolute) {
      return errorText(
        "需要绝对路径（例如 getFigures 返回的 image_path），不要把 Markdown 里的 images/xxx.png 直接传来",
      );
    }
    try {
      await assertAllowedPath(target);
    } catch (error) {
      return errorText(error instanceof Error ? error.message : String(error));
    }
    try {
      const loaded = await loadLocalImageAsDataUrl(target, { maxEdge });
      return {
        type: "content" as const,
        value: [
          {
            type: "text" as const,
            text: imageEnvelope({
              label: target,
              mediaType: loaded.mediaType,
              width: loaded.width,
              height: loaded.height,
              bytes: loaded.bytes,
              downscaled: loaded.downscaled,
            }),
          },
          { type: "file" as const, mediaType: loaded.mediaType, url: loaded.dataUrl },
        ],
      };
    } catch (error) {
      return errorText(`读取图片失败：${error instanceof Error ? error.message : String(error)}`);
    }
  },
});

export { MAX_IMAGE_BYTES, MAX_IMAGE_EDGE };

export default readImageTool;
