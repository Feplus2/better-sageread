import { readPaperMarkdown } from "@/ai/tools/paper/shared";
import { parsePaperSections } from "@/pages/paper-reader/markdown-sections";
import { openBookDocument } from "@/services/book-translation/book-translation-service";
import { invoke } from "@tauri-apps/api/core";
import { exists, readTextFile } from "@tauri-apps/plugin-fs";
import { tool } from "ai";
import { z } from "zod";
import {
  type AgentDocScope,
  assertDocInRetrievalScope,
  bookIndexed,
  docDir,
  docRefString,
  readDocMetadata,
  resolveDocRef,
} from "./shared";

const MAX_OUTLINE_ITEMS = 80;
/** 书籍目录注入上限：EPUB TOC 可能上百条，注入 35 条一级/二级即可，避免挤占上下文 */
const BOOK_TOC_MAX = 40;

function countFigureLines(markdown: string): number {
  return markdown.split("\n").filter((line) => line.trim().startsWith("![") && line.includes("images/")).length;
}

function countCitationEntries(markdown: string): number {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => /^#{1,3}\s+(references|参考文献)\b/i.test(line.trim()));
  if (start < 0) return 0;
  let count = 0;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^#{1,6}\s+/.test(line)) break;
    if (/^(?:<a id="ref-\d+"><\/a>)?\[?\d+[\].)]\s+/.test(line)) count += 1;
  }
  return count;
}

function tocItemsFromMetadataMd(markdown: string): { level: number; heading: string }[] {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => /^##\s+目录/.test(line.trim()));
  if (start < 0) return [];
  const items: { level: number; heading: string }[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s+/.test(line.trim())) break;
    const matched = /^(\s*)-\s+(.+?)\s*$/.exec(line);
    if (matched) items.push({ level: Math.floor(matched[1].length / 2) + 1, heading: matched[2] });
    if (items.length >= MAX_OUTLINE_ITEMS) break;
  }
  return items;
}

export const createGetDocumentInfoTool = (ctx: AgentDocScope) =>
  tool({
    description:
      "获取文档信息与目录（通用原语）：标题/作者/来源/索引状态/目录/图与引用计数。\n\n📖 **使用场景**：\n• 回答结构类问题（有哪些章节、目录、多少张图）\n• 调用 readDocument 前先拿准确标题与目录\n• 跨文档时先确认圈内有哪些内容\n\n🚫 **范围约束**：只能查看用户当前选择范围内的文档；越界 doc 会被明确拒绝。需要更广范围时请用户切侧栏下拉。\n\n🎯 **参数**：doc：book:<id> 或 paper:<id>；省略 = 当前文档。\n\n📊 **返回**：{doc, metadata, index, outline:{total,items:[{level,heading,anchor}]}, counts}。",
    inputSchema: z.object({
      reasoning: z.string().min(1).describe("调用此工具的原因和目的"),
      doc: z.string().optional().describe("文档引用：book:<id> 或 paper:<id>；省略 = 当前文档"),
    }),
    execute: async (args: { reasoning: string; doc?: string }) => {
      const doc = resolveDocRef(args.doc, ctx);
      // 用户划圈优先：圈外文档连元信息/目录都不读
      assertDocInRetrievalScope(doc, ctx);
      const metadata = await readDocMetadata(doc);
      if (doc.kind === "paper") {
        const markdown = await readPaperMarkdown(doc.id);
        const parsed = parsePaperSections(markdown);
        let paperIndex: { status: "indexed" | "not_indexed"; chunk_count?: number; note: string } = {
          status: "not_indexed",
          note: "未能读取论文索引状态（按未索引处理）：只能按原文读取；如确有索引，可改用 searchLibrary 语义检索。",
        };
        try {
          const status = await invoke<{ indexed: boolean; chunkCount: number }>("plugin:epub|paper_index_status", {
            paperId: doc.id,
          });
          paperIndex = status.indexed
            ? { status: "indexed", chunk_count: status.chunkCount, note: "已建向量索引" }
            : {
                status: "not_indexed",
                chunk_count: status.chunkCount,
                note: "这篇论文未建向量索引（论文向量库中没有它的分块），只能按原文读取（较慢）；回答时提醒用户可在设置中向量化后再检索。",
              };
        } catch {
          // 保持保守状态
        }
        const items = parsed.headings.slice(0, MAX_OUTLINE_ITEMS).map((heading) => ({
          level: heading.level,
          heading: heading.text,
          anchor: `${docRefString(doc)}#${heading.text}`,
        }));
        return {
          doc: { ref: docRefString(doc), kind: doc.kind, id: doc.id, title: metadata.title ?? null },
          metadata: {
            authors: metadata.author ?? null,
            venue: metadata.venue ?? null,
            doi: metadata.doi ?? null,
            published: metadata.published ?? null,
            language: metadata.language ?? null,
          },
          index: paperIndex,
          outline: { total: parsed.headings.length, items, truncated: parsed.headings.length > items.length },
          counts: { figures: countFigureLines(markdown), citations: countCitationEntries(markdown) },
          meta: { reasoning: args.reasoning },
        };
      }
      let tocItems: { level: number; heading: string }[] = [];
      try {
        const metadataMdPath = `${await docDir(doc.id)}/metadata.md`;
        if (await exists(metadataMdPath)) {
          tocItems = tocItemsFromMetadataMd(await readTextFile(metadataMdPath));
        }
      } catch {
        tocItems = [];
      }
      // 未索引书没有 metadata.md：回退解析 EPUB 原生 TOC（new 模式必须给目录，否则模型会盲翻全文）
      let tocSource = tocItems.length > 0 ? "metadata.md" : "none";
      if (tocItems.length === 0) {
        try {
          const { bookDoc } = await openBookDocument(doc.id);
          const flat: { level: number; heading: string }[] = [];
          const walk = (items: unknown, depth: number) => {
            for (const raw of (items as { label?: string; subitems?: unknown }[] | undefined) ?? []) {
              if (raw?.label) flat.push({ level: depth + 1, heading: raw.label });
              if (raw?.subitems) walk(raw.subitems, depth + 1);
              if (flat.length >= MAX_OUTLINE_ITEMS) return;
            }
          };
          walk((bookDoc as { toc?: unknown }).toc, 0);
          if (flat.length > 0) {
            tocItems = flat;
            tocSource = "epub-toc";
          }
        } catch {
          tocSource = "none";
        }
      }
      const tocTotal = tocItems.length;
      const tocTruncated = tocItems.length > BOOK_TOC_MAX;
      if (tocTruncated) tocItems = tocItems.slice(0, BOOK_TOC_MAX);
      const indexed = await bookIndexed(doc.id);
      return {
        doc: { ref: docRefString(doc), kind: doc.kind, id: doc.id, title: metadata.title ?? null },
        metadata: {
          authors: metadata.author ?? null,
          published: metadata.published ?? null,
          language: metadata.language ?? null,
        },
        index: {
          status: indexed ? "indexed" : "not_indexed",
          note: indexed
            ? "已建向量索引"
            : "本书未建向量索引，只能按目录/原文读取（较慢）；建议告诉用户可在设置中向量化后再检索，速度会快很多。",
        },
        outline: {
          total: tocTotal,
          items: tocItems.map((item) => ({
            level: item.level,
            heading: item.heading,
            anchor: `${docRefString(doc)}#${item.heading}`,
          })),
          truncated: tocTruncated,
          source: tocSource,
          note:
            tocItems.length === 0
              ? "没有可用目录；可直接用 readDocument 的 heading 尝试匹配 EPUB 目录。有目录时只读目标小节，不要整章通读。"
              : undefined,
        },
        counts: { figures: null, citations: null },
        meta: { reasoning: args.reasoning },
      };
    },
  });
