import { createContext } from "react";

/**
 * 引用标（AI 回答里的 [N] citation）的来源身份：chunkId → 来源书籍/论文。
 *
 * 映射在 ChatMessages 按消息从持久化的工具结果（tool parts 的 output）即时重建，
 * 不改消息表结构；工具结果随消息落库（H1 断点续传起即如此），老消息同样可建映射。
 * - tool-paperSearch.output.results[]：paper_id + position.chunk_id（跨文献场景的来源论文身份）
 * - tool-paperContext.output.results[]：chunk_id + paper_title（无 paper_id，只补缺不覆盖）
 * - tool-ragSearch.output：meta.book_id + results[].position.chunk_id（书籍场景）
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
    if (type === "tool-paperSearch" && Array.isArray(output.results)) {
      for (const r of output.results) {
        const chunkId = Number(r?.position?.chunk_id);
        if (Number.isInteger(chunkId) && r?.paper_id) {
          ensure().set(chunkId, { kind: "paper", paperId: r.paper_id, title: r.paper_title });
        }
      }
    } else if (type === "tool-paperContext" && Array.isArray(output.results)) {
      for (const r of output.results) {
        const chunkId = Number(r?.chunk_id);
        // paperContext 结果无 paper_id：只补缺，不覆盖 paperSearch 已建的带 id 映射
        if (Number.isInteger(chunkId) && !ensure().has(chunkId)) {
          ensure().set(chunkId, { kind: "paper", title: r?.paper_title });
        }
      }
    } else if (type === "tool-ragSearch" && Array.isArray(output.results)) {
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
