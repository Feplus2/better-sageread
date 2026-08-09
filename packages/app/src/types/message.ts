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
