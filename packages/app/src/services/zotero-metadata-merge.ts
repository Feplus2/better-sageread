import type { PaperMetadata } from "@/pages/paper-reader/paper-metadata";

/**
 * Zotero 导入的元数据合并（Zotero 优先，converter LLM 提取值兜底）。
 *
 * 背景：converter 对同一篇 PDF 可能掷出不同年份（Received 年 vs 出版年），首页下载水印
 * （"Downloaded by ..."）年份/作者也可能被误抓；Zotero 条目来自用户本地库（zotero.rs
 * sqlite 扫描），是可信靠山。规则：
 * - title/date/doi：Zotero 字段存在（非空白）即优先，缺位回退提取值
 * - author（完整列表）：保留提取值——Zotero 扫描没有全作者字段
 * - displayAuthor（列表显示用）：优先 Zotero firstAuthor（提取首作者可能被出版商页
 *   ORCID 图标等污染，实锤 emoji 混入）；「et al.」按提取作者数判断多名
 *
 * 纯函数、零运行时依赖（仅类型导入），便于单测（scripts/test-zotero-metadata-merge.mjs）。
 */

/** ZoteroItem 中参与合并的字段子集（与 zotero-import-service.ZoteroItem 对齐） */
export interface ZoteroMetaSource {
  title?: string | null;
  doi?: string | null;
  year?: string | null;
  firstAuthor?: string | null;
}

export interface MergedPaperMetadata {
  metadata: PaperMetadata;
  /** 列表显示作者（save_paper 的 author 参数） */
  displayAuthor: string;
}

const nonBlank = (v: string | null | undefined): string | null => {
  const t = v?.trim();
  return t ? t : null;
};

/** 提取作者列表的首作者名（string/PaperAuthor 两态都认；只作 Zotero firstAuthor 缺位时的兜底） */
function firstExtractedAuthor(author: PaperMetadata["author"]): string {
  const list = !author ? [] : Array.isArray(author) ? author : [author];
  const first = list[0];
  const name = typeof first === "string" ? first : (first?.name ?? "");
  return name.trim();
}

export function mergeZoteroMetadata(parsed: PaperMetadata, item: ZoteroMetaSource): MergedPaperMetadata {
  const metadata: PaperMetadata = { ...parsed };
  const zTitle = nonBlank(item.title);
  if (zTitle) metadata.title = zTitle;
  const zYear = nonBlank(item.year);
  if (zYear) metadata.date = zYear;
  const zDoi = nonBlank(item.doi);
  if (zDoi) metadata.doi = zDoi;

  // 提取作者数只用于「et al.」多名判断（不取内容——内容可能污染）
  const count = !parsed.author ? 0 : Array.isArray(parsed.author) ? parsed.author.length : 1;
  const zFirst = nonBlank(item.firstAuthor);
  const displayAuthor = zFirst
    ? count > 1
      ? `${zFirst} et al.`
      : zFirst
    : (() => {
        const first = firstExtractedAuthor(parsed.author);
        return first && count > 1 ? `${first} et al.` : first;
      })();
  return { metadata, displayAuthor };
}
