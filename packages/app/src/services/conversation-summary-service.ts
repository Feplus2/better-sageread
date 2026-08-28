import { createUtilityModelInstance, getUtilityModel, utilityTaskProviderOptions } from "@/ai/providers/factory";
import { type SummaryScope, buildScopedSummaryPrompt } from "@/ai/utils/summary-templates";
import { recordAuxUsage } from "@/services/ai-usage-service";
import { editThread, getThreadById } from "@/services/thread-service";
import type { Thread } from "@/types/thread";
import { type UIMessage, generateText } from "ai";

/**
 * 对话滚动压缩：上下文超预算时，把被裁掉的旧消息增量滚成摘要存进 thread.metadata，
 * 下一轮请求由 transport 注入 system prompt（见 custom-chat-transport.ts）。
 * 配额（2026-08-05 拍板）：摘要 ≤2000 字，转录单条截 2000 字、总长截 5 万字。
 */

export interface ConversationSummaryState {
  text: string;
  /** 已纳入摘要的消息条数（按消息数组前缀计） */
  coveredCount: number;
  /** 覆盖的最后一条消息 id，用于对齐校验（重生成/删消息时对不上则从头重滚） */
  lastCoveredMessageId?: string;
  updatedAt: number;
}

const METADATA_KEY = "conversationSummary";
const SUMMARY_CHAR_LIMIT = 2000;
const PER_MESSAGE_CHAR_CAP = 2000;
const TRANSCRIPT_CHAR_CAP = 50_000;

export function getConversationSummary(thread: Thread): ConversationSummaryState | null {
  try {
    const metadata = JSON.parse(thread.metadata);
    const state = metadata?.[METADATA_KEY];
    if (state && typeof state.text === "string" && typeof state.coveredCount === "number") {
      return state as ConversationSummaryState;
    }
    return null;
  } catch {
    return null;
  }
}

async function saveConversationSummary(threadId: string, state: ConversationSummaryState): Promise<void> {
  const thread = await getThreadById(threadId);
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(thread.metadata);
  } catch {
    metadata = {};
  }
  metadata[METADATA_KEY] = state;
  await editThread(threadId, { metadata });
}

/** 提取消息文本：正文 + tool 调用标记（摘要知道调过哪些工具即可，不需完整结果） */
function extractMessageText(message: UIMessage): string {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  return parts
    .map((part: any) => {
      if (part?.type === "text") return part.text;
      if (typeof part?.type === "string" && part.type.startsWith("tool-")) {
        return `[调用工具 ${part.type.slice(5)}]`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** 格式化转录：角色标注、单条截 2000 字、总长超 5 万字时中间省略 */
function formatTranscript(messages: UIMessage[]): string {
  const lines = messages.map((m) => {
    const role = m.role === "user" ? "用户" : m.role === "assistant" ? "助手" : m.role;
    const text = extractMessageText(m).slice(0, PER_MESSAGE_CHAR_CAP);
    return `${role}：${text}`;
  });

  const total = lines.reduce((sum, line) => sum + line.length, 0);
  if (total <= TRANSCRIPT_CHAR_CAP) return lines.join("\n\n");

  // 中间省略：保留首尾各一半预算
  const half = Math.floor(TRANSCRIPT_CHAR_CAP / 2);
  const head: string[] = [];
  const tail: string[] = [];
  let headSize = 0;
  let tailSize = 0;
  for (const line of lines) {
    if (headSize + line.length > half) break;
    head.push(line);
    headSize += line.length;
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    if (tailSize + lines[i].length > half) break;
    tail.unshift(lines[i]);
    tailSize += lines[i].length;
  }
  const omitted = lines.length - head.length - tail.length;
  return [...head, `……（中间省略 ${omitted} 条）……`, ...tail].join("\n\n");
}

/**
 * 把本轮被预算裁掉的消息前缀增量滚入摘要，返回应注入的摘要文本。
 * 已覆盖无新增 → 返回既有摘要；压缩失败 → 返回既有摘要（或 null）；全程不阻断聊天。
 */
export async function compressDroppedIntoSummary(params: {
  threadId: string;
  dropped: UIMessage[];
  /** D7 分 scope 结构化：三助手各自的固定小节模板；缺省 reader */
  agentScope?: SummaryScope;
}): Promise<string | null> {
  const { threadId, dropped, agentScope = "reader" } = params;
  if (dropped.length === 0) return null;

  try {
    const thread = await getThreadById(threadId);
    const state = getConversationSummary(thread);

    // 对齐校验：覆盖计数与消息 id 对得上才增量，否则从头重滚
    const aligned =
      state &&
      state.coveredCount > 0 &&
      state.coveredCount <= dropped.length &&
      (!state.lastCoveredMessageId || dropped[state.coveredCount - 1]?.id === state.lastCoveredMessageId);

    const existingText = aligned ? state.text : undefined;
    const newlyDropped = aligned ? dropped.slice(state.coveredCount) : dropped;

    if (newlyDropped.length === 0) {
      return existingText ?? null;
    }

    const utilityModel = getUtilityModel();
    if (!utilityModel) {
      console.warn("[滚动压缩] 无可用辅助模型，跳过压缩");
      return existingText ?? null;
    }

    const modelInstance = createUtilityModelInstance(utilityModel.providerId, utilityModel.modelId);

    let text: string;
    try {
      const result = await generateText({
        model: modelInstance,
        prompt: buildScopedSummaryPrompt({
          scope: agentScope,
          existingText,
          transcript: formatTranscript(newlyDropped),
          charLimit: SUMMARY_CHAR_LIMIT,
        }),
        maxOutputTokens: 4000,
        temperature: 0.3,
        providerOptions: utilityTaskProviderOptions(utilityModel.providerId, utilityModel.modelId),
      });
      text = result.text;
      recordAuxUsage(utilityModel.providerId, utilityModel.modelId, result.usage, "summary");
    } catch (error) {
      // AI 调用失败：沿用既有摘要（下轮有新 dropped 时会重试）
      console.warn("[滚动压缩] 辅助模型调用失败，沿用既有摘要:", error);
      return existingText ?? null;
    }

    const summaryText = text.trim().slice(0, SUMMARY_CHAR_LIMIT * 2);
    if (!summaryText) {
      console.warn("[滚动压缩] 辅助模型返回空，沿用既有摘要");
      return existingText ?? null;
    }

    const newState: ConversationSummaryState = {
      text: summaryText,
      coveredCount: dropped.length,
      lastCoveredMessageId: dropped[dropped.length - 1]?.id,
      updatedAt: Date.now(),
    };

    try {
      await saveConversationSummary(threadId, newState);
    } catch (error) {
      // 保存失败不丢本轮摘要（下一轮会对不上计数而重滚，可接受）
      console.warn("[滚动压缩] 摘要写回 thread.metadata 失败:", error);
    }

    console.log("🗜️ [滚动压缩] 已更新对话摘要:", {
      newlyCompressed: newlyDropped.length,
      coveredCount: newState.coveredCount,
      summaryLength: summaryText.length,
    });

    return summaryText;
  } catch (error) {
    console.warn("[滚动压缩] 压缩失败，本轮不注入摘要:", error);
    return null;
  }
}
