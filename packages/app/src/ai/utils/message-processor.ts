import type { UIMessage } from "@ai-sdk/react";
import { sanitizeLegacyMcpHistoryOutput } from "./tool-result-slimming";

export interface AdaptToolHistoryOptions {
  directoryMode: boolean;
  /** 当前真实工具面（非 directory 的 describeTool/useTool 壳），只用于判断能否安全改写名称 */
  tools: Record<string, unknown>;
}

function historyToolName(part: any): string | null {
  if (part?.type === "dynamic-tool") return typeof part.toolName === "string" ? part.toolName : null;
  if (typeof part?.type === "string" && part.type.startsWith("tool-")) return part.type.slice("tool-".length);
  return null;
}

function hasTool(tools: Record<string, unknown>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(tools, name);
}

function renameHistoryTool(part: any, name: string): any {
  return part.type === "dynamic-tool" ? { ...part, toolName: name } : { ...part, type: `tool-${name}` };
}

/**
 * 请求副本的 direct↔directory 适配。AI SDK 7.0.148 不会因未知历史工具名直接拒绝转换，
 * 因此不再按当前工具面删除 part；只有能确认目标存在时才改名称/入参，output、审批与元数据原样保留。
 */
export function adaptToolHistoryForRequest(
  messages: UIMessage[],
  { directoryMode, tools }: AdaptToolHistoryOptions,
): UIMessage[] {
  let touched = false;
  const adapted = messages.map((message) => {
    if (!Array.isArray(message.parts)) return message;
    let messageTouched = false;
    const parts = (message.parts as any[]).map((part) => {
      const name = historyToolName(part);
      if (!name) return part;
      if (directoryMode) {
        if (name === "describeTool" || name === "useTool" || !hasTool(tools, name)) return part;
        messageTouched = true;
        return { ...renameHistoryTool(part, "useTool"), input: { tool: name, args: part.input } };
      }
      if (name !== "useTool") return part;
      const forwarded = typeof part.input?.tool === "string" ? part.input.tool : null;
      if (!forwarded || !hasTool(tools, forwarded)) return part;
      messageTouched = true;
      return { ...renameHistoryTool(part, forwarded), input: part.input.args };
    });
    if (!messageTouched) return message;
    touched = true;
    return { ...message, parts } as UIMessage;
  });
  return touched ? adapted : messages;
}

/**
 * dynamic:false 会让 SDK 对缺失工具使用 output-omitted 文案。仅为历史转换补空 stub，
 * 让默认 text/json 转换保留原 output；调用方不得把返回的扩展工具面传给 streamText/provider。
 */
export function withUnavailableDynamicHistoryStubs<T extends Record<string, unknown>>(
  messages: UIMessage[],
  tools: T,
): T {
  let conversionTools: Record<string, unknown> | null = null;
  for (const message of messages) {
    if (!Array.isArray(message.parts)) continue;
    for (const part of message.parts as any[]) {
      if (part?.type !== "dynamic-tool" || part.dynamic !== false || typeof part.toolName !== "string") continue;
      const name = part.toolName;
      if (!name || hasTool(tools, name)) continue;
      conversionTools ??= { ...tools };
      if (!hasTool(conversionTools, name)) {
        Object.defineProperty(conversionTools, name, {
          value: {},
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
    }
  }
  return (conversionTools ?? tools) as T;
}

/** 仅处理请求开始时快照里的 MCP output；不当场改写 UI/DB，也不影响之后产生的 live 工具结果 */
export function sanitizeLegacyMcpHistoryImages(messages: UIMessage[]): UIMessage[] {
  let touched = false;
  const sanitized = messages.map((message) => {
    if (!Array.isArray(message.parts)) return message;
    let messageTouched = false;
    const parts = (message.parts as any[]).map((part) => {
      const name = historyToolName(part);
      const forwarded = name === "useTool" && typeof part.input?.tool === "string" ? part.input.tool : null;
      const isMcp = name?.startsWith("mcp_") || forwarded?.startsWith("mcp_");
      if (!isMcp || part.output == null) return part;
      const stripped = sanitizeLegacyMcpHistoryOutput(part.output);
      if (!stripped) return part;
      messageTouched = true;
      return { ...part, output: stripped.output };
    });
    if (!messageTouched) return message;
    touched = true;
    return { ...message, parts } as UIMessage;
  });
  return touched ? sanitized : messages;
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
