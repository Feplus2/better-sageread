import type { UIMessage } from "@ai-sdk/react";

/**
 * 兼容层：剔除引用已下线工具的 tool part。
 *
 * convertToModelMessages 遇到工具名不在当前 tools 中的 tool part 会抛
 * TypeValidationError: No tool schema found for tool part <name>；
 * 旧对话历史里残留已下线工具（如 deleteBook）的 part 会把整个聊天炸掉，
 * 因此在转换前过滤：未知工具的 part 剔除，过滤后 parts 为空的消息整条丢弃。
 */
export function stripUnknownToolParts(messages: UIMessage[], tools: Record<string, unknown>): UIMessage[] {
  return messages
    .map((message) => {
      if (!Array.isArray(message.parts)) return message;
      const parts = message.parts.filter((part: any) => {
        if (typeof part?.type === "string" && part.type.startsWith("tool-")) {
          return part.type.slice("tool-".length) in tools;
        }
        return true;
      });
      return { ...message, parts } as UIMessage;
    })
    .filter((message) => !Array.isArray(message.parts) || message.parts.length > 0);
}

/**
 * 转换前 parts 合法化（2026-08-07 修复 Invalid prompt 报错）：
 * 用户中途停止/异常中断会留下 text 为 undefined 的 reasoning/text part，
 * convertToModelMessages 原样透传后 zod 按 text:z.string() 校验失败，
 * 抛 "The messages must be a ModelMessage[]"；这里归一为空串。
 */
export function sanitizeMessageParts(messages: UIMessage[]): UIMessage[] {
  return messages.map((message) => {
    if (!Array.isArray(message.parts)) return message;
    const parts = message.parts
      .filter((part: any) => part != null && typeof part.type === "string")
      .map((part: any) => {
        if ((part.type === "reasoning" || part.type === "text") && typeof part.text !== "string") {
          return { ...part, text: part.text == null ? "" : String(part.text) };
        }
        return part;
      });
    return { ...message, parts } as UIMessage;
  });
}

export function processQuoteMessages(messages: UIMessage[]): UIMessage[] {
  return messages.map((message) => {
    if (message.role !== "user" || !Array.isArray(message.parts)) return message;
    if (!(message.parts as any[]).some((part: any) => part.type === "quote")) return message;

    // K2：严格按 parts 原有顺序拼装，保留用户把引用插在正文任意位置的指代关系
    //（旧版把全部引用堆在正文最前，多条引用时指代不清）
    const segments: string[] = [];
    let quoteIndex = 0;
    for (const part of message.parts as any[]) {
      if (part.type === "quote") {
        quoteIndex += 1;
        const normalized = String(part.text ?? "").replace(/\s+$/g, "");
        const quoted = normalized.replace(/\n/g, "\n> ");
        segments.push(`${part.source || `引用${quoteIndex}`}：\n> ${quoted}`);
      } else if (part.type === "text" && part.text) {
        segments.push(part.text);
      }
    }

    return {
      ...message,
      parts: [{ type: "text", text: segments.join("\n\n").trim() } as any],
    } as UIMessage;
  });
}

/**
 * J2：剔除所有消息里的 file part（图片等）。
 * 当前模型不支持多模态时在 transport 转换前调用：历史轮次的图片一并跳过，
 * 纯文本模型只是"看不到图"，绝不因图片内容报 API 错误。
 */
export function stripFileParts(messages: UIMessage[]): UIMessage[] {
  return messages
    .map((message) => {
      if (!Array.isArray(message.parts)) return message;
      if (!(message.parts as any[]).some((part: any) => part.type === "file")) return message;
      const parts = (message.parts as any[]).filter((part: any) => part.type !== "file");
      return { ...message, parts } as UIMessage;
    })
    .filter((message) => !Array.isArray(message.parts) || message.parts.length > 0);
}

/**
 * D4 图片一次性（请求期，只改副本不动存量消息）：
 * - 仅**最后一条 user 消息**的图片 part 真发（attachment:// 引用从盘物化为 dataUrl；存量 dataUrl 原样）；
 * - 更早轮次的图片 part 降级为文字存根（attachment:// 与存量 dataUrl 同等处理）——
 *   图片字节不再每轮重发重计费，模型需要重看时经 readImage 工具按引用取回。
 */
export async function resolveImageAttachmentsForRequest(messages: UIMessage[]): Promise<UIMessage[]> {
  const lastUserIndex = messages.findLastIndex((msg) => msg.role === "user");
  if (lastUserIndex === -1) return messages;

  const out = messages.slice();
  for (let i = 0; i < out.length; i++) {
    const message = out[i];
    if (message.role !== "user" || !Array.isArray(message.parts)) continue;
    const parts = message.parts as any[];
    if (!parts.some((part: any) => part.type === "file")) continue;

    const isLastUser = i === lastUserIndex;
    const nextParts: any[] = [];
    for (const part of parts) {
      if (part?.type !== "file") {
        nextParts.push(part);
        continue;
      }
      const name = typeof part.filename === "string" && part.filename ? part.filename : "图片";
      const ref =
        typeof part.url === "string" && part.url.startsWith("attachment://") ? part.url : (part as any).attachmentRef;
      if (isLastUser) {
        if (ref) {
          try {
            const { readImageAttachment } = await import("@/services/attachment-service");
            const loaded = await readImageAttachment(ref);
            if (loaded) {
              nextParts.push({ ...part, url: loaded.dataUrl, mediaType: loaded.mediaType, attachmentRef: ref });
              continue;
            }
            // 落盘文件缺失（被清理）：透传原 part（引用对多数提供商不可见图，但不炸请求）
          } catch {
            // 物化链路异常（fs/权限等）：透传原 part，不让请求因缺图失败
          }
        }
        nextParts.push(part);
      } else {
        const refText = ref ?? "已失效";
        nextParts.push({
          type: "text",
          text: `⟦图片（${name}）：已分析过，可用 readImage 工具以引用 ${refText} 重看⟧`,
        });
      }
    }
    out[i] = { ...message, parts: nextParts } as UIMessage;
  }
  return out;
}
