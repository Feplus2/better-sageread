/**
 * 全局助手工具：书籍（EPUB）全书翻译与译本状态查询（2026-08-31，docs/book-convert-queue-plan.md 卡 2）。
 *
 * 与阅读器翻译下拉同一链路：入 task-center 的 book-translate 通道（enqueueBookTranslateAndWait
 * 阻塞等结算，保持"完成后告知结果"语义）；翻译完成后自动顺带句级对齐（与 UI 行为一致，
 * 无嵌入能力时对齐跳过不抛错）。同书互斥（翻译×向量化×转换）由入队口统一冲突检查器
 * 拒入（utils/task-conflict；不同书全豁免）；同书重复发起由队列幂等拒入。
 */
import { getBookStatus, getBooksWithStatus } from "@/services/book-service";
import { summarizeBookAlignment } from "@/services/book-translation/book-alignment";
import { listBookTranslationSectionIndexes } from "@/services/book-translation/book-translation-service";
import { type BookTranslateTaskResult, enqueueBookTranslateAndWait } from "@/services/task-executors/book-translate";
import { tool } from "ai";
import { z } from "zod";

/** 拒入队/执行失败的错误消息 → 工具口径文案（幂等去重与冲突拒绝不算异常，给引导性描述） */
function rejectionMessage(title: string, error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (raw.includes("已在该队列中")) return `《${title}》正在翻译或排队中，无需重复发起`;
  if (raw.startsWith("《")) return raw;
  return `《${title}》${raw}`;
}

/** 单书译本状态查询（status 动作） */
async function bookTranslationStatus(bookId: string, title: string) {
  const status = await getBookStatus(bookId);
  const meta = status?.metadata?.translation ?? null;
  const sectionCount = (await listBookTranslationSectionIndexes(bookId)).length;
  const align = await summarizeBookAlignment(bookId);
  const hasTranslation = sectionCount > 0;
  return {
    id: bookId,
    title,
    hasTranslation,
    status: meta?.status ?? "idle",
    doneBlocks: meta?.doneBlocks ?? 0,
    totalBlocks: meta?.totalBlocks ?? 0,
    sectionCount,
    failedBatches: meta?.failedBatches ?? 0,
    alignment: align ? { alignedSentences: align.aligned, alignedWords: align.alignedW, total: align.total } : null,
    message: !hasTranslation
      ? "尚未翻译"
      : meta?.status === "complete"
        ? `译本完整 · ${meta.doneBlocks}/${meta.totalBlocks} 段；句对齐 ${align?.aligned ?? 0}/${align?.total ?? 0}，词对齐 ${align?.alignedW ?? 0}/${align?.total ?? 0}`
        : `译本不完整（可续翻） · ${meta?.doneBlocks ?? 0}/${meta?.totalBlocks ?? 0} 段${meta?.failedBatches ? ` · ${meta.failedBatches} 批失败` : ""}`,
  };
}

export const translateBookTool = tool({
  description: `书籍（EPUB）的全书翻译与译本状态查询。

📚 **适用范围**：仅书库 EPUB 书籍；论文（文献库 MARKDOWN 条目）翻译请用 processPaper；PDF 书籍需先经 convertPdf 转成 EPUB。

🎯 **核心功能**：
• action=status：查询译本体状态（有无译本/完整度/失败批次/句词对齐覆盖率）；省略 bookId 时列出全部书籍的翻译状态
• action=translate：翻译全书——默认幂等续翻（已翻段自动跳过，中断后续翻成本最低）；force=true 全量重翻（已有译文作废重翻，耗时与额度消耗与首翻相当，先与用户确认）。
  翻译完成后**自动顺带执行句级对齐**（与阅读器界面行为一致）

⚠️ **注意**：
• 翻译耗时较长（取决于书长与辅助模型速度），translate 会阻塞等待直到完成；进度见应用右下角「图书翻译」任务卡
• 需要已配置辅助模型；句级对齐另需嵌入模型（未配置时对齐自动跳过，翻译本体不受影响）
• 同书互斥：该书正在向量化/转换/已有翻译任务在跑时会被拒绝并返回原因，等其完成后再试；不同书互不影响
• 先用 getBooks(kind=book) 按书名/作者查得 bookId；拿不准时先 action=status 列全部书籍人工对齐

📊 **返回内容**：
状态查询返回译本体与对齐统计；翻译返回翻译统计（新翻/跳过/失败批次）与对齐覆盖数`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因"),
    action: z
      .enum(["status", "translate"])
      .default("translate")
      .describe("status=查询译本状态, translate=翻译全书（完成后自动带句级对齐）"),
    bookId: z
      .string()
      .optional()
      .describe("目标书籍 ID（用 getBooks(kind=book) 查询）；translate 必填，status 省略时列出全部书籍"),
    force: z
      .boolean()
      .optional()
      .describe("仅 translate 用：false=续翻跳过已翻（默认），true=全量重翻（已有译文作废）"),
  }),

  execute: async ({
    reasoning,
    action,
    bookId,
    force,
  }: {
    reasoning: string;
    action: "status" | "translate";
    bookId?: string;
    force?: boolean;
  }) => {
    const meta = { reasoning, action, bookId };
    try {
      // ==================== 状态查询 ====================
      if (action === "status") {
        if (bookId) {
          const book = (await getBooksWithStatus({ limit: 500 })).find((b) => b.id === bookId);
          if (!book) {
            return { results: { success: false, message: `未找到 ID 为 "${bookId}" 的书籍` }, meta };
          }
          return { results: { success: true, ...(await bookTranslationStatus(book.id, book.title)) }, meta };
        }
        const books = (await getBooksWithStatus({ limit: 500 })).filter((b) => b.format === "EPUB");
        const items = [];
        for (const b of books) {
          items.push(await bookTranslationStatus(b.id, b.title));
        }
        const translated = items.filter((i) => i.hasTranslation).length;
        return {
          results: {
            success: true,
            message: `共 ${books.length} 本 EPUB 书籍，${translated} 本已有译本，${books.length - translated} 本未翻译`,
            totalItems: books.length,
            translatedCount: translated,
            items,
          },
          meta,
        };
      }

      // ==================== 翻译全书 ====================
      if (!bookId) {
        return {
          results: { success: false, message: "translate 需要 bookId——先用 getBooks(kind=book) 按书名查得" },
          meta,
        };
      }
      const book = (await getBooksWithStatus({ limit: 500 })).find((b) => b.id === bookId);
      if (!book) {
        return { results: { success: false, message: `未找到 ID 为 "${bookId}" 的书籍` }, meta };
      }
      if (book.format === "MARKDOWN") {
        return {
          results: { success: false, message: `《${book.title}》是论文（MARKDOWN），论文翻译请用 processPaper` },
          meta,
        };
      }
      if (book.format !== "EPUB") {
        return {
          results: {
            success: false,
            message: `《${book.title}》为 ${book.format} 格式，仅 EPUB 书籍支持全书翻译——PDF 请先用 convertPdf 转成 EPUB`,
          },
          meta,
        };
      }

      try {
        // 入翻译通道阻塞等结算：同书互斥/幂等去重由入队口判定；翻译后自动对齐在执行器内
        const task = await enqueueBookTranslateAndWait({ id: book.id, title: book.title, force: force ?? false });
        const settled = task.result as BookTranslateTaskResult | undefined;
        const translation = settled?.translation;
        if (!translation) {
          return { results: { success: false, message: "翻译结算产物缺失" }, meta };
        }
        // 对齐抛错（非取消）按失败透传（译本已落盘，可重试或阅读器内重建）
        if (settled?.alignError) {
          return { results: { success: false, message: `翻译完成但对齐失败：${settled.alignError}` }, meta };
        }
        const align = settled?.alignment;
        const translateMsg =
          translation.failedBatches > 0
            ? `新翻 ${translation.translated} 段，${translation.failedBatches} 个批次失败已跳过（可再次 translate 补齐）`
            : translation.translated > 0
              ? `新翻 ${translation.translated} 段，跳过已翻 ${translation.skipped} 段`
              : "所有段落均已有译文";
        const alignMsg = !align
          ? "对齐未执行"
          : align.status === "done"
            ? `句对齐 ${align.computed + align.reused}/${align.total}`
            : align.status === "skipped"
              ? `对齐已跳过（${align.reason === "no-vector-capability" ? "未配置嵌入模型" : (align.reason ?? "未知原因")}）`
              : `对齐部分完成（失败 ${align.failed} 段，可在阅读器翻译菜单重建）`;

        return {
          results: {
            success: true,
            message: `《${book.title}》翻译完成：${translateMsg}；${alignMsg}。可在阅读器顶栏「翻译」菜单切换显示模式查看`,
            translation,
            alignment: align
              ? {
                  status: align.status,
                  total: align.total,
                  computed: align.computed,
                  reused: align.reused,
                  failed: align.failed,
                }
              : null,
          },
          meta,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes("已取消")) {
          return {
            results: { success: false, message: "翻译被中止，已翻译部分已保存，可用 action=translate 续翻" },
            meta,
          };
        }
        // 拒入队（冲突/重复）或执行失败（守卫文案已含引导，如中文书/fixed-layout/未配置模型）
        return { results: { success: false, message: rejectionMessage(book.title, msg) }, meta };
      }
    } catch (error) {
      return {
        results: { success: false, message: `操作失败：${error instanceof Error ? error.message : String(error)}` },
        meta,
      };
    }
  },
});
