/**
 * 全局助手工具：回收站管理（恢复/彻底删除书籍）
 */
import { getTrashedBooks, purgeBook, restoreBook } from "@/services/book-service";
import { tool } from "ai";
import { z } from "zod";

export const trashManagerTool = tool({
  description: `管理回收站中的书籍：查看、恢复、彻底删除、清空回收站。

🎯 **核心功能**：
• list：查看回收站中的书籍
• restore：恢复书籍到书库
• purge：彻底删除单本书籍（不可恢复！）
• empty：清空回收站（彻底删除所有书籍，不可恢复！）

⚠️ **危险操作**：purge/empty 会永久删除书籍文件和所有关联数据，调用前必须向用户确认

📊 **返回内容**：
操作结果`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因，purge/empty 操作应包含用户确认信息"),
    action: z.enum(["list", "restore", "purge", "empty"]).describe("操作类型"),
    bookId: z.string().optional().describe("书籍 ID（restore/purge 时需要）"),
  }),

  execute: async ({
    reasoning,
    action,
    bookId,
  }: {
    reasoning: string;
    action: "list" | "restore" | "purge" | "empty";
    bookId?: string;
  }) => {
    try {
      // ==================== 查看回收站 ====================
      if (action === "list") {
        const books = await getTrashedBooks();
        return {
          results: {
            success: true,
            message: books.length > 0 ? `回收站中有 ${books.length} 本书` : "回收站为空",
            trashedBooks: books.map((b) => ({ id: b.id, title: b.title, author: b.author })),
          },
          meta: { reasoning },
        };
      }

      // ==================== 清空回收站 ====================
      if (action === "empty") {
        const allTrashed = await getTrashedBooks();
        if (allTrashed.length === 0) {
          return {
            results: { success: true, message: "回收站已经是空的" },
            meta: { reasoning },
          };
        }

        let successCount = 0;
        let failCount = 0;
        for (const b of allTrashed) {
          try {
            await purgeBook(b.id);
            successCount++;
          } catch (e) {
            console.warn(`彻底删除《${b.title}》失败:`, e);
            failCount++;
          }
        }

        return {
          results: {
            success: failCount === 0,
            message: `回收站已清空：彻底删除 ${successCount} 本书${failCount > 0 ? `，${failCount} 本失败` : ""}`,
            purgedCount: successCount,
            failedCount: failCount,
          },
          meta: { reasoning },
        };
      }

      // restore / purge 需要 bookId
      if (!bookId) {
        return {
          results: {
            success: false,
            message: `${action === "restore" ? "恢复" : "彻底删除"}书籍需要提供 bookId 参数`,
          },
          meta: { reasoning },
        };
      }

      // 验证书籍在回收站中
      const trashedBooks = await getTrashedBooks();
      const book = trashedBooks.find((b) => b.id === bookId);
      if (!book) {
        return {
          results: {
            success: false,
            message: `回收站中未找到 ID 为 "${bookId}" 的书籍`,
            trashedBooks: trashedBooks.map((b) => ({ id: b.id, title: b.title })),
          },
          meta: { reasoning, bookId },
        };
      }

      // ==================== 恢复 ====================
      if (action === "restore") {
        await restoreBook(bookId);
        return {
          results: {
            success: true,
            message: `《${book.title}》已恢复到书库`,
            restoredBook: { id: book.id, title: book.title },
          },
          meta: { reasoning, bookId },
        };
      }

      // ==================== 彻底删除 ====================
      await purgeBook(bookId);
      return {
        results: {
          success: true,
          message: `《${book.title}》已彻底删除（文件及所有关联数据已永久移除）`,
          purgedBook: { id: book.id, title: book.title },
        },
        meta: { reasoning, bookId },
      };
    } catch (error) {
      throw new Error(`回收站操作失败: ${error instanceof Error ? error.message : "未知错误"}`);
    }
  },
});
