import { type PaperMetadata, normalizeAuthors } from "@/pages/paper-reader/paper-metadata";
import { tool } from "ai";
import { z } from "zod";
import { readPaperMetadataJson } from "./shared";

/** 摘要注入上限（字符），防止个别长摘要挤占上下文 */
const MAX_ABSTRACT_CHARS = 2000;

/** 返回当前论文 metadata.json 的关键字段（基础层工具，无需向量能力） */
export const createPaperInfoTool = (paperId: string | undefined) =>
  tool({
    description: `获取当前论文的元数据：标题、作者、发表日期、期刊/会议、DOI、摘要、关键词。

📖 **使用场景**：
• 用户问"这篇论文是什么/谁写的/发表在哪里/摘要讲了什么"
• 回答前的快速定位，无需读正文`,
    inputSchema: z.object({
      reasoning: z.string().min(1).describe("调用此工具的原因和目的，例如：'用户想知道这篇论文的出处'"),
    }),
    execute: async ({ reasoning }: { reasoning: string }) => {
      if (!paperId) {
        throw new Error("未找到当前论文，请先在文献库中打开一篇论文");
      }

      const raw = await readPaperMetadataJson(paperId);
      if (!raw) {
        throw new Error("未找到论文元数据文件（metadata.json）");
      }

      let metadata: PaperMetadata;
      try {
        metadata = JSON.parse(raw) as PaperMetadata;
      } catch {
        throw new Error("论文元数据文件（metadata.json）解析失败");
      }

      const abstract = metadata.abstract
        ? metadata.abstract.length > MAX_ABSTRACT_CHARS
          ? `${metadata.abstract.slice(0, MAX_ABSTRACT_CHARS)}……（摘要过长，已截断）`
          : metadata.abstract
        : null;

      return {
        title: metadata.title ?? null,
        authors: normalizeAuthors(metadata.author),
        date: metadata.date ?? null,
        venue: metadata["container-title"] ?? null,
        volume: metadata.volume ?? null,
        issue: metadata.issue ?? null,
        page: metadata.page ?? null,
        doi: metadata.doi ?? null,
        keywords: metadata.keywords ?? [],
        abstract,
        meta: { reasoning },
      };
    },
  });
