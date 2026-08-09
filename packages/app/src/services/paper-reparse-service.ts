/**
 * 论文批量重新解析服务。
 *
 * 用在库论文的源 PDF 重新走一遍 Papers_Converter 解析，再用 replace_paper_content 整体替换
 * paper.md / images / metadata.json（**保留论文 id**：文件夹归属、对话线程、标注随之存活；
 * 文内高亮靠 text 兜底重锚定，正文变化大时可能漂移）。
 *
 * 每篇的 PDF 来源解析顺序：metadata.zotero_pdf_path → {appData}/books/{id}/source.pdf → 计 failed。
 * 监听结算模式仿 zotero-import-service：整个批量注册一次进度监听，settleCurrent 逐篇结算。
 */

import { type PaperMetadata, parseFrontmatter, parsePaperMarkdown } from "@/pages/paper-reader/paper-metadata";
import {
  type PaperConvertProgress,
  type ScannedPaper,
  cancelPaperPdfImport,
  listenPaperConvertProgress,
  startPaperPdfImport,
} from "@/services/paper-service";
import { findDegenerateLoop } from "@/utils/degenerate";
import { invoke } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";
import { readTextFile } from "@tauri-apps/plugin-fs";

export interface ReparseItem {
  id: string;
  title: string;
  /** 可选：显式指定源 PDF 路径（优先于 zotero_pdf_path/source.pdf 解析链；processPaper reparse 用） */
  sourcePdfPath?: string;
}

export interface ReparseFailure extends ReparseItem {
  error: string;
}

export interface ReparseReport {
  done: ReparseItem[];
  failed: ReparseFailure[];
  /** 重解析后仍检测到退化循环的篇目（建议换引擎再试） */
  suspect: ReparseItem[];
  cancelled: boolean;
}

export interface ReparseCallbacks {
  onItemStart?: (index: number, total: number, item: ReparseItem) => void;
  /** 当前篇的转换进度（PaperConvertProgress 原样透传，页面自行加权总进度） */
  onItemProgress?: (progress: PaperConvertProgress) => void;
  isCancelled?: () => boolean;
}

type ConvertOutcome = { ok: true; paperDir?: string; degenerate?: boolean } | { ok: false; error: string };

/** 解析某篇论文的源 PDF 路径：zotero_pdf_path（存在才用）→ 书库目录 source.pdf → null。
 * 存在性检查走 Rust path_exists：plugin-fs 的 exists 有作用域限制，看不到 Zotero storage 等库外路径 */
export async function resolvePaperSourcePdf(paperId: string, meta?: PaperMetadata | null): Promise<string | null> {
  const zoteroPdf = meta?.zotero_pdf_path?.trim();
  if (zoteroPdf && (await invoke<boolean>("path_exists", { path: zoteroPdf }).catch(() => false))) return zoteroPdf;
  const sourcePdf = await join(await appDataDir(), "books", paperId, "source.pdf");
  if (await invoke<boolean>("path_exists", { path: sourcePdf }).catch(() => false)) return sourcePdf;
  return null;
}

/**
 * 逐篇串行重新解析：startPaperPdfImport → 等 done/error/terminated →
 * 回写 zotero_key（旧 metadata 有才注入）→ scan 新产物 → 合并保留 zotero 字段 → replace_paper_content。
 * 取消：isCancelled 置位 + 外部调 cancelPaperPdfImport，terminated 事件驱动当前篇结算，队列不再推进。
 */
export async function reparsePapers(
  items: ReparseItem[],
  metaById: Readonly<Record<string, PaperMetadata>>,
  callbacks: ReparseCallbacks = {},
): Promise<ReparseReport> {
  const report: ReparseReport = { done: [], failed: [], suspect: [], cancelled: false };
  const total = items.length;

  let settleCurrent: ((outcome: ConvertOutcome) => void) | null = null;
  const unlisten = await listenPaperConvertProgress((p) => {
    if (p.type === "start" || p.type === "progress" || p.type === "stage_done") {
      callbacks.onItemProgress?.(p);
      return;
    }
    const settle = settleCurrent;
    if (!settle) return;
    settleCurrent = null;
    if (p.type === "done") {
      settle({ ok: true, paperDir: p.paper_dir, degenerate: p.degenerate === true });
    } else if (p.type === "error") {
      settle({ ok: false, error: p.message ?? "解析失败" });
    } else if (p.type === "terminated") {
      // 取消 kill 与非零退出都落在这里；取消与否由 isCancelled() 在循环侧判定
      settle({ ok: false, error: p.success === false ? "解析进程退出" : "解析进程异常退出（未产出结果）" });
    }
  });

  try {
    for (let i = 0; i < total; i++) {
      if (callbacks.isCancelled?.()) {
        report.cancelled = true;
        break;
      }
      const item = items[i];
      callbacks.onItemStart?.(i, total, item);

      // 1. 解析 PDF 来源：显式指定路径优先，其次 zotero_pdf_path → 书库目录 source.pdf
      let pdfPath: string | null = null;
      const explicit = item.sourcePdfPath?.trim();
      if (explicit && (await invoke<boolean>("path_exists", { path: explicit }).catch(() => false))) {
        pdfPath = explicit;
      } else {
        try {
          pdfPath = await resolvePaperSourcePdf(item.id, metaById[item.id]);
        } catch (error) {
          console.warn(`解析源 PDF 路径失败: ${item.id}`, error);
        }
      }
      if (!pdfPath) {
        report.failed.push({ ...item, error: "找不到源 PDF" });
        continue;
      }

      // 2. 启动转换并等结算
      const conversion = new Promise<ConvertOutcome>((resolve) => {
        settleCurrent = resolve;
      });
      try {
        await startPaperPdfImport(pdfPath);
      } catch (error) {
        settleCurrent = null;
        report.failed.push({ ...item, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
      const outcome = await conversion;

      if (!outcome.ok || !outcome.paperDir) {
        if (callbacks.isCancelled?.()) {
          report.cancelled = true;
          break;
        }
        report.failed.push({ ...item, error: outcome.ok ? "转换未产出目录" : outcome.error });
        continue;
      }
      if (callbacks.isCancelled?.()) {
        report.cancelled = true;
        break;
      }

      // 3. 替换产物（zotero 字段保留：先注入新目录 frontmatter，再在合并 metadata 时兜底）
      try {
        const suspect = await replaceWithConverted(item, outcome.paperDir, metaById[item.id]);
        report.done.push(item);
        // 本地检测 + converter 质量守卫（done.degenerate）双通道
        if (suspect || outcome.degenerate) report.suspect.push(item);
      } catch (error) {
        report.failed.push({ ...item, error: error instanceof Error ? error.message : String(error) });
      }
    }
  } finally {
    unlisten();
    if (callbacks.isCancelled?.()) {
      report.cancelled = true;
      await cancelPaperPdfImport().catch(() => {});
    }
  }
  return report;
}

/** 单篇替换：注入 zotero_key → 扫描新产物 → 合并保留 zotero 字段 → replace_paper_content；返回是否仍疑似退化 */
async function replaceWithConverted(item: ReparseItem, paperDir: string, oldMeta?: PaperMetadata): Promise<boolean> {
  if (oldMeta?.zotero_key) {
    await invoke("inject_zotero_key", {
      paperDir,
      zoteroKey: oldMeta.zotero_key,
      zoteroPdfPath: oldMeta.zotero_pdf_path ?? null,
    });
  }
  const scanned = await invoke<ScannedPaper[]>("scan_papers_dir", { dir: paperDir });
  const paper = scanned.find((s) => s.dir === paperDir) ?? scanned[0];
  if (!paper) throw new Error(`重解析产物无法识别: ${paperDir}`);
  const metadata: PaperMetadata = paper.frontmatter ? parseFrontmatter(paper.frontmatter) : {};
  // 保留旧元数据中的 Zotero 回链字段（frontmatter 注入失败时也能落进 metadata.json）
  if (oldMeta?.zotero_key) metadata.zotero_key = oldMeta.zotero_key;
  if (oldMeta?.zotero_pdf_path) metadata.zotero_pdf_path = oldMeta.zotero_pdf_path;
  await invoke("replace_paper_content", { paperId: item.id, sourceDir: paperDir, metadata });

  // 退化循环检测（引擎换了仍可能失控，提示用户再换引擎）
  try {
    const raw = await readTextFile(await join(paperDir, "paper.md"));
    return findDegenerateLoop(parsePaperMarkdown(raw).body) != null;
  } catch {
    return false;
  }
}
