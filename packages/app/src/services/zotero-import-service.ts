import {
  type PaperMetadata,
  normalizeAuthors,
  parseFrontmatter,
  parsePaperMarkdown,
} from "@/pages/paper-reader/paper-metadata";
import {
  type Folder,
  type PaperConvertProgress,
  type PaperFolderEntry,
  type ScannedPaper,
  cancelPaperPdfImport,
  createFolder,
  getPaperFolderMap,
  listFolders,
  listTrashedFolders,
  listenPaperConvertProgress,
  renameFolder,
  setPaperFolders,
  startPaperPdfImport,
} from "@/services/paper-service";
import type { SimpleBook } from "@/types/simple-book";
import { findDegenerateLoop } from "@/utils/degenerate";
import { invoke } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";
import { readTextFile } from "@tauri-apps/plugin-fs";

// ==================== Rust 命令类型（zotero.rs，camelCase） ====================

export interface ZoteroCollection {
  key: string;
  name: string;
  parentKey: string | null;
  itemCount: number;
}

export interface ZoteroItem {
  key: string;
  title: string;
  doi: string | null;
  year: string | null;
  firstAuthor: string | null;
  collectionKeys: string[];
  pdfPath: string | null;
  hasPdf: boolean;
}

export interface ZoteroScanResult {
  collections: ZoteroCollection[];
  items: ZoteroItem[];
}

export interface ZoteroCollectionMapping {
  collectionKey: string;
  folderId: string;
  name: string;
  parentKey: string | null;
}

export interface ZoteroPaperState {
  paperId: string;
  zoteroKey: string;
  collectionKeys: string[];
}

export interface ZoteroStateResult {
  collections: ZoteroCollectionMapping[];
  papers: ZoteroPaperState[];
}

export interface PaperDedupKeys {
  id: string;
  zoteroKey: string | null;
  doi: string | null;
  title: string;
  firstAuthor: string | null;
  year: string | null;
}

/** 「未分类」伪节点 key：Zotero 里不属于任何 Collection 的条目 */
export const UNFILED_KEY = "__unfiled__";

// ==================== 纯函数：归一化与相似度 ====================

/** 标题归一化：小写、非字母数字（含 CJK）折叠为单空格 */
export function normalizeTitle(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** DOI 归一化：去 URL 前缀与 doi: 前缀、小写；空返回 null */
export function normalizeDoi(s: string | null | undefined): string | null {
  if (!s) return null;
  const v = s
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, "")
    .replace(/^doi:\s*/, "")
    .trim();
  return v || null;
}

/**
 * 姓氏归一化：兼容全名（"San Zhang" / "Zhang, San"）与单字段名（fieldMode=1）。
 * 有逗号取逗号前，否则取最后一个空白分段；只留字母（含 CJK）。
 */
export function normalizeSurname(s: string | null | undefined): string | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (!trimmed) return null;
  const part = trimmed.includes(",") ? trimmed.split(",")[0] : (trimmed.split(/\s+/).pop() ?? trimmed);
  const v = part.toLowerCase().replace(/[^\p{L}]+/gu, "");
  return v || null;
}

/** bigram Dice 相似度（0-1）；短串（<2 字符）只做恒等判断 */
export function bigramDice(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  let overlap = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const n = grams.get(g) ?? 0;
    if (n > 0) {
      overlap += 1;
      grams.set(g, n - 1);
    }
  }
  return (2 * overlap) / (a.length - 1 + (b.length - 1));
}

// ==================== 纯函数：去重链与三方合并 ====================

export type MatchVia = "zotero_key" | "doi" | "title-exact" | "title-similar";

export type MatchResult =
  /** 状态表已有记录的老 Zotero 文献：跳过导入，走三方合并 */
  | { kind: "merge"; paperId: string }
  /** 库里已存在但首次关联该 zotero_key：跳过导入 + 收养（回写 key、建状态） */
  | { kind: "adopt"; paperId: string; via: MatchVia }
  | { kind: "import" };

/**
 * 去重链：状态表 zotero_key → metadata zotero_key → DOI → 标题精确 → 标题相似+首作者。
 * 哈希兜底不在此处：转换后 save_paper 报"已存在"时按 adopt-via-hash 处理。
 */
export function matchExisting(
  item: ZoteroItem,
  dedupKeys: PaperDedupKeys[],
  stateByKey: ReadonlyMap<string, ZoteroPaperState>,
): MatchResult {
  const known = stateByKey.get(item.key);
  if (known) return { kind: "merge", paperId: known.paperId };

  const byKey = dedupKeys.find((p) => p.zoteroKey === item.key);
  if (byKey) return { kind: "adopt", paperId: byKey.id, via: "zotero_key" };

  const doi = normalizeDoi(item.doi);
  if (doi) {
    const hit = dedupKeys.find((p) => normalizeDoi(p.doi) === doi);
    if (hit) return { kind: "adopt", paperId: hit.id, via: "doi" };
  }

  const title = normalizeTitle(item.title);
  if (title) {
    const exact = dedupKeys.find((p) => normalizeTitle(p.title) === title);
    if (exact) return { kind: "adopt", paperId: exact.id, via: "title-exact" };
    const surname = normalizeSurname(item.firstAuthor);
    if (surname) {
      const similar = dedupKeys.find(
        (p) => normalizeSurname(p.firstAuthor) === surname && bigramDice(title, normalizeTitle(p.title)) >= 0.9,
      );
      if (similar) return { kind: "adopt", paperId: similar.id, via: "title-similar" };
    }
  }
  return { kind: "import" };
}

export type FilingPlan = { kind: "noop" } | { kind: "apply"; folderIds: string[] } | { kind: "conflict" };

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

/**
 * Collection 归属三方合并。zOld/zNew 均已 ∩K（K=映射表 ∪ 本次勾选）。
 * - Zotero 侧没变 → noop
 * - Zotero 侧变了且本地（在 Zotero 管辖文件夹内的归属）没动过 → apply：(L − M(K)) ∪ M(Z_new)
 * - 两边都动过 → conflict（本地赢，由调用方进报告并推进快照）
 */
export function planFilingMerge(args: {
  zOld: string[];
  zNew: string[];
  /** 论文当前本地归属（paper_folders 全量） */
  localFolderIds: string[];
  /** M：collection key → folderId，覆盖 K 内全部 key */
  folderIdByKey: ReadonlyMap<string, string>;
  /** M(K)：Zotero 管辖的全部 folderId */
  managedFolderIds: ReadonlySet<string>;
  /** 不可挂载目标（本地回收站中的映射文件夹） */
  excludedFolderIds?: ReadonlySet<string>;
}): FilingPlan {
  if (sameSet(args.zOld, args.zNew)) return { kind: "noop" };
  const mapped = (keys: string[]) =>
    keys.map((k) => args.folderIdByKey.get(k)).filter((id): id is string => !!id && !args.excludedFolderIds?.has(id));
  const localRelevant = args.localFolderIds.filter((id) => args.managedFolderIds.has(id));
  if (!sameSet(localRelevant, mapped(args.zOld))) return { kind: "conflict" };
  const keep = args.localFolderIds.filter((id) => !args.managedFolderIds.has(id));
  return { kind: "apply", folderIds: [...new Set([...keep, ...mapped(args.zNew)])] };
}

// ==================== 扫描与上下文加载 ====================

export async function scanZoteroLibrary(dataDir: string): Promise<ZoteroScanResult> {
  return invoke<ZoteroScanResult>("zotero_scan_library", { dataDir });
}

interface ImportContext {
  mappings: ZoteroCollectionMapping[];
  stateByKey: Map<string, ZoteroPaperState>;
  dedupKeys: PaperDedupKeys[];
  folders: Folder[];
  trashedFolderIds: Set<string>;
  paperFolderMap: PaperFolderEntry[];
}

async function loadImportContext(): Promise<ImportContext> {
  const [state, dedupKeys, folders, trashedFolders, paperFolderMap] = await Promise.all([
    invoke<ZoteroStateResult>("zotero_get_state"),
    invoke<PaperDedupKeys[]>("list_paper_dedup_keys"),
    listFolders(),
    listTrashedFolders(),
    getPaperFolderMap(),
  ]);
  return {
    mappings: state.collections,
    stateByKey: new Map(state.papers.map((p) => [p.zoteroKey, p])),
    dedupKeys,
    folders,
    trashedFolderIds: new Set(trashedFolders.map((f) => f.id)),
    paperFolderMap,
  };
}

// ==================== 文件夹准备（映射 → 建文件夹 / 改名同步） ====================

export interface FolderPrepResult {
  /** K 内全部 key → folderId（含本次新建） */
  folderIdByKey: Map<string, string>;
  created: string[];
  renamed: string[];
  /** 映射指向的文件夹已在本地回收站：不复活、不重建，跳过挂载 */
  skippedTrashed: string[];
}

/** 勾选集合按父先子后排序（父未勾选/未映射的子文件夹挂根级） */
function orderParentsFirst(collections: ZoteroCollection[], selectedKeys: ReadonlySet<string>): ZoteroCollection[] {
  const byKey = new Map(collections.map((c) => [c.key, c]));
  const done = new Set<string>();
  const ordered: ZoteroCollection[] = [];
  let pending = collections.filter((c) => selectedKeys.has(c.key));
  while (pending.length > 0) {
    const ready = pending.filter(
      (c) => !c.parentKey || !byKey.has(c.parentKey) || done.has(c.parentKey) || !selectedKeys.has(c.parentKey),
    );
    if (ready.length === 0) {
      // 防御：父链断裂或成环时按剩余顺序直接处理
      ready.push(...pending);
    }
    for (const c of ready) {
      ordered.push(c);
      done.add(c.key);
    }
    const readyKeys = new Set(ready.map((c) => c.key));
    pending = pending.filter((c) => !readyKeys.has(c.key));
  }
  return ordered;
}

export async function ensureCollectionFolders(
  collections: ZoteroCollection[],
  selectedKeys: ReadonlySet<string>,
  ctx: ImportContext,
): Promise<FolderPrepResult> {
  const result: FolderPrepResult = { folderIdByKey: new Map(), created: [], renamed: [], skippedTrashed: [] };
  const mappingByKey = new Map(ctx.mappings.map((m) => [m.collectionKey, m]));
  const folderNameById = new Map(ctx.folders.map((f) => [f.id, f.name]));

  // 既有映射全量入 M(K)（未勾选的已映射 collection 也参与三方合并）
  for (const m of ctx.mappings) result.folderIdByKey.set(m.collectionKey, m.folderId);

  for (const col of orderParentsFirst(collections, selectedKeys)) {
    const existing = mappingByKey.get(col.key);
    if (existing) {
      if (ctx.trashedFolderIds.has(existing.folderId)) {
        result.skippedTrashed.push(col.name);
      } else if (existing.name !== col.name) {
        // Zotero 侧改名：本地名还等于上次导入名才跟随（用户改过名则本地赢）
        const localName = folderNameById.get(existing.folderId);
        if (localName === existing.name) {
          await renameFolder(existing.folderId, col.name);
          result.renamed.push(col.name);
        }
        await upsertCollectionMapping(col.key, existing.folderId, col.name, col.parentKey);
        existing.name = col.name;
      }
      continue;
    }
    // 新建：父已处理且有映射才嵌套，否则挂根级
    const parentFolderId = col.parentKey ? (result.folderIdByKey.get(col.parentKey) ?? null) : null;
    const parentOk = parentFolderId && !ctx.trashedFolderIds.has(parentFolderId) ? parentFolderId : null;
    const folder = await createFolder(col.name, parentOk);
    await upsertCollectionMapping(col.key, folder.id, col.name, col.parentKey);
    result.folderIdByKey.set(col.key, folder.id);
    result.created.push(col.name);
  }
  return result;
}

async function upsertCollectionMapping(
  collectionKey: string,
  folderId: string,
  name: string,
  parentKey: string | null,
): Promise<void> {
  await invoke("zotero_upsert_collection", { collectionKey, folderId, name, parentKey });
}

async function upsertPaperState(paperId: string, zoteroKey: string, collectionKeys: string[]): Promise<void> {
  await invoke("zotero_upsert_paper_state", { paperId, zoteroKey, collectionKeys });
}

// ==================== 批量导入执行 ====================

export interface ZoteroImportReport {
  imported: { key: string; title: string }[];
  /** 去重跳过的（merge/adopt/hash 兜底），via 标明判重方式 */
  skippedDup: { key: string; title: string; via: string }[];
  noPdf: { key: string; title: string }[];
  /** 解析质量疑似异常（检测到退化重复循环，建议换引擎重新解析） */
  suspectQuality: { key: string; title: string }[];
  failed: { key: string; title: string; error: string }[];
  /** 归属冲突：本地赢，未动 */
  conflicts: { key: string; title: string }[];
  mergesApplied: number;
  foldersCreated: string[];
  foldersRenamed: string[];
  cancelled: boolean;
}

export interface ZoteroBatchCallbacks {
  onItemStart?: (index: number, total: number, item: ZoteroItem) => void;
  onItemProgress?: (progress: PaperConvertProgress) => void;
  onItemSettled?: (index: number, item: ZoteroItem, outcome: "imported" | "failed" | "skipped") => void;
  isCancelled?: () => boolean;
}

interface ConvertOutcome {
  ok: boolean;
  paperDir?: string;
  error?: string;
  /** converter 质量守卫：重试后仍退化（done 事件透传） */
  degenerate?: boolean;
}

/** 勾选范围内的候选条目：属于任一已勾 collection，或（勾选未分类时）无归属条目 */
export function computeCandidates(scan: ZoteroScanResult, selectedKeys: ReadonlySet<string>): ZoteroItem[] {
  const includeUnfiled = selectedKeys.has(UNFILED_KEY);
  const seen = new Set<string>();
  const out: ZoteroItem[] = [];
  for (const item of scan.items) {
    if (seen.has(item.key)) continue;
    const inSelected = item.collectionKeys.some((k) => selectedKeys.has(k));
    if (!inSelected && !(includeUnfiled && item.collectionKeys.length === 0)) continue;
    seen.add(item.key);
    out.push(item);
  }
  return out;
}

/** 对话框底部统计：新导入 / 已存在（merge+adopt）/ 无 PDF（仅统计待导入但被无 PDF 挡住的） */
export function summarizeCandidates(
  candidates: ZoteroItem[],
  dedupKeys: PaperDedupKeys[],
  stateByKey: ReadonlyMap<string, ZoteroPaperState>,
): { fresh: number; existing: number; noPdf: number } {
  let fresh = 0;
  let existing = 0;
  let noPdf = 0;
  for (const item of candidates) {
    if (matchExisting(item, dedupKeys, stateByKey).kind === "import") {
      fresh += 1;
      if (!item.hasPdf) noPdf += 1;
    } else {
      existing += 1;
    }
  }
  return { fresh, existing, noPdf };
}

/**
 * 批量导入主流程：文件夹准备 → 已存在条目三方合并/收养 → 新条目逐篇转换入库。
 * 取消：isCancelled 置真后当前篇转换被 kill，队列不再推进，报告 cancelled=true。
 */
export async function executeZoteroImport(
  scan: ZoteroScanResult,
  candidates: ZoteroItem[],
  selectedKeys: ReadonlySet<string>,
  callbacks: ZoteroBatchCallbacks = {},
): Promise<ZoteroImportReport> {
  const report: ZoteroImportReport = {
    imported: [],
    skippedDup: [],
    noPdf: [],
    failed: [],
    conflicts: [],
    suspectQuality: [],
    mergesApplied: 0,
    foldersCreated: [],
    foldersRenamed: [],
    cancelled: false,
  };

  const ctx = await loadImportContext();
  const realSelectedKeys = new Set([...selectedKeys].filter((k) => k !== UNFILED_KEY));
  const prep = await ensureCollectionFolders(scan.collections, realSelectedKeys, ctx);
  report.foldersCreated = prep.created;
  report.foldersRenamed = prep.renamed;

  // K = 映射表 ∪ 本次勾选（文件夹准备后勾选集合已全部有映射）
  const knownKeys = new Set<string>([...prep.folderIdByKey.keys()]);
  const managedFolderIds = new Set(prep.folderIdByKey.values());
  const localFolderIdsOf = (paperId: string) =>
    ctx.paperFolderMap.filter((f) => f.paperId === paperId).map((f) => f.folderId);
  const intersectKnown = (keys: string[]) => keys.filter((k) => knownKeys.has(k));

  // 已存在文献：三方合并 / 收养（Z_old=∅ 时自然获得归档）
  const toImport: ZoteroItem[] = [];
  for (const item of candidates) {
    const match = matchExisting(item, ctx.dedupKeys, ctx.stateByKey);
    if (match.kind === "import") {
      toImport.push(item);
      continue;
    }
    const paperId = match.paperId;
    report.skippedDup.push({
      key: item.key,
      title: item.title,
      via: match.kind === "merge" ? "zotero_key" : match.via,
    });
    const zOld = intersectKnown(ctx.stateByKey.get(item.key)?.collectionKeys ?? []);
    const zNew = intersectKnown(item.collectionKeys);
    const plan = planFilingMerge({
      zOld,
      zNew,
      localFolderIds: localFolderIdsOf(paperId),
      folderIdByKey: prep.folderIdByKey,
      managedFolderIds,
      excludedFolderIds: ctx.trashedFolderIds,
    });
    try {
      if (plan.kind === "apply") {
        await setPaperFolders(paperId, plan.folderIds);
        report.mergesApplied += 1;
        await upsertPaperState(paperId, item.key, zNew);
      } else if (plan.kind === "conflict") {
        report.conflicts.push({ key: item.key, title: item.title });
        // 快照仍推进到 Z_new：冲突报告一次，不再纠缠
        await upsertPaperState(paperId, item.key, zNew);
      }
      if (match.kind === "adopt") {
        // 收养：回写 zotero_key 与源 PDF 回链（frontmatter + metadata.json）并补建状态
        // （hasPdf=false 时 pdfPath 为不存在的候选兜底路径，不记录回链）
        const paperDir = await join(await appDataDir(), "books", paperId);
        await invoke("inject_zotero_key", {
          paperDir,
          zoteroKey: item.key,
          zoteroPdfPath: item.hasPdf ? item.pdfPath : null,
        });
        if (plan.kind === "noop") await upsertPaperState(paperId, item.key, zNew);
      } else if (item.hasPdf && item.pdfPath) {
        // merge：幂等回写（为早期未记录 zotero_pdf_path 的导入补回链）；
        // hasPdf=false 的 pdfPath 是扫描侧"第一个候选路径"兜底，可能不存在，不落库
        const paperDir = await join(await appDataDir(), "books", paperId);
        await invoke("inject_zotero_key", { paperDir, zoteroKey: item.key, zoteroPdfPath: item.pdfPath });
      }
    } catch (error) {
      report.failed.push({ key: item.key, title: item.title, error: String(error) });
    }
  }

  // 新文献：逐篇转换 → 注入 key → 入库 → 挂载 → 记状态
  const queue = toImport.filter((item) => {
    if (!item.hasPdf) {
      report.noPdf.push({ key: item.key, title: item.title });
      return false;
    }
    return true;
  });

  let settleCurrent: ((outcome: ConvertOutcome) => void) | null = null;
  const unlisten = await listenPaperConvertProgress((p) => {
    if (p.type === "start" || p.type === "progress" || p.type === "stage_done") {
      callbacks.onItemProgress?.(p);
      return;
    }
    const settle = settleCurrent;
    if (!settle) return;
    if (p.type === "done") {
      settleCurrent = null;
      settle({ ok: true, paperDir: p.paper_dir, degenerate: p.degenerate === true });
    } else if (p.type === "error") {
      settleCurrent = null;
      settle({ ok: false, error: p.message ?? "转换失败" });
    } else if (p.type === "terminated" && !p.success) {
      settleCurrent = null;
      settle({ ok: false, error: "已取消" });
    }
  });

  try {
    for (let i = 0; i < queue.length; i++) {
      if (callbacks.isCancelled?.()) {
        report.cancelled = true;
        break;
      }
      const item = queue[i];
      callbacks.onItemStart?.(i, queue.length, item);
      const conversion = new Promise<ConvertOutcome>((resolve) => {
        settleCurrent = resolve;
      });
      try {
        await startPaperPdfImport(item.pdfPath as string);
      } catch (error) {
        settleCurrent = null;
        report.failed.push({ key: item.key, title: item.title, error: String(error) });
        callbacks.onItemSettled?.(i, item, "failed");
        continue;
      }
      const outcome = await conversion;

      if (!outcome.ok || !outcome.paperDir) {
        if (callbacks.isCancelled?.()) report.cancelled = true;
        else report.failed.push({ key: item.key, title: item.title, error: outcome.error ?? "转换失败" });
        callbacks.onItemSettled?.(i, item, "failed");
        if (report.cancelled) break;
        continue;
      }

      try {
        const paperId = await importConvertedPaper(
          outcome.paperDir,
          item,
          prep.folderIdByKey,
          knownKeys,
          ctx.trashedFolderIds,
        );
        if (paperId.duplicate) {
          // 哈希兜底：save_paper 判"已存在"→ 按收养处理
          report.skippedDup.push({ key: item.key, title: item.title, via: "hash" });
          await upsertPaperState(paperId.id, item.key, intersectKnown(item.collectionKeys));
          callbacks.onItemSettled?.(i, item, "skipped");
        } else {
          report.imported.push({ key: item.key, title: item.title });
          if (paperId.suspect || outcome.degenerate) report.suspectQuality.push({ key: item.key, title: item.title });
          await upsertPaperState(paperId.id, item.key, intersectKnown(item.collectionKeys));
          callbacks.onItemSettled?.(i, item, "imported");
        }
      } catch (error) {
        report.failed.push({ key: item.key, title: item.title, error: String(error) });
        callbacks.onItemSettled?.(i, item, "failed");
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

/** 转换产物入库：注入 zotero_key → 扫描 → 合并元数据 → save_paper → 挂载勾选集合 */
async function importConvertedPaper(
  paperDir: string,
  item: ZoteroItem,
  folderIdByKey: ReadonlyMap<string, string>,
  knownKeys: ReadonlySet<string>,
  trashedFolderIds: ReadonlySet<string>,
): Promise<{ id: string; duplicate: boolean; suspect: boolean }> {
  await invoke("inject_zotero_key", { paperDir, zoteroKey: item.key, zoteroPdfPath: item.pdfPath });
  const scanned = await invoke<ScannedPaper[]>("scan_papers_dir", { dir: paperDir });
  const paper = scanned.find((s) => s.dir === paperDir) ?? scanned[0];
  if (!paper) throw new Error(`转换产物无法识别: ${paperDir}`);

  // 退化循环检测（引擎 VLM 偶发"模式延续"失控）：命中不阻断入库，进报告提示换引擎重解析
  let suspect = false;
  try {
    const raw = await readTextFile(await join(paper.dir, "paper.md"));
    suspect = findDegenerateLoop(parsePaperMarkdown(raw).body) != null;
  } catch {
    // 检测失败不影响入库
  }

  const parsed: PaperMetadata = paper.frontmatter ? parseFrontmatter(paper.frontmatter) : {};
  const metadata: PaperMetadata = { ...parsed, zotero_key: item.key };
  if (!metadata.doi && item.doi) metadata.doi = item.doi;
  if (item.pdfPath) metadata.zotero_pdf_path = item.pdfPath;

  const authors = normalizeAuthors(metadata.author);
  const author = authors.length > 1 ? `${authors[0]} et al.` : (authors[0] ?? "");
  try {
    await invoke<SimpleBook>("save_paper", {
      sourceDir: paper.dir,
      id: paper.id,
      metadata,
      title: metadata.title?.trim() || paper.title_fallback,
      author,
      language: metadata.lang ?? "en",
      // Zotero 导入不拷 source.pdf：以 zotero_pdf_path 回链代替（用户偏好轻便）
      retainSourcePdf: false,
    });
  } catch (error) {
    if (String(error).includes("已存在")) return { id: paper.id, duplicate: true, suspect };
    throw error;
  }

  const folderIds = [
    ...new Set(
      item.collectionKeys
        .filter((k) => knownKeys.has(k))
        .map((k) => folderIdByKey.get(k))
        .filter((id): id is string => !!id && !trashedFolderIds.has(id)),
    ),
  ];
  if (folderIds.length > 0) {
    try {
      await setPaperFolders(paper.id, folderIds);
    } catch (error) {
      // 论文已入库，挂载失败不记为导入失败
      console.warn(`挂载论文到文件夹失败: ${paper.id}`, error);
    }
  }
  return { id: paper.id, duplicate: false, suspect };
}
