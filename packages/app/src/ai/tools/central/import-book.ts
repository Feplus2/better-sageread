/**
 * 中央 Agent 工具：从本地路径导入书籍
 */
import { uploadBook } from "@/services/book-service";
import { readFile } from "@tauri-apps/plugin-fs";
import { tool } from "ai";
import { z } from "zod";

const SUPPORTED_EXTENSIONS = ["epub", "pdf", "mobi", "cbz", "fb2", "fbz"];

const MIME_TYPES: Record<string, string> = {
  epub: "application/epub+zip",
  pdf: "application/pdf",
  mobi: "application/x-mobipocket-ebook",
  cbz: "application/x-cbz",
  fb2: "application/x-fictionbook+xml",
  fbz: "application/x-fictionbook+xml",
};

export const importBookTool = tool({
  description: `从本地文件路径导入书籍到书库。

🎯 **核心功能**：
• 支持 EPUB、PDF、MOBI、CBZ、FB2 格式
• 自动提取元数据（书名、作者等）
• 导入后可在书库中看到

📊 **返回内容**：
导入结果（书名、书籍 ID）`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因"),
    filePath: z.string().min(1).describe("书籍文件的完整本地路径，如 D:\\Books\\novel.epub"),
  }),

  execute: async ({ reasoning, filePath }: { reasoning: string; filePath: string }) => {
    try {
      // 验证扩展名
      const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
      if (!SUPPORTED_EXTENSIONS.includes(ext)) {
        return {
          results: {
            success: false,
            message: `不支持的文件格式 ".${ext}"，支持的格式：${SUPPORTED_EXTENSIONS.join("、")}`,
          },
          meta: { reasoning, filePath },
        };
      }

      // 读取文件
      const bytes = await readFile(filePath);
      const fileName = filePath.split(/[\\/]/).pop() ?? `book.${ext}`;
      const file = new File([bytes.buffer as ArrayBuffer], fileName, {
        type: MIME_TYPES[ext] || "application/octet-stream",
      });

      // 调用现有入库流程
      const book = await uploadBook(file);

      return {
        results: {
          success: true,
          message: `《${book.title}》导入成功`,
          importedBook: {
            id: book.id,
            title: book.title,
            author: book.author,
            format: book.format,
          },
        },
        meta: { reasoning, filePath },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "未知错误";
      if (errorMessage.includes("No such file") || errorMessage.includes("不存在")) {
        throw new Error(`文件不存在：${filePath}`);
      }
      throw new Error(`导入书籍失败: ${errorMessage}`);
    }
  },
});
