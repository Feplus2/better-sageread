/**
 * 全局助手工具：对话管理（列表/标星/取消标星/改名/删除）
 *
 * 配合 getThreads（搜索对话）使用：先搜到目标对话的 ID，再执行管理动作
 */
import { deleteThread, editThread, getAllThreads } from "@/services/thread-service";
import type { ThreadSummary } from "@/types/thread";
import { tool } from "ai";
import { z } from "zod";

function summarize(t: ThreadSummary) {
  return {
    id: t.id,
    title: t.title,
    starred: t.starred,
    messageCount: t.message_count,
    scope: t.scope,
    updatedAt: new Date(t.updated_at).toISOString(),
  };
}

export const manageThreadsTool = tool({
  description: `管理对话记录：列出、标星、取消标星、改名、删除。

🎯 **核心功能**：
• action=list：列出全部对话（可按关键词过滤标题、只看星标）
• action=star / unstar：标星 / 取消标星（需要 threadId）
• action=rename：重命名对话（需要 threadId + newTitle）
• action=delete：删除对话（需要 threadId；⚠️ 不可恢复，必须先向用户确认）

📋 **前提条件**：知道目标对话的 threadId；不确定时先 action=list 或用 getThreads 搜索

📊 **返回内容**：
操作结果；list 返回对话摘要列表`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因"),
    action: z.enum(["list", "star", "unstar", "rename", "delete"]).describe("管理动作"),
    threadId: z.string().optional().describe("目标对话 ID（list 以外的动作必填）"),
    newTitle: z.string().optional().describe("新标题（action=rename 时必填）"),
    keyword: z.string().optional().describe("标题关键词过滤（action=list 时可选）"),
    starredOnly: z.boolean().default(false).describe("只看星标对话（action=list 时可选）"),
  }),

  execute: async ({
    reasoning,
    action,
    threadId,
    newTitle,
    keyword,
    starredOnly,
  }: {
    reasoning: string;
    action: "list" | "star" | "unstar" | "rename" | "delete";
    threadId?: string;
    newTitle?: string;
    keyword?: string;
    starredOnly: boolean;
  }) => {
    try {
      if (action === "list") {
        let threads = await getAllThreads();
        if (starredOnly) threads = threads.filter((t) => t.starred);
        if (keyword?.trim()) {
          const q = keyword.trim().toLowerCase();
          threads = threads.filter((t) => t.title.toLowerCase().includes(q));
        }
        return {
          results: {
            success: true,
            total: threads.length,
            threads: threads.map(summarize),
          },
          meta: { reasoning, keyword, starredOnly },
        };
      }

      if (!threadId) {
        return {
          results: { success: false, message: `action=${action} 需要提供 threadId` },
          meta: { reasoning },
        };
      }

      switch (action) {
        case "star":
        case "unstar": {
          const starred = action === "star";
          const updated = await editThread(threadId, { starred });
          return {
            results: { success: true, message: `已${starred ? "标星" : "取消标星"}对话「${updated.title}」` },
            meta: { reasoning, threadId },
          };
        }
        case "rename": {
          if (!newTitle?.trim()) {
            return {
              results: { success: false, message: "action=rename 需要提供 newTitle" },
              meta: { reasoning, threadId },
            };
          }
          const updated = await editThread(threadId, { title: newTitle.trim() });
          return {
            results: { success: true, message: `对话已改名为「${updated.title}」` },
            meta: { reasoning, threadId },
          };
        }
        case "delete": {
          await deleteThread(threadId);
          return {
            results: { success: true, message: "对话已删除" },
            meta: { reasoning, threadId },
          };
        }
      }
    } catch (error) {
      throw new Error(`对话管理失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
});
