import { load } from "js-yaml";

/** 结构化作者（Pandoc 官方约定） */
export interface PaperAuthor {
  name: string;
  affiliation?: string;
}

/**
 * 论文 frontmatter 元数据，对齐 docs/paper-format-contract.md §三。
 * 字段名保持 Pandoc/CSL 原样（含连字符），未知字段直接忽略。
 */
export interface PaperMetadata {
  title?: string;
  author?: PaperAuthor[] | string[];
  date?: string;
  abstract?: string;
  doi?: string;
  "container-title"?: string;
  volume?: string;
  issue?: string;
  page?: string;
  keywords?: string[];
  lang?: string;
}

/** 匹配 `---` 包裹的 YAML frontmatter（兼容 \n / \r\n / \r 行尾） */
const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|\r|$)/;

/**
 * 解析 YAML frontmatter 文本为论文元数据。
 * 解析失败或结果不是对象时返回空 metadata（入库扫描与渲染共用）。
 */
export function parseFrontmatter(yamlText: string): PaperMetadata {
  try {
    const parsed = load(yamlText);
    if (parsed && typeof parsed === "object") {
      return parsed as PaperMetadata;
    }
  } catch (error) {
    console.warn("解析论文 frontmatter 失败:", error);
  }
  return {};
}

/**
 * 解析论文 Markdown：拆出 frontmatter 元数据与正文。
 * 无 frontmatter 或 YAML 解析失败时返回空 metadata，正文尽量保留。
 */
export function parsePaperMarkdown(raw: string): { metadata: PaperMetadata; body: string } {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) {
    return { metadata: {}, body: raw };
  }

  return { metadata: parseFrontmatter(match[1]), body: raw.slice(match[0].length) };
}

/** 把 author 字段（结构化/字符串数组/单字符串）归一化为名字列表 */
export function normalizeAuthors(author?: PaperMetadata["author"]): string[] {
  if (!author) return [];
  const list = Array.isArray(author) ? author : [author];
  return list.map((item) => (typeof item === "string" ? item : item.name)).filter(Boolean);
}
