/**
 * 全局助手工具（批次 F4）：解析单篇 PDF 论文并导入 SageRead 文献库。
 *
 * 链路本体已收进 paper-service 的 importPaperPdf（P2 参考文献卡片「获取 PDF」同款链路）：
 * 经 task-center 的 paper-parse 通道入队（startPaperPdfImport 薄壳）→ waitTask 阻塞等结算
 * → importPapers(paper_dir) 落库 → 返回 paper id/title。
 * 注意与 importBook（进书库）是两条链路：本工具产物是 paper.md，进「文献库」。
 */
import { createFolder, importPaperPdf, listFolders } from "@/services/paper-service";
import { tool } from "ai";
import { z } from "zod";

export const importPaperTool = tool({
  description: `解析单篇 PDF 论文并导入 SageRead 文献库（Papers_Converter 引擎解析为 paper.md 后入库）。

🎯 **核心功能**：
• 输入本地 PDF 路径，触发解析（引擎与 Token 配置沿用 设置 → PDF 转换），完成后自动入库
• 可选指定文献库文件夹（不存在会自动创建）
• 解析通常需 2~15 分钟，本工具会阻塞等待结果
• 与 importBook（进书库）是两条独立链路：本工具进「文献库」，适合学术论文

📊 **返回内容**：
导入结果（paper id / 标题 / 所在文件夹）`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因"),
    filePath: z.string().min(1).describe("论文 PDF 的完整本地路径，如 D:\\Downloads\\paper.pdf"),
    folderName: z.string().optional().describe("导入后归入的文献库文件夹名（可选，不存在自动创建）"),
  }),

  execute: async (
    { reasoning, filePath, folderName }: { reasoning: string; filePath: string; folderName?: string },
    options?: { abortSignal?: AbortSignal },
  ) => {
    const fail = (message: string) => ({
      results: { success: false, message },
      meta: { reasoning, filePath },
    });

    // 解析目标文件夹（不存在自动创建）
    let folderId: string | undefined;
    if (folderName?.trim()) {
      try {
        const folders = await listFolders();
        const existing = folders.find((f) => f.name === folderName.trim());
        folderId = existing?.id ?? (await createFolder(folderName.trim())).id;
      } catch (error) {
        return fail(`文件夹准备失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const outcome = await importPaperPdf(filePath, folderId, options?.abortSignal);
    if (!outcome.success) {
      return fail(outcome.message);
    }
    return {
      results: { ...outcome, folder: folderName?.trim() || undefined },
      meta: { reasoning, filePath },
    };
  },
});
