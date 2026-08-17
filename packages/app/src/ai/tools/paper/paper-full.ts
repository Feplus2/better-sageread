import { parsePaperMarkdown } from "@/pages/paper-reader/paper-metadata";
import { tool } from "ai";
import { z } from "zod";
import { readPaperMarkdown } from "./shared";

/** 单次返回的全文默认上限（字符），可用 maxChars/offset 参数续读 */
const DEFAULT_FULL_CHARS = 50000;
const MAX_FULL_CHARS = 100000;

/** 通读当前论文全文（基础层工具，无需向量能力，直接读 paper.md） */
export const createPaperFullTool = (paperId: string | undefined) =>
  tool({
    description: `通读当前论文的完整正文（不含 frontmatter 元数据，元数据用 getPaperInfo 获取）。

📖 **使用场景**：
• 用户要求总结全文、评价全文、做跨小节的整体分析
• 论文较短时一次性获取比逐节读取更高效

💡 **使用建议**：
• 默认返回 50000 字符；超长论文标注 total_length 与 truncated，用 offset 续读后续部分
• 只需要某个具体小节时优先 readPaperSection，不要通读全文`,
    inputSchema: z.object({
      reasoning: z.string().min(1).describe("调用此工具的原因和目的，例如：'用户要求总结整篇论文'"),
      maxChars: z
        .number()
        .int()
        .min(5000)
        .max(MAX_FULL_CHARS)
        .optional()
        .describe(`返回字符上限（默认 ${DEFAULT_FULL_CHARS}，上限 ${MAX_FULL_CHARS}）`),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("从第几个字符开始返回（续读用，默认 0；截断提示里会给出下一次的 offset 值）"),
    }),
    execute: async ({ reasoning, maxChars, offset }: { reasoning: string; maxChars?: number; offset?: number }) => {
      if (!paperId) {
        throw new Error("未找到当前论文，请先在文献库中打开一篇论文");
      }

      const markdown = await readPaperMarkdown(paperId);
      const { body } = parsePaperMarkdown(markdown);
      const full = body.trim();
      const start = Math.min(offset ?? 0, full.length);
      const limit = maxChars ?? DEFAULT_FULL_CHARS;
      const slice = full.slice(start, start + limit);
      const end = start + slice.length;
      const truncated = end < full.length;

      return {
        content: truncated
          ? `${slice}\n……（全文过长，已截断，完整长度 ${full.length} 字符；用 offset ${end} 续读后续部分）`
          : slice,
        total_length: full.length,
        offset: start,
        truncated,
        meta: { reasoning },
      };
    },
  });
