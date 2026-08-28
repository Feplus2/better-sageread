/**
 * 对话召回（shared 级上下文工厂，reader/paper/central 三 scope 注入）：
 * 把一条对话的全部用户/AI 问答读回模型上下文。
 *
 * 场景：长对话触发 token 活塞泄压后，早期消息不再进入请求——本工具从库读全量，
 * 天然绕过活塞（活塞只裁喂模型的内存副本，落库恒全量），供"整理本轮对话为笔记"
 * "回顾前面聊了什么"等任务使用。口径与导出对话一致：只保留 text/quote，
 * tool/reasoning 等过程性 part 不进入返回（工具结果体量大且可重取，召回无意义）。
 */
import { renderMessageMarkdown } from "@/lib/export-thread-markdown";
import { getThreadById } from "@/services/thread-service";
import type { UIMessage } from "@ai-sdk/react";
import { tool } from "ai";
import { z } from "zod";

/** 单次返回默认/上限（字符）。上限的职责是防单次请求撞 128k 档模型的上下文硬墙，不是省 token */
const DEFAULT_READ_CHARS = 100000;
const MAX_READ_CHARS = 400000;

/** 逐条渲染为问答流（与导出口径一致的角色标题；纯正文流，元信息走返回的 meta 字段） */
function buildDialogueText(messages: UIMessage[] | undefined): string {
  const lines: string[] = [];
  for (const message of messages ?? []) {
    const body = renderMessageMarkdown(message);
    if (!body) continue;
    lines.push(message.role === "user" ? "## 🧑 用户" : "## 🤖 AI", "", body, "");
  }
  return lines.join("\n");
}

export const createReadThreadTool = (scopeThreadId: string | undefined) =>
  tool({
    description: `读回一条对话的完整问答记录（仅用户提问与 AI 回答，不含工具调用结果）。

🎯 **使用场景**：
• 对话被上下文压缩截断后，需要回顾/引用早期内容（"我们前面聊了什么"）
• 用户要求整理或总结本次对话（存笔记、写成文档）——被截断的早期部分必须先读回，不能只凭残存上下文

💡 **使用建议**：
• 不带 threadId 默认读当前对话（本次聊天）
• 默认返回 100000 字符；超长对话标注 totalChars 与 truncated，用 offset 续读
• 全局助手里要读其他对话：先用 manageThreads 的 list/search 拿 threadId 再指定`,
    inputSchema: z.object({
      reasoning: z
        .string()
        .min(1)
        .describe("调用此工具的原因和目的，例如：'用户要求整理本次对话为笔记，需读回被截断的早期问答'"),
      threadId: z.string().optional().describe("目标对话 ID（缺省=当前对话）"),
      maxChars: z
        .number()
        .int()
        .min(1000)
        .max(MAX_READ_CHARS)
        .optional()
        .describe(`返回字符上限（默认 ${DEFAULT_READ_CHARS}，上限 ${MAX_READ_CHARS}）`),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("从第几个字符开始返回（续读用，默认 0；截断提示里会给出下一次的 offset 值）"),
    }),
    execute: async ({
      reasoning,
      threadId,
      maxChars,
      offset,
    }: {
      reasoning: string;
      threadId?: string;
      maxChars?: number;
      offset?: number;
    }) => {
      const targetId = threadId ?? scopeThreadId;
      if (!targetId) {
        throw new Error("当前没有进行中的对话，也未指定 threadId（全局助手里可先用 manageThreads 的 list/search 查）");
      }

      const thread = await getThreadById(targetId);
      if (!thread) {
        throw new Error(`未找到对话 ${targetId}`);
      }

      const full = buildDialogueText(thread.messages);
      const start = Math.min(offset ?? 0, full.length);
      const limit = maxChars ?? DEFAULT_READ_CHARS;
      const slice = full.slice(start, start + limit);
      const end = start + slice.length;
      const truncated = end < full.length;

      return {
        title: thread.title || "未命名对话",
        scope: threadId ? "指定对话" : "当前对话",
        content: truncated
          ? `${slice}\n\n……（对话过长，已截断，完整长度 ${full.length} 字符；用 offset ${end} 续读，或调大 maxChars）`
          : slice,
        totalChars: full.length,
        messageCount: thread.messages?.length ?? 0,
        offset: start,
        truncated,
        meta: {
          reasoning,
          note: "仅含用户/AI 问答；流式回复中的最后一条消息可能尚未落库，不含在内",
        },
      };
    },
  });
