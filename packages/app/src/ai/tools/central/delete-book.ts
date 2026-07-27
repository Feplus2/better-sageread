/**
 * 全局助手工具：删除书籍（移入回收站）
 */
import { deleteBook } from "@/services/book-service";
import type { BookQueryOptions, BookWithStatus, SimpleBook } from "@/types/simple-book";
import { invoke } from "@tauri-apps/api/core";
import { tool } from "ai";
import { z } from "zod";

export const deleteBookTool = tool({
  description: `删除书籍，将其移入回收站（可恢复）。

⚠️ **危险操作**：调用前应先通过 getBooks 确认目标书籍，并向用户确认。

🎯 **核心功能**：
• 按书籍 ID 精确删除
• 书籍会被移入回收站，用户可在回收站中恢复

📊 **返回内容**：
删除操作结果`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因，应包含用户确认信息"),
    bookId: z.string().min(1).describe("要删除的书籍 ID"),
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

      // 执行删除（软删除，移入回收站）
      await deleteBook(bookId);

      return {
        results: {
          success: true,
          message: `已将《${book.title}》移入回收站`,
          deletedBook: {
            id: book.id,
            title: book.title,
            author: book.author,
          },
        },
        meta: { reasoning, bookId, bookTitle },
      };
    } catch (error) {
      throw new Error(`删除书籍失败: ${error instanceof Error ? error.message : "未知错误"}`);
    }
  },
});
