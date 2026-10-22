/**
 * 原生多模态工具结果转换（2026-10-22）。
 *
 * 图片类工具（readImage/viewImages）沿用旧的结构给 UI 与 chat 桥使用：
 *   { type: "content", value: [{ type: "text" }, { type: "file", mediaType, url: "data:image/..." }] }
 * 原生 provider（OpenAI Responses / Anthropic Messages / Gemini 3）需要 AI SDK 官方格式：
 *   { type: "content", value: [{ type: "text" }, { type: "file", mediaType, data: { type: "data", data: base64 } }] }
 *
 * 本模块在 transport 组装工具后按协议包一层 toModelOutput；chat 通道不启用，继续走图片桥。
 */

import type { Tool } from "ai";
import { getCachedToolImages } from "@/ai/utils/tool-image-cache";

/** 目录牌模式下模型实际调用的是 useTool，图片结果也可能由缓存恢复 */
const NATIVE_IMAGE_TOOL_NAMES = new Set(["readImage", "viewImages", "useTool"]);

interface CollectedImage {
  dataUrl: string;
  mediaType?: string;
}

interface CollectedOutput {
  texts: string[];
  images: CollectedImage[];
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

function collectOutput(output: unknown, toolCallId?: string): CollectedOutput {
  const collected: CollectedOutput = { texts: [], images: [] };
  walk(output, collected);
  if (toolCallId) {
    for (const cached of getCachedToolImages(toolCallId) ?? []) {
      if (isDataImageUrl(cached.dataUrl)) {
        collected.images.push({ dataUrl: cached.dataUrl, mediaType: cached.mediaType });
      }
    }
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

function toNativeToolOutput(output: unknown, toolCallId?: string) {
  const collected = collectOutput(output, toolCallId);
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
  const wrapped: Record<string, Tool> = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (!NATIVE_IMAGE_TOOL_NAMES.has(name)) {
      wrapped[name] = tool;
      continue;
    }
    wrapped[name] = {
      ...tool,
      toModelOutput: ({ output, toolCallId }: { output: unknown; toolCallId?: string }) =>
        toNativeToolOutput(output, toolCallId),
    } as Tool;
  }
  return wrapped as T;
}
