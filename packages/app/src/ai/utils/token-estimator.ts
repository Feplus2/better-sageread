import type { UIMessage } from "@ai-sdk/react";

/** 单条消息的固定结构开销（role/分隔等），经验值 */
const MESSAGE_OVERHEAD_TOKENS = 8;
/** 单个 part 序列化计入估算的长度上限，防超大 tool 结果撑爆估算 */
const PART_TEXT_CAP = 10_000;

// CJK 统一表意文字（U+4E00-U+9FFF、扩展A U+3400-U+4DBF、兼容区 U+F900-U+FAFF）
// + 日文假名（U+3040-U+30FF）+ 韩文音节（U+AC00-U+D7A3）
const CJK_RE = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힣]/g;

/**
 * 粗估文本 token 数：CJK 字符按 ≈1 token/字，其余按 ≈1 token/4 字符。
 * 用于上下文窗口预算选择，不求精确，只求量级正确且单调。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjkCount = (text.match(CJK_RE) || []).length;
  const otherCount = text.length - cjkCount;
  return Math.ceil(cjkCount + otherCount / 4);
}

/** 提取单个 part 参与估算的文本（tool 部分序列化其输入/输出） */
function extractPartText(part: unknown): string {
  if (!part || typeof part !== "object") return "";
  const p = part as Record<string, unknown>;
  if (typeof p.text === "string") return p.text.slice(0, PART_TEXT_CAP);
  // tool-* parts：输入/输出才是大头
  if (typeof p.type === "string" && p.type.startsWith("tool-")) {
    try {
      return JSON.stringify({ input: p.input, output: p.output }).slice(0, PART_TEXT_CAP);
    } catch {
      return "";
    }
  }
  return "";
}

/** 估算单条消息的 token 占用（含固定结构开销） */
export function estimateMessageTokens(message: UIMessage): number {
  let tokens = MESSAGE_OVERHEAD_TOKENS;
  const parts = Array.isArray(message.parts) ? message.parts : [];
  for (const part of parts) {
    tokens += estimateTokens(extractPartText(part));
  }
  return tokens;
}

/** 估算整段消息列表的 token 占用 */
export function estimateMessagesTokens(messages: UIMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += estimateMessageTokens(message);
  }
  return total;
}
