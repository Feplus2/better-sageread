import { resolveBookTitle, toSafeFileName } from "@/lib/export-thread-markdown";
/**
 * 全局助手工具：导出书籍划线与标注为 Markdown
 *
 * 数据来源：getBookNotes（划线/想法/书签，书内标注；notes 概念清除后不再含独立笔记）
 * 输出：单个 Markdown 文件（用户选择保存位置），划线按类型分组、时间升序
 */
import { getBookNotes } from "@/services/book-note-service";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { tool } from "ai";
import { z } from "zod";

function formatDate(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const TYPE_LABELS: Record<string, string> = {
  annotation: "划线与想法",
  excerpt: "摘录",
  bookmark: "书签",
};

export const exportNotesTool = tool({
  description: `把某本书的划线、想法（书内标注）导出为一个 Markdown 文件。

🎯 **核心功能**：
• 按书籍导出全部书内标注（划线/摘录/书签，含原文与想法）
• 输出单个 Markdown 文件，用户通过系统对话框选择保存位置

📋 **前提条件**：需要 bookId；若用户只给出书名，先用 getBooks 模糊查找并确认

📊 **返回内容**：
导出结果（条目数、文件路径）；该书无标注时返回明确提示`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因"),
    bookId: z.string().min(1).describe("书籍 ID（先用 getBooks 按书名查找）"),
  }),

  execute: async ({ reasoning, bookId }: { reasoning: string; bookId: string }) => {
    try {
      const bookNotes = await getBookNotes(bookId);

      const visibleNotes = bookNotes.filter((n) => !n.deletedAt);
      if (visibleNotes.length === 0) {
        return {
          results: { success: false, message: "这本书还没有任何标注，没什么可导出的" },
          meta: { reasoning, bookId },
        };
      }

      const bookTitle = (await resolveBookTitle(bookId)) || "未命名书籍";

      const lines: string[] = [`# 《${bookTitle}》划线与标注`, ""];
      lines.push(`> 导出于 ${formatDate(Date.now())}，共 ${visibleNotes.length} 条标注`, "");

      // 书内标注：按类型分组，组内按创建时间升序
      const sorted = [...visibleNotes].sort((a, b) => a.createdAt - b.createdAt);
      for (const type of ["annotation", "excerpt", "bookmark"] as const) {
        const group = sorted.filter((n) => n.type === type);
        if (group.length === 0) continue;
        lines.push(`## ${TYPE_LABELS[type]}（${group.length} 条）`, "");
        for (const item of group) {
          if (item.text?.trim()) {
            lines.push(`> ${item.text.trim().replace(/\n/g, "\n> ")}`, "");
          }
          if (item.note?.trim()) {
            lines.push(`**想法**：${item.note.trim()}`, "");
          }
          lines.push(`<sub>${formatDate(item.createdAt)}</sub>`, "", "---", "");
        }
      }

      const savePath = await save({
        defaultPath: `${toSafeFileName(bookTitle)}-划线标注.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!savePath) {
        return {
          results: { success: false, message: "用户取消了保存操作" },
          meta: { reasoning, bookId },
        };
      }

      await writeTextFile(savePath, lines.join("\n"));

      return {
        results: {
          success: true,
          message: `已导出《${bookTitle}》的 ${visibleNotes.length} 条标注到 ${savePath}`,
          annotations: visibleNotes.length,
          filePath: savePath,
        },
        meta: { reasoning, bookId },
      };
    } catch (error) {
      throw new Error(`导出划线标注失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
});
