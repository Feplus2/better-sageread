/**
 * P1-5 工具图片桥：OpenAI-compatible / DeepSeek 聊天接口只允许 user 消息携带 image_url，
 * 工具结果的 file part 会被 JSON.stringify 成 base64 文本（既看不见图，又按文本计费）。
 *
 * 本包装在 fetch 层把「工具结果里的图片」拆出来，改挂到紧随其后的 user 消息里（image_url），
 * 并只保留最近 IMAGE_KEEP_LAST 张；更早的图片替换成带可读路径的占位文本（可用 readImage 重看）。
 */

import { getCachedToolImages } from "@/ai/utils/tool-image-cache";

const IMAGE_KEEP_LAST = 3;
const TOOL_IMAGE_MARK = "[工具读取的图片";
const INLINE_IMAGE_TEXT = "[图片已附在随后的用户消息中]";

interface ExtractedImage {
  dataUrl: string;
  mediaType: string;
  path?: string;
}

interface ToolImageExtraction {
  content: string;
  images: ExtractedImage[];
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
  const firstPath = paths[0];
  for (const image of images) image.path = firstPath;
  return { content: JSON.stringify(next), images };
}

function imageNoteText(image: ExtractedImage): string {
  return image.path ? `${TOOL_IMAGE_MARK}：${image.path}]` : `${TOOL_IMAGE_MARK}]`;
}

function omittedText(image: ExtractedImage): string {
  const where = image.path ? `：${image.path}` : "";
  const hint = image.path ? `（如需重看，调用 readImage(path=${image.path})）` : "";
  return `[较早的图片已省略${where}]${hint}`;
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
    debugLog(`tool[${index}] content=${String(record.content).slice(0, 160)}`);
    const extracted = extractToolImages(record.content);
    const toolCallId = typeof record.tool_call_id === "string" ? record.tool_call_id : null;
    const cached = toolCallId ? getCachedToolImages(toolCallId) : undefined;
    const images = extracted && extracted.images.length > 0 ? extracted.images : (cached ?? []);
    if (images.length === 0) return;
    extractions.set(index, { content: extracted ? extracted.content : String(record.content ?? ""), images });
  });
  if (extractions.size === 0) {
    debugLog("no tool images extracted");
    return bodyText;
  }

  const flat: { messageIndex: number; image: ExtractedImage }[] = [];
  for (const [messageIndex, extraction] of extractions) {
    for (const image of extraction.images) flat.push({ messageIndex, image });
  }
  const keepFrom = Math.max(0, flat.length - IMAGE_KEEP_LAST);
  const kept = new Map<number, ExtractedImage[]>();
  const omitted = new Map<number, ExtractedImage[]>();
  flat.forEach((item, order) => {
    const target = order >= keepFrom ? kept : omitted;
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
  return JSON.stringify(body);
}

/** 包装 OpenAI-compatible fetch：把工具结果里的图片改挂到 user 消息（保留最近 IMAGE_KEEP_LAST 张）。 */
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
