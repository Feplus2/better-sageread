/**
 * 工具图片内存缓存：目录牌 useTool 会把工具结果原样返回，readImage 的 dataUrl 若进 UI/DB
 * 会变成巨大 base64 文本（渲染卡顿、请求体膨胀）。这里把图片字节留在内存里，
 * 给模型请求用「toolCallId → 图片」恢复，聊天记录只留文本占位。
 */

export interface CachedToolImage {
  dataUrl: string;
  mediaType: string;
  path?: string;
}

interface CacheState {
  entries: Map<string, CachedToolImage[]>;
}

const MAX_CACHE_ENTRIES = 40;

function cacheState(): CacheState {
  const holder = globalThis as typeof globalThis & { __sagereadToolImageCache?: CacheState };
  if (!holder.__sagereadToolImageCache) {
    holder.__sagereadToolImageCache = { entries: new Map() };
  }
  return holder.__sagereadToolImageCache;
}

export function cacheToolImages(toolCallId: string, images: CachedToolImage[]): void {
  if (!toolCallId || images.length === 0) return;
  const state = cacheState();
  state.entries.delete(toolCallId);
  state.entries.set(toolCallId, images);
  while (state.entries.size > MAX_CACHE_ENTRIES) {
    const oldest = state.entries.keys().next().value;
    if (oldest === undefined) break;
    state.entries.delete(oldest);
  }
}

export function getCachedToolImages(toolCallId: string): CachedToolImage[] | undefined {
  return cacheState().entries.get(toolCallId);
}

export function clearToolImageCache(): void {
  cacheState().entries.clear();
}
