import { appDataDir } from "@tauri-apps/api/path";
import { BaseDirectory, exists, mkdir, readFile, writeFile } from "@tauri-apps/plugin-fs";

/**
 * D4 图片一次性（2026-08-21）：聊天图片附件落盘到 {appData}/attachments/，
 * 消息里只存 `attachment://文件名` 引用（不再落 base64 dataUrl——threads 表/L2 同步/备份不再携带图片字节）。
 * 请求组装时由 transport 按需物化（仅最后一条 user 消息真发图），更早轮次降级为占位存根；
 * 模型需要重看时经 readImage 工具取回。存量消息里的 dataUrl part 照旧兼容。
 */

export const ATTACHMENT_URL_PREFIX = "attachment://";

/** dataUrl 的 base64 段转 Uint8Array（落盘用） */
function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToDataUrl(bytes: Uint8Array, mediaType: string): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return `data:${mediaType};base64,${btoa(bin)}`;
}

const EXT_BY_MEDIA: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

export function attachmentFilename(id: string, mediaType: string): string {
  const ext = EXT_BY_MEDIA[mediaType] ?? "png";
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "");
  return `${safeId}.${ext}`;
}

export function isAttachmentUrl(url: unknown): url is string {
  return typeof url === "string" && url.startsWith(ATTACHMENT_URL_PREFIX);
}

async function ensureDir(): Promise<void> {
  const dir = "attachments";
  if (!(await exists(dir, { baseDir: BaseDirectory.AppData }))) {
    await mkdir(dir, { baseDir: BaseDirectory.AppData, recursive: true });
  }
}

/** 落盘图片附件，返回 `attachment://文件名` 引用（幂等：同名覆盖） */
export async function saveImageAttachment(id: string, dataUrl: string, mediaType: string): Promise<string> {
  const filename = attachmentFilename(id, mediaType || "image/png");
  await ensureDir();
  await writeFile(`attachments/${filename}`, dataUrlToBytes(dataUrl), { baseDir: BaseDirectory.AppData });
  return `${ATTACHMENT_URL_PREFIX}${filename}`;
}

/** 按引用取回图片（dataUrl）；文件缺失返回 null（存量清理后的降级路径） */
export async function readImageAttachment(url: string): Promise<{ dataUrl: string; mediaType: string } | null> {
  if (!isAttachmentUrl(url)) return null;
  const filename = url.slice(ATTACHMENT_URL_PREFIX.length).replace(/[/\\]/g, "");
  try {
    const bytes = await readFile(`attachments/${filename}`, { baseDir: BaseDirectory.AppData });
    const mediaType = Object.entries(EXT_BY_MEDIA).find(([, ext]) => filename.endsWith(`.${ext}`))?.[0] ?? "image/png";
    return { dataUrl: bytesToDataUrl(new Uint8Array(bytes), mediaType), mediaType };
  } catch {
    return null;
  }
}

/** 渲染用：attachment:// → asset 协议 URL（应用 assetProtocol scope 已放开） */
export async function attachmentToAssetUrl(url: string): Promise<string | null> {
  if (!isAttachmentUrl(url)) return null;
  const filename = url.slice(ATTACHMENT_URL_PREFIX.length).replace(/[/\\]/g, "");
  try {
    const base = await appDataDir();
    const { convertFileSrc } = await import("@tauri-apps/api/core");
    return convertFileSrc(`${base.replace(/[\\/]+$/, "")}/attachments/${filename}`);
  } catch {
    return null;
  }
}
