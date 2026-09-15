import { extractStructuredText } from "@/services/book-content/extract-structured-text";
import { openBookDocument } from "@/services/book-translation/book-translation-service";
import { invoke } from "@tauri-apps/api/core";
import { tool } from "ai";
import { z } from "zod";

interface SectionReadResult {
  matchedTitle: string;
  text: string;
  truncated: boolean;
  totalChars: number;
  pages: number;
}

interface TocEntry {
  label: string;
  href?: string;
  subitems?: TocEntry[];
}

const normalize = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** 拍平目录为 [{ label, href }]（保留层级序） */
function flattenToc(items: TocEntry[] | undefined, out: { label: string; href: string }[] = []) {
  for (const it of items ?? []) {
    if (it?.href) out.push({ label: it.label ?? "", href: it.href });
    if (it?.subitems?.length) flattenToc(it.subitems, out);
  }
  return out;
}

/** 匹配语义（E5 根修：要 5 章给 5.9 的病）：精确 > 前缀 > 包含，逐级短路 */
function matchTocEntry(entries: { label: string; href: string }[], query: string) {
  const q = normalize(query);
  if (!q) return { kind: "none" as const };
  const exact = entries.filter((e) => normalize(e.label) === q);
  if (exact.length) return { kind: "hit" as const, entry: exact[0]! };
  const prefix = entries.filter((e) => normalize(e.label).startsWith(q));
  if (prefix.length) return { kind: "hit" as const, entry: prefix[0]! };
  const contains = entries.filter((e) => normalize(e.label).includes(q));
  if (contains.length === 1) return { kind: "hit" as const, entry: contains[0]! };
  if (contains.length > 1) return { kind: "ambiguous" as const, candidates: contains.slice(0, 20) };
  return { kind: "none" as const };
}

/** TOC href → spine 下标 + 锚点 id。href 可能带 EPUB/ 前缀或与 section.id 不完全一致，做后缀归一 */
function resolveHref(bookDoc: any, href: string): { spineIndex: number; fragment: string | null } | null {
  const [file, frag] = href.split("#");
  const sections: any[] = bookDoc.sections ?? [];
  const norm = (p: string) => p.replace(/^\.\//, "").replace(/\\/g, "/");
  const target = norm(file ?? "");
  let idx = sections.findIndex((s) => norm(s.id ?? "") === target);
  if (idx < 0) idx = sections.findIndex((s) => target.endsWith(norm(s.id ?? "")) || norm(s.id ?? "").endsWith(target));
  if (idx < 0) idx = sections.findIndex((s) => (s.id ?? "").split("/").pop() === target.split("/").pop());
  if (idx < 0) return null;
  return { spineIndex: idx, fragment: frag || null };
}

/**
 * 阅读助手兜底工具（P3）：按目录章节标题直读本书小节原文。
 * JS 读取层（2026-09-15 重写）：foliate 解析管线复用 openBookDocument；
 * 深层小节锚点直读、startOffset 续读、结构化提取（公式→LaTeX、表格→Markdown）；
 * 失败回退 Rust 侧 read_book_section（正则剥标签老路径）。
 */
export const createReadBookSectionTool = (activeBookId: string | undefined) =>
  tool({
    description: `按目录章节标题直接读取当前图书的小节原文（本书未建立向量索引时的正文兜底通道）。

🎯 **核心功能**：
• 输入目录中的章节标题（支持到三级小节），返回该小节的正文文本（公式为 LaTeX、表格为 Markdown 表格）
• 匹配规则：精确 > 前缀 > 包含；找不到或有多个候选时返回可选清单，按清单修正后重试

📋 **使用策略**：
• 回答任何书中内容问题前，先用本工具读相关小节原文，不得凭印象编造
• 目录见【当前阅读图书元信息与目录】；小节很长被截断时，用返回的 nextOffset 作 startOffset 续读（不要调大 maxChars 硬塞）
• 元数据问题（书名/作者/目录）直接答，不要调用本工具

⚠️ **什么时候别用**：
• 本书已建向量索引且 RAG 检索有结果时，优先 ragSearch/ragContext——它们是主通道
• 但 RAG 检索命中为空（通常因为本书未建索引）时，立即改用本工具读原文，不要空答`,

    inputSchema: z.object({
      reasoning: z.string().min(1).describe("调用此工具的原因"),
      chapterTitle: z.string().min(1).describe("目录中的章节标题（见【当前阅读图书元信息与目录】，支持到三级小节）"),
      maxChars: z
        .number()
        .int()
        .min(500)
        .max(30000)
        .optional()
        .describe("单次返回字符上限（默认 8000，上限 30000；长小节请用 startOffset 续读）"),
      startOffset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("从抽取文本的第 N 字符开始返回（续读：上次返回的 nextOffset 原样传入）"),
    }),

    execute: async ({
      reasoning,
      chapterTitle,
      maxChars,
      startOffset,
    }: {
      reasoning: string;
      chapterTitle: string;
      maxChars?: number;
      startOffset?: number;
    }) => {
      if (!activeBookId) {
        return {
          results: { success: false, message: "未找到当前阅读图书，请先在阅读器中打开图书" },
          meta: { reasoning },
        };
      }
      const cap = Math.min(Math.max(maxChars ?? 8000, 500), 30000);
      const offset = Math.max(startOffset ?? 0, 0);

      // ── JS 读取层（结构化：公式 LaTeX / 表格 Markdown）──
      try {
        const { bookDoc } = await openBookDocument(activeBookId);
        const entries = flattenToc((bookDoc as any).toc);
        const m = matchTocEntry(entries, chapterTitle);
        if (m.kind === "ambiguous") {
          return {
            results: {
              success: false,
              message: `标题「${chapterTitle}」有 ${m.candidates.length} 个候选，请精确后重试`,
              candidates: m.candidates.map((c) => c.label),
            },
            meta: { reasoning, chapterTitle },
          };
        }
        if (m.kind === "hit") {
          const resolved = resolveHref(bookDoc, m.entry.href);
          if (resolved) {
            const section = (bookDoc as any).sections[resolved.spineIndex];
            const doc = await section?.createDocument?.();
            if (doc) {
              const anchor = resolved.fragment ? doc.getElementById(resolved.fragment) : null;
              const { text, totalChars } = extractStructuredText(doc, anchor);
              const slice = text.slice(offset, offset + cap);
              const nextOffset = offset + slice.length;
              const truncated = nextOffset < totalChars;
              return {
                results: {
                  success: true,
                  message: truncated
                    ? `已读取「${m.entry.label}」（第 ${offset + 1}–${nextOffset} 字符，共 ${totalChars}；未读完——用 startOffset=${nextOffset} 续读）`
                    : `已读取「${m.entry.label}」（${totalChars} 字符，已读完）`,
                  matchedTitle: m.entry.label,
                  content: slice,
                  truncated,
                  totalChars,
                  nextOffset: truncated ? nextOffset : null,
                },
                meta: { reasoning, chapterTitle },
              };
            }
          }
          // href 解析失败：落到 Rust 老路径再试一次
        }
      } catch (error) {
        console.warn("[readBookSection] JS 读取层失败，回退 Rust 路径:", error);
      }

      // ── Rust 老路径（正则剥标签，兜底）──
      try {
        const res = await invoke<SectionReadResult>("plugin:epub|read_book_section", {
          bookId: activeBookId,
          chapterTitle,
          maxChars: (offset > 0 ? cap + offset : cap) ?? null,
        });
        const text = offset > 0 ? res.text.slice(offset) : res.text;
        return {
          results: {
            success: true,
            message: res.truncated
              ? `已读取「${res.matchedTitle}」（${res.pages} 页，共 ${res.totalChars} 字符，已截断——可传 startOffset=${offset + cap} 续读）`
              : `已读取「${res.matchedTitle}」（${res.pages} 页，${res.totalChars} 字符）`,
            matchedTitle: res.matchedTitle,
            content: text,
            truncated: res.truncated,
            totalChars: res.totalChars,
            nextOffset: res.truncated ? offset + cap : null,
          },
          meta: { reasoning, chapterTitle },
        };
      } catch (error) {
        return {
          results: {
            success: false,
            message: `读取失败：${error instanceof Error ? error.message : String(error)}`,
          },
          meta: { reasoning, chapterTitle },
        };
      }
    },
  });
