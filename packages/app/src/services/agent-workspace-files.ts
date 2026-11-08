import { readLocalFileTool } from "@/ai/tools/central/read-local-file";
import { loadLocalImageAsDataUrl } from "@/ai/utils/local-image";
import { wrapToolsWithGuard } from "@/ai/utils/tool-guard";
import { effectiveWorkspaceRoot } from "@/ai/utils/workspace-context";
import { useAgentConfirmStore } from "@/store/agent-confirm-store";
import { resolveWorkspaceRootForScope, useAgentSettingsStore } from "@/store/agent-settings-store";
import { invoke } from "@tauri-apps/api/core";
import type { Tool } from "ai";

export type AgentFileScope = "central" | "reader" | "paper";

export interface AgentWorkspaceRoot {
  configured: string;
  resolved: string;
}

export interface WorkspaceStat {
  resolved: string;
  exists: boolean;
  isDirectory: boolean;
  size: number;
  modifiedMs: number;
}

export interface WorkspaceChunk {
  resolved: string;
  content: string;
  nextOffset: number;
  truncated: boolean;
  binary: boolean;
  totalSize: number;
  modifiedMs: number;
}

export interface WorkspaceEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedMs: number;
}

export interface WorkspaceList {
  resolved: string;
  items: WorkspaceEntry[];
  nextOffset: number;
  truncated: boolean;
}

export interface WorkspaceAccessOptions {
  rootResolved?: string;
  abortSignal?: AbortSignal;
}

interface GuardVerdict {
  verdict: "in" | "out";
  resolved: string;
  exists: boolean;
  isDir: boolean;
}

export const WORKSPACE_PREVIEW_CHUNK_BYTES = 256 * 1024;

export async function resolveAgentWorkspaceRoot(
  scope: AgentFileScope,
  candidateRoot?: string,
): Promise<AgentWorkspaceRoot> {
  const configured = candidateRoot ?? (await effectiveWorkspaceRoot(scope));
  if (candidateRoot === undefined) {
    const verdict = await invoke<GuardVerdict>("agent_preview_resolve_path", {
      root: resolveWorkspaceRootForScope(scope),
      path: ".",
    });
    return { configured, resolved: verdict.resolved };
  }
  const stat = await withPreviewGuard<WorkspaceStat>(
    scope,
    candidateRoot,
    "agent_workspace_stat",
    {},
    {
      rootResolved: resolveWorkspaceRootForScope(scope) ?? undefined,
    },
  );
  if (!stat.exists || !stat.isDirectory) throw new Error(`预览目录不存在或不是目录: ${stat.resolved}`);
  return { configured: candidateRoot, resolved: stat.resolved };
}

function failureMessage(result: unknown): string | null {
  if (typeof result !== "object" || result === null || !("results" in result)) return null;
  const results = (result as { results?: { success?: unknown; message?: unknown } }).results;
  return results?.success === false ? String(results.message ?? "操作已取消") : null;
}

function targetExists(result: unknown): boolean {
  return typeof result !== "object" || result === null || !("exists" in result) || result.exists === true;
}

async function canonicalGuardRoot(root: string | null): Promise<string> {
  const verdict = await invoke<GuardVerdict>("agent_preview_resolve_path", { root, path: "." });
  return verdict.resolved;
}

async function withPreviewGuard<T>(
  scope: AgentFileScope,
  path: string,
  command: string,
  args: Record<string, unknown>,
  options: WorkspaceAccessOptions = {},
): Promise<T> {
  const root = options.rootResolved ?? resolveWorkspaceRootForScope(scope);
  let approval: { root: string; target: string } | null = null;
  const execute = async (input: { allowOutside?: boolean; expectedResolved?: string }): Promise<{
    result: T;
    approval?: { root: string; target: string };
  }> => {
    const verdict = await invoke<GuardVerdict>("agent_preview_resolve_path", { root, path });
    if (verdict.verdict === "out") {
      const canonicalRoot = await canonicalGuardRoot(root);
      if (!verdict.exists) {
        useAgentConfirmStore.getState().revokePreviewGrant(scope, canonicalRoot, verdict.resolved);
      } else if (useAgentConfirmStore.getState().hasPreviewGrant(scope, canonicalRoot, verdict.resolved)) {
        return {
          result: await invoke<T>(command, {
            ...args,
            root,
            path,
            allowOutside: true,
            expectedResolved: verdict.resolved,
          }),
        };
      }
      approval = { root: canonicalRoot, target: verdict.resolved };
    }
    const allowOutside =
      input.allowOutside === true ||
      (verdict.verdict === "out" && useAgentSettingsStore.getState().safetyMode === "full");
    return {
      result: await invoke<T>(command, {
        ...args,
        root,
        path,
        allowOutside,
        expectedResolved: input.expectedResolved ?? verdict.resolved,
      }),
      approval: approval ?? undefined,
    };
  };
  const previewTool: Tool = {
    ...readLocalFileTool,
    execute: async (input) => execute(input),
  };
  const guarded = wrapToolsWithGuard({ readLocalFile: previewTool }, scope, root);
  const execution = (await guarded.readLocalFile.execute?.(
    { reasoning: "文件工作区只读预览", path, mode: "read" },
    { toolCallId: "file-workspace-preview", messages: [], context: undefined, abortSignal: options.abortSignal },
  )) as { result: T; approval?: { root: string; target: string } };
  const executionFailure = failureMessage(execution);
  if (executionFailure) throw new Error(executionFailure);
  const result = execution.result;
  const grantedApproval = execution.approval;
  const failure = failureMessage(result);
  if (failure) throw new Error(failure);
  if (grantedApproval && targetExists(result)) {
    const identity = result as { modifiedMs?: unknown; totalSize?: unknown; size?: unknown };
    useAgentConfirmStore.getState().recordPreviewGrant(scope, grantedApproval.root, grantedApproval.target, {
      modifiedMs: typeof identity.modifiedMs === "number" ? identity.modifiedMs : undefined,
      size:
        typeof identity.totalSize === "number"
          ? identity.totalSize
          : typeof identity.size === "number"
            ? identity.size
            : undefined,
    });
  }
  return result;
}

export function statWorkspaceFile(scope: AgentFileScope, path: string, options: WorkspaceAccessOptions = {}) {
  return withPreviewGuard<WorkspaceStat>(scope, path, "agent_workspace_stat", {}, options);
}

export function readWorkspaceChunk(
  scope: AgentFileScope,
  path: string,
  offset = 0,
  limit = WORKSPACE_PREVIEW_CHUNK_BYTES,
  options: WorkspaceAccessOptions = {},
) {
  return withPreviewGuard<WorkspaceChunk>(scope, path, "agent_workspace_read_chunk", { offset, limit }, options);
}

export function listWorkspaceDirectory(
  scope: AgentFileScope,
  path: string,
  offset = 0,
  limit = 100,
  options: WorkspaceAccessOptions = {},
) {
  return withPreviewGuard<WorkspaceList>(scope, path, "agent_workspace_list", { offset, limit }, options);
}

export async function readWorkspaceImage(scope: AgentFileScope, path: string, options: WorkspaceAccessOptions = {}) {
  const bytes = await withPreviewGuard<ArrayBuffer>(scope, path, "agent_workspace_read_binary", {}, options);
  return loadLocalImageAsDataUrl(bytes, { maxEdge: 1536 });
}

export async function workspaceFileUrl(scope: AgentFileScope, path: string, options: WorkspaceAccessOptions = {}) {
  const bytes = await withPreviewGuard<ArrayBuffer>(scope, path, "agent_workspace_read_binary", {}, options);
  const extension = path.split(/[\\/]/).pop()?.split(".").pop()?.toLowerCase();
  const type =
    extension === "pdf" ? "application/pdf" : extension === "svg" ? "image/svg+xml" : "application/octet-stream";
  return URL.createObjectURL(new Blob([bytes], { type }));
}
