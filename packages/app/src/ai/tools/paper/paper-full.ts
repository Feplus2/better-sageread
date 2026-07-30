import { parsePaperMarkdown } from "@/pages/paper-reader/paper-metadata";
import { tool } from "ai";
import { z } from "zod";
import { readPaperMarkdown } from "./shared";

/** 单次返回的全文上限（字符），超出截断并引导按小节读取 */
const MAX_FULL_CHARS = 30000;

/** 通读当前论文全文（基础层工具，无需向量能力，直接读 paper.md） */
export const createPaperFullTool = (paperId: string | undefined) =>
  tool({
    description: `通读当前论文的完整正文（不含 frontmatter 元数据，元数据用 getPaperInfo 获取）。

📖 **使用场景**：
• 用户要求总结全文、评价全文、做跨小节的整体分析
• 论文较短时一次性获取比逐节读取更高效

💡 **使用建议**：
• 超长论文会被截断并标注 total_length，此时改用 getPaperToc + readPaperSection 按小节补读
• 只需要某个具体小节时优先 readPaperSection，不要通读全文`,
    inputSchema: z.object({
      reasoning: z.string().min(1).describe("调用此工具的原因和目的，例如：'用户要求总结整篇论文'"),
    }),
    execute: async ({ reasoning }: { reasoning: string }) => {
      if (!paperId) {
        throw new Error("未找到当前论文，请先在文献库中打开一篇论文");
      }

      const markdown = await readPaperMarkdown(paperId);
      const { body } = parsePaperMarkdown(markdown);
      const full = body.trim();
      const truncated = full.length > MAX_FULL_CHARS;

      return {
        content: truncated
          ? `${full.slice(0, MAX_FULL_CHARS)}\n……（全文过长，已截断，完整长度 ${full.length} 字符；请用 getPaperToc + readPaperSection 按小节补读后续部分）`
          : full,
        total_length: full.length,
        truncated,
        meta: { reasoning },
      };
    },
  });
