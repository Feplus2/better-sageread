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

export function processQuoteMessages(messages: UIMessage[]): UIMessage[] {
  return messages.map((message) => {
    if (message.role === "user" && Array.isArray(message.parts)) {
      const quoteParts = message.parts.filter((part: any) => part.type === "quote");
      const textParts = message.parts.filter((part: any) => part.type === "text");

      if (quoteParts.length > 0) {
        const quotesText = quoteParts
          .map((part: any, index: number) => {
            const normalized = part.text.replace(/\s+$/g, "");
            const quoted = normalized.replace(/\n/g, "\n> ");
            return `${part.source || `引用${index + 1}`}：\n> ${quoted}`;
          })
          .join("\n\n");

        const userText = textParts.map((part: any) => part.text).join("");
        const combinedText = `${quotesText}\n\n${userText}`.trim();

        return {
          ...message,
          parts: [{ type: "text", text: combinedText } as any],
        } as UIMessage;
      }
    }
    return message;
  });
}
