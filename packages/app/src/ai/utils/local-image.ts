import { convertFileSrc } from "@tauri-apps/api/core";

/** P0 本地图片读取：路径 → 魔数嗅探 → 尺寸/体积限制 → 超长边降采样 → dataUrl。 */

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_EDGE = 1024;
/** 默认长边：图片会作为 dataUrl 进入上下文并在后续每一步重复发送，默认压到 1024 控制成本 */
export const DEFAULT_IMAGE_EDGE = 1024;
const JPEG_QUALITY = 0.82;

export interface LocalImageResult {
  dataUrl: string;
  mediaType: string;
  bytes: number;
  width: number;
  height: number;
  downscaled: boolean;
}

/** 按文件头魔数识别图片类型（不信任扩展名/Blob.type）。 */
export function sniffImageMediaTypeFromBytes(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("FileReader 读取失败"));
    reader.readAsDataURL(blob);
  });
}

async function decodeImage(dataUrl: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = dataUrl;
  if (typeof img.decode === "function") {
    await img.decode();
    return img;
  }
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("图片解码失败"));
  });
  return img;
}

/** 读取本地绝对路径图片；体积超限/非图片抛错；长边超 maxEdge（默认 1024）自动降采样为 JPEG。 */
export async function loadLocalImageAsDataUrl(
  filePath: string,
  options?: { maxEdge?: number },
): Promise<LocalImageResult> {
  const assetUrl = convertFileSrc(filePath);
  const response = await fetch(assetUrl);
  if (!response.ok) {
    throw new Error(`读取图片失败（HTTP ${response.status}）：${filePath}`);
  }
  const blob = await response.blob();
  if (blob.size > MAX_IMAGE_BYTES) {
    throw new Error(`图片体积 ${(blob.size / 1048576).toFixed(1)}MB 超过 20MB 上限`);
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const sniffed = sniffImageMediaTypeFromBytes(bytes);
  if (!sniffed) {
    throw new Error("不是可识别的图片格式（支持 jpeg/png/gif/webp）");
  }
  const rawDataUrl = await blobToDataUrl(blob);
  const img = await decodeImage(rawDataUrl);
  const width = img.naturalWidth;
  const height = img.naturalHeight;
  const targetEdge = Math.min(Math.max(options?.maxEdge ?? DEFAULT_IMAGE_EDGE, 512), MAX_IMAGE_EDGE);
  const maxEdge = Math.max(width, height);
  if (maxEdge <= targetEdge) {
    return { dataUrl: rawDataUrl, mediaType: sniffed, bytes: blob.size, width, height, downscaled: false };
  }
  const scale = targetEdge / maxEdge;
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 初始化失败，无法降采样");
  ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
  const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  return {
    dataUrl,
    mediaType: "image/jpeg",
    bytes: blob.size,
    width: targetWidth,
    height: targetHeight,
    downscaled: true,
  };
}
