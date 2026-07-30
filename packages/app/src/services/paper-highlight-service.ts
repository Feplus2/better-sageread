import { createModelInstance, getUtilityModel } from "@/ai/providers/factory";
import { type ParsedPaperSections, parsePaperSections } from "@/pages/paper-reader/markdown-sections";
import type { PaperHighlightLocation } from "@/pages/paper-reader/paper-highlight-locator";
import { parsePaperMarkdown } from "@/pages/paper-reader/paper-metadata";
import type { HighlightColor } from "@/types/book";
import { generateText } from "ai";

/**
 * C2「论文 AI 自动标亮」管线服务：类型判定 → 按类别模板抽取重点句（辅助模型，严格 JSON）。
 * 分类模板定死（颜色/分组/聚合都依赖稳定 taxonomy），模型只允许输出给定类别 id。
 * quote→锚点的本地换算在 paper-highlight-locator.ts（渲染 DOM 侧），本文件只到"拿到合法 quote 列表"为止。
 */

export type PaperKind = "research" | "review" | "report";

export const PAPER_KIND_LABELS: Record<PaperKind, string> = {
  research: "研究论文",
  review: "综述",
  report: "短篇报道",
};

export interface PaperHighlightCategoryDef {
  id: string;
  /** 类别中文名（分组标题、落库 note 的【】前缀） */
  label: string;
  /** 类别色（= 标注色，15 注册名内） */
  color: HighlightColor;
  /** prompt 里的类别说明（告诉模型抽什么） */
  hint: string;
}

export const PAPER_CATEGORY_TAXONOMY: Record<PaperKind, PaperHighlightCategoryDef[]> = {
  research: [
    { id: "goal", label: "研究目标", color: "yellow", hint: "研究要解决的问题、目标或假设" },
    { id: "methods", label: "研究方法", color: "blue", hint: "方法、模型、实验设计的关键描述" },
    { id: "results", label: "主要结果", color: "green", hint: "核心数据、对比结果、关键性能数字" },
    { id: "conclusions", label: "主要结论", color: "violet", hint: "作者总结出的主要结论" },
    { id: "innovations", label: "创新点", color: "red", hint: "声称的新贡献、首创方法、与已有工作的本质区别" },
  ],
  review: [
    { id: "scope", label: "范围与问题", color: "yellow", hint: "综述覆盖的范围、要梳理的核心问题" },
    { id: "taxonomy", label: "分类框架", color: "blue", hint: "对已有工作的分类体系/组织框架" },
    { id: "advances", label: "关键进展", color: "green", hint: "各领域方向上的代表性进展" },
    { id: "debates", label: "争议与开放问题", color: "red", hint: "学界争议、未解决的开放问题" },
    { id: "outlook", label: "未来方向", color: "violet", hint: "作者展望的未来研究方向" },
  ],
  report: [
    { id: "goal", label: "研究目标", color: "yellow", hint: "研究要解决的问题、目标" },
    { id: "results", label: "主要结果", color: "green", hint: "核心数据、观察到的主要现象" },
    { id: "conclusions", label: "主要结论", color: "violet", hint: "作者总结出的主要结论" },
  ],
};

/** 全部类别的展示字典（AI tab 分组标题/色点用；跨类型合并，id 唯一） */
export const PAPER_CATEGORY_DEFS: Record<string, PaperHighlightCategoryDef> = Object.values(PAPER_CATEGORY_TAXONOMY)
  .flat()
  .reduce<Record<string, PaperHighlightCategoryDef>>((map, def) => {
    map[def.id] = def;
    return map;
  }, {});

/** 分组排序：跨类型全局固定顺序（未知类别排最后） */
export const PAPER_CATEGORY_ORDER: string[] = [
  "goal",
  "methods",
  "results",
  "conclusions",
  "innovations",
  "scope",
  "taxonomy",
  "advances",
  "debates",
  "outlook",
];

/** AI 返回的一条重点句（category 已校验属于当前模板） */
export interface RawAiHighlight {
  category: string;
  quote: string;
  note?: string;
}

/** 成功换算锚点、待落库的一条 AI 标注 */
export interface LocatedAiHighlight {
  category: string;
  note?: string;
  location: PaperHighlightLocation;
}

export interface GenerateHighlightsResult {
  /** 实际使用的论文类型（auto 时为判定结果） */
  kind: PaperKind;
  /** 模型返回的合法条目数 */
  total: number;
  /** 成功定位（锚点换算 + 去重后）的条目 */
  located: LocatedAiHighlight[];
}

/** 落库 note 的统一格式：【类别中文名】可选说明（便于任何界面识别 AI 标注类别） */
export function formatAiAnnotationNote(category: string, note?: string): string {
  const label = PAPER_CATEGORY_DEFS[category]?.label ?? category;
  return note ? `【${label}】${note}` : `【${label}】`;
}

/** 取辅助模型（未配置时回落当前聊天模型；都没有则抛错引导去设置） */
function requireUtilityModel() {
  const utilityModel = getUtilityModel();
  if (!utilityModel) {
    throw new Error("没有可用的 AI 模型，请先在设置中配置辅助模型或聊天模型");
  }
  return utilityModel;
}

/** 辅助模型一次 generateText 调用，错误归一化为可读中文 */
async function callUtilityModel(prompt: string, temperature: number): Promise<string> {
  try {
    const model = requireUtilityModel();
    const modelInstance = createModelInstance(model.providerId, model.modelId);
    const { text } = await generateText({ model: modelInstance, prompt, temperature });
    return text;
  } catch (error) {
    console.error("AI 重点标注调用失败:", error);
    if (error instanceof Error) {
      if (error.message.includes("API key") || error.message.includes("apikey")) {
        throw new Error("AI 服务配置错误：请检查 API 密钥设置");
      }
      if (error.message.includes("quota") || error.message.includes("limit")) {
        throw new Error("AI 服务额度不足：请检查账户余额或使用限制");
      }
      if (error.message.includes("没有可用的 AI 模型")) throw error;
      throw new Error(`AI 调用失败: ${error.message}`);
    }
    throw new Error("AI 调用失败: 未知错误");
  }
}

/**
 * 类型判定：一次辅助模型调用，输入标题/摘要/章节标题，输出 research/review/report。
 * 输出无法识别时拿不准归 research（默认模板）。
 */
export async function classifyPaperKind(markdown: string): Promise<PaperKind> {
  const { metadata } = parsePaperMarkdown(markdown);
  const { body, headings } = parsePaperSections(markdown);
  const headingList = headings
    .slice(0, 30)
    .map((h) => h.text)
    .join("；");
  const prompt = `你是学术论文分析助手。请判断下面这篇文献的类型，只回答三种之一：research（原创研究论文）、review（综述/元分析）、report（短篇报道/通讯/简报）。

标题：${metadata.title ?? "未知"}
摘要：${(metadata.abstract ?? body.slice(0, 800)).slice(0, 1200)}
章节标题：${headingList || "无"}

判断线索：综述通常标题含 review/survey/progress 或通篇梳理他人工作；短篇报道篇幅很短、章节很少；其余归 research。
只输出一个单词（research / review / report），不要输出任何其他内容。`;

  const text = (await callUtilityModel(prompt, 0)).trim().toLowerCase();
  if (text.includes("review")) return "review";
  if (text.includes("report")) return "report";
  return "research";
}

/** 单段正文超过该字符数时按一级 heading 切段分次调用（≈15k token 以内一次） */
const CHUNK_CHAR_LIMIT = 40_000;

/**
 * 超长论文按一级 heading 切段（无一级 heading 退化二级；再没有就整段一次调用），
 * 相邻小节合并进同一 chunk，控制每段 ≤ CHUNK_CHAR_LIMIT（单节自身超限则独立成段尽力而为）。
 */
export function splitBodyIntoChunks(parsed: ParsedPaperSections): string[] {
  const { body, headings } = parsed;
  if (body.length <= CHUNK_CHAR_LIMIT) return [body];
  const level1 = headings.filter((h) => h.level === 1);
  const cuts = level1.length > 0 ? level1 : headings.filter((h) => h.level === 2);
  if (cuts.length === 0) return [body];

  const sections: string[] = [];
  if (cuts[0].start > 0) sections.push(body.slice(0, cuts[0].start));
  for (let i = 0; i < cuts.length; i++) {
    const end = i + 1 < cuts.length ? cuts[i + 1].start : body.length;
    sections.push(body.slice(cuts[i].start, end));
  }

  const chunks: string[] = [];
  let current = "";
  for (const section of sections) {
    if (current && current.length + section.length > CHUNK_CHAR_LIMIT) {
      chunks.push(current);
      current = section;
    } else {
      current += section;
    }
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}

function buildExtractPrompt(chunk: string, kind: PaperKind, chunked: boolean): string {
  const categories = PAPER_CATEGORY_TAXONOMY[kind];
  const categoryLines = categories.map((c) => `- ${c.id} = ${c.label}：${c.hint}`).join("\n");
  return `你是学术文本分析助手。请从下面的${PAPER_KIND_LABELS[kind]}正文中，按给定类别抽取最重要的句子。

类别（id = 中文名：抽取什么）：
${categoryLines}

要求：
1. quote 必须逐字摘自给定文本：不得改写、翻译、增删字符，保持原有标点、大小写与公式写法
2. 每个类别 1-4 条；确实没有合适内容的类别可以不出现在结果中
3. 每条 quote 为 1-2 个完整句子，不超过 200 个字符，选择能独立成立、信息量高的句子
4. 摘录应覆盖文本的不同部分，不要集中在开头
5. 同等信息量下优先选择不含 $...$ 公式或表格符号的句子（纯文字句子更便于在正文中定位）
6. note 可选：一句话说明该句为何重要（中文，不超过 50 字）；不必要时不给
7. 只输出严格 JSON 数组，不要输出任何解释、Markdown 或代码围栏

输出格式：
[{"category":"${categories[0].id}","quote":"……","note":"……"}]
${chunked ? "\n（本文按章节切分后分次处理，以下只是其中一部分，请只从这部分摘录。）\n" : ""}
${PAPER_KIND_LABELS[kind]}正文：
"""
${chunk}
"""`;
}

/**
 * 解析模型输出为合法条目：剥离代码围栏、截取首个 JSON 数组；
 * 类别不在当前模板内、quote 缺失/过短/超长的条目丢弃（由调用方计数）。
 */
export function parseAiHighlightsJson(text: string, kind: PaperKind): RawAiHighlight[] {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const validIds = new Set(PAPER_CATEGORY_TAXONOMY[kind].map((c) => c.id));
  const items: RawAiHighlight[] = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object") continue;
    const { category, quote, note } = raw as Record<string, unknown>;
    if (typeof category !== "string" || !validIds.has(category)) continue;
    if (typeof quote !== "string") continue;
    const trimmedQuote = quote.trim();
    if (trimmedQuote.length < 10 || trimmedQuote.length > 600) continue;
    const trimmedNote = typeof note === "string" ? note.trim() : "";
    items.push({ category, quote: trimmedQuote, note: trimmedNote || undefined });
  }
  return items;
}

/** 模板抽取：整篇一次调用；超长按 heading 切段分次调用后合并 */
export async function extractPaperHighlights(markdown: string, kind: PaperKind): Promise<RawAiHighlight[]> {
  const parsed = parsePaperSections(markdown);
  const chunks = splitBodyIntoChunks(parsed);
  const all: RawAiHighlight[] = [];
  for (const chunk of chunks) {
    const text = await callUtilityModel(buildExtractPrompt(chunk, kind, chunks.length > 1), 0.2);
    all.push(...parseAiHighlightsJson(text, kind));
  }
  return all;
}

/**
 * 完整管线（不含落库）：类型判定（auto 时）→ 模板抽取 → 本地锚点换算（调用方注入的 locateQuotes，
 * 依赖渲染 DOM）→ 按 cfi 去重。返回 total（模型合法条目数）与 located（成功定位条目），
 * 丢弃数 = total - located.length，由调用方上报。
 */
export async function generatePaperHighlights(options: {
  markdown: string;
  kind: PaperKind | "auto";
  locateQuotes: (quotes: string[]) => (PaperHighlightLocation | null)[];
}): Promise<GenerateHighlightsResult> {
  const kind = options.kind === "auto" ? await classifyPaperKind(options.markdown) : options.kind;
  const items = await extractPaperHighlights(options.markdown, kind);
  const locations = options.locateQuotes(items.map((item) => item.quote));

  const seen = new Set<string>();
  const located: LocatedAiHighlight[] = [];
  items.forEach((item, index) => {
    const location = locations[index];
    if (!location || seen.has(location.cfi)) return;
    seen.add(location.cfi);
    located.push({ category: item.category, note: item.note, location });
  });
  return { kind, total: items.length, located };
}
