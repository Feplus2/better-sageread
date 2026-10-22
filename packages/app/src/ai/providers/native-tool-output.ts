/**
 * 原生多模态工具结果转换（2026-10-22）。
 *
 * 图片类工具（readImage/viewImages）沿用旧的结构给 UI 与 chat 桥使用：
 *   { type: "content", value: [{ type: "text" }, { type: "file", mediaType, url: "data:image/..." }] }
 * 原生 provider（OpenAI Responses / Anthropic Messages / Gemini 3）需要 AI SDK 官方格式：
 *   { type: "content", value: [{ type: "text" }, { type: "file", mediaType, data: { type: "data", data: base64 } }] }
 *
 * 本模块在 transport 组装工具后按协议包一层 toModelOutput；chat 通道不启用，继续走图片桥。
 *
 * 历史图回灌预算（2026-10-22 晚纠偏）：图片字节落库时已剥离，toModelOutput 只能从内存缓存
 * （tool-image-cache，40 条 LRU）恢复历史工具图。原实现对每个历史 toolCallId 全量恢复并重发，
 * 多图长对话会让每轮请求无限膨胀（native 通道又没有 chat 桥的 700k 预算兜底）。
 * 现在限制为：每轮最多回灌"最近 2 个工具批、合计 6 张"；当轮新产生的工具结果另有 6 张预算。
 * 更早的历史图不重发——占位文案提示模型按路径重新 readImage/viewImages。
 */

import type { Tool } from "ai";
import { getCachedToolImages, isRecentToolImageEntry, listCachedToolImageEntries } from "@/ai/utils/tool-image-cache";

/** 目录牌模式下模型实际调用的是 useTool，图片结果也可能由缓存恢复 */
const NATIVE_IMAGE_TOOL_NAMES = new Set(["readImage", "viewImages", "useTool"]);

/** 历史图回灌：最多最近 N 批 / 合计 N 张（用户口径：最近 6 张 / 2 批） */
const REPLAY_MAX_BATCHES = 2;
const REPLAY_MAX_IMAGES = 6;
/** 快照之后新产生的工具结果（当轮实时调用，含目录牌 useTool 的缓存恢复）额外预算 */
const LIVE_MAX_IMAGES = 6;

interface CollectedImage {
  dataUrl: string;
  mediaType?: string;
}

interface CollectedOutput {
  texts: string[];
  images: CollectedImage[];
}

/** 每次 wrapToolsForNativeImages 一份（= 每次 sendMessages 一份），跨历史转换与当轮多步共享 */
interface ReplayBudget {
  history?: Map<string, number>;
  /** 快照时已存在的 toolCallId：历史里被预算排除的旧条目不能走 live 预算 */
  snapshotKeys?: Set<string>;
  liveRemaining: number;
}

function createReplayBudget(): ReplayBudget {
  return { liveRemaining: LIVE_MAX_IMAGES };
}

function isDataImageUrl(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("data:image/");
}

function walk(node: unknown, out: CollectedOutput): void {
  if (typeof node === "string") {
    if (isDataImageUrl(node)) {
      out.images.push({ dataUrl: node });
      return;
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) walk(item, out);
    return;
  }
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  if (record.type === "text" && typeof record.text === "string") {
    out.texts.push(record.text);
    return;
  }
  if (record.type === "file") {
    if (isDataImageUrl(record.url)) {
      out.images.push({
        dataUrl: record.url,
        mediaType: typeof record.mediaType === "string" ? record.mediaType : undefined,
      });
      return;
    }
    // 已经是官方 data 形态：保留给上层再次处理
    const data = record.data as { type?: string; data?: unknown } | undefined;
    const mediaType = typeof record.mediaType === "string" ? record.mediaType : undefined;
    if (data?.type === "data" && typeof data.data === "string" && mediaType) {
      out.images.push({
        dataUrl: "data:" + mediaType + ";base64," + data.data,
        mediaType,
      });
      return;
    }
    return;
  }
  for (const value of Object.values(record)) walk(value, out);
}

/** 惰性建历史快照：按缓存插入序从新到旧取最近 N 批、累计 ≤6 张（同轮多步的历史工具图仍会重发） */
function ensureHistoryAllowance(budget: ReplayBudget): Map<string, number> {
  if (budget.history) return budget.history;
  const allowance = new Map<string, number>();
  const entries = listCachedToolImageEntries();
  let remaining = REPLAY_MAX_IMAGES;
  let batches = 0;
  for (let i = entries.length - 1; i >= 0 && batches < REPLAY_MAX_BATCHES && remaining > 0; i--, batches++) {
    const entry = entries[i];
    const take = Math.min(entry.images.length, remaining);
    if (take > 0) {
      allowance.set(entry.toolCallId, take);
      remaining -= take;
    }
  }
  budget.history = allowance;
  budget.snapshotKeys = new Set(entries.map((entry) => entry.toolCallId));
  return allowance;
}

/** 缓存图按预算选取：历史快照内取允许张数；快照后新增的最近条目用 live 预算 */
function cachedImagesForReplay(budget: ReplayBudget, toolCallId: string): CollectedImage[] {
  const cached = getCachedToolImages(toolCallId);
  if (!cached || cached.length === 0) return [];
  const allowance = ensureHistoryAllowance(budget);
  const allowed = allowance.get(toolCallId);
  if (allowed !== undefined) {
    return cached.slice(0, allowed).map((image) => ({ dataUrl: image.dataUrl, mediaType: image.mediaType }));
  }
  // 快照里已判定为"历史、不重发"的条目：不能走 live 预算（否则中间批次会漏网重发）
  if (budget.snapshotKeys?.has(toolCallId)) return [];
  // 快照之后才出现的工具结果（当轮实时调用）：额外 live 预算，且必须是最近批次
  if (budget.liveRemaining <= 0 || !isRecentToolImageEntry(toolCallId, REPLAY_MAX_BATCHES)) return [];
  const take = Math.min(cached.length, budget.liveRemaining);
  budget.liveRemaining -= take;
  return cached.slice(0, take).map((image) => ({ dataUrl: image.dataUrl, mediaType: image.mediaType }));
}

function collectOutput(output: unknown, toolCallId: string | undefined, budget: ReplayBudget): CollectedOutput {
  const collected: CollectedOutput = { texts: [], images: [] };
  walk(output, collected);
  if (toolCallId) {
    collected.images.push(...cachedImagesForReplay(budget, toolCallId));
  }
  // 去重（直接输出 + 缓存可能同一张）
  const seen = new Set<string>();
  collected.images = collected.images.filter((image) => {
    if (seen.has(image.dataUrl)) return false;
    seen.add(image.dataUrl);
    return true;
  });
  return collected;
}

function dataUrlToFilePart(image: CollectedImage) {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(image.dataUrl);
  const mediaType = image.mediaType ?? match?.[1] ?? "image/jpeg";
  const data = match?.[2] ?? image.dataUrl;
  return { type: "file" as const, mediaType, data: { type: "data" as const, data } };
}

function stringifyText(output: unknown): string {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function toNativeToolOutput(output: unknown, toolCallId: string | undefined, budget: ReplayBudget) {
  const collected = collectOutput(output, toolCallId, budget);
  if (collected.images.length === 0) {
    if (output && typeof output === "object" && (output as { type?: string }).type === "error-text") {
      return output as { type: "error-text"; value: string };
    }
    return { type: "text" as const, value: stringifyText(output) };
  }
  const text = collected.texts.filter(Boolean).join("\n").trim() || "image";
  return {
    type: "content" as const,
    value: [{ type: "text" as const, text }, ...collected.images.map(dataUrlToFilePart)],
  };
}

/** 给图片类工具（含目录牌 useTool）补官方 toModelOutput；其它工具原样返回。 */
export function wrapToolsForNativeImages<T extends Record<string, Tool>>(tools: T): T {
  // 预算跟随本次请求：历史转换与当轮多步工具调用共用同一份
  const budget = createReplayBudget();
  const wrapped: Record<string, Tool> = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (!NATIVE_IMAGE_TOOL_NAMES.has(name)) {
      wrapped[name] = tool;
      continue;
    }
    wrapped[name] = {
      ...tool,
      toModelOutput: ({ output, toolCallId }: { output: unknown; toolCallId?: string }) =>
        toNativeToolOutput(output, toolCallId, budget),
    } as Tool;
  }
  return wrapped as T;
}
