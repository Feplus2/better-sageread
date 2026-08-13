/**
 * 全局助手工具：SageRead 使用帮助问答（APP 帮助助手）
 *
 * 检索内置使用手册（__app_manual__ 语料库）回答"怎么用"类问题：
 * - 有向量能力：语义混合检索（手册索引按需自动构建/更新）
 * - 无向量能力：降级为本地关键词检索，无需任何模型配置
 */
import { type ManualSearchItem, ensureManualIndex, keywordSearchManual, searchManual } from "@/services/manual-service";
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

export const askAppHelpTool = tool({
  description: `回答"Better SageRead 怎么用"类问题：功能在哪、如何操作、设置含义、常见问题。

🎯 **适用场景**（用户问的是 Better SageRead 本身，而不是书的内容）：
• "怎么换主题/字体/背景？" "在哪里配置模型？" "同步怎么开？"
• "备份怎么恢复？" "这个按钮是干什么的？" "能不能……？"
• 产品功能咨询、操作指引、故障排查

🚫 **不适用**：书籍内容问答（用 RAG/直接回答）、执行操作（用对应动作工具，如 setTheme）

📋 **说明**：
• 已配置向量模型时用语义检索（手册索引自动构建，内容随版本自动更新）
• 未配置时自动降级为关键词检索，一样能用
• 回答时引用返回内容里的话术，注明出自哪个章节；查不到就老实说"手册里没写"

📊 **返回内容**：
相关手册片段（章节名 + 内容 + 相关度）`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因"),
    question: z.string().min(1).describe("用户关于 SageRead 使用的问题"),
    limit: z.number().int().min(1).max(8).default(4).describe("返回的手册片段数量（默认 4）"),
    reindex: z.boolean().default(false).describe("强制重建手册索引（一般不用；手册更新异常时用）"),
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
        const indexResult = await ensureManualIndex(config, reindex);
        const results = await searchManual(question, limit, config);

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
        console.warn("[askAppHelp] 语义检索失败，降级关键词检索:", error);
      }
    }

    // ---- 关键词降级检索（无需任何配置）----
    try {
      const results = await keywordSearchManual(question, limit);
      if (results.length === 0) {
        return {
          results: {
            success: false,
            message: "使用手册里没有找到相关内容，请根据你对 SageRead 的了解直接回答，并说明手册未覆盖",
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
      // 不抛出：让助手能把真实原因转告用户（Tauri invoke 的报错是字符串，不是 Error 实例）
      const detail = error instanceof Error ? error.message : String(error);
      console.error("[askAppHelp] 关键词降级检索失败:", error);
      return {
        results: {
          success: false,
          message: `使用帮助检索失败：${detail}。如果是首次使用本功能后立刻重试仍失败，请反馈给开发者`,
        },
        meta: { reasoning, question },
      };
    }
  },
});
