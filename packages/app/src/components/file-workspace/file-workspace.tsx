import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { AgentFileScope, AgentWorkspaceRoot } from "@/services/agent-workspace-files";
import { useFileWorkspaceStore } from "@/store/file-workspace-store";
import { FileText, FolderOpen, FolderPlus, ListX, X } from "lucide-react";
import { useState } from "react";
import { FileExplorer } from "./file-explorer";
import { FilePreview } from "./file-preview";

interface FileWorkspaceProps {
  hostId: string;
  scope: AgentFileScope;
}

function tabDomId(id: string): string {
  return `workspace-tab-${encodeURIComponent(id)}`;
}

export function FileWorkspace({ hostId, scope }: FileWorkspaceProps) {
  const host = useFileWorkspaceStore((state) => state.hosts[hostId]);
  const openExplorer = useFileWorkspaceStore((state) => state.openExplorer);
  const openFile = useFileWorkspaceStore((state) => state.openFile);
  const setActiveTab = useFileWorkspaceStore((state) => state.setActiveTab);
  const closeTab = useFileWorkspaceStore((state) => state.closeTab);
  const closeAllTabs = useFileWorkspaceStore((state) => state.closeAllTabs);
  const setPreviewRoot = useFileWorkspaceStore((state) => state.setPreviewRoot);
  const setExplorerPath = useFileWorkspaceStore((state) => state.setExplorerPath);
  const [refreshToken, setRefreshToken] = useState(0);
  const [error, setError] = useState("");

  if (!host) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground text-sm" role="status">
        正在准备工作区…
      </div>
    );
  }
  const root: AgentWorkspaceRoot = { configured: host.rootResolved, resolved: host.rootResolved };
  const activeTab = host.tabs.find((tab) => tab.id === host.activeTabId) ?? null;
  const refresh = () => setRefreshToken((value) => value + 1);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-popover" data-region="file-workspace">
      <div className="flex shrink-0 items-center border-neutral-200 border-b dark:border-neutral-700">
        <div
          role="tablist"
          aria-label="工作区标签"
          className="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto px-1"
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='tab']"));
            if (buttons.length === 0) return;
            const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? buttons.length - 1
                  : event.key === "ArrowRight"
                    ? (current + 1) % buttons.length
                    : (current - 1 + buttons.length) % buttons.length;
            event.preventDefault();
            const tabId = buttons[next]?.dataset.tabId;
            if (tabId) {
              setActiveTab(hostId, tabId);
              buttons[next]?.focus();
            }
          }}
        >
          {host.tabs.map((tab) => {
            const active = activeTab?.id === tab.id;
            return (
              <div
                key={tab.id}
                className={cn(
                  "group flex min-w-0 max-w-52 items-center rounded-t-md border-b-2 transition-colors",
                  active ? "border-primary bg-background" : "border-transparent focus-within:bg-accent hover:bg-accent",
                )}
              >
                <button
                  type="button"
                  role="tab"
                  id={tabDomId(tab.id)}
                  data-tab-id={tab.id}
                  aria-selected={active}
                  aria-controls="workspace-file-panel"
                  tabIndex={active ? 0 : -1}
                  onClick={() => setActiveTab(hostId, tab.id)}
                  className="flex h-8 min-w-0 items-center gap-1.5 truncate px-2 text-neutral-600 text-xs group-hover:text-foreground dark:text-neutral-300"
                >
                  {tab.type === "explorer" ? (
                    <FolderOpen className="size-3.5 shrink-0" />
                  ) : (
                    <FileText className="size-3.5 shrink-0" />
                  )}
                  <span className="truncate">{tab.title}</span>
                </button>
                <button
                  type="button"
                  aria-label={`关闭 ${tab.title}`}
                  onClick={() => closeTab(hostId, tab.id)}
                  className="mr-0.5 rounded p-1 text-neutral-400 hover:bg-background/60 hover:text-foreground group-hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              </div>
            );
          })}
        </div>
        <div className="flex shrink-0 items-center gap-0.5 border-neutral-200 border-l px-1 dark:border-neutral-700">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="打开文件资源管理器标签"
                onClick={() => openExplorer(hostId, scope, root.resolved)}
                className="size-7"
              >
                <FolderPlus className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">打开文件资源管理器标签</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="关闭全部标签"
                disabled={host.tabs.length === 0}
                onClick={() => closeAllTabs(hostId)}
                className="size-7"
              >
                <ListX className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">关闭全部标签</TooltipContent>
          </Tooltip>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        <div
          id="workspace-file-panel"
          role="tabpanel"
          aria-labelledby={activeTab ? tabDomId(activeTab.id) : undefined}
          className="flex h-full min-h-0 flex-col"
        >
          {error ? (
            <div className="flex flex-1 items-center justify-center gap-2 p-6 text-red-600 text-sm" role="alert">
              {error}
              <Button variant="outline" size="sm" onClick={() => setError("")}>
                知道了
              </Button>
            </div>
          ) : activeTab?.type === "explorer" ? (
            <FileExplorer
              scope={scope}
              root={root}
              currentPath={host.explorerPath}
              refreshToken={refreshToken}
              onOpenFile={(file) => openFile(hostId, scope, root.resolved, file)}
              onNavigate={(path) => setExplorerPath(hostId, path)}
              onChangeRoot={async (path) => {
                try {
                  const { resolveAgentWorkspaceRoot } = await import("@/services/agent-workspace-files");
                  const next = await resolveAgentWorkspaceRoot(scope, path);
                  setPreviewRoot(hostId, scope, next.resolved);
                } catch (reason) {
                  setError(reason instanceof Error ? reason.message : String(reason));
                  throw reason;
                }
              }}
              onResetRoot={async () => {
                const { resolveAgentWorkspaceRoot } = await import("@/services/agent-workspace-files");
                const next = await resolveAgentWorkspaceRoot(scope);
                setPreviewRoot(hostId, scope, next.resolved);
              }}
            />
          ) : activeTab ? (
            <FilePreview key={activeTab.id} tab={activeTab} refreshToken={refreshToken} onRefresh={refresh} />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-muted-foreground text-sm">
              <FolderOpen className="size-8 text-neutral-300" />
              <p>没有打开的标签。目录是可选的，也可以从对话直接打开产物。</p>
              <Button variant="outline" size="sm" onClick={() => openExplorer(hostId, scope, root.resolved)}>
                浏览目录
              </Button>
            </div>
          )}
        </div>
      </div>
      <div className="sr-only" aria-live="polite">
        {activeTab ? `当前显示${activeTab.title}，共 ${host.tabs.length} 个标签` : "没有打开的标签"}
      </div>
    </div>
  );
}
