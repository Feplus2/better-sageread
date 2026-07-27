/**
 * 全局助手工具：向量化索引
 *
 * 为书籍构建语义向量索引，使阅读助手能通过 RAG 检索书籍内容回答问题。
 * 支持单本模式和批量模式（自动检测所有未向量化的书）。
 */
import {
  type EpubIndexResult,
  getBooksWithStatus,
  indexEpub,
  updateBookVectorizationMeta,
} from "@/services/book-service";
import type { BookWithStatus } from "@/types/simple-book";
import { getCurrentVectorModelConfig } from "@/utils/model";
import { tool } from "ai";
import { z } from "zod";

/** 判断一本书是否已成功向量化 */
function isVectorized(book: BookWithStatus): boolean {
  const vec = book.status?.metadata?.vectorization;
  return vec?.status === "success";
}

/** 对单本书执行向量化，返回结果描述 */
async function vectorizeSingle(
  bookId: string,
  bookTitle: string,
  config: { embeddingsUrl: string; model: string; apiKey: string | null; dimension: number },
): Promise<{ success: boolean; message: string; chunkCount?: number }> {
  try {
    await updateBookVectorizationMeta(bookId, {
      status: "processing",
      model: config.model,
      dimension: config.dimension,
      version: 1,
      startedAt: Date.now(),
    });

    const res: EpubIndexResult = await indexEpub(bookId, {
      dimension: config.dimension,
      embeddingsUrl: config.embeddingsUrl,
      model: config.model,
      apiKey: config.apiKey,
    });

    if (res?.success && res.report) {
      await updateBookVectorizationMeta(bookId, {
        status: "success",
        chunkCount: res.report.total_chunks,
        dimension: res.report.vector_dimension,
        finishedAt: Date.now(),
      });
      return {
        success: true,
        message: `《${bookTitle}》向量化完成，分块数：${res.report.total_chunks}`,
        chunkCount: res.report.total_chunks,
      };
    }

    await updateBookVectorizationMeta(bookId, {
      status: "failed",
      finishedAt: Date.now(),
    });
    return { success: false, message: `《${bookTitle}》向量化失败：${res?.message || "未知错误"}` };
  } catch (error) {
    await updateBookVectorizationMeta(bookId, {
      status: "failed",
      finishedAt: Date.now(),
    }).catch(() => {});
    return {
      success: false,
      message: `《${bookTitle}》向量化失败：${error instanceof Error ? error.message : "未知错误"}`,
    };
  }
}

export const vectorizeBookTool = tool({
  description: `管理书籍的语义向量索引（RAG）：查询状态或执行向量化。

🎯 **核心功能**：
• status：查询所有书籍的向量化状态（不执行任何操作）
• index + bookId：向量化指定书籍
• index + 省略 bookId：自动检测并逐本向量化所有未索引的书

⚠️ **注意**：
• 索引耗时较长（取决于书籍长度和 Embedding 模型速度）
• 需要已配置 Embedding 模型（外部 API 或本地模型）

📊 **返回内容**：
向量化状态或执行结果`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因"),
    action: z.enum(["index", "status"]).default("index").describe("操作类型：index=执行向量化, status=仅查询状态"),
    bookId: z.string().optional().describe("要向量化的书籍 ID。省略时自动批量向量化所有未索引的书"),
  }),

  execute: async ({
    reasoning,
    action,
    bookId,
  }: {
    reasoning: string;
    action: "index" | "status";
    bookId?: string;
  }) => {
    try {
      // ==================== 状态查询模式 ====================
      if (action === "status") {
        const allBooks = await getBooksWithStatus({ limit: 500 });
        const statusList = allBooks.map((b) => {
          const vec = b.status?.metadata?.vectorization;
          return {
            id: b.id,
            title: b.title,
            vectorized: vec?.status === "success",
            status: vec?.status ?? "idle",
            chunkCount: vec?.chunkCount ?? null,
            model: vec?.model || null,
            finishedAt: vec?.finishedAt ?? null,
          };
        });

        const vectorizedCount = statusList.filter((s) => s.vectorized).length;
        return {
          results: {
            success: true,
            message: `共 ${allBooks.length} 本书，已向量化 ${vectorizedCount} 本，未向量化 ${allBooks.length - vectorizedCount} 本`,
            totalBooks: allBooks.length,
            vectorizedCount,
            unvectorizedCount: allBooks.length - vectorizedCount,
            books: statusList,
          },
          meta: { reasoning },
        };
      }

      // ==================== 向量化模式 ====================
      // 获取 Embedding 模型配置
      const config = await getCurrentVectorModelConfig();

      // ==================== 单本模式 ====================
      if (bookId) {
        const books = await getBooksWithStatus({ limit: 200 });
        const book = books.find((b) => b.id === bookId);

        if (!book) {
          return {
            results: {
              success: false,
              message: `未找到 ID 为 "${bookId}" 的书籍`,
            },
            meta: { reasoning, bookId },
          };
        }

        if (book.format !== "EPUB") {
          return {
            results: {
              success: false,
              message: `《${book.title}》为 ${book.format} 格式，向量化仅支持 EPUB。请先将 PDF 转换为 EPUB（设置 → PDF 转换）`,
            },
            meta: { reasoning, bookId, format: book.format },
          };
        }

        if (isVectorized(book)) {
          return {
            results: {
              success: true,
              message: `《${book.title}》已完成向量化，无需重复操作`,
              alreadyVectorized: true,
            },
            meta: { reasoning, bookId },
          };
        }

        const result = await vectorizeSingle(bookId, book.title, config);

        return {
          results: {
            success: result.success,
            message: result.message,
            chunkCount: result.chunkCount,
          },
          meta: { reasoning, bookId, model: config.model, source: config.source },
        };
      }

      // ==================== 批量模式 ====================
      const allBooks = await getBooksWithStatus({ limit: 500 });
      // 只对 EPUB 格式执行向量化，PDF 等非 EPUB 格式跳过
      const unvectorizedBooks = allBooks.filter((b) => !isVectorized(b) && b.format === "EPUB");
      const skippedNonEpub = allBooks.filter((b) => !isVectorized(b) && b.format !== "EPUB");

      if (unvectorizedBooks.length === 0) {
        const msg = skippedNonEpub.length > 0
          ? `所有 EPUB 书籍均已完成向量化。另有 ${skippedNonEpub.length} 本非 EPUB 格式书籍不支持向量化`
          : `所有 ${allBooks.length} 本书均已完成向量化，无需操作`;
        return {
          results: {
            success: true,
            message: msg,
            totalBooks: allBooks.length,
            alreadyVectorized: true,
            skippedNonEpub: skippedNonEpub.length,
          },
          meta: { reasoning },
        };
      }

      // 逐本串行向量化
      let successCount = 0;
      let failCount = 0;
      const details: { title: string; success: boolean; message: string }[] = [];

      for (const book of unvectorizedBooks) {
        const result = await vectorizeSingle(book.id, book.title, config);
        if (result.success) {
          successCount++;
        } else {
          failCount++;
        }
        details.push({ title: book.title, success: result.success, message: result.message });
      }

      const skippedNote = skippedNonEpub.length > 0 ? `（跳过 ${skippedNonEpub.length} 本非 EPUB 格式）` : "";
      return {
        results: {
          success: successCount > 0,
          message: `批量向量化完成：共 ${unvectorizedBooks.length} 本 EPUB，成功 ${successCount} 本${failCount > 0 ? `，失败 ${failCount} 本` : ""}${skippedNote}`,
          total: unvectorizedBooks.length,
          successCount,
          failCount,
          skippedNonEpub: skippedNonEpub.length,
          details,
        },
        meta: { reasoning, model: config.model, source: config.source },
      };
    } catch (error) {
      throw new Error(`向量化失败: ${error instanceof Error ? error.message : "未知错误"}`);
    }
  },
});
