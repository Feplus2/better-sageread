import { type LibraryKind, filterByKind } from "@/ai/tools/book";
import { getAllBookNotes } from "@/services/book-note-service";
import { getBooksWithStatus } from "@/services/book-service";
import { tool } from "ai";
import { z } from "zod";

/**
 * 全局/阅读助手共用工具：查询用户的标注（划线文本 + 划线下想法评论）。
 * notes 概念清除后，本工具的数据源从独立 notes 表迁移到 book_notes（type='annotation'）。
 */

interface FormattedAnnotation {
  id: string;
  bookInfo: {
    id: string;
    title: string;
    author: string;
    /** 条目类型：book=书库书籍, paper=文献库论文（无 format 映射时按 book 处理） */
    kind?: "book" | "paper";
  } | null;
  /** 划线原文 */
  text: string | null;
  /** 划线下的想法/评论 */
  note: string | null;
  color: string | null;
  starred: boolean;
  /** AI 重点类别（goal/methods/...）；人工标注为 null */
  category: string | null;
  source: string;
  createdAt: string;
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function getTimeRangeDescription(days?: number): string {
  if (!days) return "全部";
  if (days === 7) return "最近7天";
  if (days === 30) return "最近30天";
  if (days === 60) return "最近60天";
  if (days === 365) return "最近365天";
  return `最近${days}天`;
}

export const notesTool = tool({
  description: `获取用户的标注（划线文本与划线下的想法/评论），支持按时间、条目和类型筛选。

📚 **书籍 vs 论文**：标注可能来自书库书籍或文献库论文；用户说"书的标注"传 kind=book，
"论文的标注"传 kind=paper，不明确时用默认 all。

🎯 **常见用法**：
• "总结最近的标注/划线" → days=7
• "我这一周标了什么" → days=7
• "分析这个月的标注" → days=30
• "总结《人类简史》相关的标注" → bookTitle="人类简史"

📊 **返回内容**：
标注列表，包含所属条目（含类型）、划线原文、想法评论、颜色/星标/类别、创建时间，适合AI分析和总结`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因，例如：'用户想总结最近一周的标注'"),
    days: z
      .number()
      .int()
      .min(1)
      .max(3650)
      .optional()
      .describe("时间范围：最近几天的标注。7=一周, 30=一个月, 60=两个月, 365=今年。不传则返回所有"),
    bookId: z.string().min(1).optional().describe("指定条目 ID，精确匹配"),
    bookTitle: z.string().min(1).optional().describe("按标题搜索，模糊匹配（如'人类'可匹配'人类简史'）"),
    kind: z
      .enum(["book", "paper", "all"])
      .optional()
      .describe("标注所属条目类型：book=仅书籍, paper=仅论文, all=全部（默认）"),
    limit: z.number().int().min(1).max(200).default(50).describe("最多返回条数，默认50"),
  }),

  execute: async ({
    reasoning,
    days,
    bookId,
    bookTitle,
    kind,
    limit,
  }: {
    reasoning: string;
    days?: number;
    bookId?: string;
    bookTitle?: string;
    kind?: LibraryKind;
    limit?: number;
  }) => {
    try {
      // 跨书查询标注（type='annotation'，创建时间倒序）；limit 放宽一倍给后续过滤留余量
      const raw = await getAllBookNotes({ noteType: "annotation", limit: Math.min(200, (limit || 50) * 2) });

      // kind 过滤需要 id→format 映射（标注数据自身不带 format）
      let formatById: Map<string, string> | null = null;
      if (kind && kind !== "all") {
        const books = await getBooksWithStatus({ limit: 500 });
        formatById = new Map(books.map((b) => [b.id, b.format]));
      }

      const cutoff = days ? Date.now() - days * 24 * 60 * 60 * 1000 : null;
      const titleTerm = bookTitle?.toLowerCase().trim() || null;

      const formatted: FormattedAnnotation[] = [];
      for (const item of raw) {
        if (cutoff && item.createdAt < cutoff) continue;
        if (bookId?.trim() && item.bookId !== bookId.trim()) continue;
        if (titleTerm && !(item.bookTitle ?? "").toLowerCase().includes(titleTerm)) continue;
        if (formatById && !filterByKind([{ format: formatById.get(item.bookId) ?? null }], kind).length) continue;
        formatted.push({
          id: item.id,
          bookInfo: item.bookTitle
            ? {
                id: item.bookId,
                title: item.bookTitle,
                author: item.bookAuthor ?? "",
                kind: formatById?.get(item.bookId) === "MARKDOWN" ? "paper" : "book",
              }
            : null,
          text: item.text ?? null,
          note: item.note?.trim() ? item.note.trim() : null,
          color: item.color ?? null,
          starred: item.starred ?? false,
          category: item.category ?? null,
          source: item.source ?? "user",
          createdAt: formatTimestamp(item.createdAt),
        });
        if (formatted.length >= (limit || 50)) break;
      }

      return {
        results: formatted,
        summary: {
          total: formatted.length,
          timeRange: getTimeRangeDescription(days),
          bookFilter: bookTitle || (bookId ? "指定条目" : null),
          kind: kind ?? "all",
        },
        meta: {
          reasoning,
          filters: {
            days: days ?? null,
            bookId: bookId ?? null,
            bookTitle: bookTitle ?? null,
            kind: kind ?? "all",
            limit: limit || 50,
          },
        },
      };
    } catch (error) {
      throw new Error(`获取标注失败: ${error instanceof Error ? error.message : "未知错误"}`);
    }
  },
});
