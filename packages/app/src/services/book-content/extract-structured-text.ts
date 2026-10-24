/**
 * 书籍章节 DOM → 结构化文本（Agent 内容保真层）：
 * - <math> → LaTeX（TeX annotation 优先，其次 mathml-to-latex；失败回退原样 MathML）
 * - <table> → Markdown 表格（单元格按 inline 结构化序列化，保留公式与图片）
 * - 块级边界 → 换行；图片 → ![alt](src)
 * 转换器残留裸 LaTeX（\(...\) / \[...\]）本就是精确源码，原样保留。
 */
import { MathMLToLaTeX } from "mathml-to-latex";

const BLOCK_TAGS = new Set([
  "p",
  "div",
  "section",
  "article",
  "chapter",
  "blockquote",
  "pre",
  "figure",
  "figcaption",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "tr",
  "hr",
  "dt",
  "dd",
]);

/** MathML 的 TeX annotation 优先，alttext 兜底；翻译与 Agent 读取共用。 */
export function mathTexOf(el: Element): { tex: string; display: boolean } | null {
  const annotation = Array.from(el.querySelectorAll("annotation")).find((item) =>
    (item.getAttribute("encoding") ?? "").toLowerCase().includes("tex"),
  );
  const tex = (annotation?.textContent ?? el.getAttribute("alttext") ?? "").trim();
  if (!tex) return null;
  return { tex, display: el.getAttribute("display") === "block" };
}

/** 有 TeX 源时输出紧凑定界符；无 TeX 源返回 null，让调用方选择 MathML 反解或原样回退。 */
export function serializeMathElement(el: Element): string | null {
  const math = mathTexOf(el);
  if (!math) return null;
  return math.display ? `$$${math.tex}$$` : `$${math.tex}$`;
}

/** math 元素 → LaTeX 文本；display 决定 $ 还是 $$ 包裹 */
export function mathElementToLatex(math: Element, display: boolean): string {
  const source = mathTexOf(math);
  if (source) return display ? `\n$$\n${source.tex}\n$$\n` : `$${source.tex}$`;
  try {
    const latex = MathMLToLaTeX.convert(math.outerHTML);
    if (latex?.trim()) return display ? `\n$$\n${latex.trim()}\n$$\n` : `$${latex.trim()}$`;
  } catch {
    /* fall through */
  }
  // 回退：原样 MathML（精确但啰嗦）——绝不出扁平文本
  return display ? `\n[MathML] ${math.outerHTML}\n` : math.outerHTML;
}

function imageElementToMarkdown(img: Element): string {
  const alt = (img.getAttribute("alt") ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\\/g, "\\\\")
    .replace(/([\[\]])/g, "\\$1");
  const src = (img.getAttribute("src") ?? "").trim();
  const destination = /[\s()]/.test(src) ? `<${src.replace(/</g, "%3C").replace(/>/g, "%3E")}>` : src;
  return `![${alt}](${destination})`;
}

/** 表格单元格只允许 inline 内容，避免 display 公式或 <br> 破坏 Markdown 行。 */
function inlineStructuredText(root: Element): string {
  let out = "";
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.nodeValue ?? "";
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    const tag = el.localName?.toLowerCase() ?? "";
    if (tag === "script" || tag === "style" || tag === "head" || tag === "title") return;
    if (tag === "math") {
      out += mathElementToLatex(el, false);
      return;
    }
    if (tag === "img") {
      out += ` ${imageElementToMarkdown(el)} `;
      return;
    }
    if (tag === "br") {
      out += " ";
      return;
    }
    for (const child of Array.from(el.childNodes)) walk(child);
  };
  walk(root);
  return out.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
}

/** HTMLTableElement → Markdown 表格；colspan/rowspan 近似展开（跨格重复内容不补，留空位）。 */
export function tableToMarkdown(table: HTMLTableElement): string {
  const tableRows = Array.from(table.rows);
  const rows: string[][] = [];
  const occupied = new Set<string>();
  let maxCols = 0;
  for (const [rowIndex, tr] of tableRows.entries()) {
    rows[rowIndex] ??= [];
    const row = rows[rowIndex];
    let column = 0;
    for (const cell of Array.from(tr.cells)) {
      while (occupied.has(`${rowIndex}:${column}`)) column += 1;
      const colSpan = Math.max(cell.colSpan || 1, 1);
      const rowSpan = Math.max(cell.rowSpan || 1, 1);
      row[column] = inlineStructuredText(cell);
      for (let c = column + 1; c < column + colSpan; c++) row[c] = "";
      for (let r = rowIndex + 1; r < Math.min(tableRows.length, rowIndex + rowSpan); r++) {
        rows[r] ??= [];
        const future = rows[r];
        for (let c = column; c < column + colSpan; c++) {
          occupied.add(`${r}:${c}`);
          future[c] = "";
        }
      }
      column += colSpan;
      maxCols = Math.max(maxCols, column);
    }
  }
  if (rows.length === 0 || maxCols === 0) return "";
  const norm = (row: string[]) => Array.from({ length: maxCols }, (_, index) => row[index] ?? "");
  const head = norm(rows[0]);
  const lines = [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.slice(1).map((row) => `| ${norm(row).join(" | ")} |`),
  ];
  return `\n${lines.join("\n")}\n`;
}

export interface StructuredExtract {
  text: string;
  /** 抽取文本的总字符数（未应用偏移/上限之前） */
  totalChars: number;
}

/**
 * 从 startElement（含自身；null 则从 body 起）按文档序抽取结构化文本。
 * 一次走完全文，由调用方做 offset/cap——totalChars/nextOffset 才能精确。
 */
export function extractStructuredText(doc: Document, startElement: Element | null): StructuredExtract {
  const root = startElement ?? doc.body;
  if (!root) return { text: "", totalChars: 0 };
  const parts: string[] = [];
  let lastBlockEnded = false;

  const pushText = (t: string) => {
    if (!t) return;
    parts.push(t);
    lastBlockEnded = false;
  };
  const pushBlockBreak = () => {
    if (lastBlockEnded) return;
    parts.push("\n");
    lastBlockEnded = true;
  };

  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      pushText(node.nodeValue ?? "");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    const tag = el.localName?.toLowerCase() ?? "";
    if (tag === "script" || tag === "style" || tag === "head" || tag === "title") return;

    if (tag === "math") {
      const display = el.getAttribute("display") === "block";
      if (display) pushBlockBreak();
      pushText(mathElementToLatex(el, display));
      if (display) pushBlockBreak();
      return;
    }
    if (tag === "table") {
      pushBlockBreak();
      pushText(tableToMarkdown(el as HTMLTableElement));
      pushBlockBreak();
      return;
    }
    if (tag === "img") {
      pushText(` ${imageElementToMarkdown(el)} `);
      return;
    }
    if (tag === "br") {
      pushBlockBreak();
      return;
    }

    const isBlock = BLOCK_TAGS.has(tag);
    if (isBlock) pushBlockBreak();
    for (const child of Array.from(el.childNodes)) walk(child);
    if (isBlock) pushBlockBreak();
  };

  // 起点元素自身走完后，沿祖先链依次走"之后的兄弟"——即从起点到文档末尾的全部内容
  walk(root);
  let anc: Node | null = root;
  while (anc && anc !== doc.body) {
    let sib = anc.nextSibling;
    while (sib) {
      walk(sib);
      sib = sib.nextSibling;
    }
    anc = anc.parentNode;
  }

  const text = parts
    .join("")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n+ */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, totalChars: text.length };
}

/**
 * 选区 Range → 结构化文本（划词引用路径）：克隆选区内容，math 元素原位替换为
 * LaTeX 文本后取文本——小片段专用，不做块级换行规整（引用应保持选区原貌）。
 * 无 math 时返回 null（调用方走原有的 getTextFromRange 扁平路径即可）。
 */
export function rangeToStructuredText(range: Range): string | null {
  const frag = range.cloneContents();
  const maths: Element[] = [...frag.querySelectorAll("math")];
  // 选区边界本身可能就是一个 math 元素（用户整选单个公式）
  const startEl = range.startContainer.nodeType === 1 ? (range.startContainer as Element) : null;
  if (startEl?.localName?.toLowerCase() === "math") maths.unshift(startEl);
  // 带原始 LaTeX 的元素：KaTeX 包装块（书籍 rawmath）/ 论文 math 容器（rehypeMathSourceAttr）
  const rawmaths = [...frag.querySelectorAll("[data-latex]")];
  if (startEl?.classList?.contains("sageread-rawmath") && startEl.getAttribute("data-latex")) rawmaths.unshift(startEl);
  if (maths.length === 0 && rawmaths.length === 0) return null;
  for (const m of maths) {
    const latex = mathElementToLatex(m, m.getAttribute("display") === "block");
    m.replaceWith(m.ownerDocument.createTextNode(latex));
  }
  for (const el of rawmaths) {
    const tex = el.getAttribute("data-latex") ?? "";
    if (tex) {
      const isDiv = el.localName?.toLowerCase() === "div";
      el.replaceWith(el.ownerDocument.createTextNode(isDiv ? `\n$$\n${tex}\n$$\n` : ` $${tex}$ `));
    }
  }
  return frag.textContent ?? null;
}
