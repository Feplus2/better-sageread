/**
 * 全局助手工具：向量化索引（书籍 + 论文）
 *
 * 为书籍/论文构建语义向量索引，使助手能通过 RAG 检索内容回答问题。
 * EPUB 书籍走 indexEpub；MARKDOWN 论文走 vectorizePaper（index_paper，论文专用分块）。
 * 支持单本模式和批量模式（自动检测所有未向量化的条目）。
 *
 * P2-2/P2-3：执行统一入 task-center 通道（图书 book-vectorize / 论文 paper-vectorize，
 * enqueueAndWait 阻塞等结算，保持"全部完成后汇总返回"语义）——与 book-item 按钮、
 * 设置页全量重建、文献库批量条同一队列，同条目在队/在跑由队列幂等拒入，不再多入口打架。
 */
import { type LibraryKind, filterByKind } from "@/ai/tools/book";
import { getBooksWithStatus } from "@/services/book-service";
import { enqueueBookVectorizeAndWait } from "@/services/task-executors/book-vectorize";
import type { BookVectorizeResult } from "@/services/task-executors/book-vectorize";
import { type PaperVectorizeResult, enqueuePaperVectorizeAndWait } from "@/services/task-executors/paper-vectorize";
import type { BookWithStatus } from "@/types/simple-book";
import { tool } from "ai";
import { z } from "zod";

/** 判断一本书是否已成功向量化 */
function isVectorized(book: BookWithStatus): boolean {
  const vec = book.status?.metadata?.vectorization;
  return vec?.status === "success";
}

/** 拒入队/执行失败的错误消息 → 工具口径文案（队列幂等去重与冲突拒绝不算异常，给引导性描述） */
function rejectionMessage(title: string, error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (raw.includes("已在该队列中")) return `《${title}》正在向量化或排队中，无需重复发起`;
  if (raw.startsWith("《")) return raw;
  return `《${title}》${raw}`;
}

/** 对单个条目执行向量化（入队并阻塞等结算），返回结果描述 */
async function vectorizeSingleQueued(
  item: BookWithStatus,
): Promise<{ success: boolean; message: string; chunkCount?: number }> {
  try {
    if (item.format === "MARKDOWN") {
      const task = await enqueuePaperVectorizeAndWait({ id: item.id, title: item.title, author: item.author ?? "" });
      const result = task.result as PaperVectorizeResult | undefined;
      const chunkCount = result?.chunkCount ?? 0;
      return { success: true, message: `《${item.title}》向量化完成，分块数：${chunkCount}`, chunkCount };
    }
    const task = await enqueueBookVectorizeAndWait({ id: item.id, title: item.title });
    const result = task.result as BookVectorizeResult | undefined;
    const chunkCount = result?.chunkCount ?? 0;
    return { success: true, message: `《${item.title}》向量化完成，分块数：${chunkCount}`, chunkCount };
  } catch (error) {
    return { success: false, message: rejectionMessage(item.title, error) };
  }
}

export const vectorizeBookTool = tool({
  description: `管理书籍/论文的语义向量索引（RAG）：查询状态或执行向量化。

📚 **书籍 vs 论文（自动路由，无需区分操作）**：
• EPUB 书籍与 MARKDOWN 论文都支持向量化，工具按条目格式自动选择对应引擎
• kind 参数用于过滤目标：用户说"把书都向量化"传 kind=book，"把论文都向量化"传 kind=paper

🎯 **核心功能**：
• status：查询条目的向量化状态（不执行任何操作）；返回的 items 是全量条目清单（id+title+状态），可当发现清单用
• index + bookId：向量化指定条目。**先用 getBooks(kind=paper 或 book) 按标题/作者查得条目 ID**；topic 式描述查不到时，先 action=status 列全部条目，让用户的描述与标题人工对齐后再执行
• index + 省略 bookId：自动检测并逐个向量化所有未索引的条目

⚠️ **注意**：
• 索引耗时较长（取决于内容长度和 Embedding 模型速度），调用会阻塞到完成；已有任务在跑时自动排队接续
• 需要已配置 Embedding 模型（外部 API 或本地模型）
• 非 EPUB/MARKDOWN 格式（如 PDF 书籍）不支持，需先转 EPUB

📊 **返回内容**：
向量化状态或执行结果`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因"),
    action: z.enum(["index", "status"]).default("index").describe("操作类型：index=执行向量化, status=仅查询状态"),
    bookId: z
      .string()
      .optional()
      .describe(
        "要向量化的条目 ID。先用 getBooks 按标题/作者查得；topic 式描述查不到时先 action=status 列全部条目人工对齐。省略时自动批量向量化所有未索引的条目",
      ),
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

        const result = await vectorizeSingleQueued(book);

        return {
          results: {
            success: result.success,
            message: result.message,
            chunkCount: result.chunkCount,
          },
          meta: { reasoning, bookId },
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

      // 逐条入队并阻塞等结算（通道内串行；单条失败/拒入不中断整批，结束统一汇总——语义同旧串行循环）
      let successCount = 0;
      let failCount = 0;
      const details: { title: string; success: boolean; message: string }[] = [];

      for (const item of vectorizable) {
        const result = await vectorizeSingleQueued(item);
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
        meta: { reasoning, kind: kind ?? "all" },
      };
    } catch (error) {
      throw new Error(`向量化失败: ${error instanceof Error ? error.message : "未知错误"}`);
    }
  },
});
