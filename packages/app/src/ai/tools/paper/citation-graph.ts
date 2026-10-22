import { type AgentDocScope, assertDocInRetrievalScope, resolveRetrievalScope } from "@/ai/tools/document/shared";
import { appDataDir } from "@tauri-apps/api/path";
import { exists, readDir } from "@tauri-apps/plugin-fs";
import { tool } from "ai";
import { z } from "zod";
import { readPaperMarkdown, readPaperMetadataJson } from "./shared";

/**
 * P2 引用图谱（库内视角）：目标论文引用了库内哪些论文、库内哪些论文引用了目标论文。
 * 数据来自各论文 paper.md 的 References 小节 + metadata.json（DOI/标题），按 DOI/标题归一化匹配；
 * 不是全文数据库，也不构建跨库全局图谱——只回答「库内关系」。
 */

const MAX_ENTRY_CHARS = 180;
const MAX_LIST = 20;

function matchHeading(line: string): { level: number; text: string } | null {
  const matched = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
  return matched ? { level: matched[1].length, text: matched[2] } : null;
}

function isReferencesHeading(text: string): boolean {
  const lower = text.trim().toLowerCase();
  return /^references\b/.test(lower) || lower.includes("参考文献");
}

function splitCitationEntries(block: string): string[] {
  const entries: string[] = [];
  let current: string[] = [];
  const flush = () => {
    const entry = current.join(" ").trim();
    if (entry) entries.push(entry);
    current = [];
  };
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      flush();
      continue;
    }
    if (/^(?:\[\d+\]|\d+[.)]|-)\s+/.test(trimmed)) flush();
    current.push(trimmed);
  }
  flush();
  return entries;
}

function extractReferences(markdown: string): { heading: string | null; entries: string[] } {
  const lines = markdown.split("\n");
  let start = -1;
  let startLevel = 0;
  let heading = "";
  for (let index = 0; index < lines.length; index++) {
    const matched = matchHeading(lines[index]);
    if (matched && isReferencesHeading(matched.text)) {
      start = index;
      startLevel = matched.level;
      heading = matched.text;
      break;
    }
  }
  if (start < 0) return { heading: null, entries: [] };
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    const matched = matchHeading(lines[index]);
    if (matched && matched.level <= startLevel) {
      end = index;
      break;
    }
  }
  return {
    heading,
    entries: splitCitationEntries(
      lines
        .slice(start + 1, end)
        .join("\n")
        .trim(),
    ),
  };
}

function normalizeKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface PaperIdentity {
  id: string;
  title: string;
  doi: string;
}

async function readPaperIdentity(paperId: string, markdown: string): Promise<PaperIdentity> {
  let title = "";
  let doi = "";
  try {
    const metaRaw = await readPaperMetadataJson(paperId);
    if (metaRaw) {
      const meta = JSON.parse(metaRaw) as { title?: unknown; doi?: unknown };
      if (typeof meta.title === "string") title = meta.title;
      if (typeof meta.doi === "string") doi = meta.doi;
    }
  } catch {
    // metadata.json 缺失/损坏时退回正文首个标题
  }
  if (!title) {
    for (const line of markdown.split("\n")) {
      const matched = /^#\s+(.+?)\s*$/.exec(line.trim());
      if (matched) {
        title = matched[1];
        break;
      }
    }
  }
  return { id: paperId, title, doi };
}

function entryMatches(entry: string, target: PaperIdentity): boolean {
  const doiKey = target.doi.trim().toLowerCase();
  if (doiKey.length > 6 && entry.toLowerCase().includes(doiKey)) return true;
  const titleKey = normalizeKey(target.title);
  if (titleKey.length >= 18) {
    const normalizedEntry = normalizeKey(entry);
    // 只匹配标题前 60 个归一化字符，降低同义词/短标题误报
    if (normalizedEntry.includes(titleKey.slice(0, 60))) return true;
  }
  return false;
}

async function listLibraryPapers(excludeId: string): Promise<string[]> {
  const base = await appDataDir();
  const booksDir = `${base}/books`;
  const entries = await readDir(booksDir).catch(() => []);
  const paperIds: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory || entry.name === excludeId) continue;
    if (await exists(`${booksDir}/${entry.name}/paper.md`)) paperIds.push(entry.name);
  }
  return paperIds;
}

export const createGetCitationGraphTool = (ctx: AgentDocScope) =>
  tool({
    description:
      "查看论文在「库内」的引用关系：\n• 它引用了文献库里哪些论文（reference → paper）\n• 文献库里哪些论文引用了它（paper → cited by）\n按 DOI / 标题匹配 References 小节，不需要向量索引。该工具会扫描论文库里的其它论文，因此只能在「论文库」及以上范围使用；「本篇」范围会明确提示切换，不会静默缩小结果。\n\n📖 **使用场景**：\n• 「这篇论文和库里哪些论文有引用关系」「谁引用了这篇」\n• 做相关工作梳理、判断文献库里的上下游关系\n\n📊 **返回**：{doc, title, doi, references:{total, in_library:[{ref_index, paper, title, entry(≤180 字符)}]}, cited_by:{total_papers, papers:[{paper, title, ref_indexes, entries}]}, note}；只覆盖库内论文，不查外部数据库。",
    inputSchema: z.object({
      reasoning: z.string().min(1).describe("调用此工具的原因和目的"),
      doc: z.string().optional().describe("目标论文：paper:<id>；省略 = 当前论文"),
      include_cited_by: z.boolean().default(true).describe("是否扫描库内其它论文的 References 找「谁引用了它」"),
    }),
    execute: async (args: { reasoning: string; doc?: string; include_cited_by?: boolean }) => {
      const rawDoc = (args.doc ?? "").trim();
      const targetId = rawDoc.startsWith("paper:")
        ? rawDoc.slice("paper:".length)
        : rawDoc
          ? null
          : ctx.scope === "paper"
            ? ctx.currentId
            : undefined;
      if (!targetId) {
        return {
          error: rawDoc ? "引用图谱只支持论文（doc=paper:<id>）" : "缺少目标论文：请传 doc=paper:<id>",
          meta: { reasoning: args.reasoning },
        };
      }
      // 目标论文必须在用户圈内；圈外 doc 直接明确报错
      assertDocInRetrievalScope({ kind: "paper", id: targetId }, ctx);
      // 引用图谱要扫描文献库其它论文的 References；「本篇」圈不下这个动作，先请用户扩大范围
      if (resolveRetrievalScope(ctx) === "current") {
        return {
          error:
            "引用图谱需要扫描文献库中的其它论文，超出当前「本篇论文」范围。请让用户把侧栏顶部的检索范围切到「论文库」或「论文库+图书馆」后再试；不要用 readDocument 逐篇绕过。",
          meta: { reasoning: args.reasoning },
        };
      }
      const targetMarkdown = await readPaperMarkdown(targetId);
      const target = await readPaperIdentity(targetId, targetMarkdown);
      const targetRefs = extractReferences(targetMarkdown);
      const libraryIds = await listLibraryPapers(targetId);
      const library = await Promise.all(
        libraryIds.map(async (paperId) => {
          const markdown = await readPaperMarkdown(paperId).catch(() => "");
          const identity = await readPaperIdentity(paperId, markdown);
          return { identity, markdown };
        }),
      );

      const referencesInLibrary: { ref_index: number; paper: string; title: string; entry: string }[] = [];
      targetRefs.entries.forEach((entry, index) => {
        for (const { identity } of library) {
          if (entryMatches(entry, identity)) {
            referencesInLibrary.push({
              ref_index: index + 1,
              paper: `paper:${identity.id}`,
              title: identity.title,
              entry: entry.slice(0, MAX_ENTRY_CHARS),
            });
          }
        }
      });

      const citedBy: { paper: string; title: string; ref_indexes: number[]; entries: string[] }[] = [];
      if (args.include_cited_by !== false) {
        for (const { identity, markdown } of library) {
          const refs = extractReferences(markdown);
          const hitIndexes: number[] = [];
          const entries: string[] = [];
          refs.entries.forEach((entry, index) => {
            if (entryMatches(entry, target)) {
              hitIndexes.push(index + 1);
              if (entries.length < 3) entries.push(entry.slice(0, MAX_ENTRY_CHARS));
            }
          });
          if (hitIndexes.length > 0) {
            citedBy.push({ paper: `paper:${identity.id}`, title: identity.title, ref_indexes: hitIndexes, entries });
          }
        }
      }

      return {
        doc: `paper:${targetId}`,
        title: target.title,
        doi: target.doi,
        references: {
          total: targetRefs.entries.length,
          in_library: referencesInLibrary.slice(0, MAX_LIST),
        },
        cited_by: {
          total_papers: citedBy.length,
          papers: citedBy.slice(0, MAX_LIST),
        },
        note:
          libraryIds.length === 0
            ? "文献库里没有其它论文，无法建立引用关系。"
            : referencesInLibrary.length === 0 && citedBy.length === 0
              ? "库内未发现引用关系：可能这篇论文的参考文献不在库内，或匹配按 DOI/标题未命中。"
              : undefined,
        meta: { reasoning: args.reasoning },
      };
    },
  });
