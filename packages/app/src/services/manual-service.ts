/**
 * 内置使用手册服务：语料库索引构建 + 语义/关键词检索
 *
 * 手册是"虚拟语料库"（book_id = __app_manual__），与书籍共用同一套
 * plugin:epub 索引/检索管线；无向量能力时降级为本地关键词检索
 */
import { invoke } from "@tauri-apps/api/core";
import { readDir, readTextFile } from "@tauri-apps/plugin-fs";

export const MANUAL_BOOK_ID = "__app_manual__";
/** 开发者 wiki 语料库（全局助手 searchDevDocs 检索用） */
export const WIKI_BOOK_ID = "__repo_wiki__";

export interface VectorModelConfigLike {
  embeddingsUrl: string;
  model: string;
  apiKey: string | null;
  dimension: number;
}

export interface ManualIndexResult {
  success: boolean;
  message: string;
  report?: { total_chunks: number; vector_dimension: number } | null;
}

export interface ManualSearchItem {
  content: string;
  related_chapter_titles: string;
  similarity: number;
  md_file_path: string;
}

/** 手册原文落盘（幂等），返回 mdbook 目录路径 */
export async function prepareManualFiles(): Promise<string> {
  return invoke<string>("plugin:epub|prepare_manual_files");
}

/** wiki 原文落盘（幂等），返回 mdbook 目录路径 */
export async function prepareWikiFiles(): Promise<string> {
  return invoke<string>("plugin:epub|prepare_wiki_files");
}

/** 构建/更新手册向量索引（内容未变且非 force 时后端直接返回 up-to-date） */
export async function ensureManualIndex(config: VectorModelConfigLike, force = false): Promise<ManualIndexResult> {
  return invoke<ManualIndexResult>("plugin:epub|index_manual", {
    embeddingsUrl: config.embeddingsUrl,
    model: config.model,
    apiKey: config.apiKey,
    force,
  });
}

/** 构建/更新 wiki 向量索引 */
export async function ensureWikiIndex(config: VectorModelConfigLike, force = false): Promise<ManualIndexResult> {
  return invoke<ManualIndexResult>("plugin:epub|index_wiki", {
    embeddingsUrl: config.embeddingsUrl,
    model: config.model,
    apiKey: config.apiKey,
    force,
  });
}

/** 语义混合检索（BM25 + 向量，复用书籍同款 search_db；bookId 参数化——手册/wiki 同一通道） */
export async function searchCorpus(
  bookId: string,
  query: string,
  limit: number,
  config: VectorModelConfigLike,
): Promise<ManualSearchItem[]> {
  return invoke<ManualSearchItem[]>("plugin:epub|search_db", {
    bookId,
    query,
    limit,
    dimension: config.dimension,
    embeddingsUrl: config.embeddingsUrl,
    model: config.model,
    apiKey: config.apiKey,
    searchMode: "hybrid",
    vectorWeight: 0.7,
    bm25Weight: 0.3,
  });
}

/** 手册语义检索（searchCorpus 的手册封装，保持既有调用点不动） */
export function searchManual(query: string, limit: number, config: VectorModelConfigLike) {
  return searchCorpus(MANUAL_BOOK_ID, query, limit, config);
}

/* ---------------- 无向量能力时的关键词降级检索 ---------------- */

interface ManualSection {
  file: string;
  title: string;
  content: string;
  score: number;
}

/** 把查询拆成匹配词项：拉丁/数字词 + CJK 二字组（中文不按空格分词） */
function extractTerms(query: string): string[] {
  const terms = new Set<string>();
  for (const w of query.toLowerCase().match(/[a-z0-9_-]{2,}/g) ?? []) {
    terms.add(w);
  }
  const cjk = query.replace(/[A-Za-z0-9\s\p{P}]/gu, "");
  for (let i = 0; i < cjk.length - 1; i++) {
    terms.add(cjk.slice(i, i + 2));
  }
  if (cjk.length === 1) terms.add(cjk);
  return [...terms];
}

/** 关键词降级检索：按 Markdown 标题切节，按词项命中计分，返回 top N 节 */
export async function keywordSearchCorpus(
  prepareDir: () => Promise<string>,
  query: string,
  limit: number,
): Promise<ManualSearchItem[]> {
  const dir = await prepareDir();
  const entries = await readDir(dir);
  const terms = extractTerms(query);
  const queryLower = query.toLowerCase().trim();
  const sections: ManualSection[] = [];

  for (const entry of entries) {
    if (!entry.isFile || !entry.name.endsWith(".md")) continue;
    const content = await readTextFile(`${dir}/${entry.name}`);
    // 按 ## 及以上标题切节（保留标题行）
    const parts = content.split(/(?=^#{1,3} )/m);
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const firstLine = trimmed.split("\n")[0] ?? "";
      const title = firstLine.replace(/^#{1,3}\s*/, "").trim() || entry.name;
      const haystack = trimmed.toLowerCase();

      let score = 0;
      if (queryLower && haystack.includes(queryLower)) score += 10;
      for (const term of terms) {
        const occurrences = haystack.split(term).length - 1;
        score += occurrences;
        if (title.toLowerCase().includes(term)) score += 3; // 标题命中加权
      }
      if (score > 0) {
        sections.push({ file: entry.name, title, content: trimmed, score });
      }
    }
  }

  sections.sort((a, b) => b.score - a.score);
  return sections.slice(0, limit).map((s) => ({
    content: s.content.length > 2000 ? `${s.content.slice(0, 2000)}…` : s.content,
    related_chapter_titles: s.title,
    similarity: Math.min(100, s.score * 5),
    md_file_path: `${dir}/${s.file}`,
  }));
}

/** 手册关键词检索（keywordSearchCorpus 的手册封装，保持既有调用点不动） */
export function keywordSearchManual(query: string, limit: number) {
  return keywordSearchCorpus(prepareManualFiles, query, limit);
}

/** wiki 关键词检索 */
export function keywordSearchWiki(query: string, limit: number) {
  return keywordSearchCorpus(prepareWikiFiles, query, limit);
}
