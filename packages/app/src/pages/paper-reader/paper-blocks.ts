/**
 * 论文源文本切块器（翻译管线地基）+ 译文/对照视图源文本重建。
 *
 * 切块规则与渲染器 listBlocks（paper-anchors.ts）的 DOM 块枚举严格一一对应：
 *   段落 → p、ATX/Setext 标题 → h1-h6、列表项 → li（嵌套列表归入最外层 li）、
 *   引用块 → blockquote（其内段落归入）、表格 → 逐单元格 td/th（首行 th，DOM 顺序）。
 *   $$ 公式与代码块渲染为 pre/div（不在 listBlocks 选择器内），不占用块序号；
 *   图片独占段仍是 p 块（占位对齐），标记 kind="image" 且不可翻译。
 * sourceText 为 DOM textContent 等口径的纯文本（行内公式保留 $...$，图片/硬换行无文本贡献），
 * 与锚点偏移处于同一文本空间；一致性测试见 scripts/test-paper-blocks-consistency.mjs。
 *
 * 已知例外（fixture 与契约产物均不出现，出现时按不可翻译处理并可能破坏块对齐）：
 *   脚注（remark-gfm 会在文末生成 <section data-footnotes> 内的 li）、原始 HTML 块。
 */

import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { parsePaperMarkdown } from "./paper-metadata";

export type PaperBlockKind =
  | "p"
  | "h1"
  | "h2"
  | "h3"
  | "h4"
  | "h5"
  | "h6"
  | "li"
  | "blockquote"
  | "th"
  | "td"
  | "image";

export interface PaperBlock {
  /** 块序号（与 listBlocks 枚举顺序一致） */
  index: number;
  kind: PaperBlockKind;
  /** DOM textContent 等口径的块文本（行内公式保留 $...$） */
  sourceText: string;
  /** 图片独占段、空块等为 false（不占翻译批次，但仍占块序号） */
  translatable: boolean;
}

export type PaperViewMode = "original" | "translated" | "bilingual";

/** 宽松的 mdast 节点（GFM 表格/数学节点不在标准联合类型内，统一按结构访问） */
interface MdNode {
  type: string;
  value?: string;
  depth?: number;
  children?: MdNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

/** LF 归一 + 去 frontmatter 后的正文（重建时 head 原样拼回） */
function splitBody(markdown: string): { head: string; body: string } {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  const { body } = parsePaperMarkdown(normalized);
  return { head: normalized.slice(0, normalized.length - body.length), body };
}

/** mdast → DOM textContent 等口径纯文本：图片/原始 HTML 无文本贡献，硬换行与源内换行一样是 "\n" 文本节点，行内/行间公式保留 $ 定界 */
function extractText(node: MdNode): string {
  switch (node.type) {
    case "text":
    case "inlineCode":
      return node.value ?? "";
    case "inlineMath":
      return `$${node.value ?? ""}$`;
    case "math":
      return `$$${node.value ?? ""}$$`;
    case "break":
      // react-markdown 渲染 <br> 后紧跟一个 "\n" 文本节点（textContent 口径包含它）
      return "\n";
    case "image":
    case "imageReference":
    case "html":
      return "";
    default:
      return (node.children ?? []).map(extractText).join("");
  }
}

/** 枚举正文顶层节点，产出与 listBlocks 一一对应的块序列 */
function collectBlocks(children: MdNode[]): PaperBlock[] {
  const blocks: PaperBlock[] = [];
  const push = (kind: PaperBlockKind, sourceText: string, translatable: boolean) => {
    blocks.push({ index: blocks.length, kind, sourceText, translatable });
  };
  for (const node of children) {
    switch (node.type) {
      case "heading": {
        const text = extractText(node);
        push(`h${node.depth ?? 1}` as PaperBlockKind, text, text.trim().length > 0);
        break;
      }
      case "paragraph": {
        const text = extractText(node);
        const imageOnly = (node.children ?? []).every(
          (child) =>
            child.type === "image" ||
            child.type === "imageReference" ||
            child.type === "break" ||
            (child.type === "text" && !(child.value ?? "").trim()),
        );
        push(imageOnly ? "image" : "p", text, !imageOnly && text.trim().length > 0);
        break;
      }
      case "list":
        for (const item of node.children ?? []) {
          const text = extractText(item);
          push("li", text, text.trim().length > 0);
        }
        break;
      case "blockquote": {
        const text = extractText(node);
        push("blockquote", text, text.trim().length > 0);
        break;
      }
      case "table":
        (node.children ?? []).forEach((row, rowIndex) => {
          for (const cell of row.children ?? []) {
            const text = extractText(cell);
            push(rowIndex === 0 ? "th" : "td", text, text.trim().length > 0);
          }
        });
        break;
      default:
        // code/math/html/thematicBreak/definition：渲染产物不在 listBlocks 选择器内，不占块序号
        break;
    }
  }
  return blocks;
}

/** 把 paper.md 切成与渲染器块枚举一一对应的源文本块 */
export function cutPaperBlocks(markdown: string): PaperBlock[] {
  const { body } = splitBody(markdown);
  const tree = parser.parse(body) as unknown as MdNode;
  return collectBlocks(tree.children ?? []);
}

// ─── 视图重建 ───

interface Edit {
  start: number;
  end: number;
  text: string;
}

function offsetOf(point: { offset?: number } | undefined, node: MdNode): number {
  const offset = point?.offset;
  if (offset == null) throw new Error(`mdast 节点缺少 position.offset（type=${node.type}）`);
  return offset;
}

/** 节点"内容区"（第一个到最后一个子节点）：替换它可保留 #/>/| 等语法标记 */
function contentSpan(node: MdNode): { start: number; end: number } | null {
  const children = node.children ?? [];
  if (children.length === 0) return null;
  return {
    start: offsetOf(children[0].position?.start, children[0]),
    end: offsetOf(children.at(-1)?.position?.end, node),
  };
}

const oneLine = (text: string) => text.replace(/\s*\n\s*/g, " ").trim();

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const TRANSLATION_DIV_CLASS = "paper-translation";
const translationDiv = (text: string) =>
  `<div class="${TRANSLATION_DIV_CLASS}" data-translation>${escapeHtml(text)}</div>`;

const LIST_MARKER_RE = /^(\s*(?:[-+*]|\d+[.)])\s+)/;

// ─── 译文图片引用补回（译文模式硬保证） ───

/** markdown 图片引用（![alt](url) / ![alt](url "title")；MinerU 产物路径不含括号/空格，此正则够用） */
const IMAGE_REF_RE = /!\[[^\]]*\]\([^)]*\)/g;

/** 图片引用 token 中的 URL：判断译文是否已保留该图时按 URL 比对（容忍模型改写 alt 文本） */
const imageRefUrl = (token: string): string | null => /^!\[[^\]]*\]\(([^)\s"]+)/.exec(token)?.[1] ?? null;

/**
 * 译文图片引用补回：MinerU 常把图片与图注放同一段落块（A\n![](images/x.jpg)\nFig. 1. …），
 * 模型整块翻译后可能丢失 ![](...) 引用，导致译文模式图片消失。
 * 对源块 markdown 里的每个图片引用，若译文中不存在（按 URL 比对，容忍 alt 被改写）则按原相对位置补回：
 * 源块块首 → 译文块首、块尾 → 译文块尾、居中 → 按字符比例贴到最近空白之后（尽量原位）。
 * 居中图片的插入点先按原译文坐标统一计算、再从后往前插入，多图顺序与源块一致。
 */
export function restoreImageRefs(sourceMarkdown: string, translated: string): string {
  const missing: { token: string; start: number }[] = [];
  for (const match of sourceMarkdown.matchAll(IMAGE_REF_RE)) {
    const url = imageRefUrl(match[0]);
    if (url && translated.includes(url)) continue; // 译文已含该图（含 alt 被改写的情形）
    missing.push({ token: match[0], start: match.index });
  }
  if (missing.length === 0) return translated;

  const stripRefs = (text: string) => text.replace(IMAGE_REF_RE, "").trim();
  const head: string[] = [];
  const tail: string[] = [];
  const middle: { token: string; at: number }[] = [];
  for (const { token, start } of missing) {
    const before = stripRefs(sourceMarkdown.slice(0, start));
    const after = stripRefs(sourceMarkdown.slice(start + token.length));
    if (!before) {
      head.push(token);
    } else if (!after) {
      tail.push(token);
    } else {
      const at = Math.min(translated.length, Math.round((start / sourceMarkdown.length) * translated.length));
      middle.push({ token, at });
    }
  }

  let result = translated;
  // 居中图片：坐标基于原译文，从后往前插入（先入者坐标更大，不影响后入者），贴到最近的空白之后
  for (const { token, at } of [...middle].sort((a, b) => b.at - a.at)) {
    let insertAt = -1;
    for (let i = at; i < result.length; i += 1) {
      if (/\s/.test(result[i])) {
        insertAt = i + 1;
        break;
      }
    }
    if (insertAt === -1) {
      for (let i = at - 1; i >= 0; i -= 1) {
        if (/\s/.test(result[i])) {
          insertAt = i + 1;
          break;
        }
      }
    }
    result = insertAt === -1 ? `${result}\n${token}` : `${result.slice(0, insertAt)}${token} ${result.slice(insertAt)}`;
  }
  if (head.length > 0) result = `${head.join("\n")}\n${result}`;
  if (tail.length > 0) result = `${result}\n${tail.join("\n")}`;
  return result;
}

/** 枚举正文顶层节点并对每个有译文的可翻译块生成编辑（与 collectBlocks 同一遍历顺序） */
function collectEdits(
  body: string,
  children: MdNode[],
  translations: ReadonlyMap<number, string>,
  mode: Exclude<PaperViewMode, "original">,
): Edit[] {
  const edits: Edit[] = [];
  let index = 0;
  /** 取当前块译文；无译文/空白译文返回 null（该块保持原文） */
  const take = (): string | null => {
    const text = translations.get(index);
    index += 1;
    return text?.trim() ? text : null;
  };
  for (const node of children) {
    const nodeStart = offsetOf(node.position?.start, node);
    const nodeEnd = offsetOf(node.position?.end, node);
    switch (node.type) {
      case "heading":
      case "paragraph": {
        const text = take();
        if (!text) break;
        const span = contentSpan(node);
        if (!span) break;
        if (mode === "translated") {
          edits.push({ ...span, text: oneLine(restoreImageRefs(body.slice(nodeStart, nodeEnd), text)) });
        } else {
          edits.push({ start: nodeEnd, end: nodeEnd, text: `\n\n${translationDiv(text)}` });
        }
        break;
      }
      case "list":
        for (const item of node.children ?? []) {
          const text = take();
          if (!text) continue;
          const start = offsetOf(item.position?.start, item);
          const end = offsetOf(item.position?.end, item);
          if (mode === "translated") {
            // 译文模式：保留原列表标记，整块压平为单行（嵌套列表文本已并入该块译文）
            const marker = body.slice(start, end).match(LIST_MARKER_RE)?.[0] ?? "- ";
            edits.push({ start, end, text: `${marker}${oneLine(restoreImageRefs(body.slice(start, end), text))}` });
          } else {
            // 对照模式：译文 div 追加在 li 末尾（li 内部，不占块序号；原文偏移不受影响）
            edits.push({ start: end, end, text: translationDiv(text) });
          }
        }
        break;
      case "blockquote": {
        const text = take();
        if (!text) break;
        if (mode === "translated") {
          const quoted = restoreImageRefs(body.slice(nodeStart, nodeEnd), text)
            .split("\n")
            .map((line) => `> ${line.trim()}`)
            .join("\n");
          edits.push({ start: nodeStart, end: nodeEnd, text: quoted });
        } else {
          edits.push({ start: nodeEnd, end: nodeEnd, text: `\n\n${translationDiv(text)}` });
        }
        break;
      }
      case "table":
        for (const row of node.children ?? []) {
          for (const cell of row.children ?? []) {
            const text = take();
            if (!text) continue;
            const span = contentSpan(cell);
            if (!span) continue;
            if (mode === "translated") {
              // 单元格内换行与 | 会破坏表格行，压单行并转义管道符
              const restored = restoreImageRefs(body.slice(span.start, span.end), text);
              edits.push({ ...span, text: oneLine(restored).replace(/\|/g, "\\|") });
            } else {
              edits.push({ start: span.end, end: span.end, text: ` ${translationDiv(text)}` });
            }
          }
        }
        break;
      default:
        break;
    }
  }
  return edits;
}

/**
 * 用译文重建一份交给 PaperReader 渲染的 markdown（原文永远是唯一事实源，不落盘）。
 * 译文模式：可翻译块替换为译文（语法标记/公式/代码/图片原样保留；译文丢失的图片引用按原位补回，
 * 见 restoreImageRefs），块数量与顺序不变；
 * 对照模式：可翻译块后插入 <div class="paper-translation" data-translation>（listBlocks 同级排除，
 * 块索引与原文枚举一致，标注/搜索/TOC 不错位）。
 */
export function buildPaperViewMarkdown(
  markdown: string,
  translations: ReadonlyMap<number, string>,
  mode: Exclude<PaperViewMode, "original">,
): string {
  const { head, body } = splitBody(markdown);
  const tree = parser.parse(body) as unknown as MdNode;
  const edits = collectEdits(body, tree.children ?? [], translations, mode);
  let result = body;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return head + result;
}
