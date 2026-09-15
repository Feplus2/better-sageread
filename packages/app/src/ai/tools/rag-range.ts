import type { DocumentChunk } from "@/types/document";
import { invoke } from "@tauri-apps/api/core";
import { withRagErrorTranslation } from "./rag-error";
import { tool } from "ai";
import { z } from "zod";

export const createRagRangeTool = (activeBookId: string | undefined) =>
  tool({
    description: `基于全局分块索引范围获取连续的文档内容，可跨越不同章节。

📊 **核心功能**：
• 基于全局索引获取连续的文档片段
• 支持跨章节的连续内容检索
• 提供详细的位置信息和章节分析

📝 **标注支持**：
• 每个返回的分块都包含唯一的 chunk_id
• 支持对范围内的多个文本片段进行批量标注
• chunk_id 作为标注系统的核心标识符，确保标注的精确性
• 可以基于 chunk_id 对连续的文本段落进行组合标注

💡 **使用场景**：
• 获取特定索引范围的连续内容
• 跨章节的内容分析和比较
• 为用户提供可标注的连续文本片段
• 支持基于 chunk_id 的范围标注功能`,
    inputSchema: z.object({
      reasoning: z.string().min(1).describe("调用此工具的原因和目的，例如：'需要获取特定索引范围的连续内容进行分析'"),
      start_index: z.number().int().min(0).describe("起始全局索引（包含）"),
      end_index: z.number().int().min(0).describe("结束全局索引（不包含），如果省略则为start_index+10"),
      max_chunks: z.number().int().min(1).max(50).default(20).describe("最大返回分块数，默认20个"),
    }),
    execute: async ({
      reasoning,
      start_index,
      end_index,
      max_chunks,
    }: {
      reasoning: string;
      start_index: number;
      end_index?: number;
      max_chunks?: number;
    }) => {
      if (!activeBookId) {
        throw new Error("未找到当前阅读图书，请先在阅读器中打开图书");
      }

      // 计算实际的结束索引
      const actualEndIndex = end_index ?? start_index + 10;
      const actualMaxChunks = max_chunks ?? 20;

      // 确保范围合理
      if (actualEndIndex <= start_index) {
        throw new Error("结束索引必须大于起始索引");
      }

      const requestedRange = Math.min(actualEndIndex - start_index, actualMaxChunks);
      const finalEndIndex = start_index + requestedRange;

      const results = (await withRagErrorTranslation(() => invoke("plugin:epub|get_chunks_by_range", {
        bookId: activeBookId,
        startIndex: start_index,
        endIndex: finalEndIndex,
      }))) as DocumentChunk[];

      if (results.length === 0) {
        throw new Error(`在索引范围 ${start_index}-${finalEndIndex} 中未找到任何内容`);
      }

      // 分析跨越的文件/章节
      const fileGroups = [...new Set(results.map((chunk) => chunk.md_file_path))];
      const chapters = fileGroups.map((filePath) => {
        const chunks = results.filter((chunk) => chunk.md_file_path === filePath);
        return {
          file_path: filePath,
          chapter_title: chunks[0].related_chapter_titles,
          file_order: chunks[0].file_order_in_book,
          chunk_count: chunks.length,
          first_global: chunks[0].global_chunk_index,
          last_global: chunks[chunks.length - 1].global_chunk_index,
        };
      });

      // 处理每个分块
      const rangeContent = results.map((chunk, index) => {
        const actualIndex = start_index + index;

        return {
          // 基础信息
          chunk_id: chunk.id,
          sequence: index + 1, // 在范围中的序号
          content: chunk.chunk_text,

          // 章节信息
          chapter_info: {
            chapter_title: chunk.related_chapter_titles,
            file_order: chunk.file_order_in_book,
            md_file: chunk.md_file_path,
          },

          // 位置信息
          position: {
            global_index: chunk.global_chunk_index,
            expected_index: actualIndex,
            in_file: `${chunk.chunk_order_in_file + 1}/${chunk.total_chunks_in_file}`,
            md_source: chunk.md_file_path,
          },
        };
      });

      // 格式化输出
      const lines: string[] = [];
      lines.push(`[范围检索] 全局索引 ${start_index}-${finalEndIndex - 1} 的连续内容`);
      lines.push(`💭 调用原因：${reasoning}`);
      lines.push(`📚 跨越 ${chapters.length} 个章节，共 ${results.length} 个分块\n`);

      // 显示涉及的章节
      if (chapters.length > 1) {
        lines.push("涉及文件/章节：");
        chapters.forEach((chapter, idx) => {
          lines.push(`  ${idx + 1}. ${chapter.chapter_title} (${chapter.file_path}) - ${chapter.chunk_count}个分块`);
        });
        lines.push("");
      }

      // 显示每个分块
      rangeContent.forEach((item) => {
        const chapterChange =
          rangeContent.findIndex((c) => c.chapter_info.md_file === item.chapter_info.md_file) === item.sequence - 1;

        if (chapterChange && item.sequence > 1) {
          lines.push(`--- 📖 ${item.chapter_info.chapter_title} ---`);
        }

        lines.push(`📄 #${item.sequence} | 全局${item.position.global_index} | ${item.chapter_info.chapter_title}`);
        lines.push(`   位置：${item.position.in_file} | 来源：${item.position.md_source}`);
        lines.push(`   内容：${item.content.slice(0, 200)}${item.content.length > 200 ? "..." : ""}`);
        lines.push("");
      });

      // 计算统计信息
      const totalLength = rangeContent.reduce((sum, item) => sum + item.content.length, 0);
      const avgLength = Math.round(totalLength / rangeContent.length);

      // 生成范围引用信息
      const citations = rangeContent.map((item) => ({
        chunk_id: item.chunk_id, // 用于标注的核心标识符
        source: `${item.chapter_info.chapter_title}`,
        file_path: item.chapter_info.md_file,
        position: `全局索引${item.position.global_index} - ${item.position.in_file}`,
        preview: item.content.slice(0, 100) + (item.content.length > 100 ? "..." : ""),
        file_order: item.chapter_info.file_order,
      }));

      // 生成引用指南
      const citationGuide = [
        "📚 范围引用标注指南：",
        `在回答中引用范围内容时 (索引${start_index}-${finalEndIndex})，请使用以下标注：`,
        ...citations.slice(0, 5).map((c) => `[${c.chunk_id}] ${c.source}`), // 只显示前5个
        citations.length > 5 ? `... 以及其他 ${citations.length - 5} 个片段` : "",
        "",
        "📝 标注说明：",
        "• 使用 [chunk_id] 格式在句末添加引用，如 [123], [456] 等",
        "• chunk_id 是文本标注的核心标识符，用于精确定位原文片段",
        "• 当用户需要标注特定内容时，引导其使用对应的 chunk_id",
        "",
        "示例：「根据连续内容分析[123][456][789]...」",
      ]
        .filter((line) => line !== "")
        .join("\n");

      return {
        // 统一使用 results 字段
        results: rangeContent,
        // 范围基本信息
        range: {
          start_index,
          end_index: finalEndIndex,
          requested_size: requestedRange,
          actual_size: results.length,
        },
        // 涉及的章节
        chapters,
        // 格式化文本
        // formatted: lines.join("\n"),
        // ✨ 新增：标准化引用信息
        citations: citations,
        // ✨ 新增：引用指南
        citation_guide: citationGuide,
        // 统计信息
        stats: {
          total_chunks: results.length,
          total_characters: totalLength,
          average_chunk_length: avgLength,
          chapters_spanned: chapters.length,
          first_chunk_id: rangeContent[0]?.chunk_id,
          last_chunk_id: rangeContent[rangeContent.length - 1]?.chunk_id,
        },
        // 元信息
        meta: {
          reasoning,
        },
      };
    },
  });

export const ragRangeTool = createRagRangeTool(undefined);
