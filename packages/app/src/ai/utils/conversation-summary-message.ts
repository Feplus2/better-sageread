/**
 * 前情摘要注入位置（2026-10-23）：从 system prompt 挪到"保留段第一条 user 消息"的前缀。
 *
 * 为什么：厂商的前缀缓存按"逐字节相同的前缀"计费；摘要放 system prompt 里，摘要一变，
 * 从 system 段起后面全部历史都按新价重算。放到切点（被裁历史与保留对话之间）后，
 * system prompt 与最近对话都不动，缓存只在摘要这一处断一次。
 *
 * 实现注意：Anthropic/OpenAI 的消息角色有交替约束，直接插一条独立 user 消息可能与
 * 保留段第一条 user 连续；因此把摘要合并进"第一条 user 消息"的文本前缀，语义等价、角色安全。
 */
import type { ModelMessage } from "ai";

const SUMMARY_PREAMBLE = "【前情摘要】";

export function buildSummaryBlock(summary: string): string {
  return `${SUMMARY_PREAMBLE}\n${summary}\n（以上为早期对话的压缩摘要，非原始记录）\n\n`;
}

/**
 * 把摘要合并到 messages 中第一条 user 消息的文本前缀。
 * - summary 为空：原数组引用返回（零改动）
 * - 找不到 user 消息（极罕见）：原数组返回，调用方自行兜底
 * - 字符串 content：前缀拼接；数组 content：在开头插一个 text part
 */
export function injectConversationSummary(messages: ModelMessage[], summary: string | null): ModelMessage[] {
  if (!summary || !summary.trim()) return messages;
  const index = messages.findIndex((message) => message.role === "user");
  if (index < 0) return messages;

  const block = buildSummaryBlock(summary.trim());
  const next = messages.slice();
  const target = next[index];
  const content = target.content;

  if (typeof content === "string") {
    next[index] = { ...target, content: block + content } as ModelMessage;
  } else if (Array.isArray(content)) {
    next[index] = {
      ...target,
      content: [{ type: "text", text: block }, ...content],
    } as ModelMessage;
  } else {
    next[index] = { ...target, content: block } as ModelMessage;
  }
  return next;
}
