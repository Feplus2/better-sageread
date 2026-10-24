import type {
  PositionWindow,
  RawReadingPosition,
  ReadingPositionSnapshot,
  ResolvedPositionCoordinates,
} from "@/types/reading-position";
import { invoke } from "@tauri-apps/api/core";
import { getLiveReadingPosition } from "./live-position";

/**
 * 阅读位置桥服务（2026-10-20）。
 *
 * 职责：
 *   1. 把渲染层的 RawReadingPosition 交给 Rust 换算成 mdbook 文本坐标（字符偏移 + 分块区间）；
 *   2. 组装成 ReadingPositionSnapshot（提示词注入 / 工具 / 展示共用）；
 *   3. 按位置读 mdbook 原文窗口（Agent 按需扩窗）。
 *
 * 容错：Rust 不可用 / mdbook 产物缺失时 resolve 返回 null，调用方降级为"标签兜底"，
 * 不阻塞聊天。
 */

/** 提示词注入段的最大字符预算（位置本身很小，这里只是防御性上限） */
export const MAX_POSITION_PROMPT_CHARS = 600;

const pct = (v: number) => Math.round(v * 10) / 10;

/** 位置快照 -> 单行坐标文案（注入/工具共用的紧凑格式） */
function coordinateLine(p: ReadingPositionSnapshot): string {
  const parts = [`${p.mdRelPath} · 字符 ${p.charOffset}/${p.mdLength}`, `文件内 ${pct(p.percentInDoc)}%`];
  if (p.chunkRange && p.chunkTotal) {
    parts.push(`约分块 ${p.chunkRange[0]}–${p.chunkRange[1]}/${p.chunkTotal}`);
  }
  return parts.join(" · ");
}

/** 提示词动态段：书籍/论文统一格式；调用方负责拼到 system prompt 尾部并传当前文档模式 */
export function formatPositionForPrompt(p: ReadingPositionSnapshot, documentToolMode: "new" | "legacy"): string {
  const label =
    p.scope === "reader"
      ? `章节：${p.label}${p.labelSource === "fallback" ? "（目录不可用，按 spine 定位）" : ""}`
      : `小节：${p.label}`;
  const lines = ["【当前阅读位置】", label, `坐标：${coordinateLine(p)}`];
  if (p.scope === "reader" && p.spineIndex != null && p.spineTotal != null) {
    lines.push(`spine：${p.spineIndex + 1}/${p.spineTotal}${p.cfi ? ` · CFI：${p.cfi}` : ""}`);
  }
  lines.push(`进度：全书 ${pct(p.overallPercent)}%`);
  const readTool = documentToolMode === "new" ? "readDocument(position=true)" : "readAtReadingPosition";
  lines.push(
    `（每轮更新，以此为准；历史消息中的位置可能已过时。需要原文时用 ${readTool} 按需读取，不要凭记忆复述正文。）`,
  );
  return lines.join("\n").slice(0, MAX_POSITION_PROMPT_CHARS);
}

/** 位置快照 -> 工具返回对象（结构化，便于模型引用） */
export function formatPositionForTool(p: ReadingPositionSnapshot): Record<string, unknown> {
  return {
    scope: p.scope,
    label: p.label,
    label_source: p.labelSource,
    md_file: p.mdRelPath,
    char_offset: p.charOffset,
    md_length: p.mdLength,
    percent_in_file: pct(p.percentInDoc),
    chunk_range: p.chunkRange,
    chunk_total: p.chunkTotal,
    overall_percent: pct(p.overallPercent),
    spine: p.spineIndex != null && p.spineTotal != null ? { index: p.spineIndex, total: p.spineTotal } : null,
    cfi: p.cfi,
  };
}

/** Rust 坐标 -> 快照（书籍/论文共用） */
function toSnapshot(raw: RawReadingPosition, coords: ResolvedPositionCoordinates): ReadingPositionSnapshot {
  const chunkRange: [number, number] | null =
    coords.chunkRangeStart != null && coords.chunkRangeEnd != null
      ? [coords.chunkRangeStart + 1, coords.chunkRangeEnd + 1]
      : null;
  if (raw.scope === "reader") {
    const overall = raw.locTotal > 0 ? (raw.locCurrent / raw.locTotal) * 100 : coords.percentInDoc;
    const fallbackLabel = `spine ${raw.sectionIndex + 1}${coords.spineTotal ? `/${coords.spineTotal}` : ""}`;
    return {
      scope: "reader",
      docId: raw.bookId,
      label: raw.label.trim() || fallbackLabel,
      labelSource: raw.label.trim() ? "toc" : "fallback",
      mdRelPath: coords.mdRelPath,
      mdLength: coords.mdLength,
      charOffset: coords.charOffset,
      percentInDoc: coords.percentInDoc,
      chunkRange,
      chunkTotal: coords.chunkTotal,
      overallPercent: overall,
      spineIndex: raw.sectionIndex,
      spineTotal: coords.spineTotal,
      cfi: raw.cfi || null,
    };
  }
  return {
    scope: "paper",
    docId: raw.paperId,
    label: raw.headingText.trim() || "（未定位到小节标题）",
    labelSource: raw.tocAvailable ? "toc" : "fallback",
    mdRelPath: coords.mdRelPath,
    mdLength: coords.mdLength,
    charOffset: coords.charOffset,
    percentInDoc: coords.percentInDoc,
    chunkRange,
    chunkTotal: coords.chunkTotal,
    overallPercent: raw.docFraction * 100,
    spineIndex: null,
    spineTotal: null,
    cfi: null,
  };
}

/** 把原始位置解析成 mdbook 坐标快照；失败返回 null（调用方降级） */
export async function resolveReadingPosition(raw: RawReadingPosition): Promise<ReadingPositionSnapshot | null> {
  try {
    const coords =
      raw.scope === "reader"
        ? await invoke<ResolvedPositionCoordinates>("plugin:epub|resolve_reading_position", {
            bookId: raw.bookId,
            sectionHref: raw.sectionHref,
            sectionFraction: raw.sectionFraction,
            locCurrent: raw.locCurrent,
            locTotal: raw.locTotal,
          })
        : await invoke<ResolvedPositionCoordinates>("plugin:epub|resolve_paper_position", {
            paperId: raw.paperId,
            charOffset: raw.charOffset,
            docLength: raw.docLength,
          });
    return toSnapshot(raw, coords);
  } catch (error) {
    console.warn("[reading-position] 坐标换算失败，降级为标签位置:", error);
    return null;
  }
}

/** 从活注册表取位置并解析（提示词组装 / 工具调用入口） */
export async function resolveLiveReadingPosition(
  scope: RawReadingPosition["scope"],
  id: string | undefined,
): Promise<ReadingPositionSnapshot | null> {
  if (!id) return null;
  const raw = scope === "reader" ? getLiveReadingPosition("reader", id) : getLiveReadingPosition("paper", id);
  if (!raw) return null;
  return resolveReadingPosition(raw);
}

/** 降级文案：坐标换算失败时至少给出章节/小节名（不阻塞聊天） */
export function formatFallbackPosition(raw: RawReadingPosition | null): string {
  if (!raw) return "";
  if (raw.scope === "reader") {
    const label = raw.label.trim() || `spine ${raw.sectionIndex + 1}`;
    return `【当前阅读位置】\n章节：${label}\n（坐标暂不可用；历史消息中的位置可能已过时）`;
  }
  return `【当前阅读位置】\n小节：${raw.headingText.trim() || "（未定位）"}\n（坐标暂不可用；历史消息中的位置可能已过时）`;
}

/**
 * 按位置读 mdbook 原文窗口。
 * @param before 位置之前保留的字符数（默认 0）
 * @param after  位置之后读取的字符数（默认 6000，硬上限 32000）
 */
export async function readPositionWindow(
  p: ReadingPositionSnapshot,
  options?: { before?: number; after?: number },
): Promise<PositionWindow> {
  const before = Math.max(0, Math.min(options?.before ?? 0, 8000));
  const after = Math.max(500, Math.min(options?.after ?? 6000, 32000));
  const start = Math.max(0, p.charOffset - before);
  return invoke<PositionWindow>("plugin:epub|read_position_window", {
    kind: p.scope === "reader" ? "book" : "paper",
    id: p.docId,
    relPath: p.mdRelPath,
    offset: start,
    maxChars: before + after,
  });
}

/** mdbook 相对路径 -> 展示名（工具输出用，避免暴露绝对路径） */
export function shortMdPath(mdRelPath: string): string {
  const parts = mdRelPath.split("/");
  return parts.length <= 2 ? mdRelPath : parts.slice(-2).join("/");
}
