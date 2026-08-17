import type { DocumentChunk } from "@/types/document";
import { resolveMarkdownImagePaths } from "@/utils/path";
import { invoke } from "@tauri-apps/api/core";
import { tool } from "ai";
import { z } from "zod";

export const createRagContextTool = (activeBookId: string | undefined) =>
  tool({
    description: `基于分块ID获取该分块的前后文内容，用于扩展上下文信息。

🎯 **核心功能**：
• 基于 chunk_id 精确定位目标文本片段
• 获取目标片段的前后文上下文，帮助理解完整语境
• 支持灵活的上下文范围控制（前后各0-10个分块）

📝 **标注支持**：
• chunk_id 是文本标注系统的核心标识符
• 当用户需要标注特定内容时，使用 chunk_id 来精确标识该文本片段
• 返回的每个上下文分块都包含其独立的 chunk_id，支持多重标注
• 通过 chunk_id 可以实现精确的文本定位和标注管理

💡 **使用场景**：
• 扩展搜索结果的上下文信息
• 理解特定段落的完整语境
• 为用户的标注需求提供精确的 chunk_id 定位
• 支持基于 chunk_id 的文本片段标注和高亮`,
    inputSchema: z.object({
      reasoning: z.string().min(1).describe("调用此工具的原因和目的，例如：'需要获取更多上下文来理解用户问题'"),
      chunk_id: z.number().int().min(1).describe("目标分块的数据库ID"),
      prev_count: z.number().int().min(0).max(10).default(3).describe("获取前面多少个分块，默认3个"),
      next_count: z.number().int().min(0).max(10).default(3).describe("获取后面多少个分块，默认3个"),
    }),
    execute: async ({
      reasoning,
      chunk_id,
      prev_count,
      next_count,
    }: {
      reasoning: string;
      chunk_id: number;
      prev_count?: number;
      next_count?: number;
    }) => {
      if (!activeBookId) {
        throw new Error("未找到当前阅读图书，请先在阅读器中打开图书");
      }

      const results = (await invoke("plugin:epub|get_chunk_with_context", {
        bookId: activeBookId,
        chunkId: chunk_id,
        prevCount: prev_count ?? 3,
        nextCount: next_count ?? 3,
      })) as DocumentChunk[];

      const targetIndex = results.findIndex((chunk) => chunk.id === chunk_id);

      const contextData = await Promise.all(
        results.map(async (chunk, index) => {
          const isTarget = chunk.id === chunk_id;
          const relativePosition = index - targetIndex;

          let processedContent = chunk.chunk_text;
          // md_file_path 现在存储的是绝对路径，可以直接用于图片路径解析
          if (chunk.md_file_path) {
            try {
              processedContent = await resolveMarkdownImagePaths(chunk.chunk_text, chunk.md_file_path);
            } catch (error) {
              console.warn(`Failed to resolve image paths in chunk ${chunk.id}:`, error);
            }
          }

          return {
            chunk_id: chunk.id,
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
      lines.push(`[上下文检索] 分块ID ${chunk_id} 的前后文内容：`);
      lines.push(`💭 调用原因：${reasoning}\n`);

      contextData.forEach((item) => {
        const indicator = item.is_target ? "🎯" : "📄";
        lines.push(`${indicator} ${item.position_label} | ${item.related_chapter_titles}`);
        lines.push(`   位置：${item.toc_info.position_in_file} (全局${item.toc_info.global_index})`);
        lines.push(`   内容：${item.content.slice(0, 200)}${item.content.length > 200 ? "..." : ""}`);
        lines.push("");
      });

      const citations = contextData.map((item) => ({
        chunk_id: item.chunk_id,
        source: `${item.related_chapter_titles}${item.is_target ? " (目标块)" : " (上下文)"}`,
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
        "• chunk_id 是文本标注的核心标识符，用于精确定位原文片段",
        "• 目标块包含核心信息，上下文块提供补充说明",
        "• 当用户需要标注特定内容时，引导其使用对应的 chunk_id",
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
          prev_count: prev_count ?? 2,
          next_count: next_count ?? 2,
          target_found: targetIndex >= 0,
        },
      };
    },
  });

export const ragContextTool = createRagContextTool(undefined);
