import type { ChangedFile } from "@/ai/utils/changed-files";
import { classifyFileLink, isLocalPathWithinRoot } from "@/ai/utils/local-file-link";
import { type AgentFileScope, resolveAgentWorkspaceRoot, statWorkspaceFile } from "@/services/agent-workspace-files";
import { useFileWorkspaceStore } from "@/store/file-workspace-store";
import { selectTaskWorkspaceRoot, useTaskWorkspaceStore } from "@/store/task-workspace-store";
import { resolve as resolvePath } from "@tauri-apps/api/path";
import { useCallback } from "react";
import { toast } from "sonner";

export function useFileWorkspaceChat(hostId: string, scope: AgentFileScope, threadId?: string) {
  const mode = useFileWorkspaceStore((state) => state.hosts[hostId]?.mode ?? "chat");
  const taskRoot = useTaskWorkspaceStore((state) => selectTaskWorkspaceRoot(state, hostId, threadId));
  const openFile = useFileWorkspaceStore((state) => state.openFile);
  const openChangedFile = useCallback(
    async (file: Pick<ChangedFile, "path"> & { title?: string }) => {
      try {
        const root = taskRoot ?? (await resolveAgentWorkspaceRoot(scope)).resolved;
        openFile(hostId, scope, root, { path: file.path });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
    },
    [hostId, openFile, scope, taskRoot],
  );
  const openLocalFile = useCallback(
    async (href: string) => {
      try {
        const link = classifyFileLink(href);
        if (link.kind !== "local") throw new Error("这不是可打开的本地文件链接");
        const root = taskRoot ?? (await resolveAgentWorkspaceRoot(scope)).resolved;
        const resolved = await resolvePath(root, link.path);
        if (!link.absolute && !isLocalPathWithinRoot(root, resolved)) {
          throw new Error("不能通过相对链接越过当前工作区");
        }
        const stat = await statWorkspaceFile(scope, resolved, { rootResolved: root });
        if (!stat.exists || stat.isDirectory) throw new Error(`文件不存在或是目录：${stat.resolved}`);
        openFile(hostId, scope, root, { path: stat.resolved });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
    },
    [hostId, openFile, scope, taskRoot],
  );
  return { isFileMode: mode === "files", openChangedFile, openLocalFile };
}
