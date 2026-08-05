/**
 * 全局助手工具：书籍管理（删除/打开/重置进度）
 *
 * 合并自原 deleteBook / openBook / resetProgress 三个工具，执行逻辑原样搬入
 */
import { deleteBook, updateBookStatus } from "@/services/book-service";
import { useLayoutStore } from "@/store/layout-store";
import type { BookQueryOptions, BookWithStatus, SimpleBook } from "@/types/simple-book";
import { invoke } from "@tauri-apps/api/core";
import { tool } from "ai";
import { z } from "zod";

export const manageBookTool = tool({
  description: `书籍管理：删除（移入回收站）、在阅读器中打开、重置阅读进度。

🎯 **核心功能**：
• action=delete：按书籍 ID 删除（软删除进回收站，可恢复）
• action=open：按书籍 ID 精确打开，或按书名模糊搜索后打开第一本匹配的书
• action=resetProgress：重置阅读进度（状态设为"未读"，清除阅读位置）

⚠️ **危险操作**：delete / resetProgress 调用前应先通过 getBooks 确认目标书籍，并向用户确认

📊 **返回内容**：
操作结果（删除/重置返回目标书籍信息；open 返回打开的书籍；多本匹配时返回其余候选）

⚠️ **什么时候别用**：
• 恢复或彻底删除回收站书籍——请用 trashManager
• 查询书籍列表——请用 getBooks`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因（delete/resetProgress 时应包含用户确认信息）"),
    action: z
      .enum(["delete", "open", "resetProgress"])
      .describe("delete=移入回收站, open=打开阅读, resetProgress=重置进度"),
    bookId: z.string().optional().describe("书籍 ID（delete/resetProgress 必填；open 时精确打开）"),
    bookTitle: z
      .string()
      .optional()
      .describe("书名关键词（open 时无 bookId 则模糊搜索后打开第一本；delete/resetProgress 仅用于日志记录）"),
  }),

  execute: async ({
    reasoning,
    action,
    bookId,
    bookTitle,
  }: {
    reasoning: string;
    action: "delete" | "open" | "resetProgress";
    bookId?: string;
    bookTitle?: string;
  }) => {
    try {
      // ==================== 删除（移入回收站） ====================
      if (action === "delete") {
        if (!bookId) {
          return {
            results: { success: false, message: "action=delete 需要提供 bookId" },
            meta: { reasoning },
          };
        }

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
      }

      // ==================== 重置阅读进度 ====================
      if (action === "resetProgress") {
        if (!bookId) {
          return {
            results: { success: false, message: "action=resetProgress 需要提供 bookId" },
            meta: { reasoning },
          };
        }

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
      }

      // ==================== 打开书籍 ====================
      let targetId = bookId;
      let targetTitle = "";

      // 如果没有 bookId，按书名搜索
      if (!targetId && bookTitle) {
        const options: BookQueryOptions = {
          searchQuery: bookTitle.trim(),
          limit: 5,
          sortBy: "updatedAt",
          sortOrder: "desc",
        };
        const books = await invoke<BookWithStatus[]>("get_books_with_status", { options });

        if (books.length === 0) {
          return {
            results: {
              success: false,
              message: `未找到书名包含「${bookTitle}」的书籍`,
            },
            meta: { reasoning, bookTitle },
          };
        }

        targetId = books[0].id;
        targetTitle = books[0].title;

        // 如果有多本匹配，告知用户
        if (books.length > 1) {
          const list = books.map((b) => `《${b.title}》`).join("、");
          return {
            results: {
              success: true,
              message: `找到多本匹配的书籍（${list}），已打开第一本《${targetTitle}》`,
              openedBook: { id: targetId, title: targetTitle },
              otherMatches: books.slice(1).map((b) => ({ id: b.id, title: b.title })),
            },
            meta: { reasoning, bookTitle },
          };
        }
      }

      if (!targetId) {
        return {
          results: {
            success: false,
            message: "请提供 bookId 或 bookTitle 参数",
          },
          meta: { reasoning },
        };
      }

      // 获取书名（如果还没有）
      if (!targetTitle) {
        const book = await invoke<{ title: string } | null>("get_book_by_id", { id: targetId });
        if (!book) {
          return {
            results: {
              success: false,
              message: `未找到 ID 为 "${targetId}" 的书籍`,
            },
            meta: { reasoning, bookId },
          };
        }
        targetTitle = book.title;
      }

      // 打开阅读器标签页
      useLayoutStore.getState().openBook(targetId, targetTitle);

      return {
        results: {
          success: true,
          message: `已在阅读器中打开《${targetTitle}》`,
          openedBook: { id: targetId, title: targetTitle },
        },
        meta: { reasoning },
      };
    } catch (error) {
      throw new Error(`书籍管理操作失败: ${error instanceof Error ? error.message : "未知错误"}`);
    }
  },
});
