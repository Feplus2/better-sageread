import type { UIMessage } from "@ai-sdk/react";
import { estimateTokens } from "./token-estimator";

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
 * 还原后按同名规则走 L1/L2（不改 part 名——stripUnknownToolParts 的 v7 兼容语义依赖现名）。
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
    if (record.type === "file" && typeof record.url === "string" && record.url.startsWith("data:image/")) {
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
      // 图片类工具：落库前把 dataUrl 换成文本占位（含 useTool 转发；信封里的路径/尺寸保留）
      const effectiveName = name === "useTool" ? forwardedToolName(part) : name;
      if (effectiveName && IMAGE_TOOLS.has(effectiveName)) {
        if (part.state && part.state !== "output-available") return part;
        if (part.output == null) return part;
        const stripped = stripImagePayloads(part.output);
        if (stripped === null) return part;
        touched = true;
        return { ...part, output: stripped };
      }
      if (!L1_CONTENT_TOOLS.has(name)) return part;
      // useTool 转发：还原原始工具名再判定——转给 UI 消费型工具（如 mindmap）的结果不截；
      // 原始名缺失的转发按内容型兜底截断（白名单收录 useTool 即为此）。output 即真实工具的原始
      // 结果结构，头部截断天然保住 chunk_id/来源坐标（引用标转跳依赖，见 citation-source.ts）
      if (name === "useTool") {
        const forwarded = forwardedToolName(part);
        if (forwarded && !L1_CONTENT_TOOLS.has(forwarded)) return part;
      }
      if (part.state && part.state !== "output-available") return part;
      if (part.output == null) return part;
      if (part.output && typeof part.output === "object" && (part.output as any).__slimPreview) return part; // 幂等
      const text = stringifyOutput(part.output);
      if (text.length <= TOOL_RESULT_PREVIEW_CHARS) return part;
      touched = true;
      return {
        ...part,
        output: {
          __slimPreview: true,
          originalChars: text.length,
          preview: text.slice(0, TOOL_RESULT_PREVIEW_CHARS),
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
