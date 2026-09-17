import type { ReasoningTimes } from "@/hooks/use-reasoning-timer";
import type { SelectedModel } from "@/store/provider-store";
import type { UIMessage } from "ai";

export interface ChatReference {
  id: string;
  text: string;
  /** K2：内联引用标记序号（输入区插入 ⟦引用N⟧ 占位，提交时按位置展开为 quote part） */
  markerNum?: number;
}

/** J2：输入区附带的图片（base64 随消息 file part 落库；⟦图片N⟧ 标记内联定位） */
export interface ImageAttachment {
  id: string;
  markerNum: number;
  dataUrl: string;
  mediaType: string;
  name: string;
}

/** 通用文件附件（⟦文件N⟧ 标记内联定位）：
 * inline = 小文本内容直接注入消息（content 随消息落库）；
 * ref = 已复制到 attachments/ 登记路径（content 为空，Agent 用工具按需读取） */
export interface FileAttachment {
  id: string;
  markerNum: number;
  name: string;
  /** 字节数（UI 展示与 Agent 提示） */
  size: number;
  mode: "inline" | "ref";
  /** inline 模式的文本内容（ref 模式为空串） */
  content: string;
  /** ref 模式：attachment:// 引用（可解出 attachments/ 内绝对路径） */
  attachmentRef?: string;
  /** ref 模式：attachments/ 内绝对路径（登记给 Agent 用工具读取；MarkItDown 转换件指向 .md） */
  absPath?: string;
  /** MarkItDown 转换件的原始文件绝对路径（Agent 需要原文时用） */
  origPath?: string;
  /** 处理引擎标识（chip 与消息文案用，如 "MarkItDown"） */
  via?: string;
  /** 异常备注："empty" = 提取为空（扫描件特征）；其余为失败原因 */
  note?: string;
}

/**
 * Extended metadata interface for UIMessage
 * Includes custom fields for our application
 */
export interface MessageMetadata {
  // Provider information
  provider?: SelectedModel | null;
  selectedModel?: SelectedModel | null;

  // Timestamps
  createdAt?: number;
  updatedAt?: number;

  // Usage information
  totalUsage?: {
    totalTokens: number;
    promptTokens?: number;
    completionTokens?: number;
  };

  // Reasoning timing data
  reasoningTimes?: ReasoningTimes;

  // User supplied references for the prompt
  references?: ChatReference[];
}

/**
 * Extended UIMessage with typed metadata
 */
export interface ExtendedUIMessage extends Omit<UIMessage, "metadata"> {
  metadata?: MessageMetadata;
}

/**
 * Type guard to check if a message has reasoning times
 */
export function hasReasoningTimes(message: UIMessage): message is ExtendedUIMessage {
  if (!message || !message.metadata) {
    return false;
  }
  return !!(message.metadata as MessageMetadata)?.reasoningTimes;
}

/**
 * Helper function to get reasoning times from a message
 */
export function getReasoningTimes(message: UIMessage): ReasoningTimes | undefined {
  if (!message || !message.metadata) {
    return undefined;
  }
  return (message.metadata as MessageMetadata)?.reasoningTimes;
}

/**
 * Helper function to set reasoning times on a message
 */
export function setReasoningTimes(message: UIMessage, reasoningTimes: ReasoningTimes): ExtendedUIMessage {
  return {
    ...message,
    metadata: {
      ...((message?.metadata as MessageMetadata) || {}),
      reasoningTimes,
    },
  };
}

/**
 * Helper function to create a new message metadata object
 */
export function createMessageMetadata(
  provider?: SelectedModel | null,
  reasoningTimes?: ReasoningTimes,
  totalUsage?: MessageMetadata["totalUsage"],
): MessageMetadata {
  return {
    provider,
    selectedModel: provider,
    createdAt: Math.floor(Date.now() / 1000),
    updatedAt: Math.floor(Date.now() / 1000),
    reasoningTimes,
    totalUsage,
  };
}
