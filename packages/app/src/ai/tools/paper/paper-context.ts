import type { DocumentChunk } from "@/types/document";
import { resolveMarkdownImagePaths } from "@/utils/path";
import { invoke } from "@tauri-apps/api/core";
import { tool } from "ai";
import { z } from "zod";

/**
 * 论文上下文扩展（增强层工具，仅在有向量能力时注册，与 paperSearch 并列）。
 * paperSearch 命中片段不足以回答时，按 chunk_id 取同一论文内的前后邻居分块。
 * 与阅读助手的 ragContext 对等；无需闭包参数，chunk_id 由模型从 paperSearch 结果中获得。
 */
export const createPaperContextTool = () =>
  tool({
    description: `按分块ID获取论文片段的前后文内容，用于扩展 paperSearch 命中片段的上下文。

🎯 **核心功能**：
• 在 paperSearch 命中后，当片段信息不足以回答问题时，用本工具扩展阅读该片段的前后文
• chunk_id 来自 paperSearch 检索结果（position.chunk_id），不要凭空编造
• 只在同一篇论文内按分块顺序扩展，不会串到其他论文

💡 **使用场景**：
• 命中片段被截断，缺少前后铺垫（如符号定义、实验条件、前提假设）
• 需要确认片段中指代词（"该方法/该模型"）在上下文中的具体含义`,
    inputSchema: z.object({
      reasoning: z.string().min(1).describe("调用此工具的原因和目的，例如：'命中片段缺少实验条件，需要扩展上下文'"),
      chunk_id: z.number().int().min(1).describe("目标分块的数据库ID，来自 paperSearch 结果的 position.chunk_id"),
      before: z.number().int().min(0).max(10).default(3).describe("向前扩展多少个分块，默认3个"),
      after: z.number().int().min(0).max(10).default(3).describe("向后扩展多少个分块，默认3个"),
    }),
    execute: async ({
      reasoning,
      chunk_id,
      before,
      after,
    }: {
      reasoning: string;
      chunk_id: number;
      before?: number;
      after?: number;
    }) => {
      const results = (await invoke("plugin:epub|get_paper_chunk_context", {
        chunkId: chunk_id,
        before: before ?? 3,
        after: after ?? 3,
      })) as DocumentChunk[];

      if (results.length === 0) {
        return {
          results: [],
          citations: [],
          citation_guide: "",
          meta: {
            reasoning,
            target_chunk_id: chunk_id,
            total_chunks: 0,
            before: before ?? 2,
            after: after ?? 2,
            target_found: false,
            message: "未找到该分块：论文库可能尚未向量化，或 chunk_id 无效",
          },
        };
      }

      const targetIndex = results.findIndex((chunk) => chunk.id === chunk_id);

      const contextData = await Promise.all(
        results.map(async (chunk, index) => {
          const isTarget = chunk.id === chunk_id;
          const relativePosition = index - targetIndex;

          let processedContent = chunk.chunk_text;
          // md_file_path 存储的是绝对路径，可以直接用于图片路径解析
          if (chunk.md_file_path) {
            try {
              processedContent = await resolveMarkdownImagePaths(chunk.chunk_text, chunk.md_file_path);
            } catch (error) {
              console.warn(`Failed to resolve image paths in chunk ${chunk.id}:`, error);
            }
          }

          return {
            chunk_id: chunk.id,
            paper_title: chunk.book_title,
            related_chapter_titles: chunk.related_chapter_titles,
            content: processedContent,
            is_target: isTarget,
            relative_position: relativePosition,
            position_label:
              relativePosition === 0
                ? "目标分块"
                : relativePosition < 0
                  ? `前${Math.abs(relativePosition)}个`
                  : `后${relativePosition}个`,
            toc_info: {
              global_index: chunk.global_chunk_index,
              md_source: chunk.md_file_path,
              position_in_file: `${chunk.chunk_order_in_file + 1}/${chunk.total_chunks_in_file}`,
              file_order: chunk.file_order_in_book,
            },
          };
        }),
      );

      const lines: string[] = [];
      lines.push(`[上下文扩展] 分块ID ${chunk_id} 的前后文内容：`);
      lines.push(`💭 调用原因：${reasoning}\n`);

      contextData.forEach((item) => {
        const indicator = item.is_target ? "🎯" : "📄";
        lines.push(`${indicator} ${item.position_label} | 《${item.paper_title}》 ${item.related_chapter_titles}`);
        lines.push(`   位置：${item.toc_info.position_in_file} (全局${item.toc_info.global_index})`);
        lines.push(`   内容：${item.content.slice(0, 200)}${item.content.length > 200 ? "..." : ""}`);
        lines.push("");
      });

      const citations = contextData.map((item) => ({
        chunk_id: item.chunk_id,
        source: `《${item.paper_title}》 ${item.related_chapter_titles}${item.is_target ? " (目标块)" : " (上下文)"}`,
        file_path: item.toc_info.md_source,
        position: `${item.position_label} - ${item.toc_info.position_in_file}`,
        preview: item.content.slice(0, 100) + (item.content.length > 100 ? "..." : ""),
        is_target: item.is_target,
      }));

      const citationGuide = [
        "📚 上下文引用标注指南：",
        "在回答中引用上下文信息时，请使用以下标注：",
        ...citations.map((c) => `[${c.chunk_id}] ${c.source}`),
        "",
        "📝 标注说明：",
        "• 使用 [chunk_id] 格式在句末添加引用，如 [123], [456] 等",
        "• 目标块包含核心信息，上下文块提供补充说明",
        "• 引用时注明出自哪篇论文（论文标题）",
        "",
        "示例：「根据核心内容[123]，结合前文背景[456]...」",
      ].join("\n");

      return {
        results: contextData,
        citations: citations,
        citation_guide: citationGuide,
        meta: {
          reasoning,
          target_chunk_id: chunk_id,
          total_chunks: results.length,
          before: before ?? 2,
          after: after ?? 2,
          target_found: targetIndex >= 0,
        },
      };
    },
  });
