import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cancelPaperPdfImport, paperEngineTokenError } from "@/services/paper-service";
import {
  type PaperDedupKeys,
  UNFILED_KEY,
  type ZoteroCollection,
  type ZoteroImportReport,
  type ZoteroPaperState,
  type ZoteroScanResult,
  type ZoteroStateResult,
  computeCandidates,
  executeZoteroImport,
  scanZoteroLibrary,
  summarizeCandidates,
} from "@/services/zotero-import-service";
import { useConverterStore } from "@/store/converter-store";
import { invoke } from "@tauri-apps/api/core";
import { homeDir, join } from "@tauri-apps/api/path";
import { open as openPathDialog } from "@tauri-apps/plugin-dialog";
import clsx from "clsx";
import { Folder as FolderIcon, FolderOpen, Inbox, Loader2 } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

// ==================== Collection 树（parentKey 组装，同 buildFolderTree 思路） ====================

interface CollectionNode extends ZoteroCollection {
  children: CollectionNode[];
}

/** 扁平 collection 列表 → 树（parentKey 指向不存在或未扫描到的节点时按根处理，保持原顺序） */
function buildCollectionTree(collections: ZoteroCollection[]): CollectionNode[] {
  const nodes = new Map<string, CollectionNode>();
  for (const c of collections) {
    nodes.set(c.key, { ...c, children: [] });
  }
  const roots: CollectionNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentKey ? nodes.get(node.parentKey) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

/** 节点自身 + 全部后代的 key 集合（勾选联动用） */
function collectSubtreeKeys(node: CollectionNode, into: Set<string> = new Set()): Set<string> {
  into.add(node.key);
  for (const child of node.children) collectSubtreeKeys(child, into);
  return into;
}

type CheckState = boolean | "indeterminate";

function subtreeCheckState(node: CollectionNode, selectedKeys: ReadonlySet<string>): CheckState {
  const keys = collectSubtreeKeys(node);
  let hit = 0;
  for (const key of keys) if (selectedKeys.has(key)) hit += 1;
  if (hit === 0) return false;
  if (hit === keys.size) return true;
  return "indeterminate";
}

// ==================== 报告判重方式中文映射 ====================

const VIA_LABELS: Record<string, string> = {
  zotero_key: "Zotero 记录",
  doi: "DOI",
  "title-exact": "标题",
  "title-similar": "疑似重复",
  hash: "内容哈希",
};

const viaLabel = (via: string) => VIA_LABELS[via] ?? via;

// ==================== 组件状态类型 ====================

type Phase = "select" | "running" | "report";

interface RunProgress {
  /** 当前篇序号（0 基） */
  index: number;
  total: number;
  title: string;
  stageName?: string;
  detail?: string;
  percent?: number;
}

export interface ZoteroImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 导入跑过后关闭对话框时回调（父页面刷新论文列表与文件夹树） */
  onCompleted: () => void;
  /** 批量运行状态同步给父页面（禁用其他导入入口） */
  onRunningChange?: (running: boolean) => void;
}

/** Zotero 批量导入对话框：选择（目录+Collection 树）→ 进行（总进度+当前篇）→ 报告（分区结果） */
export function ZoteroImportDialog({ open, onOpenChange, onCompleted, onRunningChange }: ZoteroImportDialogProps) {
  const [phase, setPhase] = useState<Phase>("select");
  // 选择态
  const [dirInput, setDirInput] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scan, setScan] = useState<ZoteroScanResult | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [dedupKeys, setDedupKeys] = useState<PaperDedupKeys[] | null>(null);
  const [stateByKey, setStateByKey] = useState<Map<string, ZoteroPaperState>>(new Map());
  const [statsError, setStatsError] = useState<string | null>(null);
  // 进行态 / 报告态
  const [run, setRun] = useState<RunProgress | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [report, setReport] = useState<ZoteroImportReport | null>(null);

  const paperEngine = useConverterStore((state) => state.paperEngine);
  const setZoteroDataDir = useConverterStore((state) => state.setZoteroDataDir);

  const cancelRef = useRef(false);
  /** 每次打开/启动递增，丢弃迟到回调（关闭后重开时旧任务的 setState 不生效） */
  const runIdRef = useRef(0);
  /** 本次会话是否启动过导入：决定关闭时是否回调 onCompleted */
  const didRunRef = useRef(false);

  // 打开时整体重置为选择态；目录默认取 store，空则试算 ~/Zotero
  useEffect(() => {
    if (!open) return;
    runIdRef.current += 1;
    cancelRef.current = false;
    didRunRef.current = false;
    onRunningChange?.(false);
    setPhase("select");
    setScan(null);
    setScanError(null);
    setSelectedKeys(new Set());
    setDedupKeys(null);
    setStateByKey(new Map());
    setStatsError(null);
    setRun(null);
    setCancelling(false);
    setReport(null);
    const stored = useConverterStore.getState().zoteroDataDir;
    setDirInput(stored);
    if (!stored) {
      homeDir()
        .then((home) => join(home, "Zotero"))
        .then((dir) => setDirInput((prev) => prev || dir))
        .catch(() => {});
    }
  }, [open, onRunningChange]);

  // ---- 选择态派生数据 ----
  const tree = useMemo(() => (scan ? buildCollectionTree(scan.collections) : []), [scan]);
  const unfiledCount = useMemo(
    () => scan?.items.filter((item) => item.collectionKeys.length === 0).length ?? 0,
    [scan],
  );
  const candidates = useMemo(() => (scan ? computeCandidates(scan, selectedKeys) : []), [scan, selectedKeys]);
  const summary = useMemo(
    () => (dedupKeys ? summarizeCandidates(candidates, dedupKeys, stateByKey) : null),
    [candidates, dedupKeys, stateByKey],
  );
  const tokenError = paperEngineTokenError(paperEngine);
  const canStart = candidates.length > 0 && !tokenError;

  // ---- 选择态操作 ----
  const handleBrowse = async () => {
    try {
      const selected = await openPathDialog({ directory: true, multiple: false, title: "选择 Zotero 数据目录" });
      if (typeof selected === "string" && selected) setDirInput(selected);
    } catch (error) {
      console.warn("选择 Zotero 数据目录失败:", error);
    }
  };

  const handleScan = async () => {
    const dir = dirInput.trim();
    if (!dir || scanning) return;
    setScanning(true);
    setScanError(null);
    try {
      const result = await scanZoteroLibrary(dir);
      setScan(result);
      setZoteroDataDir(dir);
      // 默认全选（含「未分类」伪节点），用户再按需反选
      const all = new Set(result.collections.map((c) => c.key));
      if (result.items.some((item) => item.collectionKeys.length === 0)) all.add(UNFILED_KEY);
      setSelectedKeys(all);
      // 判重上下文（统计「预计新导入 / 已存在」用）
      try {
        const [state, dedup] = await Promise.all([
          invoke<ZoteroStateResult>("zotero_get_state"),
          invoke<PaperDedupKeys[]>("list_paper_dedup_keys"),
        ]);
        setStateByKey(new Map(state.papers.map((p) => [p.zoteroKey, p])));
        setDedupKeys(dedup);
        setStatsError(null);
      } catch (error) {
        setDedupKeys(null);
        setStatsError(`判重信息加载失败：${error instanceof Error ? error.message : String(error)}`);
      }
    } catch (error) {
      setScan(null);
      setScanError(error instanceof Error ? error.message : String(error));
    } finally {
      setScanning(false);
    }
  };

  const toggleNode = (node: CollectionNode, checked: boolean) => {
    const keys = collectSubtreeKeys(node);
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      for (const key of keys) {
        if (checked) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  };

  const renderNode = (node: CollectionNode, depth: number) => (
    <div key={node.key}>
      <div
        className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800/60"
        style={{ marginInlineStart: `${depth * 16}px` }}
      >
        <Checkbox
          checked={subtreeCheckState(node, selectedKeys)}
          onCheckedChange={(checked) => toggleNode(node, checked === true)}
        />
        <FolderIcon className="size-3.5 shrink-0 text-neutral-400" />
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
        <span className="shrink-0 text-neutral-400 text-xs">（{node.itemCount} 篇）</span>
      </div>
      {node.children.map((child) => renderNode(child, depth + 1))}
    </div>
  );

  // ---- 执行 ----
  const handleStart = async () => {
    if (!scan || !canStart) return;
    const runId = ++runIdRef.current;
    const items = candidates;
    cancelRef.current = false;
    didRunRef.current = true;
    setCancelling(false);
    setPhase("running");
    onRunningChange?.(true);
    setRun({ index: 0, total: items.length, title: "", detail: "准备导入…", percent: 0 });
    try {
      const result = await executeZoteroImport(scan, items, selectedKeys, {
        onItemStart: (index, total, item) => {
          setRun({ index, total, title: item.title, detail: "等待解析…", percent: 0 });
        },
        onItemProgress: (p) => {
          setRun((prev) =>
            prev
              ? {
                  ...prev,
                  stageName: p.stage_name ?? prev.stageName,
                  detail: p.detail ?? p.stage_name ?? prev.detail,
                  percent: p.percent ?? prev.percent,
                }
              : prev,
          );
        },
        isCancelled: () => cancelRef.current,
      });
      if (runIdRef.current === runId) {
        setReport(result);
        setPhase("report");
      }
    } catch (error) {
      if (runIdRef.current === runId) {
        setReport({
          imported: [],
          skippedDup: [],
          noPdf: [],
          failed: [
            {
              key: "",
              title: "批量导入",
              error: error instanceof Error ? error.message : String(error),
            },
          ],
          conflicts: [],
          mergesApplied: 0,
          foldersCreated: [],
          foldersRenamed: [],
          cancelled: cancelRef.current,
        });
        setPhase("report");
      }
    } finally {
      if (runIdRef.current === runId) onRunningChange?.(false);
    }
  };

  /** 取消：置位 isCancelled 并立即 kill 当前篇转换（terminated 事件驱动队列收尾） */
  const handleCancel = () => {
    cancelRef.current = true;
    setCancelling(true);
    setRun((prev) => (prev ? { ...prev, detail: "正在取消…" } : prev));
    cancelPaperPdfImport().catch(() => {});
  };

  /** 关闭：进行中等同取消；跑过导入则回调 onCompleted 让父页面刷新 */
  const handleOpenChange = (next: boolean) => {
    if (next) {
      onOpenChange(true);
      return;
    }
    if (phase === "running") handleCancel();
    if (didRunRef.current) {
      didRunRef.current = false;
      onCompleted();
    }
    onOpenChange(false);
  };

  // ---- 渲染 ----
  const overallPercent =
    run && run.total > 0 ? Math.min(100, Math.round(((run.index + (run.percent ?? 0) / 100) / run.total) * 100)) : 0;

  // 进行态：右下角后台进度卡（与单篇/多篇 PDF 导入同款），不渲染模态让出页面；取消等效原关闭行为
  if (phase === "running" && run) {
    return (
      <div className="absolute right-4 bottom-4 z-40 w-80 rounded-xl border bg-background p-3.5 shadow-lg">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="min-w-0 flex-1 truncate font-medium text-sm">{run.title || "准备导入…"}</span>
          <span className="shrink-0 text-muted-foreground text-xs">
            {Math.min(run.index + 1, run.total)}/{run.total}
          </span>
        </div>
        <Progress value={overallPercent} className="h-1.5" />
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
            {run.stageName ? `${run.stageName} · ` : ""}
            {run.detail ?? ""}
          </span>
          <span className="shrink-0 text-muted-foreground text-xs">{overallPercent}%</span>
        </div>
        <div className="mt-2.5 flex items-center justify-between gap-2">
          <span className="text-muted-foreground text-xs">Zotero 批量导入</span>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2.5 text-xs"
            onClick={handleCancel}
            disabled={cancelling}
          >
            {cancelling ? "正在取消…" : "取消"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader className="px-5">
          <DialogTitle>Zotero 批量导入</DialogTitle>
          <DialogDescription className="px-0">
            {phase === "select" && "扫描本地 Zotero 库，勾选 Collection 后批量解析入库"}
            {phase === "report" && "导入完成，结果分区如下"}
          </DialogDescription>
        </DialogHeader>

        {phase === "select" && (
          <div className="min-w-0 space-y-4 px-5 py-4">
            {/* 数据目录行 */}
            <div className="space-y-1.5">
              <span className="text-neutral-500 text-xs dark:text-neutral-400">
                Zotero 数据目录（含 zotero.sqlite 与 storage/）
              </span>
              <div className="flex items-center gap-2">
                <Input
                  value={dirInput}
                  onChange={(event) => setDirInput(event.target.value)}
                  placeholder="例如 C:\Users\你\Zotero"
                  className="h-8 flex-1 text-sm"
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      handleScan();
                    }
                  }}
                />
                <Button variant="outline" size="sm" onClick={handleBrowse} disabled={scanning}>
                  <FolderOpen className="size-4" />
                  浏览…
                </Button>
                <Button size="sm" onClick={handleScan} disabled={!dirInput.trim() || scanning}>
                  {scanning ? <Loader2 className="size-4 animate-spin" /> : null}
                  扫描
                </Button>
              </div>
              {scanError && <p className="text-red-600 text-xs dark:text-red-400">{scanError}</p>}
            </div>

            {/* Collection 树（三态勾选） */}
            {scan && (
              <div className="space-y-1.5">
                <span className="text-neutral-500 text-xs dark:text-neutral-400">
                  选择要导入的 Collection（共 {scan.items.length} 篇条目）
                </span>
                <ScrollArea className="h-56 rounded-md border border-neutral-200 dark:border-neutral-800">
                  <div className="space-y-0.5 p-1.5">
                    {tree.map((node) => renderNode(node, 0))}
                    {unfiledCount > 0 && (
                      <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800/60">
                        <Checkbox
                          checked={selectedKeys.has(UNFILED_KEY)}
                          onCheckedChange={(checked) =>
                            setSelectedKeys((prev) => {
                              const next = new Set(prev);
                              if (checked === true) next.add(UNFILED_KEY);
                              else next.delete(UNFILED_KEY);
                              return next;
                            })
                          }
                        />
                        <Inbox className="size-3.5 shrink-0 text-neutral-400" />
                        <span className="min-w-0 flex-1 truncate">未分类</span>
                        <span className="shrink-0 text-neutral-400 text-xs">（{unfiledCount} 篇）</span>
                      </div>
                    )}
                  </div>
                </ScrollArea>

                {/* 统计行 */}
                {summary ? (
                  <p className="text-neutral-500 text-xs dark:text-neutral-400">
                    已选 {candidates.length} 篇 · 预计新导入 {summary.fresh} · 已存在 {summary.existing}
                    （其中无 PDF {summary.noPdf} 篇）
                  </p>
                ) : (
                  statsError && <p className="text-amber-600 text-xs dark:text-amber-400">{statsError}</p>
                )}
              </div>
            )}
          </div>
        )}

        {phase === "report" && report && (
          // 单层原生滚动容器：Radix ScrollArea 的 display:table 视口会让 truncate/nowrap 内容撑破对话框宽度，
          // 嵌套滚动还会让内层高度约束失效（2026-08-05 报告溢出事故）
          <div className="max-h-[55vh] min-w-0 overflow-y-auto">
            <div className="min-w-0 space-y-3 px-5 py-4 text-sm">
              {report.cancelled && (
                <p className="rounded-md bg-amber-50 px-3 py-2 text-amber-700 text-xs dark:bg-amber-950/50 dark:text-amber-400">
                  已取消：仅部分条目完成处理
                </p>
              )}

              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                <span className="text-green-600 dark:text-green-400">新导入 {report.imported.length} 篇</span>
                <span className="text-neutral-600 dark:text-neutral-400">跳过重复 {report.skippedDup.length} 篇</span>
                <span className="text-neutral-600 dark:text-neutral-400">无 PDF 跳过 {report.noPdf.length} 篇</span>
                <span className={clsx(report.failed.length > 0 && "text-red-600 dark:text-red-400")}>
                  失败 {report.failed.length} 篇
                </span>
                {report.conflicts.length > 0 && (
                  <span className="text-amber-600 dark:text-amber-400">
                    分类冲突保留本地 {report.conflicts.length} 篇
                  </span>
                )}
                {report.suspectQuality.length > 0 && (
                  <span className="text-amber-600 dark:text-amber-400">
                    解析疑似异常 {report.suspectQuality.length} 篇
                  </span>
                )}
                {report.mergesApplied > 0 && (
                  <span className="text-neutral-600 dark:text-neutral-400">归属合并 {report.mergesApplied} 篇</span>
                )}
              </div>

              {report.imported.length > 0 && (
                <ReportSection title={`新导入（${report.imported.length}）`}>
                  {report.imported.map((entry) => (
                    <li key={entry.key} className="truncate" title={entry.title}>
                      {entry.title}
                    </li>
                  ))}
                </ReportSection>
              )}

              {report.skippedDup.length > 0 && (
                <ReportSection title={`跳过重复（${report.skippedDup.length}）`}>
                  {report.skippedDup.map((entry) => (
                    <li key={entry.key} className="truncate" title={entry.title}>
                      {entry.title}
                      <span className="ml-1 text-neutral-400 text-xs">（{viaLabel(entry.via)}）</span>
                    </li>
                  ))}
                </ReportSection>
              )}

              {report.noPdf.length > 0 && (
                <ReportSection title={`无 PDF 跳过（${report.noPdf.length}）`}>
                  {report.noPdf.map((entry) => (
                    <li key={entry.key} className="truncate" title={entry.title}>
                      {entry.title}
                    </li>
                  ))}
                </ReportSection>
              )}

              {report.failed.length > 0 && (
                <ReportSection title={`失败（${report.failed.length}）`} tone="error">
                  {report.failed.map((entry) => (
                    <li key={`${entry.key}-${entry.title}`}>
                      <span className="font-medium">{entry.title}</span>
                      <span className="ml-1 break-all text-red-500 text-xs dark:text-red-400">{entry.error}</span>
                    </li>
                  ))}
                </ReportSection>
              )}

              {report.conflicts.length > 0 && (
                <ReportSection title={`分类冲突（${report.conflicts.length}，已保留本地归属）`} tone="warn">
                  {report.conflicts.map((entry) => (
                    <li key={entry.key} className="truncate" title={entry.title}>
                      {entry.title}
                    </li>
                  ))}
                </ReportSection>
              )}

              {report.suspectQuality.length > 0 && (
                <ReportSection
                  title={`解析质量疑似异常（${report.suspectQuality.length}，检测到异常重复内容，建议在设置中换解析引擎后重新解析）`}
                  tone="warn"
                >
                  {report.suspectQuality.map((entry) => (
                    <li key={entry.key} className="truncate" title={entry.title}>
                      {entry.title}
                    </li>
                  ))}
                </ReportSection>
              )}

              {(report.foldersCreated.length > 0 || report.foldersRenamed.length > 0) && (
                <div className="space-y-1 text-neutral-500 text-xs dark:text-neutral-400">
                  {report.foldersCreated.length > 0 && <p>新建文件夹：{report.foldersCreated.join("、")}</p>}
                  {report.foldersRenamed.length > 0 && <p>改名文件夹：{report.foldersRenamed.join("、")}</p>}
                </div>
              )}
            </div>
          </div>
        )}

        <DialogFooter className="px-5 pt-0 pb-4">
          {phase === "select" && (
            <>
              {tokenError && <p className="mr-auto self-center text-red-600 text-xs dark:text-red-400">{tokenError}</p>}
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                取消
              </Button>
              <Button onClick={handleStart} disabled={!canStart}>
                开始导入
              </Button>
            </>
          )}
          {phase === "report" && <Button onClick={() => handleOpenChange(false)}>完成</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 报告分区：标题 + 列表（滚动由外层单容器承担，不再嵌套 ScrollArea） */
function ReportSection({
  title,
  tone,
  children,
}: {
  title: string;
  tone?: "error" | "warn";
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <p
        className={clsx(
          "font-medium text-xs",
          tone === "error" && "text-red-600 dark:text-red-400",
          tone === "warn" && "text-amber-600 dark:text-amber-400",
          !tone && "text-neutral-700 dark:text-neutral-300",
        )}
      >
        {title}
      </p>
      <ul className="list-disc space-y-0.5 pl-5 text-neutral-600 text-xs dark:text-neutral-400">{children}</ul>
    </div>
  );
}
