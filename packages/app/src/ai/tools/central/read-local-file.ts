/**
 * 全局助手工具：读取本地文件/目录
 */
import { exists, readDir, readTextFile } from "@tauri-apps/plugin-fs";
import { tool } from "ai";
import { z } from "zod";

export const readLocalFileTool = tool({
  description: `读取本地文件内容或列出目录结构。

🎯 **核心功能**：
• 读取文本文件内容（.md / .json / .txt / .yaml 等）
• 列出目录下的文件和子目录
• 检查文件/目录是否存在

📊 **返回内容**：
文件内容（截断至 12000 字符）或目录列表`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因"),
    path: z.string().min(1).describe("文件或目录的完整本地路径"),
    mode: z.enum(["read", "list"]).default("read").describe("read=读取文件内容, list=列出目录"),
  }),

  execute: async ({ reasoning, path, mode }: { reasoning: string; path: string; mode: "read" | "list" }) => {
    try {
      const pathExists = await exists(path);
      if (!pathExists) {
        return {
          results: { success: false, message: `路径不存在：${path}` },
          meta: { reasoning, path },
        };
      }

      if (mode === "list") {
        const entries = await readDir(path);
        const items = entries.map((e) => ({
          name: e.name,
          isDirectory: e.isDirectory,
        }));
        return {
          results: {
            success: true,
            message: `目录 ${path} 下有 ${items.length} 项`,
            items,
          },
          meta: { reasoning, path },
        };
      }

      // read mode
      const content = await readTextFile(path);
      const truncated =
        content.length > 12000 ? `${content.slice(0, 12000)}\n...[截断，共 ${content.length} 字符]` : content;

      return {
        results: {
          success: true,
          message: `已读取 ${path}（${content.length} 字符）`,
          content: truncated,
        },
        meta: { reasoning, path },
      };
    } catch (error) {
      return {
        results: { success: false, message: `读取失败：${error instanceof Error ? error.message : String(error)}` },
        meta: { reasoning, path },
      };
    }
  },
});
