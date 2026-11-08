import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  type AgentFileScope,
  type AgentWorkspaceRoot,
  resolveAgentWorkspaceRoot,
} from "@/services/agent-workspace-files";
import { useFileWorkspaceStore } from "@/store/file-workspace-store";
import { Folder, FolderOpen } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

interface WorkspaceOpenButtonProps {
  hostId: string;
  scope: AgentFileScope;
  className?: string;
}

export function WorkspaceOpenButton({ hostId, scope, className }: WorkspaceOpenButtonProps) {
  const [opening, setOpening] = useState(false);
  const mode = useFileWorkspaceStore((state) => state.hosts[hostId]?.mode ?? "chat");
  const rootResolved = useFileWorkspaceStore((state) => state.hosts[hostId]?.rootResolved);
  const recentRoot = useFileWorkspaceStore((state) => state.recentRoots[scope]?.[0]);
  const openWorkspace = useFileWorkspaceStore((state) => state.openWorkspace);
  const closeWorkspace = useFileWorkspaceStore((state) => state.closeWorkspace);
  const filesActive = mode === "files";
  const label = filesActive ? "收起文件工作区，返回对话" : "打开文件工作区";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={label}
          aria-pressed={filesActive}
          disabled={opening}
          className={className ?? "z-40 size-7 rounded-full hover:bg-accent dark:hover:bg-accent"}
          onClick={async () => {
            if (filesActive) {
              closeWorkspace(hostId);
              return;
            }
            if (opening) return;
            setOpening(true);
            try {
              const preferred = rootResolved ?? recentRoot;
              let root: AgentWorkspaceRoot;
              try {
                root = await resolveAgentWorkspaceRoot(scope, preferred);
              } catch (reason) {
                const message = reason instanceof Error ? reason.message : String(reason);
                if (!preferred || (!message.includes("不存在") && !message.includes("不是目录"))) throw reason;
                toast.warning("上次预览目录不可用，已回退共享工作区；最近记录仍保留");
                root = await resolveAgentWorkspaceRoot(scope);
              }
              openWorkspace(hostId, scope, root.resolved);
            } catch (error) {
              toast.error(error instanceof Error ? error.message : String(error));
            } finally {
              setOpening(false);
            }
          }}
        >
          {filesActive ? <FolderOpen className="size-4" /> : <Folder className="size-4" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
