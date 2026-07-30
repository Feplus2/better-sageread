import { parsePaperMarkdown } from "./paper-metadata";

/** ATX heading 的定位信息（偏移基于去掉 frontmatter 的正文） */
export interface PaperSectionHeading {
  /** 锚点 id（对齐 rehype-slug 的 github-slugger 产物，重复标题追加 -1/-2） */
  id: string;
  /** 去除行内 Markdown 格式后的纯文本标题（对齐渲染后 DOM 的 textContent） */
  text: string;
  /** 标题层级 1-6 */
  level: number;
  /** heading 行的起始字符偏移 */
  start: number;
  /** heading 行结束偏移（小节正文从这里开始） */
  contentStart: number;
}

export interface ParsedPaperSections {
  /** 去掉 frontmatter 的正文 */
  body: string;
  /** 按文档顺序的 heading 列表 */
  headings: PaperSectionHeading[];
}

/** github-slugger 兼容的 slug：小写、去掉非字母/数字/ mark/连接符/ dash 的字符、空格转连字符 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\p{Pc}\p{Pd} ]/gu, "")
    .replace(/ /g, "-");
}

/** 把 heading 行文本渲染为纯文本（对齐 react-markdown 渲染后的 textContent） */
function stripInlineMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .trim();
}

const HEADING_RE = /^(#{1,6})[ \t]+(.*)$/;
const FENCE_RE = /^(```|~~~)/;

/**
 * 解析 paper.md：去掉 frontmatter，提取 ATX heading 列表（跳过围栏代码块内的 # 行）。
 * 工具（getPaperToc/readPaperSection）与"当前阅读小节"注入共用。
 */
export function parsePaperSections(markdown: string): ParsedPaperSections {
  const { body: rawBody } = parsePaperMarkdown(markdown);
  // 统一行尾为 \n：MinerU 等解析器产物可能是 CRLF/CR，不统一会导致按行正则（含 $ 锚点）整批失配
  const body = rawBody.replace(/\r\n?/g, "\n");
  const headings: PaperSectionHeading[] = [];
  const slugCount = new Map<string, number>();
  let offset = 0;
  let inFence = false;
  let fenceChar = "`";

  for (const line of body.split("\n")) {
    const trimmed = line.trim();

    if (FENCE_RE.test(trimmed)) {
      if (!inFence) {
        inFence = true;
        fenceChar = trimmed.charAt(0);
      } else if (trimmed.startsWith(fenceChar.repeat(3))) {
        inFence = false;
      }
      offset += line.length + 1;
      continue;
    }

    if (!inFence) {
      const match = line.match(HEADING_RE);
      if (match) {
        // 闭合 ATX 形式（## Heading ##）去掉尾部 # 序列
        const text = stripInlineMarkdown(match[2].replace(/[ \t]+#+[ \t]*$/, ""));
        if (text) {
          const base = slugify(text);
          const count = slugCount.get(base) ?? 0;
          slugCount.set(base, count + 1);
          headings.push({
            id: count === 0 ? base : `${base}-${count}`,
            text,
            level: match[1].length,
            start: offset,
            contentStart: offset + line.length + 1,
          });
        }
      }
    }

    offset += line.length + 1;
  }

  return { body, headings };
}

/**
 * 按 id 或标题文本定位 heading：id 精确 → 文本精确 → 文本精确（大小写不敏感）→ 文本包含。
 * LLM 工具入参与 PaperReader 上报的 {id, text} 都经此归一。
 */
export function findSectionHeading(parsed: ParsedPaperSections, query: string): PaperSectionHeading | undefined {
  const q = query.trim();
  if (!q) return undefined;
  const lower = q.toLowerCase();
  return (
    parsed.headings.find((h) => h.id && h.id === q) ??
    parsed.headings.find((h) => h.text === q) ??
    parsed.headings.find((h) => h.text.toLowerCase() === lower) ??
    parsed.headings.find((h) => h.text.toLowerCase().includes(lower))
  );
}

/** 提取某 heading 的小节正文：到下一个同级或更高级 heading 为止（含其下级子小节） */
export function getSectionContent(parsed: ParsedPaperSections, heading: PaperSectionHeading): string {
  const index = parsed.headings.indexOf(heading);
  if (index === -1) return "";
  const next = parsed.headings.slice(index + 1).find((h) => h.level <= heading.level);
  const end = next ? next.start : parsed.body.length;
  return parsed.body.slice(heading.contentStart, end).trim();
}
