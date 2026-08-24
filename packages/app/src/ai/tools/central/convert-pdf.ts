/**
 * 全局助手工具：PDF 转 EPUB 并入库
 *
 * P2-1：改为 task-center book-convert 通道入队并阻塞等结算（enqueueAndWait）——
 * 修复前工具自挂监听 5 秒即解除（「完成后自动导入」永不兑现、也无进度卡）；
 * 现在由通道执行器全程跟踪（右下角小卡可见），完成后自动入库并把结果返回给模型。
 */
import { type BookConvertResult, enqueueBookConvertAndWait } from "@/services/task-executors/book-convert";
import { tool } from "ai";
import { z } from "zod";

export const convertPdfTool = tool({
  description: `将 PDF 文件转换为 EPUB 格式并导入书库。

⚠️ **注意**：
• 转换过程可能需要几分钟，取决于 PDF 复杂度（调用会阻塞到转换结束）
• 需要预先配置 MinerU Token 和辅助模型
• 转换进度会在界面右下角显示
• 已有转换任务在跑时，本任务自动排队接续

🎯 **核心功能**：
• 支持 OCR 识别扫描版 PDF
• 支持翻译为目标语言
• 转换完成后自动导入书库

📊 **返回内容**：
转换结果（epubPath 与是否已导入书库）`,

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

      // 入队并阻塞等结算：done 后通道执行器自动入库，TaskItem.result 带回 epubPath/导入结果；
      // 排队/运行中被用户取消或转换失败 → reject 进下方 catch
      const task = await enqueueBookConvertAndWait({ pdfPath, ocr, translate: translate ?? "none", autoImport: true });
      const result = task.result as BookConvertResult | undefined;

      return {
        results: {
          success: true,
          message: result?.imported
            ? `PDF 转换完成，已导入书库：${pdfPath}`
            : `PDF 转换完成：${result?.epubPath || pdfPath}（自动导入未成功，可在界面右下角卡片手动重试导入）`,
          details: {
            ocr,
            translate: translate || "不翻译",
            epubPath: result?.epubPath,
            imported: result?.imported ?? false,
          },
        },
        meta: { reasoning, pdfPath },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "未知错误";
      // 提供更友好的错误提示
      if (errorMessage.includes("MinerU Token") || errorMessage.includes("PaddleOCR Token")) {
        throw new Error("请先在 设置 → PDF 转换 中配置当前引擎的 Token");
      }
      if (errorMessage.includes("辅助模型")) {
        throw new Error("请先在 设置 → 模型提供商 中配置辅助模型");
      }
      throw new Error(`PDF 转换失败: ${errorMessage}`);
    }
  },
});
