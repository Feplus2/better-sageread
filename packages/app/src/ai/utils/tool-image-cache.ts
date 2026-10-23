/**
 * 工具图片内存缓存：目录牌 useTool 会把工具结果原样返回，readImage 的 dataUrl 若进 UI/DB
 * 会变成巨大 base64 文本（渲染卡顿、请求体膨胀）。这里把图片字节留在内存里，
 * 给模型请求用「toolCallId → 图片」恢复，聊天记录只留文本占位。
 *
 * 来源口径（2026-10-23 用户拍板）：
 * - builtin（readImage/viewImages）：可跨轮按预算从缓存回灌，历史也能看到原图；
 * - mcp（MCP 工具结果）：**只在当轮 live 可见**，字节已落盘到 {appData}/image-cache/mcp；
 *   跨轮/历史一律不回灌，只保留带绝对路径的文本占位（重启后 readImage 按路径重看）。
 */

/** 图片字节来源：builtin=内置看图工具（可跨轮回灌）；mcp=MCP 工具（仅当轮 live 可见） */
export type ToolImageOrigin = "mcp" | "builtin";

export interface CachedToolImage {
  dataUrl: string;
  mediaType: string;
  path?: string;
  /** 来源标记；缺省按 builtin 处理（兼容未标 origin 的旧调用） */
  origin?: ToolImageOrigin;
}

/** 是否 MCP 来源图片：跨轮/历史不得回灌，仅当轮 live 允许 */
export function isMcpToolImage(image: CachedToolImage): boolean {
  return image.origin === "mcp";
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

/** 按插入顺序（旧→新）导出缓存条目：native 通道历史图回灌预算按"最近 N 批"计算 */
export function listCachedToolImageEntries(): Array<{ toolCallId: string; images: CachedToolImage[] }> {
  return Array.from(cacheState().entries.entries()).map(([toolCallId, images]) => ({ toolCallId, images }));
}

/** 该 toolCallId 是否在最近 maxEntries 个缓存条目内（Map 插入序，新条目在尾部） */
export function isRecentToolImageEntry(toolCallId: string, maxEntries: number): boolean {
  if (maxEntries <= 0) return false;
  const keys = Array.from(cacheState().entries.keys());
  const start = Math.max(0, keys.length - maxEntries);
  for (let i = start; i < keys.length; i++) {
    if (keys[i] === toolCallId) return true;
  }
  return false;
}

export function clearToolImageCache(): void {
  cacheState().entries.clear();
}
