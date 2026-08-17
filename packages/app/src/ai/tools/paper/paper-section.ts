import { findSectionHeading, getSectionContent, parsePaperSections } from "@/pages/paper-reader/markdown-sections";
import { tool } from "ai";
import { z } from "zod";
import { readPaperMarkdown } from "./shared";

/** 单次返回的小节正文默认上限（字符），可用 maxChars/offset 参数续读 */
const DEFAULT_SECTION_CHARS = 16000;
const MAX_SECTION_CHARS = 40000;

/** 按标题读取当前论文某个小节的正文（基础层工具，无需向量能力，直接读 paper.md） */
export const createPaperSectionTool = (paperId: string | undefined) =>
  tool({
    description: `按标题读取当前论文某个小节的完整正文（含其下级子小节，到下一个同级或更高级标题为止）。

📖 **使用场景**：
• 用户询问论文某个部分的具体内容（方法、实验、结论等）
• 需要原文细节（数据、公式、论证过程）支撑回答时

💡 **使用建议**：
• 标题参数先用 getPaperToc 获取准确文本；支持标题文本或锚点 id，容错大小写与部分匹配
• 默认返回 16000 字符；超长小节标注 total_length 与 truncated，可调大 maxChars 或用 offset 续读后半截`,
    inputSchema: z.object({
      reasoning: z.string().min(1).describe("调用此工具的原因和目的，例如：'用户想深入了解实验部分的设置'"),
      heading: z.string().min(1).describe("小节标题文本（如 '3.2 实验设置'）或锚点 id"),
      maxChars: z
        .number()
        .int()
        .min(1000)
        .max(MAX_SECTION_CHARS)
        .optional()
        .describe(`返回字符上限（默认 ${DEFAULT_SECTION_CHARS}，上限 ${MAX_SECTION_CHARS}）`),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("从第几个字符开始返回（续读用，默认 0；截断提示里会给出下一次的 offset 值）"),
    }),
    execute: async ({
      reasoning,
      heading,
      maxChars,
      offset,
    }: {
      reasoning: string;
      heading: string;
      maxChars?: number;
      offset?: number;
    }) => {
      if (!paperId) {
        throw new Error("未找到当前论文，请先在文献库中打开一篇论文");
      }

      const markdown = await readPaperMarkdown(paperId);
      const parsed = parsePaperSections(markdown);
      const found = findSectionHeading(parsed, heading);

      if (!found) {
        const available = parsed.headings
          .map((h) => h.text)
          .slice(0, 20)
          .join("；");
        throw new Error(`未找到标题 "${heading}"。可用标题：${available || "（本文档没有章节标题）"}`);
      }

      const full = getSectionContent(parsed, found);
      const start = Math.min(offset ?? 0, full.length);
      const limit = maxChars ?? DEFAULT_SECTION_CHARS;
      const slice = full.slice(start, start + limit);
      const end = start + slice.length;
      const truncated = end < full.length;

      return {
        heading: { id: found.id, text: found.text, level: found.level },
        content: truncated
          ? `${slice}\n……（小节正文过长，已截断，完整长度 ${full.length} 字符；用 offset ${end} 续读后续，或调大 maxChars）`
          : slice,
        total_length: full.length,
        offset: start,
        truncated,
        meta: { reasoning },
      };
    },
  });
