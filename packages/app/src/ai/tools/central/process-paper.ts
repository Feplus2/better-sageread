import { parsePaperMarkdown } from "@/pages/paper-reader/paper-metadata";
/**
 * 全局助手工具（2026-08-07）：论文翻译、句词对齐与重新解析（文献库论文专属）。
 *
 * 与论文阅读器 UI 的同款链路复用：
 * - translatePaper（paper-translation-service）：幂等续翻/force 重翻，逐批落盘
 * - alignPaperTranslation（paper-alignment-service）：句级 + 词级对齐一条龙（需嵌入模型，
 *   无嵌入能力时跳过不抛错）；translate 动作完成后自动执行对齐（与 UI 行为一致）
 * - inspectPaperAlignment：对齐覆盖统计（status 动作用）
 * - reparsePapers（paper-reparse-service，I1）：源 PDF 重走解析器并整体替换产物，
 *   保留论文 id/文件夹归属/对话/标注（与文献库页批量重解析同款）
 */
import { alignPaperTranslation, inspectPaperAlignment } from "@/services/paper-alignment-service";
import { reparsePapers } from "@/services/paper-reparse-service";
import { loadPaperTranslation, translatePaper } from "@/services/paper-translation-service";
import { appDataDir } from "@tauri-apps/api/path";
import { exists, readTextFile } from "@tauri-apps/plugin-fs";
import { tool } from "ai";
import { z } from "zod";

/** 读取论文 markdown 源文（{appData}/books/{paperId}/paper.md） */
async function readPaperMarkdown(paperId: string): Promise<string> {
  const base = await appDataDir();
  const parts = [base, "books", paperId, "paper.md"];
  // appDataDir 在 Windows 带尾部分隔符，join 手动拼避免畸形
  const path = parts
    .join("/")
    .replace(/[/\\]+/g, "/")
    .replace(":/", ":/");
  if (!(await exists(path))) {
    throw new Error(`论文不存在（paper.md 缺失）：${paperId}`);
  }
  return await readTextFile(path);
}

export const processPaperTool = tool({
  description: `文献库论文的翻译、句词对齐与重新解析管理。

📚 **适用范围**：仅文献库论文（MARKDOWN 格式）；书籍翻译请走 convertPdf 的转换链路。

🎯 **核心功能**：
• action=status：查询论文的翻译与对齐状态（有无译本、句/词对齐覆盖率）
• action=translate：翻译论文（force=false 续翻跳过已翻，force=true 全部重翻）；
  翻译完成后**自动顺带执行句级+词级对齐**（与阅读器界面行为一致）
• action=align：仅执行/重建对齐（force=false 幂等补齐，force=true 全量重算）
• action=reparse：用源 PDF 重新解析并替换正文（解析器升级/解析质量差时）；
  默认自动定位源 PDF，找不到时可用 filePath 显式指定

⚠️ **注意**：
• 翻译耗时较长（取决于论文长度与辅助模型速度），工具会阻塞等待直到完成
• 对齐需要已配置 Embedding 模型；未配置时对齐会跳过（翻译本体不受影响）
• reparse 后：已有译文的块转陈旧（下次 translate 自动更新），句词对齐需重建（align force=true），文内高亮可能漂移
• 先用 getBooks(kind=paper) 确认目标论文的 ID

📊 **返回内容**：
翻译统计（新翻/跳过/失败批次）与对齐统计（句/词对齐覆盖数）`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因"),
    action: z
      .enum(["status", "translate", "align", "reparse"])
      .describe(
        "status=查询状态, translate=翻译（自动带对齐）, align=仅对齐/重建对齐, reparse=用源PDF重新解析替换正文",
      ),
    paperId: z.string().min(1).describe("论文 ID（用 getBooks(kind=paper) 查询）"),
    force: z
      .boolean()
      .optional()
      .describe("translate: false=续翻跳过已翻(默认), true=全部重翻；align: false=幂等补齐(默认), true=全量重算"),
    filePath: z
      .string()
      .optional()
      .describe("仅 reparse 用：源 PDF 的完整本地路径（默认自动定位，找不到时才需显式指定）"),
  }),

  execute: async (
    {
      reasoning,
      action,
      paperId,
      force,
      filePath,
    }: {
      reasoning: string;
      action: "status" | "translate" | "align" | "reparse";
      paperId: string;
      force?: boolean;
      filePath?: string;
    },
    options?: { abortSignal?: AbortSignal },
  ) => {
    const meta = { reasoning, action, paperId };
    try {
      // ==================== 状态查询 ====================
      if (action === "status") {
        const markdown = await readPaperMarkdown(paperId);
        const file = await loadPaperTranslation(paperId);
        const alignInfo = await inspectPaperAlignment(markdown, file);
        const hasTranslation = !!file && Object.keys(file.blocks).length > 0;
        return {
          results: {
            success: true,
            hasTranslation,
            alignStatus: file?.alignStatus ?? null,
            alignWStatus: file?.alignWStatus ?? null,
            alignment: alignInfo
              ? {
                  total: alignInfo.total,
                  alignedSentences: alignInfo.aligned,
                  alignedWords: alignInfo.alignedW,
                }
              : null,
            message: hasTranslation
              ? `已有译本；句对齐 ${alignInfo?.aligned ?? 0}/${alignInfo?.total ?? 0}，词对齐 ${alignInfo?.alignedW ?? 0}/${alignInfo?.total ?? 0}`
              : "尚未翻译",
          },
          meta,
        };
      }

      // ==================== 翻译（自动带对齐） ====================
      if (action === "translate") {
        const markdown = await readPaperMarkdown(paperId);
        const result = await translatePaper({
          paperId,
          markdown,
          force: force ?? false,
          signal: options?.abortSignal,
        });
        if (result.cancelled) {
          return {
            results: {
              success: false,
              message: `翻译被中止，已翻译 ${result.translated} 块已保存，可用 action=translate 续翻`,
              translation: result,
            },
            meta,
          };
        }

        // 翻译完成后自动对齐（与 UI 行为一致；无嵌入能力时内部跳过并给 reason，不抛错）
        const align = await alignPaperTranslation({
          paperId,
          markdown,
          force: false,
          signal: options?.abortSignal,
        });

        const translateMsg =
          result.failedBatches > 0
            ? `新翻 ${result.translated} 块，${result.failedBatches} 个批次失败已跳过（可再次 translate 补齐）`
            : result.translated > 0
              ? `新翻 ${result.translated} 块，跳过已翻 ${result.skipped} 块`
              : "所有块均已有译文";
        const alignMsg =
          align.status === "done"
            ? `句对齐 ${align.computed + align.reused}/${align.total}，词对齐 ${align.words.computed + align.words.reused}/${align.words.total}`
            : align.status === "skipped"
              ? `对齐已跳过（${align.reason === "no-vector-capability" ? "未配置嵌入模型" : align.reason}）`
              : `对齐部分完成（句级失败 ${align.failed} 块，词级失败 ${align.words.failed} 块，可 action=align 补齐）`;

        return {
          results: {
            success: true,
            message: `翻译完成：${translateMsg}；${alignMsg}`,
            translation: result,
            alignment: {
              status: align.status,
              sentences: { total: align.total, computed: align.computed, reused: align.reused, failed: align.failed },
              words: align.words,
            },
          },
          meta,
        };
      }

      // ==================== 重新解析（I1：复用文献库页同款 reparse 服务） ====================
      if (action === "reparse") {
        const markdown = await readPaperMarkdown(paperId);
        const { metadata } = parsePaperMarkdown(markdown);
        const title = metadata.title || paperId;
        const report = await reparsePapers(
          [{ id: paperId, title, sourcePdfPath: filePath }],
          { [paperId]: metadata },
          { isCancelled: () => options?.abortSignal?.aborted === true },
        );
        if (report.cancelled) {
          return { results: { success: false, message: "重新解析被中止" }, meta };
        }
        if (report.failed.length > 0) {
          return {
            results: {
              success: false,
              message: `重新解析失败：${report.failed[0].error}${report.failed[0].error === "找不到源 PDF" ? "（可用 filePath 参数显式指定源 PDF 路径）" : ""}`,
            },
            meta,
          };
        }
        const suspectMsg =
          report.suspect.length > 0 ? "（⚠️ 检测到疑似退化重复内容，建议在设置→PDF转换中更换解析引擎后重试）" : "";
        return {
          results: {
            success: true,
            message: `重新解析完成${suspectMsg}。注意：正文已替换——已有译文的块转陈旧（下次 action=translate 会自动续翻更新），句词对齐需重建（action=align force=true），文内高亮可能漂移。`,
          },
          meta,
        };
      }

      // ==================== 仅对齐 ====================
      const markdown = await readPaperMarkdown(paperId);
      const align = await alignPaperTranslation({
        paperId,
        markdown,
        force: force ?? false,
        signal: options?.abortSignal,
      });

      if (align.status === "skipped") {
        const reasonMsg =
          align.reason === "no-translation"
            ? "该论文尚未翻译，请先 action=translate"
            : align.reason === "no-vector-capability"
              ? "未配置嵌入模型，请先在设置中配置向量模型"
              : "无可对齐内容";
        return {
          results: { success: false, message: `对齐跳过：${reasonMsg}` },
          meta,
        };
      }

      return {
        results: {
          success: true,
          message: `对齐${force ? "重建" : "补齐"}完成：句级新算 ${align.computed}/${align.total}（复用 ${align.reused}），词级新算 ${align.words.computed}/${align.words.total}（复用 ${align.words.reused}）${align.status === "partial" ? "（部分失败，可重试）" : ""}`,
          alignment: {
            status: align.status,
            sentences: { total: align.total, computed: align.computed, reused: align.reused, failed: align.failed },
            words: align.words,
          },
        },
        meta,
      };
    } catch (error) {
      return {
        results: { success: false, message: `操作失败：${error instanceof Error ? error.message : String(error)}` },
        meta,
      };
    }
  },
});
