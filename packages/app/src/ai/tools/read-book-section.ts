import { readBookSectionCanonical, resolveBookWindowImages } from "@/services/book-content/book-reading-adapter";
import { invoke } from "@tauri-apps/api/core";
import { tool } from "ai";
import { z } from "zod";
import { readCanonicalWindow } from "./document/canonical-window";

interface SectionReadResult {
  matchedTitle: string;
  text: string;
  truncated: boolean;
  totalChars: number;
  pages: number;
}

/**
 * 阅读助手兜底工具（P3）：按目录章节标题直读本书小节原文。
 * JS 读取层与 readDocument 共用 book-reading-adapter 的高保真 canonical；
 * 深层小节锚点直读、节内 startOffset 续读、窗口图片解析；
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

      // ── JS 读取层（与 readDocument 共用 canonical；Rust 仅作失败兜底）──
      try {
        const canonical = await readBookSectionCanonical(activeBookId, chapterTitle);
        if (canonical.kind === "ambiguous") {
          return {
            results: {
              success: false,
              message: `标题「${chapterTitle}」有 ${canonical.total} 个候选（按相关度列出前 ${canonical.candidates.length} 个），请精确后重试`,
              candidates: canonical.candidates.map((candidate) => candidate.label),
            },
            meta: { reasoning, chapterTitle },
          };
        }
        if (canonical.kind === "ok") {
          const fallbackNote =
            canonical.matchKind === "fallback"
              ? `（查询的小节号无目录项，已从最近的父级「${canonical.matchedQuery}」起读）`
              : canonical.matchKind === "number"
                ? `（目录中无此标题文本，已按小节号 ${canonical.matchedQuery} 匹配——注：注入目录的标题可能被转义损坏，以此返回的目录标题为准）`
                : "";
          const window = readCanonicalWindow(canonical.text, { offset, after: cap });
          const content = await resolveBookWindowImages(activeBookId, window.text, {
            ...canonical,
            windowStart: window.start,
          });
          return {
            results: {
              success: true,
              message: window.truncated
                ? `已读取「${canonical.matchedTitle}」${fallbackNote}（第 ${window.start + 1}–${window.end} 字符，共 ${canonical.totalChars}；未读完——用 startOffset=${window.nextOffset} 续读）`
                : `已读取「${canonical.matchedTitle}」${fallbackNote}（${canonical.totalChars} 字符，已读完）`,
              matchedTitle: canonical.matchedTitle,
              content,
              truncated: window.truncated,
              totalChars: canonical.totalChars,
              nextOffset: window.nextOffset,
            },
            meta: { reasoning, chapterTitle },
          };
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
