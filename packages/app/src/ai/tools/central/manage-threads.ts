/**
 * 全局助手工具：对话管理（列表/搜索/标星/取消标星/改名/删除/导出）
 *
 * 合并自原 getThreads / exportThreads 两个工具，执行逻辑原样搬入
 *
 * 导出默认行为：每个对话独立导出为一个文件（用户选择输出目录）
 * 合并模式：仅当 merge=true 时，所有对话合并写入单个文件
 * 支持格式：markdown / html / png
 */
import { buildThreadHtml } from "@/lib/export-thread-html";
import { renderMessagesToPngBlob } from "@/lib/export-thread-image";
import { buildThreadMarkdown, resolveBookTitle, toSafeFileName } from "@/lib/export-thread-markdown";
import {
  deleteThread,
  editThread,
  getAllThreads,
  getGlobalThreads,
  getThreadById,
  getThreadsBybookId,
} from "@/services/thread-service";
import type { Thread, ThreadSummary } from "@/types/thread";
import { open, save } from "@tauri-apps/plugin-dialog";
import { writeFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { tool } from "ai";
import dayjs from "dayjs";
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

function summarize(t: ThreadSummary) {
  return {
    id: t.id,
    title: t.title,
    starred: t.starred,
    messageCount: t.message_count,
    scope: t.scope,
    updatedAt: new Date(t.updated_at).toISOString(),
  };
}

export const manageThreadsTool = tool({
  description: `管理对话记录：列出、搜索、标星、取消标星、改名、删除、导出。

🎯 **核心功能**：
• action=list：列出全部对话（可按关键词过滤标题、只看星标）
• action=search：查询/搜索对话（标题关键词模糊匹配、筛选星标、按书籍筛选、限制条数），获取对话 ID 供后续操作
• action=star / unstar：标星 / 取消标星（需要 threadId）
• action=rename：重命名对话（需要 threadId + newTitle）
• action=delete：删除对话（需要 threadId；⚠️ 不可恢复，必须先向用户确认）
• action=export：导出对话为文件（默认每个对话独立一个文件，选择输出目录；支持 markdown/html/png；仅当用户明确要求"合并"时才 merge=true；可按书籍、星标、对话 ID 筛选目标）

📋 **前提条件**：管理动作需要目标对话的 threadId；不确定时先 action=list 或 action=search

📊 **返回内容**：
操作结果；list/search 返回对话摘要列表；export 返回导出结果（文件数、目录路径）`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因"),
    action: z
      .enum(["list", "search", "star", "unstar", "rename", "delete", "export"])
      .describe("list=列出, search=搜索, star/unstar=标星/取消, rename=改名, delete=删除, export=导出"),
    threadId: z.string().optional().describe("目标对话 ID（list/search/export 以外的动作必填）"),
    newTitle: z.string().optional().describe("新标题（action=rename 时必填）"),
    keyword: z.string().optional().describe("标题关键词过滤（action=list 时可选）"),
    starredOnly: z.boolean().default(false).describe("只看/只导出星标对话（list/search/export 时可选）"),
    search: z.string().optional().describe("标题搜索关键词，模糊匹配（action=search 时可选）"),
    bookId: z.string().optional().describe("按书籍 ID 筛选（action=search）或导出该书的所有对话（action=export）"),
    limit: z.number().int().min(1).max(100).default(20).describe("action=search：最多返回条数，默认20"),
    threadIds: z.array(z.string()).optional().describe("action=export：指定要导出的对话 ID 列表"),
    format: z
      .enum(["markdown", "html", "png"])
      .default("markdown")
      .describe("action=export：导出格式 markdown=Markdown文档, html=网页, png=图片"),
    merge: z
      .boolean()
      .default(false)
      .describe("action=export：是否合并为单个文件（默认 false = 每个对话独立一个文件）"),
  }),

  execute: async ({
    reasoning,
    action,
    threadId,
    newTitle,
    keyword,
    starredOnly,
    search,
    bookId,
    limit,
    threadIds,
    format,
    merge,
  }: {
    reasoning: string;
    action: "list" | "search" | "star" | "unstar" | "rename" | "delete" | "export";
    threadId?: string;
    newTitle?: string;
    keyword?: string;
    starredOnly: boolean;
    search?: string;
    bookId?: string;
    limit?: number;
    threadIds?: string[];
    format: ExportFormat;
    merge: boolean;
  }) => {
    try {
      if (action === "list") {
        let threads = await getAllThreads();
        if (starredOnly) threads = threads.filter((t) => t.starred);
        if (keyword?.trim()) {
          const q = keyword.trim().toLowerCase();
          threads = threads.filter((t) => t.title.toLowerCase().includes(q));
        }
        return {
          results: {
            success: true,
            total: threads.length,
            threads: threads.map(summarize),
          },
          meta: { reasoning, keyword, starredOnly },
        };
      }

      // ==================== 搜索对话（原 getThreads） ====================
      if (action === "search") {
        // 获取对话列表
        let threads = bookId ? await getThreadsBybookId(bookId) : await getAllThreads();

        // 按星标筛选
        if (starredOnly) {
          threads = threads.filter((t) => t.starred);
        }

        // 按标题关键词模糊匹配
        if (search?.trim()) {
          const kw = search.trim().toLowerCase();
          threads = threads.filter((t) => (t.title || "").toLowerCase().includes(kw));
        }

        // 限制数量
        const maxCount = limit || 20;
        const results = threads.slice(0, maxCount).map((t) => ({
          id: t.id,
          title: t.title || "未命名对话",
          starred: t.starred,
          messageCount: t.message_count,
          bookId: t.book_id,
          updatedAt: dayjs(t.updated_at).format("YYYY-MM-DD HH:mm:ss"),
        }));

        return {
          results: {
            total: threads.length,
            returned: results.length,
            threads: results,
          },
          meta: {
            reasoning,
            filters: { search: search ?? null, starredOnly, bookId: bookId ?? null, limit: maxCount },
          },
        };
      }

      // ==================== 导出对话（原 exportThreads） ====================
      if (action === "export") {
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
      }

      if (!threadId) {
        return {
          results: { success: false, message: `action=${action} 需要提供 threadId` },
          meta: { reasoning },
        };
      }

      switch (action) {
        case "star":
        case "unstar": {
          const starred = action === "star";
          const updated = await editThread(threadId, { starred });
          return {
            results: { success: true, message: `已${starred ? "标星" : "取消标星"}对话「${updated.title}」` },
            meta: { reasoning, threadId },
          };
        }
        case "rename": {
          if (!newTitle?.trim()) {
            return {
              results: { success: false, message: "action=rename 需要提供 newTitle" },
              meta: { reasoning, threadId },
            };
          }
          const updated = await editThread(threadId, { title: newTitle.trim() });
          return {
            results: { success: true, message: `对话已改名为「${updated.title}」` },
            meta: { reasoning, threadId },
          };
        }
        case "delete": {
          await deleteThread(threadId);
          return {
            results: { success: true, message: "对话已删除" },
            meta: { reasoning, threadId },
          };
        }
      }
    } catch (error) {
      throw new Error(`对话管理失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
});
