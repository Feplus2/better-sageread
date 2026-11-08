import { WorkspaceDirectoryDialog } from "@/components/file-workspace/workspace-directory-dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { AgentFileScope } from "@/services/agent-workspace-files";
import { useAgentSettingsStore } from "@/store/agent-settings-store";
import { selectTaskWorkspaceRoot, useTaskWorkspaceStore } from "@/store/task-workspace-store";
import { appDataDir } from "@tauri-apps/api/path";
import { FolderOpen, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

export interface WorkspaceChipProps {
  hostId?: string;
  scope?: AgentFileScope;
  threadId?: string;
}

const SCOPE_LABELS = { central: "全局助手", reader: "阅读助手", paper: "论文助手" } as const;

export function WorkspaceChip({ hostId = "central", scope = "central", threadId }: WorkspaceChipProps) {
  const workspaceRoot = useAgentSettingsStore((state) => state.workspaceRoot);
  const perAgentRoots = useAgentSettingsStore((state) => state.perAgentRoots);
  const setPerAgentRoot = useAgentSettingsStore((state) => state.setPerAgentRoot);
  const taskRoot = useTaskWorkspaceStore((state) => selectTaskWorkspaceRoot(state, hostId, threadId));
  const clearTaskWorkspaceRoot = useTaskWorkspaceStore((state) => state.clearTaskWorkspaceRoot);
  const setTaskWorkspaceRoot = useTaskWorkspaceStore((state) => state.setTaskWorkspaceRoot);
  const [displayRoot, setDisplayRoot] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const overridden = Boolean(taskRoot || perAgentRoots[scope]);

  useEffect(() => {
    const configured = taskRoot ?? perAgentRoots[scope] ?? workspaceRoot;
    if (configured) {
      setDisplayRoot(configured);
      return;
    }
    void appDataDir().then((dir) => setDisplayRoot(`${dir.replace(/[\\/]+$/, "")}/agent-workspace`));
  }, [perAgentRoots, scope, taskRoot, workspaceRoot]);

  const shortName = displayRoot ? (displayRoot.split(/[\\/]/).filter(Boolean).pop() ?? displayRoot) : "…";
  const resetShared = () => {
    clearTaskWorkspaceRoot(hostId, threadId);
    setPerAgentRoot(scope, null);
    toast.success("已恢复共享工作区");
  };

  return (
    <div className="flex min-w-0 items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            className="flex h-7 min-w-0 cursor-pointer items-center gap-1 rounded-md bg-muted px-2 text-neutral-600 text-xs hover:bg-muted/70 dark:text-neutral-300"
            aria-label={`选择${SCOPE_LABELS[scope]}的任务工作区：${displayRoot || "…"}`}
          >
            <FolderOpen className="size-3.5 flex-shrink-0" />
            <span className="max-w-32 truncate">{overridden ? shortName : "共享工作区"}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">
          {displayRoot || "…"}（{taskRoot ? "仅本次任务" : perAgentRoots[scope] ? "此助手默认" : "共享工作区"}）
        </TooltipContent>
      </Tooltip>
      {overridden && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={resetShared}
              className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="恢复共享工作区"
            >
              <RotateCcw className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">恢复共享工作区</TooltipContent>
        </Tooltip>
      )}
      <WorkspaceDirectoryDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title={`选择${SCOPE_LABELS[scope]}的任务工作区`}
        initialPath={displayRoot}
        mode="task"
        defaultMode={taskRoot ? "once" : "remember"}
        onSubmit={(path, mode) => {
          if (mode === "remember") {
            setPerAgentRoot(scope, path);
            clearTaskWorkspaceRoot(hostId, threadId);
          } else {
            setTaskWorkspaceRoot(hostId, threadId ?? null, path);
          }
        }}
        onReset={resetShared}
      />
    </div>
  );
}
