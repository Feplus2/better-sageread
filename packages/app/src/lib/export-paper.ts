/**
 * 论文整篇导出管线：原文/译文/对照 + 标注 + 图片合并为一份文档。
 *
 * 视图 markdown 复用 buildPaperViewMarkdown（原文为唯一事实源，译文不落盘）；
 * 图片统一内嵌 base64 data URI（单文件自包含，无需复制 assets 目录）；
 * HTML 用 marked 渲染 + KaTeX 服务端烘焙公式（样式/字体全内联）；
 * PDF 沿用标注导出的"打印版 HTML → 系统浏览器另存"路线（零新依赖）。
 * 标注以"文末标注节"合并（色标/★/quote/评论/前后文，复用标注导出渲染器）。
 */

import { charOffsetToPoint, listBlocks, parseAnchor } from "@/pages/paper-reader/paper-anchors";
import {
  type PaperViewMode,
  buildPaperBilingualExportMarkdown,
  buildPaperViewMarkdown,
  cutPaperBlocks,
} from "@/pages/paper-reader/paper-blocks";
import {
  MATH_SEGMENT_RE,
  mapSourceOffsetsToLive,
  mapSrcRangeToTgt,
  normalizeLiveElement,
  normalizeMathText,
} from "@/pages/paper-reader/paper-cross-anchor";
import { normalizeAuthors, parsePaperMarkdown } from "@/pages/paper-reader/paper-metadata";
import { HIGHLIGHT_COLOR_HEX } from "@/services/constants";
import type { PaperTranslatedMeta, PaperTranslationFile } from "@/services/paper-translation-service";
import type { BookNote, HighlightStyle } from "@/types/book";
import { appDataDir, join } from "@tauri-apps/api/path";
import { save } from "@tauri-apps/plugin-dialog";
import { readFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { openPath } from "@tauri-apps/plugin-opener";
import dayjs from "dayjs";
import katex from "katex";
import { marked } from "marked";
import { toast } from "sonner";
import { EXPORT_ANNOTATIONS_CSS, buildAnnotationsListHtml } from "./export-annotations-html";
import { renderAnnotationMarkdown, toSafeAnnotationFileName } from "./export-annotations-markdown";
import { EXPORT_HTML_CSS, sanitizeHtml } from "./export-html-shared";

export type PaperExportMode = PaperViewMode;
export type PaperExportFormat = "markdown" | "html" | "pdf";

export interface PaperExportParams {
  paperId: string;
  /** 论文标题（保存对话框默认名；文档头标题回退） */
  title: string;
  /** paper.md 原文（唯一事实源） */
  markdown: string;
  /** 译本块文本（mode != original 时必需；null 时按原文导出） */
  translationMap?: ReadonlyMap<number, string> | null;
  /** 译本文件本体（含句/词对齐表；译文模式内联高亮跨语言映射、对照模式中文侧镜像用） */
  translationFile?: PaperTranslationFile | null;
  /** 元数据译文（文档头中文标题，译文/对照模式优先） */
  translatedMeta?: PaperTranslatedMeta | null;
  /** 标注列表（includeAnnotations 时合并进文末标注节） */
  annotations?: BookNote[];
  mode: PaperExportMode;
  includeAnnotations: boolean;
  includeImages: boolean;
  format: PaperExportFormat;
}

export const PAPER_EXPORT_MODE_LABELS: Record<PaperExportMode, string> = {
  original: "原文",
  translated: "译文",
  bilingual: "逐段对照",
};

// ─── 图片处理 ───

/** markdown 图片引用（![alt](url) / ![alt](url "title")；与 paper-blocks.ts 口径一致） */
const IMAGE_REF_RE = /!\[[^\]]*\]\([^)]*\)/g;
const IMAGE_URL_RE = /^!\[[^\]]*\]\(([^)\s"]+)/;

/** 对照模式译文 div：内部图片引用是字面文本（原文块紧邻其上已带图），导出时清除 */
const TRANSLATION_DIV_RE = /(<div class="paper-translation" data-translation>)([\s\S]*?)(<\/div>)/g;

const IMAGE_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
};

function imageMime(url: string): string {
  const ext = url.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_MIME[ext] ?? "image/png";
}

/** 二进制 → base64（分块避免参数过多栈溢出） */
function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** 相对图片引用（images/...）→ data URI；读取失败/远程 URL 返回 null（调用方保留原引用） */
async function resolveImageDataUri(paperId: string, url: string): Promise<string | null> {
  if (/^(?:https?:|data:)/i.test(url)) return null;
  try {
    const path = await join(await appDataDir(), "books", paperId, url.replace(/^\.\//, ""));
    const bytes = await readFile(path);
    return `data:${imageMime(url)};base64,${base64Encode(bytes)}`;
  } catch (error) {
    console.warn(`导出论文：图片读取失败 ${url}:`, error);
    return null;
  }
}

/** markdown 文本中的本地图片引用批量替换为 data URI（每张图只读一次） */
async function embedImagesAsDataUris(doc: string, paperId: string): Promise<string> {
  const urls = new Set<string>();
  for (const match of doc.matchAll(IMAGE_REF_RE)) {
    const url = IMAGE_URL_RE.exec(match[0])?.[1];
    if (url && !/^(?:https?:|data:)/i.test(url)) urls.add(url);
  }
  if (urls.size === 0) return doc;
  const dataUris = new Map<string, string>();
  for (const url of urls) {
    const dataUri = await resolveImageDataUri(paperId, url);
    if (dataUri) dataUris.set(url, dataUri);
  }
  if (dataUris.size === 0) return doc;
  return doc.replace(IMAGE_REF_RE, (token) => {
    const url = IMAGE_URL_RE.exec(token)?.[1];
    const dataUri = url ? dataUris.get(url) : undefined;
    return dataUri && url ? token.replace(url, dataUri) : token;
  });
}

// ─── 文档构建 ───

/** 按文档位置（首个锚点 segment 块索引）排序标注，与侧栏口径一致 */
function annotationSortKey(note: BookNote): number {
  const anchor = note.cfi ? parseAnchor(note.cfi) : null;
  return anchor?.segments[0]?.b ?? Number.MAX_SAFE_INTEGER;
}

/** 译文 div 内图片引用清理（导出专用；原文块紧邻其上已带图，div 内是字面文本） */
function stripTranslationDivImageRefs(doc: string): string {
  return doc.replace(TRANSLATION_DIV_RE, (_match, open: string, content: string, close: string) => {
    return open + content.replace(IMAGE_REF_RE, "") + close;
  });
}

/** 模式化正文：视图重建 → 去 frontmatter → 译文 div 图片引用清理 → 按 includeImages 剔除图片引用 */
function buildPaperExportBody(params: PaperExportParams): string {
  const { markdown, translationMap, mode } = params;
  let viewMarkdown = markdown;
  if (mode !== "original" && translationMap) {
    // 对照模式分格式：markdown 导出走原生引用块（可编辑、公式保持 $...$），HTML 导出走译文 div（样式化）
    viewMarkdown =
      mode === "bilingual" && params.format === "markdown"
        ? buildPaperBilingualExportMarkdown(markdown, translationMap)
        : buildPaperViewMarkdown(markdown, translationMap, mode as Exclude<PaperViewMode, "original">);
  }
  const { body } = parsePaperMarkdown(viewMarkdown.replace(/\r\n?/g, "\n"));
  let exportBody = stripTranslationDivImageRefs(body);
  if (!params.includeImages) exportBody = exportBody.replace(IMAGE_REF_RE, "");
  return exportBody.trim();
}

/**
 * 构建导出用 markdown 文档：
 * frontmatter 原样保留 + 标题 H1（译文/对照模式优先中文标题）+ 模式化正文 + 可选标注节。
 * 图片按 includeImages 剔除或保留引用（内嵌 data URI 由导出步骤按格式处理）。
 */
export function buildPaperExportMarkdown(params: PaperExportParams): string {
  const { markdown, mode, annotations = [], includeAnnotations } = params;
  const normalized = markdown.replace(/\r\n?/g, "\n");
  const { metadata, body: originalBody } = parsePaperMarkdown(normalized);
  const head = normalized.slice(0, normalized.length - originalBody.length).trim();

  // 标题 H1：frontmatter 只有机器可读元数据，导出文档补一行可读标题
  const docTitle = (mode !== "original" && params.translatedMeta?.title_zh) || metadata.title || params.title;
  const sections = [head, `# ${docTitle}`, buildPaperExportBody(params)].filter(Boolean);

  if (includeAnnotations && annotations.length > 0) {
    const sorted = [...annotations].sort((a, b) => {
      const diff = annotationSortKey(a) - annotationSortKey(b);
      return diff !== 0 ? diff : a.createdAt - b.createdAt;
    });
    sections.push(`---\n\n## 标注（${sorted.length} 条）\n\n${sorted.map(renderAnnotationMarkdown).join("\n\n")}`);
  }

  return `${sections.join("\n\n")}\n`;
}

// ─── HTML 构建 ───

/** 论文正文样式补丁（EXPORT_HTML_CSS/EXPORT_ANNOTATIONS_CSS 已覆盖容器/卡片/表格/代码，此补标题层级/译文块/公式） */
const PAPER_EXPORT_CSS = `
  main h1, main h2, main h3, main h4, main h5, main h6 { line-height: 1.4; margin: 1.2em 0 0.5em; }
  main h1 { font-size: 1.5em; } main h2 { font-size: 1.3em; } main h3 { font-size: 1.15em; }
  main p, main ul, main ol { margin: 0.6em 0; }
  main ul, main ol { padding-left: 1.6em; }
  main li { margin: 0.2em 0; }
  .katex-display { overflow-x: auto; overflow-y: hidden; padding: 2px 0; }
  /* \tag 编号右对齐：渲染走 rehype-katex 内嵌 katex 0.16（.tag），自包含 CSS 来自 0.18（.katex-tag），双类名并写 */
  .katex-display > .katex > .katex-html > .tag,
  .katex-display > .katex > .katex-html > .katex-tag { position: absolute; right: 0; }
  .paper-translation { margin: 0.35em 0 1em; padding-left: 0.75em; border-left: 2px solid #d8cfc0;
                        color: #6b5c42; font-size: 0.92em; }
  .annotations-section { margin-top: 28px; padding-top: 16px; border-top: 1px solid #ddd3b8; }
  .annotations-section h2 { font-size: 18px; margin: 0 0 12px; }
  /* 标注内联高亮（颜色经 --pa-color 内联注入；pa-mark-tgt 为对照模式中文侧镜像，低透明） */
  .pa-mark { border-radius: 2px; padding: 0 1px; color: inherit; }
  .pa-mark-highlight { background: color-mix(in srgb, var(--pa-color) 35%, transparent); }
  .pa-mark-underline { background: none; text-decoration: underline 2px var(--pa-color); text-underline-offset: 2px; }
  .pa-mark-squiggly { background: none; text-decoration: underline wavy 1.5px var(--pa-color); text-underline-offset: 3px; }
  .pa-mark-tgt { opacity: 0.65; }
`;

/** 公式段 → KaTeX HTML（与 paper-blocks.ts renderTranslationHtml 同一容错语义：失败保留源码文本） */
function renderMathSegment(raw: string): string {
  const display = raw.startsWith("$$");
  const inner = display ? raw.slice(2, -2) : raw.slice(1, -1);
  try {
    return katex.renderToString(inner, { displayMode: display, throwOnError: true });
  } catch {
    return raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
}

/** 块级公式占位（<pre> 包裹）：pre 不在锚点块选择器内，保证导出 DOM 块枚举与阅读区一致（内联高亮的前提） */
const MATH_PLACEHOLDER_BLOCK_RE = /<pre>@@PAPER_MATH_(\d+)@@<\/pre>/g;
const MATH_PLACEHOLDER_RE = /@@PAPER_MATH_(\d+)@@/g;

/**
 * markdown → HTML：公式段先占位保护（防 marked 破坏 KaTeX HTML），渲染后换回。
 * 独占行的 $$...$$ 用 <pre> 占位（块级、不占锚点块序号；换回时连同 <pre> 一起替换），
 * 行内公式用纯文本占位（避免把所在段落拆成多个块）。
 */
function renderMarkdownHtml(doc: string): string {
  const mathSegments: string[] = [];
  const protectedDoc = doc.replace(MATH_SEGMENT_RE, (raw, offset: number) => {
    mathSegments.push(renderMathSegment(raw));
    const placeholder = `@@PAPER_MATH_${mathSegments.length - 1}@@`;
    const lineBefore = doc.slice(0, offset).split("\n").pop() ?? "";
    const lineAfter = doc.slice(offset + raw.length).split("\n")[0] ?? "";
    const blockLevel = raw.startsWith("$$") && lineBefore.trim() === "" && lineAfter.trim() === "";
    return blockLevel ? `<pre>${placeholder}</pre>` : placeholder;
  });
  return sanitizeHtml(marked.parse(protectedDoc, { async: false }))
    .replace(MATH_PLACEHOLDER_BLOCK_RE, (_m, i) => mathSegments[Number(i)] ?? "")
    .replace(MATH_PLACEHOLDER_RE, (_m, i) => mathSegments[Number(i)] ?? "");
}

// ─── 标注内联高亮（HTML 导出） ───

/** 标注笔触 → 导出 <mark> 类名（颜色走 --pa-color 内联变量，CSS 见 PAPER_EXPORT_CSS） */
const MARK_STYLE_CLASS: Record<HighlightStyle, string> = {
  highlight: "pa-mark-highlight",
  underline: "pa-mark-underline",
  squiggly: "pa-mark-squiggly",
};

interface DomPoint {
  node: Text;
  offset: number;
}

/** 单个元素内的待包裹区间（同元素内逆文档序应用，避免前次 split/wrap 使后续坐标失效） */
interface PendingMark {
  start: DomPoint;
  end: DomPoint;
  /** 元素 raw 坐标系的起点（元素内排序用） */
  rawStart: number;
  styleClass: string;
  colorHex: string;
  /** 中文侧镜像标记（对照模式；低透明样式） */
  mirror: boolean;
}

/** 在元素内用 <mark> 包裹 [start, end)：逐文本节点包裹（surroundContents 不跨界），失败静默跳过 */
function wrapMarkRange(doc: Document, containerEl: Element, mark: PendingMark): void {
  const range = doc.createRange();
  range.setStart(mark.start.node, mark.start.offset);
  range.setEnd(mark.end.node, mark.end.offset);
  const walker = doc.createTreeWalker(containerEl, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let node = walker.nextNode() as Text | null;
  while (node) {
    if (range.intersectsNode(node)) textNodes.push(node);
    node = walker.nextNode() as Text | null;
  }
  for (const textNode of textNodes) {
    const piece = doc.createRange();
    if (textNode === mark.start.node) piece.setStart(textNode, mark.start.offset);
    else piece.setStartBefore(textNode);
    if (textNode === mark.end.node) piece.setEnd(textNode, mark.end.offset);
    else piece.setEndAfter(textNode);
    if (piece.collapsed) continue;
    const el = doc.createElement("mark");
    el.className = mark.mirror ? `pa-mark pa-mark-tgt ${mark.styleClass}` : `pa-mark ${mark.styleClass}`;
    el.setAttribute("style", `--pa-color:${mark.colorHex}`);
    piece.surroundContents(el);
  }
}

/**
 * 把标注按锚点内联进导出 HTML（Markdown 格式天然无法表达高亮，仅 HTML 路线做）。
 * 锚点是"块索引 + 块 textContent 字符偏移"的 DOM 坐标（paper-anchors.ts），锚的永远是英文原文；
 * 按模式落到不同目标：
 * - 原文：英文块直接映射（公式感知换算：stored 源文坐标 ↔ 烘焙 KaTeX 的导出 DOM）；
 * - 译文：先经句/词对齐（mapSrcRangeToTgt，词级优先）把英文锚点映射为中文区间，再在译文块内定位；
 *   块未翻译（仍是英文）时回退英文直接映射；无对齐数据时静默跳过（文末标注节仍是完整事实源）；
 * - 对照：英文块内联 + 译文 div 中文镜像（低透明，同阅读区 -tgt 语义）。
 */
function applyAnnotationsInline(bodyHtml: string, params: PaperExportParams): string {
  const annotations = params.annotations ?? [];
  if (annotations.length === 0) return bodyHtml;
  const parsed = new DOMParser().parseFromString(
    `<body><div id="paper-export-root">${bodyHtml}</div></body>`,
    "text/html",
  );
  const container = parsed.querySelector("#paper-export-root");
  if (!container) return bodyHtml;
  const blockEls = listBlocks(container);
  const sourceBlocks = cutPaperBlocks(params.markdown);
  const translationBlocks = params.translationFile?.blocks ?? {};

  /** 收集一对待定位区间到 pending（坐标换算失败返回 false 跳过） */
  const pending = new Map<Element, PendingMark[]>();
  const collect = (
    targetEl: Element,
    normStoredText: string,
    s: number,
    e: number,
    markBase: Pick<PendingMark, "styleClass" | "colorHex" | "mirror">,
  ): boolean => {
    const normStored = normalizeMathText(normStoredText);
    const normLive = normalizeLiveElement(targetEl, "[data-translation]");
    const mapped =
      normStored.raw === normLive.raw ? { start: s, end: e } : mapSourceOffsetsToLive(normStored, normLive, s, e);
    if (!mapped || mapped.start >= mapped.end) return false;
    const start = charOffsetToPoint(targetEl, mapped.start);
    const end = charOffsetToPoint(targetEl, mapped.end);
    if (!start || !end) return false;
    const list = pending.get(targetEl) ?? [];
    list.push({ ...markBase, start, end, rawStart: mapped.start });
    pending.set(targetEl, list);
    return true;
  };

  /** 块对应的译文 div（对照模式）：li/td 内嵌于块内，p/heading/blockquote 为紧随的兄弟 */
  const translationDivOf = (blockEl: Element): Element | null => {
    const inner = blockEl.querySelector("[data-translation]");
    if (inner) return inner;
    const next = blockEl.nextElementSibling;
    return next?.matches("[data-translation]") ? next : null;
  };

  for (const annotation of annotations) {
    const anchor = annotation.cfi ? parseAnchor(annotation.cfi) : null;
    if (!anchor) continue;
    const styleClass = MARK_STYLE_CLASS[annotation.style ?? "highlight"];
    const colorHex = annotation.color ? HIGHLIGHT_COLOR_HEX[annotation.color] : HIGHLIGHT_COLOR_HEX.yellow;
    for (const segment of anchor.segments) {
      const blockEl = blockEls[segment.b];
      const sourceBlock = sourceBlocks[segment.b];
      if (!blockEl || !sourceBlock) continue;
      try {
        // 英文侧内联（原文/对照；译文模式仅当该块仍是英文时做回退）
        if (params.mode !== "translated") {
          collect(blockEl, sourceBlock.sourceText, segment.s, segment.e, { styleClass, colorHex, mirror: false });
        }
        // 中文侧（译文/对照镜像）：句词对齐把英文锚点映射为中文区间
        const translation = translationBlocks[String(segment.b)];
        if (params.mode !== "original" && translation) {
          const tgtEl = params.mode === "translated" ? blockEl : translationDivOf(blockEl);
          const tgtRanges =
            translation.align && translation.align.length > 0
              ? mapSrcRangeToTgt(translation.align, segment.s, segment.e, translation.alignW)
              : null;
          let mirrored = false;
          if (tgtEl && tgtRanges) {
            for (const range of tgtRanges) {
              mirrored =
                collect(tgtEl, translation.text, range.ts, range.te, {
                  styleClass,
                  colorHex,
                  mirror: params.mode === "bilingual",
                }) || mirrored;
            }
          }
          // 译文模式回退：无对齐/映射失败且块仍是英文原文（未翻译块）时直接英文映射
          if (params.mode === "translated" && !mirrored) {
            collect(blockEl, sourceBlock.sourceText, segment.s, segment.e, { styleClass, colorHex, mirror: false });
          }
        } else if (params.mode === "translated") {
          // 无译本块（未翻译）：块仍是英文，直接映射
          collect(blockEl, sourceBlock.sourceText, segment.s, segment.e, { styleClass, colorHex, mirror: false });
        }
      } catch (error) {
        console.warn("导出论文：标注内联映射失败，已跳过:", error);
      }
    }
  }

  // 同元素内逆文档序应用（后包裹的区间不影响前面区间的坐标）；单个失败不影响其余
  for (const [targetEl, marks] of pending) {
    for (const mark of [...marks].sort((a, b) => b.rawStart - a.rawStart)) {
      try {
        wrapMarkRange(parsed, targetEl, mark);
      } catch (error) {
        console.warn("导出论文：标注内联包裹失败，已跳过:", error);
      }
    }
  }
  return container.innerHTML;
}

/** 导出文档头：标题（译文/对照优先中文）+ 作者/期刊/日期/导出时间/模式/标注数 */
function buildPaperHeaderHtml(params: PaperExportParams, annotationCount: number): string {
  const { metadata } = parsePaperMarkdown(params.markdown.replace(/\r\n?/g, "\n"));
  const docTitle =
    (params.mode !== "original" && params.translatedMeta?.title_zh) || metadata.title || params.title || "未命名论文";
  const authors = normalizeAuthors(metadata.author).join(", ");
  const venue = [metadata["container-title"], metadata.date].filter(Boolean).join(" · ");
  const esc = (t: string) =>
    t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const metaItems = [
    authors && `<span>${esc(authors)}</span>`,
    venue && `<span>${esc(venue)}</span>`,
    `<span>导出时间：${dayjs().format("YYYY-MM-DD HH:mm:ss")}</span>`,
    `<span>内容：${PAPER_EXPORT_MODE_LABELS[params.mode]}</span>`,
    annotationCount > 0 && `<span>标注：${annotationCount} 条</span>`,
  ].filter(Boolean);
  return `<header>
    <h1>${esc(docTitle)}</h1>
    <div class="meta">${metaItems.join("\n      ")}</div>
  </header>`;
}

/**
 * 构建自包含单文件 HTML（样式/字体/图片全内联，无外部依赖）。
 * autoPrint 供 PDF 打印页：加载完成自动唤起浏览器打印（另存为 PDF）。
 * KaTeX 样式经动态 import 懒加载（字体 base64 约 400KB，不进主 chunk）。
 */
export async function buildPaperExportHtml(
  params: PaperExportParams,
  options?: { autoPrint?: boolean },
): Promise<string> {
  const annotations = params.includeAnnotations ? (params.annotations ?? []) : [];
  const sorted = [...annotations].sort((a, b) => {
    const diff = annotationSortKey(a) - annotationSortKey(b);
    return diff !== 0 ? diff : a.createdAt - b.createdAt;
  });

  // 正文 markdown（模式化正文，无 frontmatter/标题 H1/标注节——文档头已覆盖标题；图片按需内嵌）
  let body = buildPaperExportBody(params);
  if (params.includeImages) body = await embedImagesAsDataUris(body, params.paperId);
  let bodyHtml = renderMarkdownHtml(body);
  if (params.includeAnnotations) bodyHtml = applyAnnotationsInline(bodyHtml, params);

  const annotationsHtml =
    sorted.length > 0
      ? `<section class="annotations-section">
    <h2>标注（${sorted.length} 条）</h2>
${buildAnnotationsListHtml(sorted)}
  </section>`
      : "";

  const { buildInlineKatexCss } = await import("./export-paper-katex-css");
  const title = params.title || "未命名论文";

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</title>
<style>${buildInlineKatexCss()}</style>
<style>${EXPORT_HTML_CSS}${EXPORT_ANNOTATIONS_CSS}${PAPER_EXPORT_CSS}</style>
</head>
<body>
<div class="container">
  ${buildPaperHeaderHtml(params, sorted.length)}
  <main>
${bodyHtml}
  </main>
  ${annotationsHtml}
  <footer>由 Better SageRead 导出</footer>
</div>
${options?.autoPrint ? "<script>window.addEventListener('load', () => window.print());</script>" : ""}
</body>
</html>
`;
}

// ─── 导出入口 ───

/**
 * 按所选格式导出论文文档：
 * markdown/html 弹保存对话框写用户所选路径；pdf 写 appDataDir 打印页交系统浏览器另存。
 * 图片在写出前内嵌为 data URI（单文件自包含）。
 */
export async function exportPaperDocument(params: PaperExportParams): Promise<boolean> {
  try {
    const baseName = `${toSafeAnnotationFileName(params.title)}-${PAPER_EXPORT_MODE_LABELS[params.mode]}`;

    if (params.format === "markdown") {
      let doc = buildPaperExportMarkdown(params);
      if (params.includeImages) doc = await embedImagesAsDataUris(doc, params.paperId);
      const path = await save({
        defaultPath: `${baseName}.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!path) return false; // 用户取消保存，不视为失败
      await writeTextFile(path, doc);
      toast.success("论文导出成功");
      return true;
    }

    if (params.format === "html") {
      const path = await save({
        defaultPath: `${baseName}.html`,
        filters: [{ name: "HTML", extensions: ["html"] }],
      });
      if (!path) return false;
      const html = await buildPaperExportHtml(params);
      await writeTextFile(path, html);
      toast.success("论文导出成功");
      return true;
    }

    // PDF：打印版 HTML → 系统浏览器打开自动唤起打印（与标注 PDF 导出同路线）
    const html = await buildPaperExportHtml(params, { autoPrint: true });
    const printPath = await join(await appDataDir(), "paper-print.html");
    await writeTextFile(printPath, html);
    await openPath(printPath);
    toast.success("已在浏览器打开打印页，打印机选“另存为 PDF”即可", { duration: 6000 });
    return true;
  } catch (error) {
    console.error("导出论文失败:", error);
    toast.error("导出论文失败");
    return false;
  }
}
