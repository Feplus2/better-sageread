import type { BookQueryOptions, BookStatus, BookWithStatus, SimpleBook } from "@/types/simple-book";
import { invoke } from "@tauri-apps/api/core";
import { tool } from "ai";
import { z } from "zod";

type BookStatusState = BookStatus["status"];

/** 条目类型判别（书籍/论文同表存储，按 format 区分）：MARKDOWN = 文献库论文，其余 = 书库书籍 */
export type LibraryKind = "book" | "paper" | "all";
export const isPaperFormat = (format: string | undefined | null) => format === "MARKDOWN";
export function filterByKind<T extends { format?: string | null }>(items: T[], kind?: LibraryKind): T[] {
  if (!kind || kind === "all") return items;
  return kind === "paper"
    ? items.filter((i) => isPaperFormat(i.format))
    : items.filter((i) => !isPaperFormat(i.format));
}

const STATUS_LABELS: Record<BookStatusState, string> = {
  unread: "未开始",
  reading: "阅读中",
  completed: "已完成",
};

async function loadSingleBook(bookId: string): Promise<BookWithStatus | null> {
  const book = await invoke<SimpleBook | null>("get_book_by_id", { id: bookId });
  if (!book) {
    return null;
  }

  const status = await invoke<BookStatus | null>("get_book_status", { bookId });
  return { ...book, status: status ?? undefined };
}

async function loadBookList(options: BookQueryOptions): Promise<BookWithStatus[]> {
  return await invoke<BookWithStatus[]>("get_books_with_status", { options });
}

export const getBooksTool = tool({
  description: `查询书库书籍/文献库论文的列表和基本信息，支持按类型、状态和关键词筛选。

📚 **书籍 vs 论文（必须区分）**：
• 书籍（kind=book）：EPUB 等电子书，存放在书库
• 论文（kind=paper）：MARKDOWN 格式的学术文献，存放在文献库
• 用户说"我的书/书籍"时传 kind=book；说"论文/文献"时传 kind=paper；不明确时才用默认 all

🎯 **核心功能**：
• 支持按条目 ID 精确查询（不受 kind 过滤）
• 支持按书名/作者模糊搜索
• 支持按阅读状态筛选

📊 **返回内容**：
条目列表，包含标题、作者、格式、类型（书籍/论文）、阅读状态和进度等信息`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因，例如：'用户想查看所有在读的书籍'"),
    bookId: z.string().min(1).optional().describe("指定条目 ID，精确查询单个条目（不受 kind 过滤）"),
    search: z.string().min(1).optional().describe("搜索关键词，匹配标题或作者"),
    kind: z
      .enum(["book", "paper", "all"])
      .optional()
      .describe(
        "条目类型：book=仅书籍（书库）, paper=仅论文（文献库）, all=全部（默认）。用户提到书/论文时务必传对应值",
      ),
    status: z.enum(["unread", "reading", "completed"]).optional().describe("筛选阅读状态"),
    limit: z.number().int().min(1).max(50).default(10).describe("最多返回条数，默认10"),
  }),

  execute: async ({
    reasoning,
    bookId,
    search,
    kind,
    status,
    limit,
  }: {
    reasoning: string;
    bookId?: string;
    search?: string;
    kind?: LibraryKind;
    status?: BookStatusState;
    limit?: number;
  }) => {
    try {
      let rawBooks: BookWithStatus[] = [];

      // 1. 如果指定了 bookId，精确查询（不受 kind 过滤，返回中标注类型）
      if (bookId?.trim()) {
        const single = await loadSingleBook(bookId.trim());
        if (single) {
          rawBooks = [single];
        }
      } else {
        // 2. 否则查询列表
        const queryOptions: BookQueryOptions = {
          limit: limit || 10,
          sortBy: "updatedAt",
          sortOrder: "desc",
          ...(search ? { searchQuery: search.trim() } : {}),
        };
        rawBooks = await loadBookList(queryOptions);
        // 3. 按类型过滤（书籍/论文区分）
        rawBooks = filterByKind(rawBooks, kind);
      }

      // 4. 按状态筛选
      if (status) {
        rawBooks = rawBooks.filter((book) => book.status?.status === status);
      }

      // 5. 限制返回数量
      if (!bookId) {
        rawBooks = rawBooks.slice(0, limit || 10);
      }

      // 6. 格式化返回数据（统一使用 results 字段）
      const results = rawBooks.map((book) => {
        const { status: statusInfo, ...rest } = book;
        const basic = rest as SimpleBook;

        const progressPercent =
          statusInfo && statusInfo.progressTotal > 0
            ? Number(((statusInfo.progressCurrent / statusInfo.progressTotal) * 100).toFixed(1))
            : null;

        return {
          id: basic.id,
          title: basic.title,
          author: basic.author,
          format: basic.format,
          kind: isPaperFormat(basic.format) ? "paper" : "book",
          language: basic.language,
          tags: basic.tags ?? [],
          createdAt: basic.createdAt,
          updatedAt: basic.updatedAt,
          status: statusInfo
            ? {
                state: statusInfo.status,
                label: STATUS_LABELS[statusInfo.status],
                progressCurrent: statusInfo.progressCurrent,
                progressTotal: statusInfo.progressTotal,
                progressPercent,
                lastReadAt: statusInfo.lastReadAt ?? null,
                startedAt: statusInfo.startedAt ?? null,
                completedAt: statusInfo.completedAt ?? null,
              }
            : null,
        };
      });

      return {
        results,
        meta: {
          reasoning,
          total: results.length,
          filters: {
            bookId: bookId ?? null,
            search: search ?? null,
            kind: kind ?? "all",
            status: status ?? null,
            limit: limit || 10,
          },
        },
      };
    } catch (error) {
      throw new Error(`查询失败: ${error instanceof Error ? error.message : "未知错误"}`);
    }
  },
});
