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
 * MCP 工具（2026-10-23 口径）：mcp_ 工具结果里的图片已被 mcp-manager 落盘并换成带路径的占位，
 * 落盘成功的图按 toolCallId 进内存缓存（origin=mcp），**只在当轮 live** 回灌成官方 file part；
 * 跨轮/历史（请求开始时的历史快照）一律跳过 origin=mcp，只保留落盘路径占位（重启后 readImage 重看）。
 * 内置 readImage/viewImages（origin=builtin）的跨轮预算回灌行为不变。
 * 直接调用（非目录牌）时也识别 MCP 原始 image content 形状，避免把 base64 当文本喂给模型。
 *
 * 历史图回灌预算（2026-10-22 晚纠偏）：图片字节落库时已剥离，toModelOutput 只能从内存缓存
 * （tool-image-cache，40 条 LRU）恢复历史工具图。原实现对每个历史 toolCallId 全量恢复并重发，
 * 多图长对话会让每轮请求无限膨胀（native 通道又没有 chat 桥的 700k 预算兜底）。
 * 现在限制为：每轮最多回灌"最近 2 个工具批、合计 6 张"；当轮新产生的工具结果另有 6 张预算。
 * 更早的历史图不重发——占位文案提示模型按路径重新 readImage/viewImages。
 */

import {
  getCachedToolImages,
  isMcpToolImage,
  isRecentToolImageEntry,
  listCachedToolImageEntries,
} from "@/ai/utils/tool-image-cache";
import { stripToolImageBytes, toolImageBytesFromNode } from "@/ai/utils/tool-result-slimming";
import type { Tool } from "ai";

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

/**
 * 每次 wrapToolsForNativeImages 一份（= 每次 sendMessages 一份），跨历史转换与当轮多步共享。
 * 历史条目在**创建本对象时**冻结（= 本次请求开始）：此后工具执行新写入缓存的条目一律算当轮 live，
 * 不能等第一次 toModelOutput 才拍快照——否则会话里第一次看图时，当前工具结果会被误判成"历史"
 * （MCP 图因此丢失；内置图也会被错算进历史预算）。
 */
interface ReplayBudget {
  /** 请求开始时缓存里的条目快照（历史消息的图片回灌只看这份） */
  historyEntries: ReturnType<typeof listCachedToolImageEntries>;
  /** 快照内所有 toolCallId（含 MCP）：这些条目不得再走 live 预算 */
  snapshotKeys: Set<string>;
  history?: Map<string, number>;
  liveRemaining: number;
}

function createReplayBudget(): ReplayBudget {
  const historyEntries = listCachedToolImageEntries();
  return {
    historyEntries,
    snapshotKeys: new Set(historyEntries.map((entry) => entry.toolCallId)),
    liveRemaining: LIVE_MAX_IMAGES,
  };
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
  // 图片节点统一识别：MCP image content（{type:"image",data,mimeType}）/ AI SDK 官方
  // file-data（{type:"file",mediaType,data:{type:"data",data}}）/ SageRead 旧 file-url
  const imageBytes = toolImageBytesFromNode(record);
  if (imageBytes) {
    out.images.push({ dataUrl: imageBytes.dataUrl, mediaType: imageBytes.mediaType });
    return;
  }
  for (const value of Object.values(record)) walk(value, out);
}

/**
 * 用请求开始时的冻结快照算历史预算：按缓存插入序从新到旧取最近 N 批、累计 ≤6 张（仅 origin=builtin）。
 * MCP 图片（origin=mcp）不参与历史回灌、也不占内置图配额（2026-10-23 口径）。
 */
function ensureHistoryAllowance(budget: ReplayBudget): Map<string, number> {
  if (budget.history) return budget.history;
  const allowance = new Map<string, number>();
  const entries = budget.historyEntries;
  let remaining = REPLAY_MAX_IMAGES;
  let index = entries.length - 1;
  let batches = 0;
  while (index >= 0 && remaining > 0 && batches < REPLAY_MAX_BATCHES) {
    const entry = entries[index];
    index -= 1;
    // 跨轮/历史不回灌 MCP 图：跳过且不消耗批次配额，保证内置图历史预算不变
    if (entry.images.some(isMcpToolImage)) continue;
    batches += 1;
    const take = Math.min(entry.images.length, remaining);
    if (take > 0) {
      allowance.set(entry.toolCallId, take);
      remaining -= take;
    }
  }
  budget.history = allowance;
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

interface McpNativeConversion {
  hasImageEvidence: boolean;
  strippedOutput: { output: unknown } | null;
}

function isGeneratedMcpImagePlaceholderText(text: string): boolean {
  if (/^\[MCP 图片 #\d+ 落盘失败已省略（字节不写入聊天记录）；需要重看时请重新调用该 MCP 工具\]$/.test(text)) {
    return true;
  }
  if (/^\[历史 MCP 图片 #\d+ 未保留可重看路径（字节不写入聊天记录）；需要重看时请重新调用该 MCP 工具\]$/.test(text)) {
    return true;
  }
  const prefix = "[MCP 图片已落盘：";
  const instruction = "，需要重看时用 readImage(path=";
  if (!text.startsWith(prefix) || !text.endsWith(")]")) return false;
  const body = text.slice(prefix.length, -2);
  const split = body.indexOf(instruction);
  if (split <= 0) return false;
  const path = body.slice(0, split);
  return body === `${path}${instruction}${path}`;
}

function containsMcpImageMarker(output: unknown): boolean {
  if (Array.isArray(output)) return output.some(containsMcpImageMarker);
  if (!output || typeof output !== "object") return false;
  const record = output as Record<string, unknown>;
  if (record.type === "text" && typeof record.text === "string" && isGeneratedMcpImagePlaceholderText(record.text)) {
    return true;
  }
  return Object.values(record).some(containsMcpImageMarker);
}

function toNativeToolOutput(
  output: unknown,
  toolCallId: string | undefined,
  budget: ReplayBudget,
  mcp: McpNativeConversion,
) {
  const collected = collectOutput(output, toolCallId, budget);
  if (mcp.hasImageEvidence) {
    // ToolResultOutput 顶层只能是官方判别联合；完整 MCP 结果放在 text JSON，图片另附官方 file-data。
    const text = stringifyText(mcp.strippedOutput?.output ?? output);
    if (collected.images.length === 0) return { type: "text" as const, value: text };
    return {
      type: "content" as const,
      value: [{ type: "text" as const, text }, ...collected.images.map(dataUrlToFilePart)],
    };
  }
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

/** 需要官方 toModelOutput 的工具：内置图片工具 + 所有 MCP 工具（mcp_ 前缀，图片走缓存回灌） */
function isNativeImageCapableTool(name: string): boolean {
  return NATIVE_IMAGE_TOOL_NAMES.has(name) || name.startsWith("mcp_");
}

/** 给图片类工具（含目录牌 useTool 与 MCP 工具）补官方 toModelOutput；其它工具原样返回。 */
export function wrapToolsForNativeImages<T extends Record<string, Tool>>(
  tools: T,
  forwardedTools: Record<string, Tool> = {},
): T {
  // 预算跟随本次请求：历史转换与当轮多步工具调用共用同一份
  const budget = createReplayBudget();
  const wrapped: Record<string, Tool> = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (!isNativeImageCapableTool(name)) {
      wrapped[name] = tool;
      continue;
    }
    // MCP Tool 自带 mcpToModelOutput（content → text parts）；文本型结果没有图时应沿用，
    // 不能退化成 JSON.stringify（保持文本型 MCP 工具行为不变）
    const originalToModelOutput = (tool as any).toModelOutput as
      | ((opts: { output: unknown; toolCallId?: string; input?: unknown }) => unknown)
      | undefined;
    wrapped[name] = {
      ...tool,
      toModelOutput: ({ output, toolCallId, input }: { output: unknown; toolCallId?: string; input?: unknown }) => {
        const forwarded = name === "useTool" ? (input as any)?.tool : null;
        const forwardedTool =
          name === "useTool" && typeof forwarded === "string" ? forwardedTools[forwarded] : undefined;
        const converter =
          name === "useTool"
            ? ((forwardedTool as any)?.toModelOutput as typeof originalToModelOutput)
            : originalToModelOutput;
        const converterInput = name === "useTool" ? (input as any)?.args : input;
        const isMcp = name.startsWith("mcp_") || (typeof forwarded === "string" && forwarded.startsWith("mcp_"));
        const strippedOutput = isMcp ? stripToolImageBytes(output) : null;
        const hasCachedImages = !!(isMcp && toolCallId && getCachedToolImages(toolCallId)?.length);
        const hasImageEvidence = isMcp && (!!strippedOutput || hasCachedImages || containsMcpImageMarker(output));
        const nativeOutput = toNativeToolOutput(output, toolCallId, budget, { hasImageEvidence, strippedOutput });
        if (isMcp && !hasImageEvidence && nativeOutput.type === "text" && converter) {
          return converter({ output, toolCallId, input: converterInput });
        }
        return nativeOutput;
      },
    } as Tool;
  }
  return wrapped as T;
}
