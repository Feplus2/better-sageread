/**
 * 全局助手工具：查询/搜索对话记录
 */
import { getAllThreads, getThreadsBybookId } from "@/services/thread-service";
import { tool } from "ai";
import dayjs from "dayjs";
import { z } from "zod";

export const getThreadsTool = tool({
  description: `查询和搜索对话记录列表。

🎯 **核心功能**：
• 按标题关键词模糊搜索对话
• 筛选星标对话
• 按书籍筛选对话
• 获取对话 ID（用于导出、删除等后续操作）

📊 **返回内容**：
对话列表，包含 ID、标题、星标状态、消息数、更新时间`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因"),
    search: z.string().optional().describe("标题搜索关键词（模糊匹配）"),
    starredOnly: z.boolean().default(false).describe("是否仅返回星标对话"),
    bookId: z.string().optional().describe("按书籍 ID 筛选"),
    limit: z.number().int().min(1).max(100).default(20).describe("最多返回条数，默认20"),
  }),

  execute: async ({
    reasoning,
    search,
    starredOnly,
    bookId,
    limit,
  }: {
    reasoning: string;
    search?: string;
    starredOnly: boolean;
    bookId?: string;
    limit?: number;
  }) => {
    try {
      // 获取对话列表
      let threads = bookId ? await getThreadsBybookId(bookId) : await getAllThreads();

      // 按星标筛选
      if (starredOnly) {
        threads = threads.filter((t) => t.starred);
      }

      // 按标题关键词模糊匹配
      if (search?.trim()) {
        const keyword = search.trim().toLowerCase();
        threads = threads.filter((t) => (t.title || "").toLowerCase().includes(keyword));
      }

      // 限制数量
      const maxCount = limit || 20;
      const results = threads.slice(0, maxCount).map((t) => ({
        id: t.id,
        title: t.title || "未命名对话",
        starred: t.starred,
        messageCount: t.message_count,
        bookId: t.book_id,
        updatedAt: dayjs(t.updated_at).format("YYYY-MM-DD HH:mm:ss"),
      }));

      return {
        results: {
          total: threads.length,
          returned: results.length,
          threads: results,
        },
        meta: {
          reasoning,
          filters: { search: search ?? null, starredOnly, bookId: bookId ?? null, limit: maxCount },
        },
      };
    } catch (error) {
      throw new Error(`查询对话失败: ${error instanceof Error ? error.message : "未知错误"}`);
    }
  },
});
