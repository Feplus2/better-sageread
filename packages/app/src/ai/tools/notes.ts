import { getAllBookNotes } from "@/services/book-note-service";
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
  description: `获取用户的标注（划线文本与划线下的想法/评论），支持按时间和书籍筛选。

🎯 **常见用法**：
• "总结最近的标注/划线" → days=7
• "我这一周标了什么" → days=7
• "分析这个月的标注" → days=30
• "总结《人类简史》相关的标注" → bookTitle="人类简史"

📊 **返回内容**：
标注列表，包含所属书籍、划线原文、想法评论、颜色/星标/类别、创建时间，适合AI分析和总结`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因，例如：'用户想总结最近一周的标注'"),
    days: z
      .number()
      .int()
      .min(1)
      .max(3650)
      .optional()
      .describe("时间范围：最近几天的标注。7=一周, 30=一个月, 60=两个月, 365=今年。不传则返回所有"),
    bookId: z.string().min(1).optional().describe("指定书籍ID，精确匹配"),
    bookTitle: z.string().min(1).optional().describe("按书名搜索，模糊匹配（如'人类'可匹配'人类简史'）"),
    limit: z.number().int().min(1).max(200).default(50).describe("最多返回条数，默认50"),
  }),

  execute: async ({
    reasoning,
    days,
    bookId,
    bookTitle,
    limit,
  }: {
    reasoning: string;
    days?: number;
    bookId?: string;
    bookTitle?: string;
    limit?: number;
  }) => {
    try {
      // 跨书查询标注（type='annotation'，创建时间倒序）；limit 放宽一倍给后续过滤留余量
      const raw = await getAllBookNotes({ noteType: "annotation", limit: Math.min(200, (limit || 50) * 2) });

      const cutoff = days ? Date.now() - days * 24 * 60 * 60 * 1000 : null;
      const titleTerm = bookTitle?.toLowerCase().trim() || null;

      const formatted: FormattedAnnotation[] = [];
      for (const item of raw) {
        if (cutoff && item.createdAt < cutoff) continue;
        if (bookId?.trim() && item.bookId !== bookId.trim()) continue;
        if (titleTerm && !(item.bookTitle ?? "").toLowerCase().includes(titleTerm)) continue;
        formatted.push({
          id: item.id,
          bookInfo: item.bookTitle ? { id: item.bookId, title: item.bookTitle, author: item.bookAuthor ?? "" } : null,
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
          bookFilter: bookTitle || (bookId ? "指定书籍" : null),
        },
        meta: {
          reasoning,
          filters: {
            days: days ?? null,
            bookId: bookId ?? null,
            bookTitle: bookTitle ?? null,
            limit: limit ?? 50,
          },
        },
      };
    } catch (error) {
      throw new Error(`获取标注失败: ${error instanceof Error ? error.message : "未知错误"}`);
    }
  },
});
