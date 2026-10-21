import { getCurrentVectorModelConfig } from "@/utils/model";
import { invoke } from "@tauri-apps/api/core";
import { tool } from "ai";
import { z } from "zod";
import { type AgentDocScope, clipSnippet } from "./shared";

interface PaperSearchItem {
  paper_id: string;
  book_title: string;
  book_author: string;
  content: string;
  similarity: number;
  chunk_id: number;
}

export const createSearchLibraryTool = (ctx: AgentDocScope) =>
  tool({
    description:
      "在文献库（论文）中做语义+关键词混合检索，返回「文档锚点 + 有界片段」，不是全文。命中后建议先 getDocumentInfo(doc) 看目录，再用 readDocument(doc, heading) 精读，不要一次读全文。\n\n📖 **使用场景**：\n• 跨论文主题检索、找哪篇论文讨论过某个方法\n• 定位到片段后，用 readDocument(doc, heading/offset) 精读\n\n🎯 **scope**：current=当前论文；collection=面板选定范围（默认）；all=全部文献。跨文献比较时用 all。\n\n📊 **返回**：{results:[{doc, title, snippet(≤400 字符), chunk_id, similarity}], total}；引用要注明论文标题。\n\n⚠️ 书籍跨库检索尚未接入（P2）；读某本书用 readDocument(doc=book:<id>)。\n\n🔍 论文正文为英文，请用英文术语构造 query；复杂问题拆 2-3 个子查询。",
    inputSchema: z.object({
      reasoning: z.string().min(1).describe("调用此工具的原因和目的"),
      query: z.string().min(1).describe("检索问题（英文术语命中率更高）"),
      scope: z
        .enum(["current", "collection", "all"])
        .default("collection")
        .describe("检索范围：current=当前论文，collection=面板范围，all=全部文献"),
      docType: z.enum(["paper", "book"]).optional().describe("限定文档类型；当前只支持 paper（书籍检索 P2 接入）"),
      topK: z.number().int().min(1).max(12).default(6).describe("返回片段数，默认 6"),
    }),
    execute: async (args: {
      reasoning: string;
      query: string;
      scope?: "current" | "collection" | "all";
      docType?: "paper" | "book";
      topK?: number;
    }) => {
      if (args.docType === "book") {
        return {
          results: [],
          total: 0,
          note: "书籍跨库语义检索尚未接入（P2）；请用 readDocument(doc=book:<id>, heading=...) 按章节读取。",
        };
      }
      const scope = args.scope ?? "collection";
      let paperIds: string[] | null = null;
      let scopeLabel = "全部文献";
      if (scope === "current") {
        if (ctx.scope === "paper" && ctx.currentId) {
          paperIds = [ctx.currentId];
          scopeLabel = "当前论文";
        } else {
          scopeLabel = "全部文献（当前没有单篇论文上下文）";
        }
      } else if (scope === "collection") {
        paperIds = ctx.paperScopeIds ?? null;
        scopeLabel = paperIds ? `${paperIds.length} 篇论文（面板范围）` : "全部文献";
      }
      try {
        const config = await getCurrentVectorModelConfig();
        const raw = (await invoke("plugin:epub|search_papers_db", {
          query: args.query,
          paperIds,
          topK: args.topK ?? 6,
          vectorWeight: 0.7,
          bm25Weight: 0.3,
          includeReferences: false,
          embeddingsUrl: config.embeddingsUrl,
          model: config.model,
          apiKey: config.apiKey,
        })) as PaperSearchItem[];
        const results = raw.map((item) => ({
          doc: `paper:${item.paper_id}`,
          title: item.book_title,
          snippet: clipSnippet(item.content, 400),
          chunk_id: item.chunk_id,
          similarity: Number.parseFloat((item.similarity * 100).toFixed(1)),
        }));
        return {
          query: args.query,
          scope: scopeLabel,
          results,
          total: results.length,
          note: results.length === 0 ? "没有命中：换英文关键词，或把 scope 改为 all 再试" : undefined,
          meta: { reasoning: args.reasoning },
        };
      } catch (error) {
        return {
          query: args.query,
          scope: scopeLabel,
          results: [],
          total: 0,
          note: `语义检索不可用：${error instanceof Error ? error.message : String(error)}。请改用 readDocument 按章节读取。`,
        };
      }
    },
  });
