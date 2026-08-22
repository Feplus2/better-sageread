import { readImageAttachment } from "@/services/attachment-service";
import { tool } from "ai";
import { z } from "zod";

/**
 * D4 图片一次性：按引用重看已分析的图片附件。
 * 图片只在出现的那一轮真发（更早轮次在请求组装时降级为 ⟦图片…可用 readImage 重看⟧ 存根），
 * 模型需要再看图时用本工具按 attachment:// 引用取回（工具结果以 file part 返回，v7 原生支持）。
 */
export const readImageTool = tool({
  description: `重看聊天里已分析过的图片附件。
输入为图片存根或历史消息里的 attachment:// 引用（形如 attachment://img-xxx.png）。
返回图片本体（多模态通道）；文件已被清理时返回提示。仅对图片附件有效。`,
  inputSchema: z.object({
    ref: z.string().min(1).describe("图片引用，形如 attachment://img-xxx.png"),
  }),
  execute: async ({ ref }: { ref: string }) => {
    const loaded = await readImageAttachment(ref);
    if (!loaded) {
      return {
        type: "error-text" as const,
        value: `图片附件不存在或已被清理：${ref}`,
      };
    }
    return {
      type: "content" as const,
      value: [
        {
          type: "text" as const,
          text: `图片 ${ref}（已从附件库取回，请基于图片内容回答）：`,
        },
        {
          type: "file" as const,
          mediaType: loaded.mediaType,
          url: loaded.dataUrl,
        },
      ],
    };
  },
});

export default readImageTool;
