import { parsePaperSections } from "@/pages/paper-reader/markdown-sections";
import { tool } from "ai";
import { z } from "zod";
import { readPaperMarkdown } from "./shared";

/** 获取当前论文的目录结构（基础层工具，无需向量能力，直接读 paper.md） */
export const createPaperTocTool = (paperId: string | undefined) =>
  tool({
    description: `获取当前论文的目录结构（全部标题层级）。

📖 **使用场景**：
• 用户问论文的结构、章节安排、包含哪些部分
• 调用 readPaperSection 前先用它定位准确的标题文本

返回紧凑的缩进列表，其中的标题文本可直接作为 readPaperSection 的入参。`,
    inputSchema: z.object({
      reasoning: z.string().min(1).describe("调用此工具的原因和目的，例如：'用户想了解论文的整体结构'"),
    }),
    execute: async ({ reasoning }: { reasoning: string }) => {
      if (!paperId) {
        throw new Error("未找到当前论文，请先在文献库中打开一篇论文");
      }

      const markdown = await readPaperMarkdown(paperId);
      const parsed = parsePaperSections(markdown);

      if (parsed.headings.length === 0) {
        return {
          toc: [],
          toc_text: "（本文档没有章节标题）",
          total: 0,
          meta: { reasoning },
        };
      }

      const minLevel = Math.min(...parsed.headings.map((h) => h.level));
      const tocText = parsed.headings.map((h) => `${"  ".repeat(h.level - minLevel)}- ${h.text}`).join("\n");

      return {
        toc: parsed.headings.map((h) => ({ id: h.id, text: h.text, level: h.level })),
        toc_text: tocText,
        total: parsed.headings.length,
        meta: { reasoning },
      };
    },
  });
