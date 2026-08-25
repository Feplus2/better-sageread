import { type PaperMetadata, normalizeAuthors, parseFrontmatter } from "@/pages/paper-reader/paper-metadata";
import {
  type EpubIndexResult,
  deleteBook,
  getBooksWithStatus,
  updateBookVectorizationMeta,
} from "@/services/book-service";
import { resolveLlmParams } from "@/services/converter-service";
import { notifyPaperListChanged, notifyPaperStatusChanged } from "@/services/paper-events";
import { syncGetConfig, syncUploadBook } from "@/services/sync-service";
import type { PaperParseResult } from "@/services/task-executors/paper-parse";
import { useConverterStore } from "@/store/converter-store";
import type { BookWithStatus, SimpleBook } from "@/types/simple-book";
import { getCurrentVectorModelConfig } from "@/utils/model";
import { invoke } from "@tauri-apps/api/core";
import { type UnlistenFn, listen } from "@tauri-apps/api/event";
import { appDataDir, join } from "@tauri-apps/api/path";
import { exists, readFile, writeFile } from "@tauri-apps/plugin-fs";

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
  const importedIds: string[] = [];

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
      // P2.1 产物随入库：references.json（转换器产出过才有）拷进书目录，参考文献卡片依赖它；
      // 拷贝失败仅告警不阻断入库（与 source.pdf 留存同语义）
      try {
        const refsSrc = await join(paper.dir, "references.json");
        if (await exists(refsSrc)) {
          const refsDst = await join(await appDataDir(), "books", paper.id, "references.json");
          await writeFile(refsDst, await readFile(refsSrc));
        }
      } catch (error) {
        console.warn(`拷贝 references.json 失败（不影响入库）: ${paper.dir}`, error);
      }
      if (folderId) {
        try {
          await setPaperFolders(paper.id, [folderId]);
        } catch (error) {
          // 论文已入库，挂载失败不记为导入失败
          console.warn(`挂载论文到文件夹失败: ${paper.id}`, error);
        }
      }
      result.imported += 1;
      importedIds.push(paper.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("已存在")) {
        result.skipped += 1;
      } else {
        result.failed.push({ dir: paper.dir, error: message });
      }
    }
  }

  // L2 开启时异步上传论文文件到云端（不阻塞导入流程，与书籍导入同款；整目录 zip 捆走文件通道）
  try {
    const config = await syncGetConfig();
    if (config?.l2_enabled) {
      for (const id of importedIds) {
        syncUploadBook(id).catch((e) => console.warn("论文文件自动上传失败（忽略）:", id, e));
      }
    }
  } catch (error) {
    console.warn("读取同步配置失败（跳过论文自动上传）:", error);
  }

  // 新条目入库 → 通知列表响应式重载（覆盖队列/AI 工具 importPaper 全部入口；
  // 页面不在场时通知落空，重进时 loadAll 兜底）
  if (result.imported > 0) notifyPaperListChanged();

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
  /** converter 侧完整性闸：重试+降级后仍有内容缺失（图/表断号、页数不足）时 done 携带 true */
  incomplete?: boolean;
  /** 完整性闸命中的具体问题清单（incomplete 时携带） */
  qc_warnings?: string[];
  /** 任务归属标识：Rust 侧注入的源 PDF 路径，多任务并发时据此过滤事件（防串台） */
  pdf_path?: string;
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
  const { mineruToken, paddleocrToken } = useConverterStore.getState();
  if (engine.startsWith("mineru") && !mineruToken) return "尚未配置 MinerU Token，请先在 设置 → PDF 转换 中填写";
  if (engine === "paddleocr" && !paddleocrToken) return "尚未配置 PaddleOCR Token，请先在 设置 → PDF 转换 中填写";
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

/** 取消解析进程：pdfPath 定向取消本任务（P3 多句柄）；缺省取消全部在跑（旧语义，Zotero 对话框取消钮用） */
export async function cancelPaperPdfImport(pdfPath?: string): Promise<void> {
  await invoke("cancel_paper_convert", { pdfPath: pdfPath ?? null });
}

/** 解析产物 done 快照（Rust pending_done 槽；camelCase 对齐 serde rename_all） */
export interface PaperConvertPendingDone {
  pdfPath: string;
  paperDir: string;
  title?: string;
  slug?: string;
  degenerate?: boolean;
  incomplete?: boolean;
}

/** 解析通道状态（页面刷新后的恢复探测）：全部在跑任务 + 全部可能未被消费的 done 产物（P3 多数组） */
export interface PaperConvertStatus {
  runningPdfPaths: string[];
  pendingDones: PaperConvertPendingDone[];
}

/** 查询解析通道状态：页面刷新后 Rust 侧进程/产物仍在，前端据此恢复进度卡与落库链路。
 *  pdfPath 给了则定向过滤该篇，缺省返回全部 */
export async function getPaperConvertStatus(pdfPath?: string): Promise<PaperConvertStatus> {
  return invoke<PaperConvertStatus>("paper_convert_status", { pdfPath: pdfPath ?? null });
}

/** 落库（import/replace）成功后确认清除 Rust 侧 pending_done 槽：pdfPath 定向清该篇；
 *  缺省清空全部（旧语义）。幂等，fire-and-forget 用 */
export async function clearPaperConvertPendingDone(pdfPath?: string): Promise<void> {
  await invoke("clear_paper_convert_pending_done", { pdfPath: pdfPath ?? null });
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

/** Rust get_paper_source_status 返回的论文产物版本锚状态（camelCase） */
export interface PaperSourceStatus {
  /** 当前 paper.md 的 sourceHash（文件缺失为 null） */
  sourceHash: string | null;
  /** translation-zh.json 顶层 sourceHash（无译本或老译本未记录为 null） */
  translationSourceHash: string | null;
  /** 有译本但 hash 缺失/不一致 → 陈旧（渲染侧按未翻译处理） */
  translationStale: boolean;
  /** metadata.json 的 vectorizedSourceHash（向量化完成时写入；重解析换新后消失） */
  vectorizedSourceHash: string | null;
  /** 锚缺失/不一致，或向量库中该论文已无分片 → 需要（重新）向量化（未曾向量化亦为 true） */
  vectorizedStale: boolean;
}

/** 查询论文产物版本锚状态（低成本：小文件读取 + 向量库一行 COUNT；渲染防错配/重向量化引导用） */
export async function getPaperSourceStatus(paperId: string): Promise<PaperSourceStatus> {
  return invoke<PaperSourceStatus>("get_paper_source_status", { paperId });
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
  notifyPaperStatusChanged(paper.id);

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
    notifyPaperStatusChanged(paper.id);
    throw error;
  }

  if (res?.success && res.report) {
    await updateBookVectorizationMeta(paper.id, {
      status: "success",
      chunkCount: res.report.total_chunks,
      dimension: res.report.vector_dimension,
      finishedAt: Date.now(),
    });
    // 响应式通知：列表圆环完成即转绿，不靠重挂载/手动刷新
    notifyPaperStatusChanged(paper.id);
    return res;
  }

  await updateBookVectorizationMeta(paper.id, { status: "failed", finishedAt: Date.now() });
  notifyPaperStatusChanged(paper.id);
  throw new Error(res?.message || "向量化失败");
}

/** 单篇 PDF 解析入库的结算结果（importPaperPdf 返回；AI 工具 importPaper 链路用） */
export interface PaperPdfImportOutcome {
  success: boolean;
  message: string;
  paper?: { id?: string; title: string; author?: string };
  degenerate?: boolean;
  incomplete?: boolean;
}

/** 解析超时上限：论文解析（OCR/VLM）耗时可达十分钟级 */
const PAPER_PARSE_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * 解析单篇 PDF 论文并导入文献库（AI 工具 importPaper 的链路）。
 * P2-4 起改走统一队列：入队 task-center 的 paper-parse 通道并阻塞等结算（返回语义保持）——
 * 拿到队列可见性/冲突检查，不改变 AI 的回答节奏。payload.silent 抑制执行器 toast
 * （旧自持监听链路全程静默，只回消息）。中止/超时经 cancelTask 落到任务取消
 * （执行器侧先结算再杀进程树）。执行/落库本体在执行器内，此处只做校验、等待与结果分类。
 */
export async function importPaperPdf(
  filePath: string,
  folderId?: string,
  abortSignal?: AbortSignal,
): Promise<PaperPdfImportOutcome> {
  // 1. 基本校验（同旧链路）
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  if (ext !== "pdf") {
    return { success: false, message: `仅支持 PDF 论文解析，收到 ".${ext}"。普通电子书请用 importBook 导入书库。` };
  }
  const exists = await invoke<boolean>("path_exists", { path: filePath }).catch(() => false);
  if (!exists) {
    return { success: false, message: `文件不存在：${filePath}` };
  }
  const { paperEngine } = useConverterStore.getState();
  const tokenError = paperEngineTokenError(paperEngine);
  if (tokenError) {
    return { success: false, message: tokenError };
  }

  // 2. 入队 paper-parse 通道 + 等结算（先 enqueue 拿 taskId 再 waitTask：超时/中止要能定点取消本任务，
  // 不能 cancelChannel 误伤前排的其它任务）。动态导入执行器模块：加载即自注册通道（无环约束，
  // 执行器静态依赖本模块的服务函数）。
  const { useTaskCenterStore } = await import("@/store/task-center-store");
  const { dismissPaperParseIfIdle } = await import("@/services/task-executors/paper-parse");
  dismissPaperParseIfIdle();
  const enq = useTaskCenterStore.getState().enqueue({
    channel: "paper-parse",
    targetId: filePath,
    title: filePath.split(/[\\/]/).pop() ?? filePath,
    payload: { kind: "parse", pdfPath: filePath, folderId, silent: true },
  });
  if (!enq.ok) {
    return { success: false, message: enq.detail ?? "解析任务入队失败" };
  }
  const taskId = enq.taskId;
  const onAbort = () => useTaskCenterStore.getState().cancelTask(taskId);
  abortSignal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(onAbort, PAPER_PARSE_TIMEOUT_MS);
  try {
    await useTaskCenterStore.getState().waitTask(taskId);
  } catch {
    // 失败/取消：从任务本体取分类信息（result 由执行器在抛错前写入；取消无 result）
  } finally {
    clearTimeout(timer);
    abortSignal?.removeEventListener("abort", onAbort);
  }

  const task = useTaskCenterStore.getState().tasks[taskId];
  if (!task || task.status === "cancelled") {
    return { success: false, message: "解析已取消（用户中止或超时）" };
  }
  const result = task.result as PaperParseResult | undefined;
  if (task.status === "error") {
    if (result?.outcome === "failed") {
      // 入库段失败的 error 已是「解析成功但入库失败：…」成品文案（执行器与卡片共用）；解析段是原始文案
      return { success: false, message: result.stage === "import" ? result.error : `论文解析失败：${result.error}` };
    }
    return { success: false, message: `论文解析失败：${task.error ?? "未知错误"}` };
  }

  // 3. 定位入库后的 paper（标题匹配，退化用 slug）——同旧链路
  if (!result || result.outcome === "failed") {
    return { success: false, message: "论文解析失败：结算产物缺失" };
  }
  const label = result.title ?? result.slug ?? "";
  let imported: BookWithStatus | null = null;
  try {
    const papers = await listPapers();
    imported =
      papers.find((p) => result.title && p.title === result.title) ??
      papers.find((p) => result.slug && p.title.includes(result.slug)) ??
      null;
  } catch {
    // 列表反查失败不影响成功语义（入库已完成），退化为仅标题回执
  }
  return {
    success: true,
    message:
      result.outcome === "imported" ? `论文《${label}》已解析并导入文献库` : `论文《${label}》已入库过（内容未变化）`,
    paper: imported ? { id: imported.id, title: imported.title, author: imported.author } : { title: label },
    degenerate: result.degenerate === true,
    incomplete: result.incomplete === true,
  };
}
