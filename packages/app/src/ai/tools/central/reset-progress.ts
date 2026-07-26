/**
 * 中央 Agent 工具：重置阅读进度
 */
import { updateBookStatus } from "@/services/book-service";
import type { BookQueryOptions, BookWithStatus, SimpleBook } from "@/types/simple-book";
import { invoke } from "@tauri-apps/api/core";
import { tool } from "ai";
import { z } from "zod";

export const resetProgressTool = tool({
  description: `重置书籍的阅读进度。

⚠️ **危险操作**：此操作会清除阅读进度，调用前应先向用户确认。

🎯 **核心功能**：
• 重置单本书的阅读进度
• 将状态设为"未读"
• 清除阅读位置信息

📊 **返回内容**：
重置操作结果`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因，应包含用户确认信息"),
    bookId: z.string().min(1).describe("要重置进度的书籍 ID"),
    bookTitle: z.string().optional().describe("书籍标题（用于日志记录）"),
  }),

  execute: async ({
    reasoning,
    bookId,
    bookTitle,
  }: {
    reasoning: string;
    bookId: string;
    bookTitle?: string;
  }) => {
    try {
      // 先验证书籍是否存在
      const book = await invoke<SimpleBook | null>("get_book_by_id", { id: bookId });
      if (!book) {
        return {
          results: {
            success: false,
            message: `未找到 ID 为 "${bookId}" 的书籍`,
          },
          meta: { reasoning, bookId },
        };
      }

      // 重置进度
      await updateBookStatus(bookId, {
        status: "unread",
        progressCurrent: 0,
        location: "",
        lastReadAt: undefined,
        startedAt: undefined,
        completedAt: undefined,
      });

      return {
        results: {
          success: true,
          message: `已重置《${book.title}》的阅读进度`,
          resetBook: {
            id: book.id,
            title: book.title,
            author: book.author,
          },
        },
        meta: { reasoning, bookId, bookTitle },
      };
    } catch (error) {
      throw new Error(`重置阅读进度失败: ${error instanceof Error ? error.message : "未知错误"}`);
    }
  },
});
