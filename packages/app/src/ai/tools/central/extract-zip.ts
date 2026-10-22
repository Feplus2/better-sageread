/**
 * 全局助手工具：解压 ZIP 文件
 */
import { mkdir, readFile, writeFile } from "@tauri-apps/plugin-fs";
import { tool } from "ai";
import { z } from "zod";

/** 单个/合计解压体积上限（防 zip 炸弹） */
const MAX_ENTRY_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;

/**
 * 安全拼接解压目标路径：拒绝绝对路径、盘符、任何 .. 段，保证落点始终在 destDir 内（防 zip-slip）。
 * 返回 null 表示该 entry 非法，应跳过。
 */
function safeEntryPath(destDir: string, entryName: string): string | null {
  const normalized = entryName.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return null;
  const segments: string[] = [];
  for (const segment of normalized.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") return null; // 直接拒绝，不做"尝试归一化"
    segments.push(segment);
  }
  if (segments.length === 0) return null;
  return `${destDir.replace(/[\\/]+$/, "")}/${segments.join("/")}`;
}

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
      const skipped: string[] = [];
      let totalBytes = 0;
      for (const entry of entries) {
        const entryPath = safeEntryPath(destDir, entry.filename);
        if (!entryPath) {
          skipped.push(entry.filename);
          continue;
        }
        if (entry.directory) {
          await mkdir(entryPath, { recursive: true }).catch(() => {});
          continue;
        }
        const entryBytes = Number(entry.uncompressedSize ?? 0);
        if (entryBytes > MAX_ENTRY_BYTES || totalBytes + entryBytes > MAX_TOTAL_BYTES) {
          await reader.close().catch(() => {});
          return {
            results: {
              success: false,
              message: `解压中止：压缩包内文件过大（单文件上限 100MB、解压总量上限 200MB），疑似 zip 炸弹`,
              destDir,
              files,
              skipped,
            },
            meta: { reasoning, zipPath },
          };
        }
        // 确保父目录存在
        const parentDir = entryPath.replace(/[/\\][^/\\]+$/, "");
        await mkdir(parentDir, { recursive: true }).catch(() => {});
        const data = await entry.getData!(new Uint8ArrayWriter());
        totalBytes += data.length;
        await writeFile(entryPath, data);
        files.push(entry.filename);
      }

      await reader.close();

      return {
        results: {
          success: true,
          message: skipped.length
            ? `已解压 ${files.length} 个文件到 ${destDir}；跳过 ${skipped.length} 个非法路径项（防 zip-slip）`
            : `已解压 ${files.length} 个文件到 ${destDir}`,
          destDir,
          files,
          ...(skipped.length > 0 ? { skipped } : {}),
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
