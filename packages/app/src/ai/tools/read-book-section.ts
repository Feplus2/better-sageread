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

/**
 * 阅读助手兜底工具（P3）：按目录章节标题直读本书小节原文。
 * 仅在无向量能力时注册（registry reader 分支 else）；不依赖向量索引与 mdbook 产物，
 * Rust 侧 read_book_section 随读随解析 EPUB（目录 href → spine 页范围 → HTML 提取文本）。
 */
export const createReadBookSectionTool = (activeBookId: string | undefined) =>
  tool({
    description: `按目录章节标题直接读取当前图书的小节原文（本书未建立向量索引时的正文兜底通道）。

🎯 **核心功能**：
• 输入目录中的章节标题，返回该小节的正文纯文本（默认截 8000 字符）
• 标题支持模糊匹配；找不到时会返回可选章节清单，按清单修正后重试

📋 **使用策略**：
• 回答任何书中内容问题前，先用本工具读相关小节原文，不得凭印象编造
• 目录见【当前阅读图书元信息与目录】；小节内容被截断时，可调大 maxChars 续读
• 元数据问题（书名/作者/目录）直接答，不要调用本工具

⚠️ **什么时候别用**：
• 本书已建向量索引且 RAG 检索有结果时，优先 ragSearch/ragContext——它们是主通道
• 但 RAG 检索命中为空（通常因为本书未建索引）时，立即改用本工具读原文，不要空答`,

    inputSchema: z.object({
      reasoning: z.string().min(1).describe("调用此工具的原因"),
      chapterTitle: z.string().min(1).describe("目录中的章节标题（见【当前阅读图书元信息与目录】）"),
      maxChars: z
        .number()
        .int()
        .min(500)
        .max(30000)
        .optional()
        .describe("返回字符上限（默认 8000，上限 30000；截断后可调大续读）"),
    }),

    execute: async ({
      reasoning,
      chapterTitle,
      maxChars,
    }: {
      reasoning: string;
      chapterTitle: string;
      maxChars?: number;
    }) => {
      if (!activeBookId) {
        return {
          results: { success: false, message: "未找到当前阅读图书，请先在阅读器中打开图书" },
          meta: { reasoning },
        };
      }
      try {
        const res = await invoke<SectionReadResult>("plugin:epub|read_book_section", {
          bookId: activeBookId,
          chapterTitle,
          maxChars: maxChars ?? null,
        });
        return {
          results: {
            success: true,
            message: res.truncated
              ? `已读取「${res.matchedTitle}」（${res.pages} 页，共 ${res.totalChars} 字符，已截断——可调大 maxChars 续读）`
              : `已读取「${res.matchedTitle}」（${res.pages} 页，${res.totalChars} 字符）`,
            matchedTitle: res.matchedTitle,
            content: res.text,
            truncated: res.truncated,
            totalChars: res.totalChars,
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
