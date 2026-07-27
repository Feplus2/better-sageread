/**
 * 全局助手工具：在阅读器中打开书籍
 */
import { useLayoutStore } from "@/store/layout-store";
import type { BookQueryOptions, BookWithStatus } from "@/types/simple-book";
import { invoke } from "@tauri-apps/api/core";
import { tool } from "ai";
import { z } from "zod";

export const openBookTool = tool({
  description: `在阅读器中打开一本书。

🎯 **核心功能**：
• 按书籍 ID 直接打开
• 按书名模糊搜索后打开

📊 **返回内容**：
打开操作结果`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因"),
    bookId: z.string().optional().describe("书籍 ID（精确打开）"),
    bookTitle: z.string().optional().describe("书名关键词（模糊搜索后打开第一本匹配的书）"),
  }),

  execute: async ({
    reasoning,
    bookId,
    bookTitle,
  }: {
    reasoning: string;
    bookId?: string;
    bookTitle?: string;
  }) => {
    try {
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
      throw new Error(`打开书籍失败: ${error instanceof Error ? error.message : "未知错误"}`);
    }
  },
});
