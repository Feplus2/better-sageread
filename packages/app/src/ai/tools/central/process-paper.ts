import { parsePaperMarkdown } from "@/pages/paper-reader/paper-metadata";
/**
 * 全局助手工具（2026-08-07）：论文翻译、句词对齐与重新解析（文献库论文专属）。
 *
 * 与论文阅读器 UI 的同款链路复用：
 * - translatePaper（paper-translation-service）：幂等续翻/force 重翻，逐批落盘
 * - alignPaperTranslation（paper-alignment-service）：句级 + 词级对齐一条龙（需嵌入模型，
 *   无嵌入能力时跳过不抛错）；translate 动作完成后自动执行对齐（与 UI 行为一致）
 * - inspectPaperAlignment：对齐覆盖统计（status 动作用）
 * - startPaperReparse（convert-progress-store，I1/冲突模型收尾）：重解析**入统一解析队列**
 *   异步执行（入队即返），去重/向量化互斥/标签页提示与文献库页完全同口径；
 *   产物整体替换，保留论文 id/文件夹归属/对话/标注
 *
 * P2-3：translate/align 改入 task-center 的 paper-translate 通道（enqueueAndWait 阻塞等结算，
 * 返回语义不变）；任务冲突模型守卫移到入队口（utils/paper-conflict 注入的 conflictChecker，
 * 与 PapersPage 批量按钮同一口径：解析×翻译同篇互斥、同篇翻译幂等去重），
 * 执行期的注册表 translate 槽打点由通道执行器负责（重解析互斥在 AI 路径同样成立）。
 */
import { type AlignResult, inspectPaperAlignment } from "@/services/paper-alignment-service";
import { resolvePaperSourcePdf } from "@/services/paper-reparse-service";
import { getPaperSourceStatus } from "@/services/paper-service";
import { loadPaperTranslation } from "@/services/paper-translation-service";
import { type PaperTranslateResult, enqueuePaperTranslateAndWait } from "@/services/task-executors/paper-translate";
import { startPaperReparse } from "@/store/convert-progress-store";
import { invoke } from "@tauri-apps/api/core";
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

📚 **适用范围**：仅文献库论文（MARKDOWN 格式）；书籍（EPUB）翻译请用 translateBook。

🎯 **核心功能**：
• action=status：查询论文的翻译与对齐状态（有无译本、句/词对齐覆盖率、译本/向量是否因重解析而陈旧）
• action=translate：翻译论文（force=false 续翻跳过已翻，force=true 全部重翻）；
  翻译完成后**自动顺带执行句级+词级对齐**（与阅读器界面行为一致）
• action=align：仅执行/重建对齐（force=false 幂等补齐，force=true 全量重算）
• action=reparse：用源文件（PDF 或 XML）重新解析并替换正文（解析器升级/解析质量差时）；
  **入统一解析队列异步执行，调用立即返回**（进度见应用右下角进度卡，完成后自动生成产物）；
  默认自动定位源文件（source.xml → Zotero 回链 PDF → 书库 source.pdf），找不到时可用 filePath 显式指定

⚠️ **注意**：
• 翻译耗时较长（取决于论文长度与辅助模型速度），translate/align 会阻塞等待直到完成；reparse 不入队阻塞、立即返回
• 对齐需要已配置 Embedding 模型；未配置时对齐会跳过（翻译本体不受影响）
• 同篇互斥：该论文正在解析队列中（排队或解析中）时，translate/align/reparse 会被拒绝并返回提示，需等解析完成后再试
• reparse 完成后：已有译文的块转陈旧（下次 translate 自动更新），句词对齐需重建（align force=true），文内高亮可能漂移
• 先用 getBooks(kind=paper) 确认目标论文的 ID

📊 **返回内容**：
翻译统计（新翻/跳过/失败批次）与对齐统计（句/词对齐覆盖数）`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因"),
    action: z
      .enum(["status", "translate", "align", "reparse"])
      .describe(
        "status=查询状态, translate=翻译（自动带对齐）, align=仅对齐/重建对齐, reparse=用源文件（PDF/XML）重新解析替换正文",
      ),
    paperId: z.string().min(1).describe("论文 ID（用 getBooks(kind=paper) 查询）"),
    force: z
      .boolean()
      .optional()
      .describe("translate: false=续翻跳过已翻(默认), true=全部重翻；align: false=幂等补齐(默认), true=全量重算"),
    filePath: z
      .string()
      .optional()
      .describe("仅 reparse 用：源文件（PDF 或 XML）的完整本地路径（默认自动定位，找不到时才需显式指定）"),
  }),

  execute: async ({
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
  }) => {
    const meta = { reasoning, action, paperId };
    try {
      // ==================== 状态查询 ====================
      if (action === "status") {
        const markdown = await readPaperMarkdown(paperId);
        const file = await loadPaperTranslation(paperId);
        const alignInfo = await inspectPaperAlignment(markdown, file);
        const hasTranslation = !!file && Object.keys(file.blocks).length > 0;
        // 版本锚判定：重解析后旧译本/旧向量即陈旧（陈旧译本阅读器不再显示，需重新翻译；向量需重向量化）
        const source = await getPaperSourceStatus(paperId).catch(() => null);
        const translationStale = source?.translationStale ?? false;
        const vectorizedStale = source?.vectorizedStale ?? false;
        return {
          results: {
            success: true,
            hasTranslation,
            translationStale,
            vectorizedStale,
            alignStatus: file?.alignStatus ?? null,
            alignWStatus: file?.alignWStatus ?? null,
            alignment: alignInfo
              ? {
                  total: alignInfo.total,
                  alignedSentences: alignInfo.aligned,
                  alignedWords: alignInfo.alignedW,
                }
              : null,
            message: !hasTranslation
              ? "尚未翻译"
              : translationStale
                ? "译本已陈旧：论文重新解析后旧译文不再显示，需重新翻译（action=translate）"
                : `已有译本；句对齐 ${alignInfo?.aligned ?? 0}/${alignInfo?.total ?? 0}，词对齐 ${alignInfo?.alignedW ?? 0}/${alignInfo?.total ?? 0}`,
          },
          meta,
        };
      }

      // ==================== 翻译（自动带对齐） ====================
      if (action === "translate") {
        const markdown = await readPaperMarkdown(paperId);
        const title = parsePaperMarkdown(markdown).metadata.title || paperId;
        try {
          // 入翻译通道阻塞等结算（P2-3）：解析冲突/同篇幂等由入队口判定；翻译后自动对齐在执行器内
          const task = await enqueuePaperTranslateAndWait({ id: paperId, title, force: force ?? false });
          const settled = task.result as PaperTranslateResult | undefined;
          const result = settled?.translation;
          const align = settled?.alignment;
          if (!result) {
            return { results: { success: false, message: "翻译结算产物缺失" }, meta };
          }
          // 对齐抛错（非取消）按旧口径整体失败（译本已落盘，可 action=align 补齐）
          if (settled?.alignError) {
            return { results: { success: false, message: `操作失败：${settled.alignError}` }, meta };
          }
          if (!align) {
            return { results: { success: false, message: "翻译结算产物缺失" }, meta };
          }

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
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          if (msg.includes("已取消")) {
            return {
              results: { success: false, message: "翻译被中止，已翻译部分已保存，可用 action=translate 续翻" },
              meta,
            };
          }
          // 拒入队（冲突/重复）或执行失败：msg 已含引导或书名号，缺标题时补上
          return { results: { success: false, message: msg.startsWith("《") ? msg : `《${title}》${msg}` }, meta };
        }
      }

      // ==================== 重新解析（入统一解析队列，异步执行） ====================
      if (action === "reparse") {
        const markdown = await readPaperMarkdown(paperId);
        const { metadata } = parsePaperMarkdown(markdown);
        const title = metadata.title || paperId;
        // 源文件（PDF/XML）预检（保持引导性：显式路径不存在 / 自动定位失败都在入队前早报错）；
        // 存在性走 Rust path_exists——plugin-fs 的 exists 有作用域限制，看不到 Zotero storage 等库外路径
        const explicit = filePath?.trim();
        if (explicit && !(await invoke<boolean>("path_exists", { path: explicit }).catch(() => false))) {
          return {
            results: { success: false, message: `指定的源文件（PDF 或 XML）不存在：${explicit}` },
            meta,
          };
        }
        if (!explicit && !(await resolvePaperSourcePdf(paperId, metadata))) {
          return {
            results: {
              success: false,
              message: "找不到源文件（PDF 或 XML），无法重新解析（可用 filePath 参数显式指定源文件路径）",
            },
            meta,
          };
        }
        // 入队即返：去重/向量化互斥/标签页警告与文献库页「重新解析」完全同口径；
        // 拒入队时 message 为 startPaperReparse 的 toast 同款文案
        const enq = startPaperReparse({ id: paperId, title, filePath: explicit || undefined });
        if (!enq.ok) {
          return {
            results: { success: false, message: `${enq.message}（本次未入队，可在当前任务完成后再试）` },
            meta,
          };
        }
        return {
          results: {
            success: true,
            queued: true,
            message: `${enq.message}——已入统一解析队列异步执行（进度见应用右下角进度卡）。完成后注意：已有译文的块转陈旧（下次 action=translate 自动续翻更新），句词对齐需重建（action=align force=true），文内高亮可能漂移；若该论文标签页开着，顶部会出现「重新加载」横幅`,
          },
          meta,
        };
      }

      // ==================== 仅对齐 ====================
      const markdown = await readPaperMarkdown(paperId);
      const title = parsePaperMarkdown(markdown).metadata.title || paperId;
      // 与 translate 同通道入队（alignOnly）：同篇互斥/幂等去重走入队口，force 透传为对齐重算标志
      let align: AlignResult;
      try {
        const task = await enqueuePaperTranslateAndWait({ id: paperId, title, force: force ?? false, alignOnly: true });
        const settledAlign = (task.result as PaperTranslateResult | undefined)?.alignment;
        if (!settledAlign) throw new Error("对齐结算产物缺失");
        align = settledAlign;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { results: { success: false, message: msg.startsWith("《") ? msg : `《${title}》${msg}` }, meta };
      }

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
