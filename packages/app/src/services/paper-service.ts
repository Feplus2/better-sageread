import { type PaperMetadata, normalizeAuthors, parseFrontmatter } from "@/pages/paper-reader/paper-metadata";
import {
  type EpubIndexResult,
  deleteBook,
  getBooksWithStatus,
  updateBookVectorizationMeta,
} from "@/services/book-service";
import { resolveLlmParams } from "@/services/converter-service";
import { useConverterStore } from "@/store/converter-store";
import type { BookWithStatus, SimpleBook } from "@/types/simple-book";
import { getCurrentVectorModelConfig } from "@/utils/model";
import { invoke } from "@tauri-apps/api/core";
import { type UnlistenFn, listen } from "@tauri-apps/api/event";

/** Rust scan_papers_dir 返回的扫描结果（字段与 Rust 侧 snake_case 保持一致） */
export interface ScannedPaper {
  dir: string;
  /** paper.md 内容的 sha256 前 16 位 hex */
  id: string;
  frontmatter: string | null;
  title_fallback: string;
  file_size: number;
}

export interface ImportPapersResult {
  imported: number;
  skipped: number;
  failed: { dir: string; error: string }[];
}

// ==================== 文件夹（§3.2：folders 树表 + paper_folders 多对多） ====================

/** Rust Folder 序列化形状（camelCase） */
export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  /** 软删除时间戳（毫秒）；可见文件夹列表中恒为 null */
  trashedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** buildFolderTree 产物：含 children 的树节点 */
export interface FolderTreeNode extends Folder {
  children: FolderTreeNode[];
}

/** Rust PaperFolder 序列化形状：paper_folders 关系行 */
export interface PaperFolderEntry {
  paperId: string;
  folderId: string;
}

export async function listFolders(): Promise<Folder[]> {
  return invoke<Folder[]>("list_folders");
}

export async function createFolder(name: string, parentId?: string | null): Promise<Folder> {
  return invoke<Folder>("create_folder", { name, parentId: parentId ?? null });
}

export async function renameFolder(id: string, name: string): Promise<void> {
  return invoke("rename_folder", { id, name });
}

/** 软删除：文件夹移入回收站（子树整体隐藏，成员关系原样保留，可恢复） */
export async function deleteFolder(id: string): Promise<void> {
  return invoke("delete_folder", { id });
}

/** 回收站中的文件夹列表（只含自身被软删的文件夹） */
export async function listTrashedFolders(): Promise<Folder[]> {
  return invoke<Folder[]>("list_trashed_folders");
}

/** 从回收站恢复文件夹（子树随其重现，归属关系原样回来） */
export async function restoreFolder(id: string): Promise<void> {
  return invoke("restore_folder", { id });
}

/** 彻底清除文件夹：子文件夹与成员关系级联删除；论文不删除，仅失去归属 */
export async function purgeFolder(id: string): Promise<void> {
  return invoke("purge_folder", { id });
}

/** 移动文件夹到新父节点（null = 根级）；Rust 侧做环检测 */
export async function moveFolder(id: string, newParentId: string | null): Promise<void> {
  return invoke("move_folder", { id, newParentId });
}

/** 整体替换某篇论文的文件夹归属（空数组 = 移出所有文件夹，成为"未归档"） */
export async function setPaperFolders(paperId: string, folderIds: string[]): Promise<void> {
  return invoke("set_paper_folders", { paperId, folderIds });
}

/** 全量成员关系（一次拿全，避免 N+1） */
export async function getPaperFolderMap(): Promise<PaperFolderEntry[]> {
  return invoke<PaperFolderEntry[]>("get_paper_folder_map");
}

/** 扁平文件夹列表 → 树（parentId 指向不存在的节点时按根处理，保持插入顺序） */
export function buildFolderTree(folders: Folder[]): FolderTreeNode[] {
  const nodes = new Map<string, FolderTreeNode>();
  for (const folder of folders) {
    nodes.set(folder.id, { ...folder, children: [] });
  }
  const roots: FolderTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

/**
 * 导入论文目录：扫描（dir 本身是论文目录，或其一级子目录是论文目录均可）→ 逐篇解析
 * frontmatter → save_paper 落盘入库。save_paper 报"已存在"计 skipped，其余错误计入 failed。
 * folderId 传入时，新入库的论文自动挂到该文件夹（跳过的重复篇不动）。
 */
export async function importPapers(dir: string, folderId?: string): Promise<ImportPapersResult> {
  const scanned = await invoke<ScannedPaper[]>("scan_papers_dir", { dir });
  const result: ImportPapersResult = { imported: 0, skipped: 0, failed: [] };

  for (const paper of scanned) {
    try {
      const metadata: PaperMetadata = paper.frontmatter ? parseFrontmatter(paper.frontmatter) : {};
      const authors = normalizeAuthors(metadata.author);
      // 多位作者只存第一位 + " et al."（完整列表在 metadata.json 里，列表页自行展示）
      const author = authors.length > 1 ? `${authors[0]} et al.` : (authors[0] ?? "");
      await invoke<SimpleBook>("save_paper", {
        sourceDir: paper.dir,
        id: paper.id,
        metadata,
        title: metadata.title?.trim() || paper.title_fallback,
        author,
        language: metadata.lang ?? "en",
      });
      if (folderId) {
        try {
          await setPaperFolders(paper.id, [folderId]);
        } catch (error) {
          // 论文已入库，挂载失败不记为导入失败
          console.warn(`挂载论文到文件夹失败: ${paper.id}`, error);
        }
      }
      result.imported += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("已存在")) {
        result.skipped += 1;
      } else {
        result.failed.push({ dir: paper.dir, error: message });
      }
    }
  }

  return result;
}

/** 文献库列表：与图书馆同一数据源（getBooksWithStatus），只取 MARKDOWN */
export async function listPapers(): Promise<BookWithStatus[]> {
  const books = await getBooksWithStatus();
  return books.filter((book) => book.format === "MARKDOWN");
}

// ==================== 单篇 PDF 解析导入（Papers_Converter sidecar） ====================

/** 论文解析进度事件（对应 Papers_Converter headless JSON 协议 + Rust 补发的 terminated） */
export interface PaperConvertProgress {
  type: "start" | "progress" | "stage_done" | "done" | "error" | "terminated";
  title?: string;
  engine?: string;
  stage?: number;
  stage_name?: string;
  detail?: string;
  fraction?: number | null;
  percent?: number;
  elapsed?: number;
  slug?: string;
  paper_dir?: string;
  paper_md?: string;
  message?: string;
  success?: boolean;
  /** converter 侧质量守卫：重试后仍检测到退化循环时 done 携带 true（见 Papers_Converter quality_guard） */
  degenerate?: boolean;
}

interface PaperConvertParams {
  pdfPath: string;
  engine?: string;
  mineruToken?: string;
  paddleocrToken?: string;
  glmApiKey?: string;
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
}

/** 引擎对应的 Token 检查（返回 null 通过，否则为引导文案） */
export function paperEngineTokenError(engine: string): string | null {
  const { mineruToken, paddleocrToken, glmApiKey } = useConverterStore.getState();
  if (engine === "mineru" && !mineruToken) return "尚未配置 MinerU Token，请先在 设置 → PDF 转换 中填写";
  if (engine === "paddleocr" && !paddleocrToken) return "尚未配置 PaddleOCR Token，请先在 设置 → PDF 转换 中填写";
  if (engine === "glm" && !glmApiKey) return "尚未配置 GLM API Key，请先在 设置 → PDF 转换 中填写";
  return null;
}

/** 启动单篇 PDF→paper.md 解析（异步；进度经 listenPaperConvertProgress 回传） */
export async function startPaperPdfImport(pdfPath: string): Promise<void> {
  const { paperEngine, mineruToken, paddleocrToken, glmApiKey } = useConverterStore.getState();
  const tokenError = paperEngineTokenError(paperEngine);
  if (tokenError) throw new Error(tokenError);
  const params: PaperConvertParams = {
    pdfPath,
    engine: paperEngine,
    mineruToken: mineruToken || undefined,
    paddleocrToken: paddleocrToken || undefined,
    glmApiKey: glmApiKey || undefined,
    ...resolveLlmParams(),
  };
  await invoke("convert_paper_pdf", { params });
}

export async function cancelPaperPdfImport(): Promise<void> {
  await invoke("cancel_paper_convert");
}

export async function listenPaperConvertProgress(
  callback: (progress: PaperConvertProgress) => void,
): Promise<UnlistenFn> {
  return listen<string>("paper-convert://progress", (event) => {
    try {
      callback(JSON.parse(event.payload) as PaperConvertProgress);
    } catch (e) {
      console.warn("无法解析论文解析进度事件:", event.payload, e);
    }
  });
}

/** 删除论文：复用书籍软删除（进回收站，可恢复） */
export async function trashPaper(id: string): Promise<void> {
  return deleteBook(id);
}

/**
 * 向量化单篇论文：写入全局论文向量库 {app_data}/papers/vectors.sqlite（重索引先删后插）。
 * 进度经 paper://index-progress 事件发出（由页面监听）；状态合并写入 book_status.metadata.vectorization。
 * 无可用嵌入模型时直接抛错，不发起调用。
 */
export async function vectorizePaper(paper: { id: string; title: string; author: string }): Promise<EpubIndexResult> {
  const { useLlamaStore } = await import("@/store/llama-store");
  if (!useLlamaStore.getState().hasVectorCapability()) {
    throw new Error("没有可用的嵌入模型，请先在设置中下载本地嵌入模型或配置外部嵌入服务");
  }

  const vectorConfig = await getCurrentVectorModelConfig();

  await updateBookVectorizationMeta(paper.id, {
    status: "processing",
    model: vectorConfig.model,
    dimension: vectorConfig.dimension,
    version: 1,
    startedAt: Date.now(),
  });

  let res: EpubIndexResult;
  try {
    res = await invoke<EpubIndexResult>("plugin:epub|index_paper", {
      paperId: paper.id,
      title: paper.title,
      author: paper.author,
      dimension: vectorConfig.dimension,
      embeddingsUrl: vectorConfig.embeddingsUrl,
      model: vectorConfig.model,
      apiKey: vectorConfig.apiKey,
    });
  } catch (error) {
    await updateBookVectorizationMeta(paper.id, { status: "failed", finishedAt: Date.now() });
    throw error;
  }

  if (res?.success && res.report) {
    await updateBookVectorizationMeta(paper.id, {
      status: "success",
      chunkCount: res.report.total_chunks,
      dimension: res.report.vector_dimension,
      finishedAt: Date.now(),
    });
    return res;
  }

  await updateBookVectorizationMeta(paper.id, { status: "failed", finishedAt: Date.now() });
  throw new Error(res?.message || "向量化失败");
}
