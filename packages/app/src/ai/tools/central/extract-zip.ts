/**
 * 全局助手工具：解压 ZIP 文件
 */
import { mkdir, readFile, writeFile } from "@tauri-apps/plugin-fs";
import { tool } from "ai";
import { z } from "zod";

export const extractZipTool = tool({
  description: `解压 ZIP 压缩文件到指定目录。

🎯 **核心功能**：
• 解压 .zip 文件到目标目录（自动创建）
• 保留目录结构
• 返回解压后的文件列表

📊 **返回内容**：
解压结果（目标目录、文件列表）`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因"),
    zipPath: z.string().min(1).describe("ZIP 文件的完整本地路径"),
    destDir: z.string().min(1).describe("解压到的目标目录"),
  }),

  execute: async ({ reasoning, zipPath, destDir }: { reasoning: string; zipPath: string; destDir: string }) => {
    try {
      const { ZipReader, BlobReader, Uint8ArrayWriter } = await import("@zip.js/zip.js");

      const zipBytes = await readFile(zipPath);
      const blob = new Blob([zipBytes.buffer as ArrayBuffer]);
      const reader = new ZipReader(new BlobReader(blob));
      const entries = await reader.getEntries();

      await mkdir(destDir, { recursive: true }).catch(() => {});

      const files: string[] = [];
      for (const entry of entries) {
        const entryPath = `${destDir}/${entry.filename}`;
        if (entry.directory) {
          await mkdir(entryPath, { recursive: true }).catch(() => {});
        } else {
          // 确保父目录存在
          const parentDir = entryPath.replace(/[/\\][^/\\]+$/, "");
          await mkdir(parentDir, { recursive: true }).catch(() => {});
          const data = await entry.getData!(new Uint8ArrayWriter());
          await writeFile(entryPath, data);
          files.push(entry.filename);
        }
      }

      await reader.close();

      return {
        results: {
          success: true,
          message: `已解压 ${files.length} 个文件到 ${destDir}`,
          destDir,
          files,
        },
        meta: { reasoning, zipPath },
      };
    } catch (error) {
      return {
        results: { success: false, message: `解压失败：${error instanceof Error ? error.message : String(error)}` },
        meta: { reasoning, zipPath },
      };
    }
  },
});
