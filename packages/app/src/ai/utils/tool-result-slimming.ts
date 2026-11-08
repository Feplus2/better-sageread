import type { UIMessage } from "@ai-sdk/react";
import { estimateTokens } from "./token-estimator";
import { cacheToolImages } from "./tool-image-cache";

/**
 * D5+D6 工具结果两层瘦身（2026-08-21 定稿，业界对照 microcompact/context editing）：
 *
 * L1 出生截断（落库即预览，"本地不留垃圾"）：persistMessagesNow 写盘前把大体积工具结果
 * 换成结构化预览（头部保留 chunk_id/来源坐标等寻址信息，正文截断）。当轮在飞的多步链不经过
 * 落库，天然全量——"AI 当时读到就行"。存量线程不追溯。threads 表/L2 同步/备份流量同步缩小。
 *
 * L2 请求期存根活塞（批处理，防缓存抖动）：仅 RAG 三件套（ragSearch/ragContext/ragRange）。
 * 十进位轮次块分批——B = 满足 B ≤ T−5 的最大 10 倍数（T=user 轮数，块宽 10/窗口 5），
 * user 轮号 ≤ B 的轮次中 RAG 结果降级为一行 ID 存根；引用判用位按"结果所在轮后 5 轮内
 * 的 [chunkId] 标注"冻结计算（固定统计窗，边界扩张不回写 → 纯函数、单调、前缀稳定）；
 * clear_at_least：本批可清除量不足下限则整批推迟（缓存重启要断够本）。
 *
 * D8 目录牌模式兼容：useTool 转发的结果 part 名为 tool-useTool，原始工具名从 input.tool
 * 还原后按同名规则走 L1/L2（不改 UI/DB part 名；请求副本的历史适配另行处理）。
 *
 * 两层都只改副本/写盘内容，永不改动内存中的原消息（请求期副本语义）。
 */

/**
 * L1 预览正文上限（2026-08-28 用户裁定 2000→1000：存档预览的唯一消费者是人——
 * "点开工具卡瞄一眼 Agent 读了啥"；AI 当轮走内存全量、跨轮按参数重取，均不读预览。
 * 引用转跳（buildCitationMap）读结构化 output 不读预览文本，预览长短不在功能链路上）。
 * 坐标在头部天然保留。
 */
export const TOOL_RESULT_PREVIEW_CHARS = 1000;

/** L1 纳入截断的内容承载型工具（UI 消费输出的工具不纳入，如 mindmap）；
 * useTool 是目录牌转发入口：按 input.tool 还原原始工具名再判定（见 truncateToolResultsForStorage） */
const L1_CONTENT_TOOLS = new Set([
  "describeTool",
  "useTool",
  // 2026-10-22 新原语（默认模式实际在用的工具；漏加会让 L1 截断对默认工具面失效）
  "readDocument",
  "getDocumentInfo",
  "searchLibrary",
  "getCitationGraph",
  "getFigures",
  "getCitations",
  "ragSearch",
  "ragContext",
  "ragRange",
  "readThread",
  "readBookSection",
  "readPaperSection",
  "readPaperFull",
  "paperSearch",
  "paperContext",
  "webSearch",
  "sciverseSearch",
  "httpRequest",
  "readLocalFile",
  "searchFiles",
  "runCommand",
  "downloadFile",
  "extractZip",
  "convertPdf",
]);

/** 图片类工具：结果里的 dataUrl 一律不落库（2026-10-22，viewImages 一次最多 6 张，base64 会撑爆线程） */
const IMAGE_TOOLS = new Set(["readImage", "viewImages"]);
/** 落库占位：字节丢弃，信封（路径/尺寸）仍在，需要重看时按路径重新调用 readImage/viewImages。
 * 注意：重启或超过 native 回灌窗口后图片不会自动重发，文案必须诚实（不能写"在线程里保留"）。 */
const IMAGE_BYTES_PLACEHOLDER =
  "[历史图片未随本轮重发（字节不落库；重启/较早轮次后模型看不到原图），需要重看时用 readImage/viewImages 按路径重取]";

// ==================== 工具图片形状统一识别（2026-10-22 MCP 图片收口） ====================
// MCP server 返回的图片是 @ai-sdk/mcp 的原始 content part（{type:"image",data,mimeType}），
// 与 SageRead 旧形状（file+url）和 AI SDK v7 官方形状（file+data）都不同；四个消费点
// （MCP execute 收口 / 目录牌 useTool / 落库 L1 / native toModelOutput）统一走这里的识别器，
// 避免各写一套正则导致某条路径漏剥 base64。

/** 工具结果里的图片字节（dataUrl 自带 MIME 前缀与 base64）；path 仅来自结果自身的真实路径 */
export interface ToolImageBytes {
  dataUrl: string;
  mediaType: string;
  path?: string;
}

/** 图片占位文案（目录牌 useTool 与 MCP execute 共用；#N 与缓存里的图片顺序一一对应） */
export function imagePlaceholderText(seq: number): string {
  return `[图片 #${seq} 内容已交给模型，base64 不写入聊天记录]`;
}

/** MCP 图片已落盘占位：带绝对路径，重启/跨轮后模型可用 readImage 按路径重看（2026-10-23 口径） */
export function mcpImageSavedPlaceholder(path: string): string {
  return `[MCP 图片已落盘：${path}，需要重看时用 readImage(path=${path})]`;
}

/** MCP 图片落盘失败的降级占位：字节省略，明确告知重看要重新调用 MCP 工具 */
export function mcpImageSaveFailedPlaceholder(seq: number): string {
  return `[MCP 图片 #${seq} 落盘失败已省略（字节不写入聊天记录）；需要重看时请重新调用该 MCP 工具]`;
}

/** 无路径的旧 MCP 历史不能假装还能从缓存重看，只能诚实要求重新调用原 MCP 工具 */
export function mcpImageHistoryPlaceholder(seq: number): string {
  return `[历史 MCP 图片 #${seq} 未保留可重看路径（字节不写入聊天记录）；需要重看时请重新调用该 MCP 工具]`;
}

function dataUrlMediaType(dataUrl: string): string {
  const matched = /^data:([^;]+);base64,/i.exec(dataUrl);
  return matched?.[1] ?? "image/jpeg";
}

function isImageDataUrl(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("data:image/");
}

/**
 * 识别工具结果里的图片节点（三种真实形状）：
 * 1) MCP / AI SDK raw image content：{ type:"image", data:"<裸base64>", mimeType:"image/png" }
 *    （@ai-sdk/mcp 的 execute 直接返回 CallToolResult，图片就是这个形状）
 * 2) AI SDK v7 官方 file-data：{ type:"file", mediaType:"image/*", data:{ type:"data", data:"<base64>" } }
 * 3) SageRead 旧 file-url：{ type:"file", mediaType:"image/*", url:"data:image/..." }
 * 4) 裸 dataUrl 字符串（部分工具直接返回整串）
 * 非图片节点（文本/JSON 结构）返回 null——调用方据此保证文本型工具结果零改动。
 */
export function toolImageBytesFromNode(node: unknown): ToolImageBytes | null {
  if (isImageDataUrl(node)) return { dataUrl: node, mediaType: dataUrlMediaType(node) };
  if (!node || typeof node !== "object" || Array.isArray(node)) return null;
  const record = node as Record<string, unknown>;
  const path = typeof record.path === "string" && record.path.trim() ? record.path : undefined;
  if (record.type === "image") {
    if (typeof record.data !== "string" || record.data.length === 0) return null;
    const declaredType =
      typeof record.mimeType === "string"
        ? record.mimeType
        : typeof record.mediaType === "string"
          ? record.mediaType
          : "image/jpeg";
    // MCP ImageContent.data 是裸 base64；也兼容服务端直接回 dataUrl 的写法
    if (record.data.startsWith("data:")) {
      return { dataUrl: record.data, mediaType: dataUrlMediaType(record.data), ...(path ? { path } : {}) };
    }
    return {
      dataUrl: `data:${declaredType};base64,${record.data}`,
      mediaType: declaredType,
      ...(path ? { path } : {}),
    };
  }
  if (record.type === "file") {
    if (isImageDataUrl(record.url)) {
      return {
        dataUrl: record.url,
        mediaType: typeof record.mediaType === "string" ? record.mediaType : dataUrlMediaType(record.url),
        ...(path ? { path } : {}),
      };
    }
    const data = record.data as { type?: string; data?: unknown } | undefined;
    if (data?.type === "data" && typeof data.data === "string" && data.data.length > 0) {
      const mediaType = typeof record.mediaType === "string" ? record.mediaType : "";
      // 只认图片：官方 file part 也可能是 PDF/文本，误当图片会破坏文本型结果
      if (!mediaType.startsWith("image/")) return null;
      return { dataUrl: `data:${mediaType};base64,${data.data}`, mediaType, ...(path ? { path } : {}) };
    }
  }
  return null;
}

interface ImageWalkResult {
  value: unknown;
  changed: boolean;
}

interface ToolImageWalkOptions {
  /** 图片节点替换内容；缺省返回 "内容已交给模型" 通用占位 */
  placeholderFor?: (seq: number, image: ToolImageBytes) => unknown;
}

/** 递归收集图片节点（不替换）；MCP 收口需要先落盘拿到路径，再按同一顺序生成带路径占位 */
function collectToolImagesWalk(node: unknown, images: ToolImageBytes[]): void {
  const image = toolImageBytesFromNode(node);
  if (image) {
    images.push(image);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectToolImagesWalk(item, images);
    return;
  }
  if (node && typeof node === "object") {
    for (const item of Object.values(node as Record<string, unknown>)) collectToolImagesWalk(item, images);
  }
}

/** 收集工具结果里的全部图片（按遍历顺序，与 stripToolImageBytes 的 #N 序号一一对应） */
export function collectToolImages(node: unknown): ToolImageBytes[] {
  const images: ToolImageBytes[] = [];
  collectToolImagesWalk(node, images);
  return images;
}

function collectToolImagePathsWalk(node: unknown, paths: string[]): void {
  if (typeof node === "string") {
    const matched = /<path>([^<]+)<\/path>/.exec(node);
    if (matched?.[1]?.trim()) paths.push(matched[1].trim());
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectToolImagePathsWalk(item, paths);
    return;
  }
  if (!node || typeof node !== "object") return;
  const image = toolImageBytesFromNode(node);
  if (image) {
    if (image.path) paths.push(image.path);
    return;
  }
  for (const item of Object.values(node as Record<string, unknown>)) collectToolImagePathsWalk(item, paths);
}

/** 只收集结果中已经存在的路径，不为缺失图片编造缓存位置 */
export function collectToolImagePaths(node: unknown): string[] {
  const paths: string[] = [];
  collectToolImagePathsWalk(node, paths);
  return paths;
}

/** 递归把图片节点换成带序号占位；只改副本（无图片返回原引用，保证文本型结果零开销） */
function replaceImageBytesWalk(
  node: unknown,
  images: ToolImageBytes[],
  seq: { count: number },
  placeholderFor: (seq: number, image: ToolImageBytes) => unknown,
): ImageWalkResult {
  const image = toolImageBytesFromNode(node);
  if (image) {
    images.push(image);
    seq.count += 1;
    const replacement = placeholderFor(seq.count, image);
    if (
      node &&
      typeof node === "object" &&
      !Array.isArray(node) &&
      replacement &&
      typeof replacement === "object" &&
      !Array.isArray(replacement)
    ) {
      const nodeFields = Object.fromEntries(
        Object.entries(node as Record<string, unknown>).filter(
          ([key]) => key !== "type" && key !== "data" && key !== "url",
        ),
      );
      return { value: { ...nodeFields, ...replacement }, changed: true };
    }
    return { value: replacement, changed: true };
  }
  if (Array.isArray(node)) {
    let changed = false;
    const value = node.map((item) => {
      const walked = replaceImageBytesWalk(item, images, seq, placeholderFor);
      if (walked.changed) changed = true;
      return walked.value;
    });
    return { value: changed ? value : node, changed };
  }
  if (node && typeof node === "object") {
    let changed = false;
    const value: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
      const walked = replaceImageBytesWalk(item, images, seq, placeholderFor);
      value[key] = walked.value;
      if (walked.changed) changed = true;
    }
    return { value: changed ? value : node, changed };
  }
  return { value: node, changed: false };
}

const defaultImagePlaceholderFor = (seq: number): unknown => ({ type: "text", text: imagePlaceholderText(seq) });

/**
 * 摘掉工具结果里的图片字节并换文本占位（供 MCP execute 包装用）。
 * 返回 null = 没有图片（文本型 MCP 工具保持零改动）；有图片返回新副本 + 图片字节。
 * placeholderFor 允许调用方按 #N 序号生成自定义占位（MCP 落盘后用带路径文案）。
 */
export function stripToolImageBytes(
  node: unknown,
  options?: ToolImageWalkOptions,
): { output: unknown; images: ToolImageBytes[] } | null {
  const images: ToolImageBytes[] = [];
  const walked = replaceImageBytesWalk(
    node,
    images,
    { count: 0 },
    options?.placeholderFor ?? defaultImagePlaceholderFor,
  );
  if (!walked.changed) return null;
  return { output: walked.value, images };
}

/** 请求开始前的旧 MCP 输出：有真实路径就保留，无路径只留重新调用原工具的诚实说明 */
export function sanitizeLegacyMcpHistoryOutput(node: unknown): { output: unknown; images: ToolImageBytes[] } | null {
  const paths = collectToolImagePaths(node);
  return stripToolImageBytes(node, {
    placeholderFor: (seq, image) => {
      const path = image.path ?? paths[seq - 1];
      return {
        type: "text",
        text: path ? mcpImageSavedPlaceholder(path) : mcpImageHistoryPlaceholder(seq),
      };
    },
  });
}

/** MCP 图片落盘回调：成功返回图片绝对路径，返回 null / 抛错表示落盘失败（降级纯占位） */
export type McpImageSaveFn = (image: ToolImageBytes, seq: number) => Promise<string | null>;

export interface McpImagePersistOptions {
  saveImage?: McpImageSaveFn;
}

/**
 * MCP 工具结果图片统一收口（getMcpToolsForScope 的 execute 包装调用；导出供单测）：
 * 1) 收集图片 → 调 saveImage 逐张落盘（失败降级纯占位并说明）；
 * 2) 输出里的图片 part 换成带绝对路径的文本占位（历史/落库只留路径，重启后可 readImage 重看）；
 * 3) 成功落盘的图片按 toolCallId 进内存缓存（origin=mcp），仅用于**当轮 live** 可见
 *    （native toModelOutput / chat 图片桥会按 origin 跳过历史回灌）；
 * 4) 无图片 → 原对象引用返回（文本型 MCP 工具行为不变）。
 */
export async function sanitizeMcpToolResultImages(
  result: unknown,
  toolCallId: string | undefined,
  options?: McpImagePersistOptions,
): Promise<unknown> {
  const images = collectToolImages(result);
  if (images.length === 0) return result;
  const saveImage = options?.saveImage;
  const savedPaths: Array<string | null> = [];
  if (saveImage) {
    for (let index = 0; index < images.length; index += 1) {
      try {
        savedPaths.push(await saveImage(images[index], index + 1));
      } catch {
        savedPaths.push(null);
      }
    }
  }
  const stripped = stripToolImageBytes(result, {
    placeholderFor: (seq) => ({
      type: "text",
      text: saveImage
        ? savedPaths[seq - 1]
          ? mcpImageSavedPlaceholder(savedPaths[seq - 1] as string)
          : mcpImageSaveFailedPlaceholder(seq)
        : imagePlaceholderText(seq),
    }),
  });
  if (!stripped) return result;
  // 当轮 live 缓存：落盘失败的图不再回灌（已明确降级为纯占位），避免"说省略却又看到图"
  const visible = stripped.images
    .map((image, index) => ({ ...image, path: savedPaths[index] ?? undefined, origin: "mcp" as const }))
    .filter((image) => !saveImage || !!image.path);
  if (toolCallId && visible.length > 0) {
    cacheToolImages(toolCallId, visible);
  }
  return stripped.output;
}

/** L2 纳入存根的 RAG 工具 */
const L2_RAG_TOOLS = new Set(["ragSearch", "ragContext", "ragRange"]);

/** L2：块宽与保底窗口（user 轮数） */
const L2_BLOCK = 10;
const L2_WINDOW = 5;
/** L2：引用判用的固定统计窗（结果所在轮之后的 N 轮；冻结语义的关键——与降级边界解耦） */
const CITE_WINDOW = 5;
/** L2：clear_at_least 保底清除量（tokens；本批收益不足则整批推迟） */
const L2_CLEAR_AT_LEAST_TOKENS = 2000;

interface ToolLikePart {
  type: string;
  toolCallId?: string;
  toolName?: string;
  state?: string;
  output?: unknown;
}

function toolNameOf(part: ToolLikePart): string | null {
  if (typeof (part as any).toolName === "string") return (part as any).toolName;
  if (part.type?.startsWith("tool-")) return part.type.slice("tool-".length);
  return null;
}

/** D8 目录牌模式：useTool 转发 part 的原始工具名在 input.tool（{tool, args} 入参），还原后按原名归类 */
function forwardedToolName(part: ToolLikePart): string | null {
  const input = (part as any).input;
  return typeof input?.tool === "string" && input.tool ? input.tool : null;
}

/**
 * 递归摘掉工具输出里的图片字节，返回 null 表示没改动（避免无谓拷贝）。
 * 只用于落库副本：内存里的消息仍保留 dataUrl 供本轮/后续请求经图片桥发送。
 */
function stripImagePayloads(node: unknown): unknown | null {
  if (typeof node === "string") {
    return node.startsWith("data:image/") ? IMAGE_BYTES_PLACEHOLDER : null;
  }
  if (Array.isArray(node)) {
    let changed = false;
    const next = node.map((item) => {
      const replaced = stripImagePayloads(item);
      if (replaced === null) return item;
      changed = true;
      return replaced;
    });
    return changed ? next : null;
  }
  if (node && typeof node === "object") {
    const record = node as Record<string, unknown>;
    // 图片节点（旧 file-url / AI SDK 官方 file-data / MCP image content）：落库前统一换占位
    if (toolImageBytesFromNode(record)) {
      return { type: "text", text: IMAGE_BYTES_PLACEHOLDER };
    }
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      const replaced = stripImagePayloads(value);
      if (replaced === null) {
        next[key] = value;
      } else {
        changed = true;
        next[key] = replaced;
      }
    }
    return changed ? next : null;
  }
  return null;
}

function stringifyOutput(output: unknown): string {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

/**
 * L1 出生截断：返回可在落库前替换消息数组的副本（无大结果时原数组引用返回，零开销）。
 * 预览为自描述对象（截断标记 + 原始长度 + 首段正文），幂等（已截断的不二次处理）。
 */
export function truncateToolResultsForStorage(messages: UIMessage[]): UIMessage[] {
  let touched = false;
  const out = messages.map((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.parts)) return message;
    const parts = (message.parts as any[]).map((part) => {
      if (
        part?.type !== "tool-ragSearch" &&
        !String(part?.type ?? "").startsWith("tool-") &&
        part?.type !== "dynamic-tool"
      ) {
        return part;
      }
      const name = toolNameOf(part);
      if (!name) return part;
      // MCP 工具（含 dynamic-tool 形态与目录牌 useTool 转发）：图片收口 + L1 截断都要覆盖，
      // 否则 MCP 的 base64 / 大文本会原样进线程 JSON（2026-10-22 图片链路收口）
      const forwarded = name === "useTool" ? forwardedToolName(part) : null;
      const isMcpPart = name.startsWith("mcp_") || part.type === "dynamic-tool" || !!forwarded?.startsWith("mcp_");
      // 图片类工具：落库前把 dataUrl / MCP 图片 part 换成文本占位（含 useTool 转发；信封路径保留）
      const effectiveName = name === "useTool" ? forwarded : name;
      let workingPart = part;
      if ((effectiveName && IMAGE_TOOLS.has(effectiveName)) || isMcpPart) {
        if (part.state && part.state !== "output-available") return part;
        if (part.output != null) {
          const stripped = stripImagePayloads(part.output);
          if (stripped !== null) {
            touched = true;
            workingPart = { ...part, output: stripped };
          }
        }
        // 内置 readImage/viewImages 保持原行为（摘完直接返回）；MCP 摘图后继续走 L1 文本截断
        if (!isMcpPart) return workingPart;
      }
      if (!L1_CONTENT_TOOLS.has(name) && !isMcpPart) return part;
      // useTool 转发：还原原始工具名再判定——转给 UI 消费型工具（如 mindmap）的结果不截；
      // 原始名缺失的转发按内容型兜底截断（白名单收录 useTool 即为此）。output 即真实工具的原始
      // 结果结构，头部截断天然保住 chunk_id/来源坐标（引用标转跳依赖，见 citation-source.ts）
      if (name === "useTool" && !isMcpPart && forwarded && !L1_CONTENT_TOOLS.has(forwarded)) return part;
      if (workingPart.state && workingPart.state !== "output-available") return part;
      if (workingPart.output == null) return part;
      if (workingPart.output && typeof workingPart.output === "object" && (workingPart.output as any).__slimPreview) {
        return workingPart; // 幂等（图片已摘但文本小：返回摘好的副本）
      }
      const text = stringifyOutput(workingPart.output);
      if (text.length <= TOOL_RESULT_PREVIEW_CHARS) return workingPart;
      // MCP 图片已落盘：L1 截断时把带路径的图片占位补回预览尾部——
      // 历史消息只留路径也能 readImage 重看（2026-10-23 口径）
      const preservedImageNotes = isMcpPart
        ? Array.from(text.matchAll(/\[MCP 图片[^\]]*\]/g))
            .map((match) => match[0])
            .slice(0, 6)
        : [];
      touched = true;
      if (effectiveName === "runCommand" && Array.isArray((workingPart.output as any)?.results?.changes)) {
        const results = (workingPart.output as any).results;
        const clip = (value: unknown) =>
          typeof value === "string" && value.length > TOOL_RESULT_PREVIEW_CHARS
            ? `${value.slice(0, TOOL_RESULT_PREVIEW_CHARS)}…[截断]`
            : value;
        return {
          ...workingPart,
          output: {
            __slimPreview: true,
            originalChars: text.length,
            preview: text.slice(0, TOOL_RESULT_PREVIEW_CHARS),
            hint: "工具结果已按 D6 截断归档（完整内容可按参数重取）",
            results: { ...results, stdout: clip(results.stdout), stderr: clip(results.stderr) },
          },
        };
      }
      return {
        ...workingPart,
        output: {
          __slimPreview: true,
          originalChars: text.length,
          preview:
            preservedImageNotes.length > 0
              ? `${text.slice(0, TOOL_RESULT_PREVIEW_CHARS)}\n…（工具结果已截断，以下为图片落盘路径）\n${preservedImageNotes.join("\n")}`
              : text.slice(0, TOOL_RESULT_PREVIEW_CHARS),
          hint: "工具结果已按 D6 截断归档（完整内容可按参数重取）",
        },
      };
    });
    return { ...message, parts } as UIMessage;
  });
  return touched ? out : messages;
}

/** 从文本里提取 [N] 引用标注的 chunk id 集合（引用标注规范保证格式：句末独立 [118] [877]） */
function extractCitedChunkIds(text: string): Set<string> {
  const ids = new Set<string>();
  const re = /\[(\d{1,6})\]/g;
  for (const m of text.matchAll(re)) ids.add(m[1]);
  return ids;
}

/** 从 RAG 结果文本（预览或全文）提取 chunk id 候选（chunk_id 字段形态） */
function extractResultChunkIds(text: string): Set<string> {
  const ids = new Set<string>();
  const re = /chunk_id"?\s*[:=]\s*(\d{1,6})/g;
  for (const m of text.matchAll(re)) ids.add(m[1]);
  return ids;
}

/** 提取来源坐标行（related_chapter_titles 字段形态；取首次命中） */
function extractSourceCoord(text: string): string | null {
  const m = text.match(/related_chapter_titles"?\s*[:=]\s*"([^"]{1,80})"/);
  return m ? m[1] : null;
}

/** 计算 L2 降级边界：B = 满足 B ≤ T−5 的最大 10 倍数（不足 10 时为 0 = 不降级） */
export function agedBoundary(userTurnCount: number): number {
  const cap = userTurnCount - L2_WINDOW;
  if (cap < L2_BLOCK) return 0;
  return Math.floor(cap / L2_BLOCK) * L2_BLOCK;
}

function stubText(toolName: string, seq: number, resultText: string, cited: Set<string>): string {
  const chunkIds = extractResultChunkIds(resultText);
  const coord = extractSourceCoord(resultText);
  if (chunkIds.size > 0) {
    const citedList: string[] = [];
    const uncitedList: string[] = [];
    for (const id of chunkIds) (cited.has(id) ? citedList : uncitedList).push(id);
    const parts: string[] = [];
    if (citedList.length) parts.push(`已引 ${citedList.join("/")}`);
    if (uncitedList.length) parts.push(`未引 ${uncitedList.join("/")}`);
    if (coord) parts.push(`来源：${coord}`);
    return `⟦${toolName}#${seq}：${parts.join("；")}⟧`;
  }
  const brief = resultText.replace(/\s+/g, " ").slice(0, 60);
  return `⟦${toolName}#${seq} 结果已归档：${brief}…⟧`;
}

/**
 * L2 请求期存根活塞（纯函数，只改副本）。输入为已选入本轮请求的消息。
 * 引用判用冻结语义：结果所在 user 轮之后 CITE_WINDOW 轮内的 assistant [id] 标注计入；
 * 统计窗固定，与降级边界解耦——边界扩张不回写旧存根，前缀逐轮稳定。
 */
export function compactAgedRagResults(messages: UIMessage[]): UIMessage[] {
  // 1) 标定每个消息所属的 user 轮号（user 消息开启新一轮；其后的 assistant 消息同轮）
  const turnOf: number[] = [];
  let turn = 0;
  for (const m of messages) {
    if (m.role === "user") turn += 1;
    turnOf.push(turn);
  }
  const boundary = agedBoundary(turn);
  if (boundary <= 0) return messages;

  // 2) 收集每轮的 assistant 文本（供引用判定；只看统计窗内的轮）
  const turnTexts = new Map<number, string>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as any;
    if (m.role !== "assistant" || !Array.isArray(m.parts)) continue;
    const t = turnOf[i];
    const text = m.parts
      .filter((p: any) => p?.type === "text")
      .map((p: any) => p?.text ?? "")
      .join("\n");
    turnTexts.set(t, `${turnTexts.get(t) ?? ""}\n${text}`);
  }

  // 3) 候选降级：user 轮号 ≤ boundary 的 RAG 结果；同时估算清除量（clear_at_least）
  interface Candidate {
    msgIdx: number;
    partIdx: number;
    stub: string;
    savedChars: number;
    resultChars: number;
  }
  const candidates: Candidate[] = [];
  let stubSeq = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as any;
    if (m.role !== "assistant" || !Array.isArray(m.parts)) continue;
    const t = turnOf[i];
    if (t === 0 || t > boundary) continue;
    m.parts.forEach((part: any, partIdx: number) => {
      const name = toolNameOf(part);
      if (!name) return;
      // useTool 转发：从 input.tool 还原原始工具名（原名缺失的不降级——无法确认是 RAG 系）；
      // 存根文案用原名 ⟦ragSearch#N⟧，模型侧语义与直挂模式一致
      const effective = name === "useTool" ? forwardedToolName(part) : name;
      if (!effective || !L2_RAG_TOOLS.has(effective)) return;
      if (part.state && part.state !== "output-available") return;
      if (part.output == null) return;
      const out = part.output as any;
      const resultText = out?.__slimPreview ? String(out.preview ?? "") : stringifyOutput(out);
      if (!resultText) return;
      stubSeq += 1;
      // 引用统计窗：本工具结果所在轮起 CITE_WINDOW 轮（含同轮——引用标注通常就在工具调用后的
      // 同一条助手回答里；固定窗，与降级边界解耦，边界扩张不回写旧存根）
      const cited = new Set<string>();
      for (let w = t; w <= t + CITE_WINDOW && w <= turn; w++) {
        for (const id of extractCitedChunkIds(turnTexts.get(w) ?? "")) cited.add(id);
      }
      const stub = stubText(effective, stubSeq, resultText, cited);
      candidates.push({
        msgIdx: i,
        partIdx,
        stub,
        savedChars: Math.max(0, resultText.length - stub.length),
        resultChars: resultText.length,
      });
    });
  }
  if (candidates.length === 0) return messages;

  // 4) clear_at_least：整批收益不足则全部推迟（等积累到下一批再断缓存）
  const totalSavedTokens = candidates.reduce(
    (sum, c) => sum + estimateTokens("x".repeat(Math.max(0, c.savedChars))),
    0,
  );
  if (totalSavedTokens < L2_CLEAR_AT_LEAST_TOKENS) return messages;

  // 5) 生成副本并替换（output 直接换存根字符串——模型侧干净，工具卡显示一行存根）
  const out = messages.slice() as any[];
  const byMsg = new Map<number, Candidate[]>();
  for (const c of candidates) {
    if (!byMsg.has(c.msgIdx)) byMsg.set(c.msgIdx, []);
    byMsg.get(c.msgIdx)!.push(c);
  }
  for (const [msgIdx, list] of byMsg) {
    const parts = (out[msgIdx].parts as any[]).slice();
    for (const c of list) {
      parts[c.partIdx] = { ...parts[c.partIdx], output: c.stub };
    }
    out[msgIdx] = { ...out[msgIdx], parts };
  }
  return out as UIMessage[];
}
