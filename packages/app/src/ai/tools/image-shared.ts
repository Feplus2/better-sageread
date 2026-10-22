import { useAgentSettingsStore } from "@/store/agent-settings-store";
import { appDataDir } from "@tauri-apps/api/path";

/**
 * 图片类工具（readImage / viewImages）共用的路径守卫与信封格式：
 * - 只允许 appData 与工作区/按助手根内的图片（界外由用户手动导入）；
 * - 信封形如 <path>…</path><type>image</type><content>…</content>，图片桥按 <path> 还原
 *   "被省略的图是哪一张"，所以批量看图时每张图各自带一条信封（顺序与 file part 一致）。
 */

const normalizePath = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

async function allowedRoots(): Promise<string[]> {
  const roots: string[] = [];
  try {
    roots.push(await appDataDir());
  } catch {
    // appDataDir 不可用时只校验工作区根
  }
  const settings = useAgentSettingsStore.getState();
  if (settings.workspaceRoot) roots.push(settings.workspaceRoot);
  for (const value of Object.values(settings.perAgentRoots)) {
    if (value) roots.push(value);
  }
  return roots.map(normalizePath);
}

/** 校验图片路径在允许根内；越界抛错（错误文案直接回给模型） */
export async function assertAllowedPath(filePath: string): Promise<void> {
  const target = normalizePath(filePath);
  const roots = await allowedRoots();
  const allowed = roots.some((root) => target === root || target.startsWith(`${root}/`));
  if (!allowed) {
    throw new Error("只能查看文献库或工作区内的图片；界外路径请用户确认后用 readLocalFile/导入到工作区");
  }
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
