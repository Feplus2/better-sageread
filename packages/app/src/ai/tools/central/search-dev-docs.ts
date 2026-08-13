/**
 * 全局助手工具：开发者 wiki 检索（__repo_wiki__ 语料库）
 *
 * 检索内置的开发者 wiki（架构/数据模型/同步协议/Agent 系统/解析管线/开发工作流）
 * 回答"这个项目是怎么实现的"类问题；有向量能力用语义混合检索，无则降级关键词检索。
 */
import {
  type ManualSearchItem,
  ensureWikiIndex,
  keywordSearchWiki,
  searchCorpus,
  WIKI_BOOK_ID,
} from "@/services/manual-service";
import { useLlamaStore } from "@/store/llama-store";
import { getCurrentVectorModelConfig } from "@/utils/model";
import { tool } from "ai";
import { z } from "zod";

function formatResults(items: ManualSearchItem[]) {
  return items.map((item, idx) => ({
    rank: idx + 1,
    section: item.related_chapter_titles,
    similarity: item.similarity,
    content: item.content,
  }));
}

export const searchDevDocsTool = tool({
  description: `检索 Better SageRead 开发者 wiki（架构/数据模型/同步协议/Agent 系统/解析管线/开发工作流）。

🎯 **适用场景**（用户/你自己想了解这个项目的实现细节）：
• "同步是怎么实现的？" "密钥存在哪？" "论文解析管线走的哪一步？"
• "Agent 工具有哪些？" "备份的目录布局？" "怎么构建/测试/发布？"
• 用户让你基于项目现状做扩展时的自查入口

🚫 **不适用**：使用帮助（用 askAppHelp）、书籍/论文内容问答（用 RAG/paperSearch）

📋 **说明**：
• 已配置向量模型时用语义检索（wiki 索引自动构建，内容随版本自动更新）
• 未配置时自动降级为关键词检索
• 回答时注明出自 wiki 哪个章节；查不到就老实说"wiki 里没写"`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因"),
    question: z.string().min(1).describe("关于项目实现的问题"),
    limit: z.number().int().min(1).max(8).default(4).describe("返回的 wiki 片段数量（默认 4）"),
    reindex: z.boolean().default(false).describe("强制重建 wiki 索引（一般不用；wiki 更新异常时用）"),
  }),

  execute: async ({
    reasoning,
    question,
    limit,
    reindex,
  }: {
    reasoning: string;
    question: string;
    limit: number;
    reindex: boolean;
  }) => {
    // ---- 优先语义检索（有向量能力时）----
    const hasVector = useLlamaStore.getState().hasVectorCapability();
    if (hasVector) {
      try {
        const config = await getCurrentVectorModelConfig();
        const indexResult = await ensureWikiIndex(config, reindex);
        const results = await searchCorpus(WIKI_BOOK_ID, question, limit, config);

        if (results.length > 0) {
          return {
            results: formatResults(results),
            summary: {
              mode: "semantic",
              indexStatus: indexResult.message === "up-to-date" ? "已是最新" : "已重建",
              totalFound: results.length,
            },
            meta: { reasoning, question },
          };
        }
        // 语义检索无结果，落关键词兜底
      } catch (error) {
        console.warn("[searchDevDocs] 语义检索失败，降级关键词检索:", error);
      }
    }

    // ---- 关键词降级检索（无需任何配置）----
    try {
      const results = await keywordSearchWiki(question, limit);
      if (results.length === 0) {
        return {
          results: {
            success: false,
            message: "开发者 wiki 里没有找到相关内容；wiki 随源码运行内嵌，请确认当前为最新版本",
          },
          meta: { reasoning, question },
        };
      }
      return {
        results: formatResults(results),
        summary: {
          mode: hasVector ? "keyword（语义检索失败后的降级）" : "keyword（未配置向量模型）",
          totalFound: results.length,
        },
        meta: { reasoning, question },
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error("[searchDevDocs] 关键词降级检索失败:", error);
      return {
        results: {
          success: false,
          message: `开发者 wiki 检索失败：${detail}`,
        },
        meta: { reasoning, question },
      };
    }
  },
});
