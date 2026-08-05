import { tool } from "ai";
import { z } from "zod";
import { readPaperMarkdown } from "./shared";

/** getCitations 返回的参考文献文本整体上限（字符），超出截断并标注 */
const MAX_CITATIONS_CHARS = 8000;
/** getFigures 返回的图片条数上限 */
const MAX_FIGURES = 50;

/** 标题行匹配：返回 { level, text } 或 null */
function matchHeading(line: string): { level: number; text: string } | null {
  const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
  if (!m) return null;
  return { level: m[1].length, text: m[2] };
}

/** 判断标题是否为参考文献小节（References / 参考文献，大小写不敏感） */
function isReferencesHeading(text: string): boolean {
  const t = text.trim().toLowerCase();
  return /^references\b/.test(t) || t.includes("参考文献");
}

/** 把参考文献小节的文本按空行/编号行拆成条目 */
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
    // 编号行（[1] / 1. / 1) / - 开头）开启新条目
    if (/^(?:\[\d+\]|\d+[.)]|-)\s+/.test(trimmed)) {
      flush();
    }
    current.push(trimmed);
  }
  flush();
  return entries;
}

/** 提取当前论文的参考文献列表（基础层工具，直接读 paper.md，无需向量能力） */
export const createGetCitationsTool = (paperId: string | undefined) =>
  tool({
    description: `提取当前论文的参考文献（References / 参考文献小节）列表。

📖 **使用场景**：
• 用户问"这篇论文引用了哪些文献""参考文献里有没有某某的工作"
• 需要基于参考文献做文献溯源、相关工作梳理时

📊 **返回内容**：
{heading, entries[], total, truncated}；整体超过 ${MAX_CITATIONS_CHARS} 字符会截断并标注

⚠️ **什么时候别用**：
• 用户问的是正文内容而非参考文献——用 readPaperSection
• 论文没有 References / 参考文献标题时会返回明确提示，不要反复重试`,
    inputSchema: z.object({
      reasoning: z.string().min(1).describe("调用此工具的原因和目的，例如：'用户想查看这篇论文的参考文献'"),
    }),
    execute: async ({ reasoning }: { reasoning: string }) => {
      if (!paperId) {
        throw new Error("未找到当前论文，请先在文献库中打开一篇论文");
      }

      const markdown = await readPaperMarkdown(paperId);
      const lines = markdown.split("\n");

      // 定位参考文献标题，取其到下一同级或更高级标题之间的文本
      let start = -1;
      let startLevel = 0;
      let headingText = "";
      for (let i = 0; i < lines.length; i++) {
        const h = matchHeading(lines[i]);
        if (h && isReferencesHeading(h.text)) {
          start = i;
          startLevel = h.level;
          headingText = h.text;
          break;
        }
      }
      if (start < 0) {
        return {
          found: false,
          message: "未在论文中找到 References / 参考文献 标题，该论文的 Markdown 可能不含独立参考文献小节",
          meta: { reasoning },
        };
      }

      let end = lines.length;
      for (let i = start + 1; i < lines.length; i++) {
        const h = matchHeading(lines[i]);
        if (h && h.level <= startLevel) {
          end = i;
          break;
        }
      }

      const block = lines
        .slice(start + 1, end)
        .join("\n")
        .trim();
      const entries = splitCitationEntries(block);
      const full = entries.map((e, i) => `${i + 1}. ${e}`).join("\n");
      const truncated = full.length > MAX_CITATIONS_CHARS;

      return {
        found: true,
        heading: headingText,
        total: entries.length,
        content: truncated
          ? `${full.slice(0, MAX_CITATIONS_CHARS)}\n……（参考文献过长，已截断，完整长度 ${full.length} 字符）`
          : full,
        truncated,
        meta: { reasoning },
      };
    },
  });

/** 提取当前论文的图片清单（基础层工具，直接读 paper.md，无需向量能力） */
export const createGetFiguresTool = (paperId: string | undefined) =>
  tool({
    description: `提取当前论文中的图片清单（含图注与所在小节）。

📖 **使用场景**：
• 用户问"这篇论文有哪些图""图 X 在哪里/讲什么"
• 需要定位某个图表所在小节时

📊 **返回内容**：
[{image, caption, captionFrom, section}]，最多 ${MAX_FIGURES} 条。
captionFrom 标注图注来源："alt"=Markdown 图片 alt；"block"=图片下方正文里的图注段落（Figure N. / 图 N 开头）；null=没找到图注。
message 会报告游离图注数（有编号文本但附近没有图片，可能是图丢失的残注）。

⚠️ **什么时候别用**：
• 用户想理解某张图的具体内容——本工具只返回路径与图注，不能"看"图；应结合 readPaperSection 读图注附近的正文`,
    inputSchema: z.object({
      reasoning: z.string().min(1).describe("调用此工具的原因和目的，例如：'用户想浏览论文中的所有图片'"),
    }),
    execute: async ({ reasoning }: { reasoning: string }) => {
      if (!paperId) {
        throw new Error("未找到当前论文，请先在文献库中打开一篇论文");
      }

      const markdown = await readPaperMarkdown(paperId);
      const lines = markdown.split("\n");

      // 图注段落："Figure 1:" / "Fig. 1." / "图 1" / "表2" / "Table 3" 等编号开头
      const CAPTION_RE = /^(?:figure|fig|table|图|表)\s*[.．:：]?\s*[（(]?\d+/i;
      // 多图版的分版标号行："A" / "(a)" / "B"
      const PANEL_RE = /^[（(]?[A-Za-z][)）]?$/;
      // 只含图片语法的行（多图版中间夹的图片行，向后找图注时跳过）
      const IMG_ONLY_RE = /^\s*(!\[[^\]]*\]\([^)]*\)\s*)+$/;
      const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

      const figures: { image: string; caption: string; captionFrom: "alt" | "block" | null; section: string | null }[] =
        [];
      const usedCaptionLines = new Set<number>();
      let lastHeading: string | null = null;
      let truncated = false;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const h = matchHeading(line);
        if (h) {
          lastHeading = h.text;
          continue;
        }
        const imgRe = /!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g;
        let m: RegExpExecArray | null;
        // biome-ignore lint/suspicious/noAssignInExpressions: 正则迭代惯用法
        while ((m = imgRe.exec(line)) !== null) {
          const src = m[2];
          if (!/(^|\/)images\//.test(src)) continue;
          if (figures.length >= MAX_FIGURES) {
            truncated = true;
            break;
          }
          const alt = collapse(m[1]);
          let caption = alt;
          let captionFrom: "alt" | "block" | null = alt ? "alt" : null;
          // alt 缺失或只是编号标签（"Figure 1"、"图2 (a)"，≤20 字符）时，向后找正文图注段落：
          // 跳过空行/分版标号/纯图片行，命中首个编号开头的文本行；遇到标题或非图注文本行停止
          const labelOnly = alt.length <= 20 && CAPTION_RE.test(alt);
          if (!alt || labelOnly) {
            for (let j = i + 1; j <= Math.min(i + 8, lines.length - 1); j++) {
              if (matchHeading(lines[j])) break;
              const probe = lines[j].trim();
              if (!probe || PANEL_RE.test(probe) || IMG_ONLY_RE.test(probe)) continue;
              if (CAPTION_RE.test(probe)) {
                caption = collapse(probe);
                captionFrom = "block";
                usedCaptionLines.add(j);
              }
              break;
            }
          }
          figures.push({ image: src, caption, captionFrom, section: lastHeading });
        }
        if (truncated) break;
      }

      // 游离图注：编号开头但未被任何图片用作图注的文本行（converter 图丢失/图组拆散的残注）
      let orphanCaptions = 0;
      for (let i = 0; i < lines.length; i++) {
        const probe = lines[i].trim();
        if (CAPTION_RE.test(probe) && !usedCaptionLines.has(i)) orphanCaptions += 1;
      }

      return {
        total: figures.length,
        truncated,
        figures,
        orphanCaptions,
        message:
          figures.length === 0
            ? "论文中没有找到 images/ 目录下的图片"
            : `共找到 ${figures.length} 张图片${truncated ? `（已达 ${MAX_FIGURES} 条上限，可能还有更多）` : ""}${
                orphanCaptions > 0 ? `；另有 ${orphanCaptions} 段游离图注未关联到图片` : ""
              }`,
        meta: { reasoning },
      };
    },
  });
