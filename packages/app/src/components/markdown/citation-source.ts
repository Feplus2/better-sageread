import { createContext } from "react";

/**
 * 引用标（AI 回答里的 [N] citation）的来源身份：chunkId → 来源书籍/论文。
 *
 * 映射在 ChatMessages 按消息从持久化的工具结果（tool parts 的 output）即时重建，
 * 不改消息表结构；工具结果随消息落库（H1 断点续传起即如此），老消息同样可建映射。
 * - tool-paperSearch.output.results[]：paper_id + position.chunk_id（跨文献场景的来源论文身份）
 * - tool-paperContext.output.results[]：chunk_id + paper_title（无 paper_id，只补缺不覆盖）
 * - tool-ragSearch.output：meta.book_id + results[].position.chunk_id（书籍场景）
 * - D8 目录牌模式：tool-useTool 为转发入口，真实工具名在 input.tool，output 即原工具结果结构，
 *   还原原名后按上述同口径解析（请求历史适配只改发送副本，UI/DB 中的 part 名不改写）
 */
export type CitationSource =
  | { kind: "paper"; paperId?: string; title?: string }
  | { kind: "book"; bookId?: string; title?: string };

/** 消息级 chunkId → 来源映射（ChatMessages 按消息注入）；null = 无映射，调用方退到面板/全局兜底 */
export const CitationMapContext = createContext<ReadonlyMap<number, CitationSource> | null>(null);

/** 面板级兜底来源（论文助手 = 当前论文）；书籍阅读器/全局页的兜底仍走 use-annotation-search 的 store 逻辑 */
export const CitationFallbackContext = createContext<CitationSource | null>(null);

/** 从一条消息的 parts 重建 chunkId → 来源映射；无工具结果返回 null */
export function buildCitationMap(parts: any[]): ReadonlyMap<number, CitationSource> | null {
  if (!Array.isArray(parts)) return null;
  let map: Map<number, CitationSource> | null = null;
  const ensure = () => {
    if (!map) map = new Map<number, CitationSource>();
    return map;
  };
  for (const part of parts) {
    const type = part?.type;
    if (typeof type !== "string" || !type.startsWith("tool-")) continue;
    const output = part.output;
    if (!output || typeof output !== "object") continue;
    // D8 目录牌：useTool 转发 part 的原始工具名在 input.tool（output 即原工具的结果结构）
    const rawName = type.slice("tool-".length);
    const name = rawName === "useTool" && typeof part.input?.tool === "string" ? part.input.tool : rawName;
    if (name === "paperSearch" && Array.isArray(output.results)) {
      for (const r of output.results) {
        const chunkId = Number(r?.position?.chunk_id);
        if (Number.isInteger(chunkId) && r?.paper_id) {
          ensure().set(chunkId, { kind: "paper", paperId: r.paper_id, title: r.paper_title });
        }
      }
    } else if (name === "paperContext" && Array.isArray(output.results)) {
      for (const r of output.results) {
        const chunkId = Number(r?.chunk_id);
        // paperContext 结果无 paper_id：只补缺，不覆盖 paperSearch 已建的带 id 映射
        if (Number.isInteger(chunkId) && !ensure().has(chunkId)) {
          ensure().set(chunkId, { kind: "paper", title: r?.paper_title });
        }
      }
    } else if (name === "ragSearch" && Array.isArray(output.results)) {
      const bookId = output.meta?.book_id;
      for (const r of output.results) {
        const chunkId = Number(r?.position?.chunk_id);
        if (Number.isInteger(chunkId)) {
          ensure().set(chunkId, { kind: "book", bookId, title: r?.related_chapter_titles });
        }
      }
    }
  }
  return map;
}

function sameCitationMap(
  a: ReadonlyMap<number, CitationSource> | null,
  b: ReadonlyMap<number, CitationSource> | null,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.size !== b.size) return false;
  for (const [chunkId, x] of a) {
    const y = b.get(chunkId);
    if (!y || x.kind !== y.kind || x.title !== y.title) return false;
    if ((x as any).paperId !== (y as any).paperId || (x as any).bookId !== (y as any).bookId) return false;
  }
  return true;
}

const mapByParts = new WeakMap<object, ReadonlyMap<number, CitationSource> | null>();
const mapByMessage = new Map<string, ReadonlyMap<number, CitationSource> | null>();

/**
 * 引用映射的引用稳定版：CitationMapContext 的值引用一变，该消息里每个 [N] 引用标都会整体重渲染
 * （每个都订阅着一串 store）。历史消息 parts 引用不变 → WeakMap 直接命中；流式中的消息 parts 每个 tick
 * 换引用，但映射内容通常不变 → 与上次结果结构比较，相同则沿用旧引用。
 */
export function getStableCitationMap(
  messageId: string | undefined,
  parts: any[],
): ReadonlyMap<number, CitationSource> | null {
  const cacheable = Array.isArray(parts);
  if (cacheable && mapByParts.has(parts)) return mapByParts.get(parts) ?? null;
  let result = buildCitationMap(parts);
  if (messageId) {
    const prev = mapByMessage.get(messageId);
    if (prev !== undefined && sameCitationMap(prev, result)) result = prev;
    if (mapByMessage.size > 300) mapByMessage.clear();
    mapByMessage.set(messageId, result);
  }
  if (cacheable) mapByParts.set(parts, result);
  return result;
}
