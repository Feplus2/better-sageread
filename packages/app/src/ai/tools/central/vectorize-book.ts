/**
 * 全局助手工具：向量化索引（书籍 + 论文）
 *
 * 为书籍/论文构建语义向量索引，使助手能通过 RAG 检索内容回答问题。
 * EPUB 书籍走 indexEpub；MARKDOWN 论文走 vectorizePaper（index_paper，论文专用分块）。
 * 支持单本模式和批量模式（自动检测所有未向量化的条目）。
 */
import { type LibraryKind, filterByKind } from "@/ai/tools/book";
import {
  type EpubIndexResult,
  getBooksWithStatus,
  indexEpub,
  updateBookVectorizationMeta,
} from "@/services/book-service";
import { vectorizePaper } from "@/services/paper-service";
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

/** 对单篇论文执行向量化（vectorizePaper 内部已管理 meta 状态与失败回写） */
async function vectorizePaperSingle(
  paperId: string,
  paperTitle: string,
  paperAuthor: string,
): Promise<{ success: boolean; message: string; chunkCount?: number }> {
  try {
    const res = await vectorizePaper({ id: paperId, title: paperTitle, author: paperAuthor });
    return {
      success: true,
      message: `《${paperTitle}》向量化完成，分块数：${res.report?.total_chunks ?? 0}`,
      chunkCount: res.report?.total_chunks ?? 0,
    };
  } catch (error) {
    return {
      success: false,
      message: `《${paperTitle}》向量化失败：${error instanceof Error ? error.message : "未知错误"}`,
    };
  }
}

/** 按 format 执行向量化：EPUB → indexEpub；MARKDOWN → index_paper；其余拒绝（导出供设置页「全量重新向量化」复用，G1-3） */
export function vectorizeItem(
  item: BookWithStatus,
  config: { embeddingsUrl: string; model: string; apiKey: string | null; dimension: number },
) {
  if (item.format === "MARKDOWN") {
    return vectorizePaperSingle(item.id, item.title, item.author ?? "");
  }
  return vectorizeSingle(item.id, item.title, config);
}

export const vectorizeBookTool = tool({
  description: `管理书籍/论文的语义向量索引（RAG）：查询状态或执行向量化。

📚 **书籍 vs 论文（自动路由，无需区分操作）**：
• EPUB 书籍与 MARKDOWN 论文都支持向量化，工具按条目格式自动选择对应引擎
• kind 参数用于过滤目标：用户说"把书都向量化"传 kind=book，"把论文都向量化"传 kind=paper

🎯 **核心功能**：
• status：查询条目的向量化状态（不执行任何操作）
• index + bookId：向量化指定条目
• index + 省略 bookId：自动检测并逐个向量化所有未索引的条目

⚠️ **注意**：
• 索引耗时较长（取决于内容长度和 Embedding 模型速度）
• 需要已配置 Embedding 模型（外部 API 或本地模型）
• 非 EPUB/MARKDOWN 格式（如 PDF 书籍）不支持，需先转 EPUB

📊 **返回内容**：
向量化状态或执行结果`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因"),
    action: z.enum(["index", "status"]).default("index").describe("操作类型：index=执行向量化, status=仅查询状态"),
    bookId: z.string().optional().describe("要向量化的条目 ID。省略时自动批量向量化所有未索引的条目"),
    kind: z
      .enum(["book", "paper", "all"])
      .optional()
      .describe("目标类型：book=仅书籍, paper=仅论文, all=全部（默认）。status/批量 index 时作为过滤条件"),
  }),

  execute: async ({
    reasoning,
    action,
    bookId,
    kind,
  }: {
    reasoning: string;
    action: "index" | "status";
    bookId?: string;
    kind?: LibraryKind;
  }) => {
    try {
      // ==================== 状态查询模式 ====================
      if (action === "status") {
        const allBooks = filterByKind(await getBooksWithStatus({ limit: 500 }), kind);
        const statusList = allBooks.map((b) => {
          const vec = b.status?.metadata?.vectorization;
          return {
            id: b.id,
            title: b.title,
            kind: b.format === "MARKDOWN" ? "paper" : "book",
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
            message: `共 ${allBooks.length} 个条目，已向量化 ${vectorizedCount} 个，未向量化 ${allBooks.length - vectorizedCount} 个`,
            totalItems: allBooks.length,
            vectorizedCount,
            unvectorizedCount: allBooks.length - vectorizedCount,
            items: statusList,
          },
          meta: { reasoning, kind: kind ?? "all" },
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
              message: `未找到 ID 为 "${bookId}" 的条目`,
            },
            meta: { reasoning, bookId },
          };
        }

        if (book.format !== "EPUB" && book.format !== "MARKDOWN") {
          return {
            results: {
              success: false,
              message: `《${book.title}》为 ${book.format} 格式，向量化仅支持 EPUB 书籍与 MARKDOWN 论文。请先将 PDF 转换为 EPUB（设置 → PDF 转换）`,
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

        const result = await vectorizeItem(book, config);

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
      const allBooks = filterByKind(await getBooksWithStatus({ limit: 500 }), kind);
      // 只对 EPUB/MARKDOWN 执行向量化，其余格式（PDF 等）跳过
      const vectorizable = allBooks.filter((b) => !isVectorized(b) && (b.format === "EPUB" || b.format === "MARKDOWN"));
      const skippedUnsupported = allBooks.filter(
        (b) => !isVectorized(b) && b.format !== "EPUB" && b.format !== "MARKDOWN",
      );

      if (vectorizable.length === 0) {
        const msg =
          skippedUnsupported.length > 0
            ? `所有可向量化的书籍/论文均已完成。另有 ${skippedUnsupported.length} 个不支持格式的条目未处理`
            : `所有 ${allBooks.length} 个条目均已完成向量化，无需操作`;
        return {
          results: {
            success: true,
            message: msg,
            totalItems: allBooks.length,
            alreadyVectorized: true,
            skippedUnsupported: skippedUnsupported.length,
          },
          meta: { reasoning, kind: kind ?? "all" },
        };
      }

      // 逐个串行向量化（EPUB 走 indexEpub，MARKDOWN 走 index_paper）
      let successCount = 0;
      let failCount = 0;
      const details: { title: string; success: boolean; message: string }[] = [];

      for (const item of vectorizable) {
        const result = await vectorizeItem(item, config);
        if (result.success) {
          successCount++;
        } else {
          failCount++;
        }
        details.push({ title: item.title, success: result.success, message: result.message });
      }

      const skippedNote = skippedUnsupported.length > 0 ? `（跳过 ${skippedUnsupported.length} 个不支持格式）` : "";
      return {
        results: {
          success: successCount > 0,
          message: `批量向量化完成：共 ${vectorizable.length} 个条目，成功 ${successCount} 个${failCount > 0 ? `，失败 ${failCount} 个` : ""}${skippedNote}`,
          total: vectorizable.length,
          successCount,
          failCount,
          skippedUnsupported: skippedUnsupported.length,
          details,
        },
        meta: { reasoning, kind: kind ?? "all", model: config.model, source: config.source },
      };
    } catch (error) {
      throw new Error(`向量化失败: ${error instanceof Error ? error.message : "未知错误"}`);
    }
  },
});
