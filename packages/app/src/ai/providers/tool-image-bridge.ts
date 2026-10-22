/**
 * P1-5 工具图片桥：OpenAI-compatible / DeepSeek 聊天接口只允许 user 消息携带 image_url，
 * 工具结果的 file part 会被 JSON.stringify 成 base64 文本（既看不见图，又按文本计费）。
 *
 * 本包装在 fetch 层把「工具结果里的图片」拆出来，改挂到紧随其后的 user 消息里（image_url）。
 *
 * 2026-10-22 改造（用户批准）：原先硬编码「全请求最近 3 张」——同一批 4 张图会砍掉第 1 张，
 * 且与单图体积预算脱节。现在改为「按字节预算保留 + 最新工具批优先」：
 * 1. 从新到旧挑图：最新一次工具批/最新一轮的图片先占预算（同一批多图也会被优先整体保留）；
 * 2. 预算 = 全部工具图片 dataUrl 字符数之和（默认 700k，见 utils/tool-image-budget，可运行时覆盖）；
 * 3. 装不下的老图替换成带可读路径的占位（可用 readImage/viewImages 重看），且任何情况至少保留 1 张；
 * 4. 多图工具结果（viewImages）按图片顺序配对各自的 <path>，占位能指回具体文件而不是第一条路径。
 */

import { getToolImageBudgetChars } from "@/ai/utils/tool-image-budget";
import { getCachedToolImages } from "@/ai/utils/tool-image-cache";

const TOOL_IMAGE_MARK = "[工具读取的图片";
const INLINE_IMAGE_TEXT = "[图片已附在随后的用户消息中]";

export interface ExtractedImage {
  dataUrl: string;
  mediaType: string;
  path?: string;
}

interface ToolImageExtraction {
  content: string;
  images: ExtractedImage[];
}

interface FlatImage {
  messageIndex: number;
  image: ExtractedImage;
}

function debugLog(line: string): void {
  try {
    const holder = globalThis as typeof globalThis & { __sagereadImageBridgeLog?: string[] };
    holder.__sagereadImageBridgeLog = [...(holder.__sagereadImageBridgeLog ?? []), line].slice(-40);
  } catch {
    // 调试日志失败不影响请求
  }
}

function isImageDataUrl(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("data:image/");
}

function extractPath(text: string): string | undefined {
  const matched = /<path>([^<]+)<\/path>/.exec(text);
  return matched?.[1]?.trim();
}

/** 递归遍历任意 JSON 结构：把图片节点替换成文字占位，并收集图片与可读路径。 */
function walkImages(node: unknown, images: ExtractedImage[], paths: string[]): unknown {
  if (typeof node === "string") {
    if (isImageDataUrl(node)) {
      images.push({ dataUrl: node, mediaType: "image/jpeg" });
      return INLINE_IMAGE_TEXT;
    }
    const path = extractPath(node);
    if (path) paths.push(path);
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((item) => walkImages(item, images, paths));
  }
  if (node && typeof node === "object") {
    const record = node as Record<string, unknown>;
    if (record.type === "file" && isImageDataUrl(record.url)) {
      images.push({
        dataUrl: record.url,
        mediaType: typeof record.mediaType === "string" ? record.mediaType : "image/jpeg",
      });
      return { type: "text", text: INLINE_IMAGE_TEXT };
    }
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) next[key] = walkImages(value, images, paths);
    return next;
  }
  return node;
}

function extractToolImages(content: unknown): ToolImageExtraction | null {
  if (typeof content !== "string" || !content.includes("data:image/")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  const images: ExtractedImage[] = [];
  const paths: string[] = [];
  const next = walkImages(parsed, images, paths);
  if (images.length === 0) return null;
  // 遍历顺序里信封与图片一一对应（readImage 单图、viewImages 多图都是「信封 + file part」交替）；
  // 数量对不上时退回首条路径，至少不让占位丢路径。
  const fallbackPath = paths[0];
  images.forEach((image, index) => {
    image.path = paths[index] ?? fallbackPath;
  });
  return { content: JSON.stringify(next), images };
}

/**
 * 选图核心（纯函数，导出供 L1 单测）：sizes 为按消息顺序排列（旧→新）的 dataUrl 字符数。
 * 从最新一张往回装预算——最新工具批/最新一轮天然优先，装不下就留给更老的图；
 * 任何情况至少保留最新 1 张（即使它单独就超预算）。
 */
export function selectKeptIndexes(sizes: number[], budgetChars: number): Set<number> {
  const kept = new Set<number>();
  let used = 0;
  for (let index = sizes.length - 1; index >= 0; index -= 1) {
    const size = sizes[index] ?? 0;
    if (kept.size === 0 || used + size <= budgetChars) {
      kept.add(index);
      used += size;
    }
  }
  return kept;
}

function imageNoteText(image: ExtractedImage): string {
  return image.path ? `${TOOL_IMAGE_MARK}：${image.path}]` : `${TOOL_IMAGE_MARK}]`;
}

function omittedText(image: ExtractedImage): string {
  const where = image.path ? `：${image.path}` : "";
  const hint = image.path
    ? `（如需重看，调用 readImage(path=${image.path})，或多图一起用 viewImages）`
    : "（如需重看，请重新调用 readImage）";
  return `[图片已省略${where}]${hint}`;
}

function transformBody(bodyText: string): string {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    return bodyText;
  }
  const messages = body.messages;
  if (!Array.isArray(messages)) return bodyText;
  debugLog(`transform: messages=${messages.length} bodyLen=${bodyText.length}`);

  const extractions = new Map<number, ToolImageExtraction>();
  messages.forEach((message, index) => {
    if (!message || typeof message !== "object") return;
    const record = message as Record<string, unknown>;
    if (record.role !== "tool") return;
    const rawContent = typeof record.content === "string" ? record.content : "";
    const extracted = extractToolImages(rawContent);
    const toolCallId = typeof record.tool_call_id === "string" ? record.tool_call_id : null;
    const cached = toolCallId ? getCachedToolImages(toolCallId) : undefined;
    // 目录牌模式：工具结果里的 dataUrl 已被 useTool 摘到内存缓存，这里按 toolCallId 取回
    const contentPath = extractPath(rawContent);
    const images = (extracted && extracted.images.length > 0 ? extracted.images : (cached ?? [])).map((image) => ({
      ...image,
      path: image.path ?? contentPath,
    }));
    if (images.length === 0) return;
    extractions.set(index, { content: extracted ? extracted.content : rawContent, images });
  });
  if (extractions.size === 0) {
    debugLog("no tool images extracted");
    return bodyText;
  }

  // 扁平化后按「最新优先」装预算
  const flat: FlatImage[] = [];
  for (const [messageIndex, extraction] of extractions) {
    for (const image of extraction.images) flat.push({ messageIndex, image });
  }
  const budget = getToolImageBudgetChars();
  const sizes = flat.map((item) => item.image.dataUrl.length);
  const keptIndexes = selectKeptIndexes(sizes, budget);
  let keptChars = 0;
  for (const index of keptIndexes) keptChars += sizes[index] ?? 0;
  // 最新一轮（请求末尾连续的 tool 消息组）图片数：用于排查「一批图是否被砍」
  let latestRoundImages = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const record = messages[index] as Record<string, unknown> | undefined;
    if (record?.role !== "tool") break;
    latestRoundImages += extractions.get(index)?.images.length ?? 0;
  }
  debugLog(
    `plan: images=${flat.length} latestRound=${latestRoundImages} kept=${keptIndexes.size} chars=${keptChars}/${budget} omitted=${flat.length - keptIndexes.size}`,
  );

  const kept = new Map<number, ExtractedImage[]>();
  const omitted = new Map<number, ExtractedImage[]>();
  flat.forEach((item, order) => {
    const target = keptIndexes.has(order) ? kept : omitted;
    const list = target.get(item.messageIndex) ?? [];
    list.push(item.image);
    target.set(item.messageIndex, list);
  });

  const nextMessages: unknown[] = [];
  // OpenAI 协议要求 tool 响应紧邻 assistant 的 tool_calls：多张图要等这一组 tool 消息全部结束后，
  // 再插一条 user 消息统一附图；否则 user 消息夹在 tool 消息之间会让请求挂起（实测两张图必挂）。
  let pendingImages: ExtractedImage[] = [];
  let pendingNotes: string[] = [];
  const flushPending = () => {
    if (pendingImages.length === 0) return;
    if (pendingImages.length > 1) {
      // 多图同批：记录每张图对应的路径（排查"占位/提示指错图"），只进内存调试日志
      const paths = pendingImages.map((image) => image.path ?? "?").join(" | ");
      debugLog(`flush: images=${pendingImages.length} paths=${paths.slice(0, 400)}`);
    }
    nextMessages.push({
      role: "user",
      content: [
        { type: "text", text: pendingNotes.join("\n") },
        ...pendingImages.map((image) => ({ type: "image_url", image_url: { url: image.dataUrl } })),
      ],
    });
    pendingImages = [];
    pendingNotes = [];
  };
  messages.forEach((message, index) => {
    const extraction = extractions.get(index);
    if (!extraction) {
      flushPending();
      nextMessages.push(message);
      return;
    }
    const record = message as Record<string, unknown>;
    const omittedImages = omitted.get(index) ?? [];
    const extraText = omittedImages.map((image) => omittedText(image)).join("\n");
    const content = extraText ? `${extraction.content}\n${extraText}` : extraction.content;
    nextMessages.push({ ...record, content });
    const keptImages = kept.get(index) ?? [];
    for (const image of keptImages) {
      pendingImages.push(image);
      pendingNotes.push(imageNoteText(image));
    }
    const next = messages[index + 1] as Record<string, unknown> | undefined;
    if (!next || next.role !== "tool") flushPending();
  });
  flushPending();

  body.messages = nextMessages;
  const transformed = JSON.stringify(body);
  debugLog(`done: bodyLen ${bodyText.length} -> ${transformed.length}`);
  return transformed;
}

/** 包装 OpenAI-compatible fetch：把工具结果里的图片改挂到 user 消息（按字节预算 + 最新工具批优先）。 */
export function wrapOpenAICompatToolImagesFetch(baseFetch: typeof fetch): typeof fetch {
  return async (input, init) => {
    const body = init?.body;
    debugLog(`fetch: bodyType=${typeof body} hasImage=${typeof body === "string" && body.includes("data:image/")}`);
    if (typeof body !== "string" || !body.includes('"role":"tool"')) {
      return baseFetch(input, init);
    }
    try {
      const transformed = transformBody(body);
      return await baseFetch(input, { ...init, body: transformed });
    } catch {
      return baseFetch(input, init);
    }
  };
}
