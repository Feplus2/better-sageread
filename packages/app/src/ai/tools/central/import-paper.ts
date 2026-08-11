/**
 * 全局助手工具（批次 F4）：解析单篇 PDF 论文并导入 SageRead 文献库。
 *
 * 链路：startPaperPdfImport（Papers_Converter sidecar 解析）→ 等 done/error/terminated
 * 进度事件 → importPapers(paper_dir) 落库 → 返回 paper id/title。
 * 注意与 importBook（进书库）是两条链路：本工具产物是 paper.md，进「文献库」。
 */
import {
  type PaperConvertProgress,
  cancelPaperPdfImport,
  createFolder,
  importPapers,
  listFolders,
  listPapers,
  listenPaperConvertProgress,
  paperEngineTokenError,
  startPaperPdfImport,
} from "@/services/paper-service";
import { useConverterStore } from "@/store/converter-store";
import { invoke } from "@tauri-apps/api/core";
import { tool } from "ai";
import { z } from "zod";

/** 解析超时上限：论文解析（OCR/VLM）耗时可达十分钟级 */
const PARSE_TIMEOUT_MS = 15 * 60 * 1000;

type Outcome =
  | { kind: "done"; progress: PaperConvertProgress }
  | { kind: "error"; message: string }
  | { kind: "cancelled" };

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

    // 1. 基本校验
    const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
    if (ext !== "pdf") {
      return fail(`仅支持 PDF 论文解析，收到 ".${ext}"。普通电子书请用 importBook 导入书库。`);
    }
    const exists = await invoke<boolean>("path_exists", { path: filePath }).catch(() => false);
    if (!exists) {
      return fail(`文件不存在：${filePath}`);
    }
    const { paperEngine } = useConverterStore.getState();
    const tokenError = paperEngineTokenError(paperEngine);
    if (tokenError) {
      return fail(tokenError);
    }

    // 2. 解析目标文件夹（不存在自动创建）
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

    // 3. 监听进度 → 启动解析 → 等结算（中止信号联动 cancel）
    // 先注册监听再启动解析：避免 listen 就绪前后端发出的事件丢失；
    // 按 pdf_path 过滤事件归属：并发/连续导入时只结算本任务的 done/error/terminated
    let outcome: Outcome = { kind: "error", message: "解析超时" };
    let unlisten: (() => void) | null = null;
    let settled = false;
    let resolveDone: () => void = () => {};
    const donePromise = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const settle = (o: Outcome) => {
      if (settled) return;
      settled = true;
      outcome = o;
      resolveDone();
    };
    try {
      unlisten = await listenPaperConvertProgress((progress) => {
        if (progress.pdf_path !== filePath) return;
        if (progress.type === "done" && progress.paper_dir) {
          settle({ kind: "done", progress });
        } else if (progress.type === "error") {
          settle({ kind: "error", message: progress.message ?? "解析失败" });
        } else if (progress.type === "terminated") {
          settle(progress.success === false ? { kind: "error", message: "解析进程异常退出" } : { kind: "cancelled" });
        }
      });
    } catch {
      settle({ kind: "error", message: "进度监听注册失败" });
    }
    if (!settled) {
      void startPaperPdfImport(filePath).catch((error) =>
        settle({ kind: "error", message: error instanceof Error ? error.message : String(error) }),
      );
    }

    const onAbort = () => {
      void cancelPaperPdfImport().catch(() => {});
    };
    options?.abortSignal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(onAbort, PARSE_TIMEOUT_MS);
    try {
      await donePromise;
    } finally {
      clearTimeout(timer);
      options?.abortSignal?.removeEventListener("abort", onAbort);
      unlisten?.();
    }

    if (outcome.kind === "cancelled") {
      return fail("解析已取消（用户中止或超时）");
    }
    if (outcome.kind === "error") {
      return fail(`论文解析失败：${outcome.message}`);
    }

    // 4. 入库
    const { progress } = outcome;
    try {
      const result = await importPapers(progress.paper_dir, folderId);
      if (result.failed.length > 0) {
        return fail(`解析成功但入库失败：${result.failed[0].error}`);
      }
      // 定位入库后的 paper（标题匹配，退化用 slug）
      const papers = await listPapers();
      const imported =
        papers.find((p) => progress.title && p.title === progress.title) ??
        papers.find((p) => progress.slug && p.title.includes(progress.slug)) ??
        null;
      return {
        results: {
          success: true,
          message:
            result.imported > 0
              ? `论文《${progress.title ?? progress.slug}》已解析并导入文献库`
              : `论文《${progress.title ?? progress.slug}》已入库过（内容未变化）`,
          paper: imported
            ? { id: imported.id, title: imported.title, author: imported.author }
            : { title: progress.title ?? progress.slug },
          folder: folderName?.trim() || undefined,
          degenerate: progress.degenerate === true,
          incomplete: progress.incomplete === true,
        },
        meta: { reasoning, filePath },
      };
    } catch (error) {
      return fail(`解析成功但入库失败：${error instanceof Error ? error.message : String(error)}`);
    }
  },
});
