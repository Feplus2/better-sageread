/**
 * 全局助手工具：PDF 转 EPUB 并入库
 */
import {
  type ConvertProgress,
  importConvertedEpub,
  listenConvertProgress,
  startConvert,
} from "@/services/converter-service";
import { tool } from "ai";
import { z } from "zod";

export const convertPdfTool = tool({
  description: `将 PDF 文件转换为 EPUB 格式并导入书库。

⚠️ **注意**：
• 转换过程可能需要几分钟，取决于 PDF 复杂度
• 需要预先配置 MinerU Token 和辅助模型
• 转换进度会在界面右下角显示

🎯 **核心功能**：
• 支持 OCR 识别扫描版 PDF
• 支持翻译为目标语言
• 转换完成后自动导入书库

📊 **返回内容**：
转换启动状态`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因"),
    pdfPath: z.string().min(1).describe("PDF 文件的完整路径，如 D:\\Books\\paper.pdf"),
    ocr: z.boolean().default(true).describe("是否启用 OCR 识别（扫描版 PDF 需要）"),
    translate: z
      .enum(["zh", "en", "ja", "ko"])
      .optional()
      .describe("翻译目标语言：zh=中文, en=英文, ja=日文, ko=韩文，不传则不翻译"),
  }),

  execute: async ({
    reasoning,
    pdfPath,
    ocr,
    translate,
  }: {
    reasoning: string;
    pdfPath: string;
    ocr: boolean;
    translate?: string;
  }) => {
    try {
      // 验证路径基本格式
      if (!pdfPath.toLowerCase().endsWith(".pdf")) {
        return {
          results: {
            success: false,
            message: "文件路径必须以 .pdf 结尾",
          },
          meta: { reasoning, pdfPath },
        };
      }

      // 启动转换（异步）
      await startConvert(pdfPath, ocr, translate);

      // 设置进度监听，转换完成后自动入库
      let epubPath: string | undefined;
      const unlisten = await listenConvertProgress((progress: ConvertProgress) => {
        if (progress.type === "done" && progress.epub_path) {
          epubPath = progress.epub_path;
          // 自动导入
          importConvertedEpub(progress.epub_path)
            .then(() => {
              console.log("[ConvertPdf] 转换完成并已入库:", progress.epub_path);
            })
            .catch((e) => {
              console.error("[ConvertPdf] 入库失败:", e);
            });
        }
      });

      // 5秒后取消监听（避免内存泄漏，实际进度由 UI 组件处理）
      setTimeout(() => unlisten(), 5000);

      return {
        results: {
          success: true,
          message: `已启动 PDF 转换任务：${pdfPath}`,
          details: {
            ocr,
            translate: translate || "不翻译",
          },
          note: "转换进度将在界面右下角显示，完成后会自动导入书库",
        },
        meta: { reasoning, pdfPath },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "未知错误";
      // 提供更友好的错误提示
      if (errorMessage.includes("MinerU Token")) {
        throw new Error("请先在 设置 → PDF 转换 中配置 MinerU Token");
      }
      if (errorMessage.includes("辅助模型")) {
        throw new Error("请先在 设置 → 模型提供商 中配置辅助模型");
      }
      throw new Error(`PDF 转换失败: ${errorMessage}`);
    }
  },
});
