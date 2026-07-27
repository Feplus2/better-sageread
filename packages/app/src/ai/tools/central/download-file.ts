/**
 * 全局助手工具：下载文件到本地
 */
import { fetch as fetchTauri } from "@tauri-apps/plugin-http";
import { mkdir, writeFile } from "@tauri-apps/plugin-fs";
import { tool } from "ai";
import { z } from "zod";

export const downloadFileTool = tool({
  description: `从 URL 下载文件到本地磁盘（支持二进制：zip、图片、PDF 等）。

🎯 **核心功能**：
• 下载任意 URL 的文件到指定本地路径
• 自动创建目标目录（如不存在）
• 走 Tauri 原生网络栈，无 CORS 限制

📊 **返回内容**：
下载结果（保存路径、文件大小）`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因"),
    url: z.string().url().describe("文件的下载 URL"),
    savePath: z.string().min(1).describe("保存到的完整本地路径，如 D:\\temp\\skill.zip"),
  }),

  execute: async ({ reasoning, url, savePath }: { reasoning: string; url: string; savePath: string }) => {
    try {
      const response = await fetchTauri(url);
      if (!response.ok) {
        return {
          results: { success: false, message: `下载失败：HTTP ${response.status} ${response.statusText}` },
          meta: { reasoning, url },
        };
      }

      const buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer);

      // 确保目标目录存在
      const dirPath = savePath.replace(/[/\\][^/\\]+$/, "");
      if (dirPath && dirPath !== savePath) {
        await mkdir(dirPath, { recursive: true }).catch(() => {});
      }

      await writeFile(savePath, bytes);

      return {
        results: {
          success: true,
          message: `已下载到 ${savePath}（${(bytes.length / 1024).toFixed(1)} KB）`,
          savePath,
          sizeBytes: bytes.length,
        },
        meta: { reasoning, url },
      };
    } catch (error) {
      return {
        results: { success: false, message: `下载失败：${error instanceof Error ? error.message : String(error)}` },
        meta: { reasoning, url },
      };
    }
  },
});
