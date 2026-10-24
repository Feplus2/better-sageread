import { useAgentSettingsStore } from "@/store/agent-settings-store";
import { invoke } from "@tauri-apps/api/core";

/**
 * 图片类工具（readImage / viewImages）共用的 canonical 读取与信封格式：
 * - Rust 在读取字节的同一调用中校验 AppData、共享工作区与各助手根；界外授权由 tool-guard 按路径注入；
 * - 信封形如 <path>…</path><type>image</type><content>…</content>，图片桥按 <path> 还原
 *   "被省略的图是哪一张"，所以批量看图时每张图各自带一条信封（顺序与 file part 一致）。
 */

export interface ImageRoots {
  root: string | null;
  additionalRoots: string[];
}

export interface ImageReadGrant {
  path: string;
  allowOutside: boolean;
  expectedResolved: string;
}

export function imageRootsFromSettings(): ImageRoots {
  const settings = useAgentSettingsStore.getState();
  return {
    root: settings.workspaceRoot,
    additionalRoots: Object.values(settings.perAgentRoots).filter(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    ),
  };
}

export async function readLocalImageBytes(
  filePath: string,
  options?: { roots?: ImageRoots; grant?: ImageReadGrant },
): Promise<ArrayBuffer> {
  const roots = options?.roots ?? imageRootsFromSettings();
  const result = await invoke<unknown>("agent_read_image", {
    root: roots.root,
    additionalRoots: roots.additionalRoots,
    path: filePath,
    allowOutside: options?.grant?.allowOutside === true,
    expectedPath: options?.grant?.path ?? null,
    expectedResolved: options?.grant?.expectedResolved ?? null,
  });
  if (!(result instanceof ArrayBuffer)) {
    throw new Error("图片读取 IPC 未返回 ArrayBuffer 原始字节");
  }
  return result;
}

export interface ResolvedImageTarget {
  kind: "ref" | "path";
  value: string;
}

export function collectImageTargets(paths?: string[], refs?: string[]): ResolvedImageTarget[] {
  const out: ResolvedImageTarget[] = [];
  const seen = new Set<string>();
  for (const raw of [...(paths ?? []), ...(refs ?? [])]) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    const value = raw.trim();
    const target = { kind: value.startsWith("attachment://") ? ("ref" as const) : ("path" as const), value };
    const key = target.value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(target);
  }
  return out;
}

/** 本地绝对路径判定（Windows 盘符 / POSIX 根） */
export function isAbsoluteImagePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("/");
}

export function imageEnvelope(params: {
  label: string;
  mediaType: string;
  width?: number;
  height?: number;
  bytes?: number;
  payloadBytes?: number;
  downscaled?: boolean;
  /** 多图批量序号前缀，例如 "第 1/4 张：" */
  ordinal?: string;
}): string {
  const sizeMb = params.bytes != null ? (params.bytes / 1048576).toFixed(2) : null;
  const downsample = params.downscaled ? " (resized)" : "";
  const payload = params.payloadBytes ? `, payload ${Math.round(params.payloadBytes / 1024)} KB` : "";
  const dims = params.width != null && params.height != null ? ` ${params.width}x${params.height} px` : "";
  const source = sizeMb != null ? `, ${sizeMb} MB source` : "";
  return `${params.ordinal ?? ""}<path>${params.label}</path><type>image</type><content>${params.mediaType}${dims}${source}${payload}${downsample}</content>\n请基于图片内容回答；引用时说明图号/所在小节，不要编造图中不存在的细节。`;
}
