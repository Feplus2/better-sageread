import { getCurrentVectorModelConfig } from "@/utils/model";
import { invoke } from "@tauri-apps/api/core";
import { tool } from "ai";
import { z } from "zod";

/** Rust search_papers_db 返回的单条结果（PaperSearchItemDto） */
interface PaperSearchItem {
  paper_id: string;
  book_title: string;
  book_author: string;
  content: string;
  similarity: number;
  md_file_path: string;
  file_order_in_book: number;
  chunk_id: number;
  chunk_order_in_file: number;
  total_chunks_in_file: number;
  global_chunk_index: number;
}

/**
 * 文献库语义检索（增强层工具，仅在有向量能力时注册）。
 * paperIds 为检索范围闭包：null = 全部文献；数组 = 限定论文集合（用户在面板中选择的作用域）。
 */
export const createPaperSearchTool = (paperIds: string[] | null | undefined) =>
  tool({
    description: `在文献库向量库中执行语义+关键词混合检索，返回最相关的论文片段（可跨论文）。

🔍 **检索范围**：由用户在面板中选择（本篇论文/所在文件夹/全部文献/自定义文件夹），工具自动生效，无需传参。

💡 **使用场景**：
• 跨论文的主题对比、文献调研类问题（"这些论文里谁用了 XX 方法"）
• 范围为"本篇论文"时，在当前论文中按语义查找相关内容

📝 **引用要求**：结果来自不同论文时，回答中必须注明片段出自哪篇论文（标题）。

🌐 **检索技巧**：
• 论文正文为英文：**请用英文术语构造 query**（中文提问先在心里翻译成英文专业术语再检索），命中率显著更高
• 复杂问题拆成 2-3 个不同措辞的 query 分次检索（同义词/上下位词/具体↔抽象），比一次长查询覆盖更全
• 概念性查询可调高 vectorWeight，精确术语/符号/人名可调高 bm25Weight
• 默认不命中参考文献列表（References 小节的分片已打标排除）；确需检索参考文献（如找某篇引用）时传 includeReferences=true
• 长综述全文总结类需求，优先 getPaperToc + readPaperSection 按小节通读，不要把 topK 拉满当全文阅读器用`,
    inputSchema: z.object({
      reasoning: z.string().min(1).describe("调用此工具的原因和目的，例如：'用户想比较多篇论文的方法'"),
      query: z.string().min(1).describe("检索问题（论文正文为英文，请用英文专业术语构造，命中率更高）"),
      topK: z.number().int().min(1).max(30).default(5).describe("返回的片段数量，建议 3-8 个"),
      vectorWeight: z.number().min(0).max(1).default(0.7).describe("向量搜索权重（0-1），概念性查询可调高"),
      bm25Weight: z.number().min(0).max(1).default(0.3).describe("关键词搜索权重（0-1），术语查询可调高"),
      includeReferences: z
        .boolean()
        .default(false)
        .describe("是否包含参考文献列表（References 小节）的分片，默认排除；找引用/溯源时才开"),
    }),
    execute: async ({
      reasoning,
      query,
      topK,
      vectorWeight,
      bm25Weight,
      includeReferences,
    }: {
      reasoning: string;
      query: string;
      topK?: number;
      vectorWeight?: number;
      bm25Weight?: number;
      includeReferences?: boolean;
    }) => {
      const vectorConfig = await getCurrentVectorModelConfig();

      const results = (await invoke("plugin:epub|search_papers_db", {
        query,
        paperIds: paperIds ?? null,
        topK: topK ?? 5,
        vectorWeight: vectorWeight ?? 0.7,
        bm25Weight: bm25Weight ?? 0.3,
        includeReferences: includeReferences ?? false,
        embeddingsUrl: vectorConfig.embeddingsUrl,
        model: vectorConfig.model,
        apiKey: vectorConfig.apiKey,
      })) as PaperSearchItem[];

      const enhancedResults = results.map((r, index) => ({
        rank: index + 1,
        paper_id: r.paper_id,
        paper_title: r.book_title,
        paper_author: r.book_author,
        similarity: Number.parseFloat((r.similarity * 100).toFixed(1)),
        content: r.content,
        position: {
          chunk_id: r.chunk_id,
          file_position: `${r.chunk_order_in_file + 1}/${r.total_chunks_in_file}`,
        },
      }));

      const citations = enhancedResults.map((item) => ({
        chunk_id: item.position.chunk_id,
        source: `《${item.paper_title}》 - 相似度${item.similarity}%`,
        preview: item.content.slice(0, 100) + (item.content.length > 100 ? "..." : ""),
      }));

      const citationGuide = [
        "📚 引用标注指南：",
        "在回答中引用检索结果时，请注明出自哪篇论文：",
        ...citations.map((c) => `[${c.chunk_id}] ${c.source}`),
        "",
        "📝 标注说明：",
        "• 跨论文结果必须在句末标注论文标题，如「XX 方法在《论文A》中被提出[123]」",
        "• 使用 [chunk_id] 格式在句末添加引用，如 [123], [456] 等",
      ].join("\n");

      return {
        results: enhancedResults,
        citations,
        citation_guide: citationGuide,
        meta: {
          reasoning,
          total_found: results.length,
          query,
          scope: paperIds == null ? "全部文献" : `${paperIds.length} 篇论文`,
          search_config: {
            vector_weight: vectorWeight ?? 0.7,
            bm25_weight: bm25Weight ?? 0.3,
          },
        },
      };
    },
  });
