/**
 * 全局助手工具：从本地路径导入阅读字体（.woff2/.ttf，ttf 自动转 woff2）
 *
 * 导入的是书籍正文可用的自定义字体（设置 → 字体管理同款），
 * 导入后可通过 managePreferences(action=reader) 的 fontName 直接启用
 */
import { uploadFontByPath } from "@/services/font-service";
import { useFontStore } from "@/store/font-store";
import { tool } from "ai";
import { z } from "zod";

export const importFontTool = tool({
  description: `从本地文件路径导入阅读字体。

🎯 **核心功能**：
• 支持 .woff2 和 .ttf 文件（ttf 自动转换为 woff2）
• 导入后即可在阅读设置中选用（也可让我用 managePreferences(action=reader) 直接切换）

📋 **前提条件**：需要字体文件的绝对路径（如 D:\\Fonts\\LXGW.woff2）

📊 **返回内容**：
导入结果（字体名称、文件名）`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因"),
    filePath: z.string().min(1).describe("字体文件的绝对路径（.woff2 或 .ttf）"),
  }),

  execute: async ({ reasoning, filePath }: { reasoning: string; filePath: string }) => {
    try {
      const info = await uploadFontByPath(filePath.trim());
      // 刷新字体列表，让阅读设置立即可选
      await useFontStore.getState().refreshFonts();

      return {
        results: {
          success: true,
          message: `字体「${info.name}」导入成功，已可在阅读设置中选用`,
          font: { name: info.name, filename: info.filename },
        },
        meta: { reasoning, filePath },
      };
    } catch (error) {
      throw new Error(`导入字体失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
});
