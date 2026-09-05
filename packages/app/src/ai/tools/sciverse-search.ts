import { useSciverseStore } from "@/store/sciverse-store";
import { invoke } from "@tauri-apps/api/core";
import { tool } from "ai";
import { z } from "zod";

/** Sciverse 证据片段（与 Rust SciverseEvidence 的 camelCase 输出对齐） */
interface SciverseEvidence {
  title: string;
  docId: string;
  chunkId: string;
  score: number;
  offset: number;
  pageNo: number | null;
  abstract: string;
  text: string;
  context: string | null;
  contextMore: boolean | null;
}

export const sciverseSearchTool = tool({
  description: `科研搜索（学术/科研类问题优先用它，而非 webSearch）：Sciverse 学术证据检索，直接返回论文原文中的证据片段。

OpenDataLab 科学证据数据层，覆盖 4.5 亿+ 知识记录与 3000 万+ AI-Ready 论文全文。

🎯 **适用场景**：
• 科研问答、学术概念解释、方法/定理/实验细节查证——需要「基于论文原文证据」的高可信度回答
• 追问某本书/某篇论文涉及的外部学术背景知识

🚫 **不适用（防止与 webSearch 混用）**：
• 新闻、实时资讯、网页资料、作者动态等通用网络信息 → 用 webSearch
• 本书/文献库内已收录内容的检索 → 用 ragSearch / paperSearch
• 发现、下载、导入新文献 → 用文献管理类 MCP 工具（若已配置）

📊 **返回内容**：
证据片段列表，每条含论文标题、命中的原文片段、相关度分数、页码与原文偏移坐标。作答时基于片段内容，并注明出自哪篇论文（标题）；不要编造片段之外的"原文"。`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因，例如：'用户问的问题涉及学术事实，需要论文原文证据支撑'"),
    question: z.string().min(1).describe("自然语言问题或论断（中英文均可，1-200 字最佳），如 '多头注意力机制如何工作'"),
    topK: z.number().int().min(1).max(30).default(8).describe("返回的证据条数，默认 8 条"),
    mode: z
      .enum(["fast", "balanced", "quality"])
      .default("balanced")
      .describe("检索质量/延迟权衡：fast 仅关键词（最快）/ balanced 混合检索（默认）/ quality 质量最高（较慢）"),
    expand: z
      .boolean()
      .default(false)
      .describe("true 时对前 3 条命中从原文偏移处扩读上下文（证据更充分，回答关键问题时开启）"),
  }),

  execute: async ({
    reasoning,
    question,
    topK,
    mode,
    expand,
  }: {
    reasoning: string;
    question: string;
    topK?: number;
    mode?: "fast" | "balanced" | "quality";
    expand?: boolean;
  }) => {
    const state = useSciverseStore.getState();
    if (!state.enabled) {
      throw new Error("科研搜索未启用。请引导用户到 设置 → 科研搜索 填写 API Token 并打开开关");
    }
    try {
      // Token 由 Rust 侧自 keyring 取（sciverse:token），前端不传密钥
      const results = await invoke<SciverseEvidence[]>("sciverse_search", {
        query: question.trim(),
        topK: topK || 8,
        mode: mode || "balanced",
        expand: expand || false,
      });

      return {
        results,
        meta: {
          reasoning,
          question,
          count: results.length,
        },
      };
    } catch (error) {
      throw new Error(`科研搜索失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
});
