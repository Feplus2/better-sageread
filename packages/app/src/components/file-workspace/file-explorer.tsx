import { WorkspaceDirectoryDialog } from "@/components/file-workspace/workspace-directory-dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  type AgentFileScope,
  type AgentWorkspaceRoot,
  type WorkspaceEntry,
  listWorkspaceDirectory,
} from "@/services/agent-workspace-files";
import { useFileWorkspaceStore } from "@/store/file-workspace-store";
import { ChevronLeft, FileText, Folder, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

interface FileExplorerProps {
  scope: AgentFileScope;
  root: AgentWorkspaceRoot;
  currentPath: string;
  refreshToken: number;
  onOpenFile: (file: { path: string; title?: string }) => void;
  onNavigate: (path: string) => void;
  onChangeRoot: (path: string) => Promise<void>;
  onResetRoot: () => Promise<void>;
}

function normalize(path: string): string {
  const trimmed = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[A-Za-z]:$/.test(trimmed) ? `${trimmed}/` : trimmed || "/";
}

function parentPath(path: string): string {
  const normalized = normalize(path);
  if (/^[A-Za-z]:\/[^/]+$/.test(normalized)) return `${normalized.slice(0, 2)}/`;
  const index = normalized.lastIndexOf("/");
  return index > 0 ? normalized.slice(0, index) : normalized;
}

export function FileExplorer({
  scope,
  root,
  currentPath,
  refreshToken,
  onOpenFile,
  onNavigate,
  onChangeRoot,
  onResetRoot,
}: FileExplorerProps) {
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [nextOffset, setNextOffset] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [chooserOpen, setChooserOpen] = useState(false);
  const storedRecentPaths = useFileWorkspaceStore((state) => state.recentRoots[scope]);
  const recentPaths = storedRecentPaths ?? [];
  const requestRef = useRef(0);

  const load = useCallback(
    async (offset: number, append: boolean) => {
      const request = ++requestRef.current;
      setLoading(true);
      setError("");
      try {
        const result = await listWorkspaceDirectory(scope, currentPath, offset, 100, { rootResolved: root.resolved });
        if (request !== requestRef.current) return;
        setEntries((previous) => (append ? [...previous, ...result.items] : result.items));
        setNextOffset(result.nextOffset);
        setTruncated(result.truncated);
      } catch (reason) {
        if (request === requestRef.current) setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        if (request === requestRef.current) setLoading(false);
      }
    },
    [currentPath, root.resolved, scope],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken 是显式刷新信号，即使目录和根未变也重新读取。
  useEffect(() => {
    void load(0, false);
  }, [load, refreshToken]);

  const atRoot = normalize(currentPath) === normalize(root.resolved);
  return (
    <aside className="flex h-full min-h-0 flex-col" data-region="file-explorer" aria-label="文件资源管理器">
      <div className="flex h-9 shrink-0 items-center gap-1 border-neutral-200 border-b px-2 dark:border-neutral-700">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="返回上级目录"
              disabled={atRoot}
              onClick={() => onNavigate(parentPath(currentPath))}
              className="rounded p-1 text-neutral-500 hover:bg-accent disabled:opacity-30"
            >
              <ChevronLeft className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">返回上级目录</TooltipContent>
        </Tooltip>
        <button
          type="button"
          onClick={() => setChooserOpen(true)}
          className="min-w-0 flex-1 truncate rounded px-1 text-left text-neutral-500 text-xs hover:bg-accent"
          aria-label={`更换预览目录。当前：${currentPath}`}
        >
          {currentPath}
        </button>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="刷新目录"
              onClick={() => void load(0, false)}
              className="rounded p-1 text-neutral-500 hover:bg-accent"
            >
              <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">刷新目录</TooltipContent>
        </Tooltip>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {error ? (
          <div className="p-3 text-red-600 text-xs dark:text-red-400" role="alert">
            {error}
          </div>
        ) : entries.length === 0 && !loading ? (
          <div className="p-3 text-neutral-400 text-xs">此目录为空</div>
        ) : (
          entries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              onClick={() =>
                entry.isDirectory ? onNavigate(entry.path) : onOpenFile({ path: entry.path, title: entry.name })
              }
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-neutral-600 text-xs hover:bg-accent dark:text-neutral-300"
              aria-label={entry.isDirectory ? `打开目录 ${entry.name}` : `预览文件 ${entry.name}`}
            >
              {entry.isDirectory ? (
                <Folder className="size-3.5 shrink-0 text-amber-500" />
              ) : (
                <FileText className="size-3.5 shrink-0 text-neutral-400" />
              )}
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            </button>
          ))
        )}
        {loading && (
          <div className="flex items-center gap-2 p-3 text-neutral-400 text-xs">
            <Loader2 className="size-3.5 animate-spin" /> 读取目录…
          </div>
        )}
        {truncated && !loading && (
          <button
            type="button"
            onClick={() => void load(nextOffset, true)}
            className="w-full rounded-md px-2 py-1.5 text-center text-primary text-xs hover:bg-accent"
          >
            加载更多
          </button>
        )}
      </div>
      <WorkspaceDirectoryDialog
        open={chooserOpen}
        onOpenChange={setChooserOpen}
        title="更换预览目录"
        initialPath={currentPath}
        recentPaths={recentPaths}
        onSubmit={onChangeRoot}
        onReset={onResetRoot}
      />
    </aside>
  );
}
