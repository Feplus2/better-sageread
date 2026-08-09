/**
 * 全局助手工具：书籍/论文条目管理（删除/打开/重置进度）
 *
 * 合并自原 deleteBook / openBook / resetProgress 三个工具，执行逻辑原样搬入；
 * open 按条目 format 自动路由：MARKDOWN 论文开论文阅读器，其余开书籍阅读器。
 */
import { deleteBook, updateBookStatus } from "@/services/book-service";
import { useLayoutStore } from "@/store/layout-store";
import type { BookQueryOptions, BookWithStatus, SimpleBook } from "@/types/simple-book";
import { invoke } from "@tauri-apps/api/core";
import { tool } from "ai";
import { z } from "zod";

export const manageBookTool = tool({
  description: `书籍/论文条目管理：删除（移入回收站）、在阅读器中打开、重置阅读进度。

📚 **书籍 vs 论文**：本工具对书库书籍（EPUB）与文献库论文（MARKDOWN）都适用；
open 会自动按条目类型打开对应阅读器（论文→论文阅读器，书籍→书籍阅读器）。
先用 getBooks 确认目标条目的 id 和类型再操作。

🎯 **核心功能**：
• action=delete：按条目 ID 删除（软删除进回收站，可恢复）
• action=open：按条目 ID 精确打开，或按标题模糊搜索后打开第一个匹配的条目
• action=resetProgress：重置阅读进度（状态设为"未读"，清除阅读位置）

⚠️ **危险操作**：delete / resetProgress 调用前应先通过 getBooks 确认目标条目，并向用户确认

📊 **返回内容**：
操作结果（删除/重置返回目标条目信息；open 返回打开的条目；多个匹配时返回其余候选）

⚠️ **什么时候别用**：
• 恢复或彻底删除回收站条目——请用 trashManager
• 查询条目列表——请用 getBooks`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因（delete/resetProgress 时应包含用户确认信息）"),
    action: z
      .enum(["delete", "open", "resetProgress"])
      .describe("delete=移入回收站, open=打开阅读, resetProgress=重置进度"),
    bookId: z.string().optional().describe("条目 ID（delete/resetProgress 必填；open 时精确打开）"),
    bookTitle: z
      .string()
      .optional()
      .describe("标题关键词（open 时无 bookId 则模糊搜索后打开第一个；delete/resetProgress 仅用于日志记录）"),
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
              kind: book.format === "MARKDOWN" ? "paper" : "book",
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

      // ==================== 打开条目（按 format 路由：MARKDOWN 论文 → 论文阅读器） ====================
      let targetId = bookId;
      let targetTitle = "";
      let targetFormat = "";

      // 如果没有 bookId，按标题搜索
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
              message: `未找到标题包含「${bookTitle}」的条目`,
            },
            meta: { reasoning, bookTitle },
          };
        }

        targetId = books[0].id;
        targetTitle = books[0].title;
        targetFormat = books[0].format ?? "";

        // 如果有多个匹配，告知用户
        if (books.length > 1) {
          const list = books.map((b) => `《${b.title}》`).join("、");
          return {
            results: {
              success: true,
              message: `找到多个匹配的条目（${list}），已打开第一个《${targetTitle}》`,
              openedBook: { id: targetId, title: targetTitle, kind: targetFormat === "MARKDOWN" ? "paper" : "book" },
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

      // 获取标题与格式（如果还没有）
      if (!targetTitle || !targetFormat) {
        const book = await invoke<{ title: string; format?: string } | null>("get_book_by_id", { id: targetId });
        if (!book) {
          return {
            results: {
              success: false,
              message: `未找到 ID 为 "${targetId}" 的条目`,
            },
            meta: { reasoning, bookId },
          };
        }
        targetTitle = targetTitle || book.title;
        targetFormat = targetFormat || book.format || "";
      }

      // 按类型路由到对应阅读器（MARKDOWN 论文开论文阅读器，其余开书籍阅读器）
      const layoutStore = useLayoutStore.getState();
      if (targetFormat === "MARKDOWN") {
        layoutStore.openPaper(targetId, targetTitle);
      } else {
        layoutStore.openBook(targetId, targetTitle);
      }

      const openedKind = targetFormat === "MARKDOWN" ? "paper" : "book";
      return {
        results: {
          success: true,
          message: `已在${openedKind === "paper" ? "论文" : "书籍"}阅读器中打开《${targetTitle}》`,
          openedBook: { id: targetId, title: targetTitle, kind: openedKind },
        },
        meta: { reasoning },
      };
    } catch (error) {
      throw new Error(`条目管理操作失败: ${error instanceof Error ? error.message : "未知错误"}`);
    }
  },
});
