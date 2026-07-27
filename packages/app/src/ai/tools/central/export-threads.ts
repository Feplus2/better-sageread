/**
 * 全局助手工具：导出对话记录
 *
 * 默认行为：每个对话独立导出为一个文件（用户选择输出目录）
 * 合并模式：仅当 merge=true 时，所有对话合并写入单个文件
 * 支持格式：markdown / html / png
 */
import { buildThreadHtml } from "@/lib/export-thread-html";
import { renderMessagesToPngBlob } from "@/lib/export-thread-image";
import { buildThreadMarkdown, resolveBookTitle, toSafeFileName } from "@/lib/export-thread-markdown";
import { getGlobalThreads, getThreadById, getThreadsBybookId } from "@/services/thread-service";
import type { Thread } from "@/types/thread";
import { open, save } from "@tauri-apps/plugin-dialog";
import { writeFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { tool } from "ai";
import { z } from "zod";

type ExportFormat = "markdown" | "html" | "png";

const FORMAT_EXT: Record<ExportFormat, string> = {
  markdown: "md",
  html: "html",
  png: "png",
};

const FORMAT_FILTERS: Record<ExportFormat, { name: string; extensions: string[] }[]> = {
  markdown: [{ name: "Markdown", extensions: ["md"] }],
  html: [{ name: "HTML", extensions: ["html"] }],
  png: [{ name: "PNG 图片", extensions: ["png"] }],
};

/** 将单个对话渲染为指定格式的内容 */
async function renderThread(thread: Thread, format: ExportFormat): Promise<{ text?: string; bytes?: Uint8Array }> {
  const bookTitle = await resolveBookTitle(thread.book_id);
  const meta = { title: thread.title || "未命名对话", bookTitle };

  switch (format) {
    case "markdown":
      return { text: buildThreadMarkdown(thread.messages, meta) };
    case "html":
      return { text: buildThreadHtml(thread.messages, meta) };
    case "png": {
      const blob = await renderMessagesToPngBlob(thread.messages, meta);
      const buffer = await blob.arrayBuffer();
      return { bytes: new Uint8Array(buffer) };
    }
  }
}

export const exportThreadsTool = tool({
  description: `导出对话记录为文件。

🎯 **核心功能**：
• 默认每个对话独立导出为一个文件（选择输出目录）
• 支持 markdown、html、png 三种格式
• 仅当用户明确要求"合并"时才使用合并模式
• 支持按书籍、星标、对话 ID 筛选目标

📊 **返回内容**：
导出操作结果（文件数、目录路径）`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因"),
    bookId: z.string().optional().describe("指定书籍 ID，导出该书的所有对话"),
    starredOnly: z.boolean().default(false).describe("是否仅导出星标对话"),
    threadIds: z.array(z.string()).optional().describe("指定要导出的对话 ID 列表"),
    format: z
      .enum(["markdown", "html", "png"])
      .default("markdown")
      .describe("导出格式：markdown=Markdown文档, html=网页, png=图片"),
    merge: z.boolean().default(false).describe("是否合并为单个文件（默认 false = 每个对话独立一个文件）"),
  }),

  execute: async ({
    reasoning,
    bookId,
    starredOnly,
    threadIds,
    format,
    merge,
  }: {
    reasoning: string;
    bookId?: string;
    starredOnly: boolean;
    threadIds?: string[];
    format: ExportFormat;
    merge: boolean;
  }) => {
    try {
      // 1. 收集目标对话
      let targetThreadIds: string[] = [];

      if (threadIds && threadIds.length > 0) {
        targetThreadIds = threadIds;
      } else if (bookId) {
        const threads = await getThreadsBybookId(bookId);
        targetThreadIds = threads.filter((t) => !starredOnly || t.starred).map((t) => t.id);
      } else {
        const threads = await getGlobalThreads();
        targetThreadIds = threads.filter((t) => !starredOnly || t.starred).map((t) => t.id);
      }

      if (targetThreadIds.length === 0) {
        return {
          results: {
            success: false,
            message: starredOnly ? "没有找到符合条件的星标对话" : "没有找到符合条件的对话",
          },
          meta: { reasoning, bookId, starredOnly },
        };
      }

      // 2. 加载所有目标对话
      const loadedThreads: Thread[] = [];
      for (const tid of targetThreadIds) {
        try {
          const thread = await getThreadById(tid);
          if (thread.messages && thread.messages.length > 0) {
            loadedThreads.push(thread);
          }
        } catch (e) {
          console.warn(`加载对话 ${tid} 失败:`, e);
        }
      }

      if (loadedThreads.length === 0) {
        return {
          results: { success: false, message: "没有可导出的对话内容" },
          meta: { reasoning },
        };
      }

      const ext = FORMAT_EXT[format];

      // ==================== 独立模式（默认） ====================
      if (!merge) {
        const outputDir = await open({
          directory: true,
          title: "选择导出目录",
        });

        if (!outputDir || typeof outputDir !== "string") {
          return {
            results: { success: false, message: "用户取消了目录选择" },
            meta: { reasoning },
          };
        }

        let successCount = 0;
        let failCount = 0;
        const exportedFiles: string[] = [];

        for (const thread of loadedThreads) {
          try {
            const fileName = `${toSafeFileName(thread.title || "未命名对话")}.${ext}`;
            const filePath = `${outputDir}/${fileName}`;
            const rendered = await renderThread(thread, format);

            if (rendered.text !== undefined) {
              await writeTextFile(filePath, rendered.text);
            } else if (rendered.bytes) {
              await writeFile(filePath, rendered.bytes);
            }

            successCount++;
            exportedFiles.push(fileName);
          } catch (e) {
            console.warn(`导出对话「${thread.title}」失败:`, e);
            failCount++;
          }
        }

        return {
          results: {
            success: successCount > 0,
            message: `成功导出 ${successCount} 个对话到 ${outputDir}${failCount > 0 ? `，${failCount} 个失败` : ""}`,
            exportedCount: successCount,
            failedCount: failCount,
            outputDir,
            files: exportedFiles,
          },
          meta: { reasoning, bookId, starredOnly, format, merge },
        };
      }

      // ==================== 合并模式 ====================
      const savePath = await save({
        defaultPath: starredOnly ? `星标对话导出.${ext}` : `对话导出.${ext}`,
        filters: FORMAT_FILTERS[format],
      });

      if (!savePath) {
        return {
          results: { success: false, message: "用户取消了保存操作" },
          meta: { reasoning },
        };
      }

      // png 格式不支持合并，逐个导出
      if (format === "png") {
        let successCount = 0;
        const dir =
          savePath.substring(0, savePath.lastIndexOf("/")) || savePath.substring(0, savePath.lastIndexOf("\\"));
        for (const thread of loadedThreads) {
          try {
            const fileName = `${toSafeFileName(thread.title || "未命名对话")}.png`;
            const rendered = await renderThread(thread, format);
            if (rendered.bytes) {
              await writeFile(`${dir}/${fileName}`, rendered.bytes);
              successCount++;
            }
          } catch (e) {
            console.warn(`导出对话「${thread.title}」失败:`, e);
          }
        }
        return {
          results: {
            success: successCount > 0,
            message: `PNG 格式不支持合并，已逐个导出 ${successCount} 个对话到 ${dir}`,
            exportedCount: successCount,
          },
          meta: { reasoning, format },
        };
      }

      // markdown / html 合并导出
      const allContents: string[] = [];
      let exportedCount = 0;

      for (const thread of loadedThreads) {
        try {
          const rendered = await renderThread(thread, format);
          if (rendered.text !== undefined) {
            allContents.push(rendered.text);
            if (format === "markdown") {
              allContents.push("\n\n---\n\n");
            }
            exportedCount++;
          }
        } catch (e) {
          console.warn(`导出对话「${thread.title}」失败:`, e);
        }
      }

      if (exportedCount === 0) {
        return {
          results: { success: false, message: "没有可导出的对话内容" },
          meta: { reasoning },
        };
      }

      await writeTextFile(savePath, allContents.join(format === "markdown" ? "" : "\n<hr/>\n"));

      return {
        results: {
          success: true,
          message: `成功合并导出 ${exportedCount} 个对话到 ${savePath}`,
          exportedCount,
          filePath: savePath,
        },
        meta: { reasoning, bookId, starredOnly, format, merge },
      };
    } catch (error) {
      throw new Error(`导出对话失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
});
