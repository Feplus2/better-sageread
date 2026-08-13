import type { Transformer } from "./types";

/**
 * rawmath：把 EPUB XHTML 文本节点里残留的 LaTeX 源码（\(...\) 与 \[...\]）就地替换为 KaTeX 渲染 HTML。
 *
 * 背景：Books_Converter 的行内公式识别会跳过含 `<`（XHTML 中为 &lt;）的片段，转换产物里留下
 * 整段裸 LaTeX 源码（单本书实测 304 处行内 + 9 处行间），阅读器此前原样展示源码。
 *
 * 走字符串级处理而非 DOMParser 往返：正规 XHTML 文本中的 < 必然转义为 &lt;，因此按 < 切分
 * 标签/文本是可靠的；而 DOMParser 对含 &nbsp; 等未声明实体的 EPUB 会直接 parsererror，不可用。
 * 转换发生在章节 XHTML 进 iframe 之前（transformTarget data 管线），文档天生就是渲染好的，
 * epubcfi/标注的 DOM 序号不受运行时改写影响。
 */

// 懒加载：katex 本体与自包含样式（约 400KB 字体 data URI）只在真遇到裸公式时才付出成本
let katexPromise: Promise<typeof import("katex")> | null = null;
function loadKatex() {
  if (!katexPromise) katexPromise = import("katex");
  return katexPromise;
}

let cssPromise: Promise<typeof import("@/lib/export-paper-katex-css")> | null = null;
function loadCss() {
  if (!cssPromise) cssPromise = import("@/lib/export-paper-katex-css");
  return cssPromise;
}

const KATEX_STYLE_ID = "sageread-rawmath-katex";

/** 这些元素内部不扫描：代码类内容与已渲染的 MathML（含 m:math 命名空间前缀） */
const SKIP_LOCAL_NAMES = new Set(["script", "style", "code", "pre", "textarea", "math"]);

/** XML 反转义：&amp; 必须最后处理（&amp;lt; 表示字面 &lt; 文本） */
function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number.parseInt(d, 10)))
    .replace(/&amp;/g, "&");
}

/** 文本片段内的 \(...\) / \[...\] → KaTeX HTML；无配对收尾的裸定界符原样保留 */
function transformText(text: string, katex: typeof import("katex").default): { out: string; changed: boolean } {
  let out = "";
  let changed = false;
  let i = 0;
  while (i < text.length) {
    const inlineIdx = text.indexOf("\\(", i);
    const displayIdx = text.indexOf("\\[", i);
    let start = -1;
    let close = "";
    let display = false;
    if (inlineIdx !== -1 && (displayIdx === -1 || inlineIdx < displayIdx)) {
      start = inlineIdx;
      close = "\\)";
    } else if (displayIdx !== -1) {
      start = displayIdx;
      close = "\\]";
      display = true;
    }
    if (start === -1) {
      out += text.slice(i);
      break;
    }
    const bodyStart = start + 2;
    const end = text.indexOf(close, bodyStart);
    // 体内又出现开定界符：说明前一个开界定符本就是裸的（转换器残次），越过它让后者自己配对
    if (end === -1 || text.slice(bodyStart, end).includes("\\(") || text.slice(bodyStart, end).includes("\\[")) {
      out += text.slice(i, bodyStart);
      i = bodyStart;
      continue;
    }
    out += text.slice(i, start);
    const tex = unescapeXml(text.slice(bodyStart, end)).trim();
    let html: string | null = null;
    if (tex) {
      try {
        html = katex.renderToString(tex, { displayMode: display, throwOnError: false, strict: "ignore" });
      } catch {
        html = null;
      }
    }
    if (html) {
      // KaTeX 输出实测无具名实体/裸 <，XHTML 安全（strict XML 解析不炸）
      out += display ? `<div class="sageread-rawmath">${html}</div>` : `<span class="sageread-rawmath">${html}</span>`;
      changed = true;
    } else {
      out += text.slice(start, end + 2);
    }
    i = end + 2;
  }
  return { out, changed };
}

/** 扫描 XHTML：标签/注释/CDATA 原样跳过，skip 元素整体跳过，仅处理文本区 */
function transformXhtml(content: string, katex: typeof import("katex").default): { out: string; changed: boolean } {
  let out = "";
  let changed = false;
  let i = 0;
  const n = content.length;

  while (i < n) {
    const lt = content.indexOf("<", i);
    if (lt === -1) {
      const t = transformText(content.slice(i), katex);
      out += t.out;
      changed ||= t.changed;
      break;
    }
    if (lt > i) {
      const t = transformText(content.slice(i, lt), katex);
      out += t.out;
      changed ||= t.changed;
    }
    if (content.startsWith("<!--", lt)) {
      const end = content.indexOf("-->", lt + 4);
      const stop = end === -1 ? n : end + 3;
      out += content.slice(lt, stop);
      i = stop;
      continue;
    }
    if (content.startsWith("<![CDATA[", lt)) {
      const end = content.indexOf("]]>", lt + 9);
      const stop = end === -1 ? n : end + 3;
      out += content.slice(lt, stop);
      i = stop;
      continue;
    }
    const gt = content.indexOf(">", lt + 1);
    if (gt === -1) {
      out += content.slice(lt);
      break;
    }
    const tag = content.slice(lt, gt + 1);
    out += tag;
    i = gt + 1;

    // 开标签且属于 skip 名单：整体跳到对应闭标签之后（嵌套同名元素在实践中不存在）
    const m = /^<([a-zA-Z][\w:.-]*)/.exec(tag);
    if (m && !tag.endsWith("/>")) {
      const local = m[1].split(":").pop()!.toLowerCase();
      if (SKIP_LOCAL_NAMES.has(local)) {
        const closeRe = new RegExp(`</${m[1]}\\s*>`, "i");
        const closeM = closeRe.exec(content.slice(i));
        if (closeM) {
          out += content.slice(i, i + closeM.index + closeM[0].length);
          i += closeM.index + closeM[0].length;
        } else {
          out += content.slice(i);
          i = n;
        }
      }
    }
  }
  return { out, changed };
}

export const rawmathTransformer: Transformer = {
  name: "rawmath",

  transform: async (ctx) => {
    const content = ctx.content;
    // 快路径：没有定界符直接返回（连 katex 模块都不加载）
    if (!content.includes("\\(") && !content.includes("\\[")) return content;

    const [{ default: katex }, { buildInlineKatexCss }] = await Promise.all([loadKatex(), loadCss()]);
    const { out, changed } = transformXhtml(content, katex);
    if (!changed) return content;

    // 命中过裸公式的章节注入自包含 KaTeX 样式（iframe 文档不继承外层 index.css；字体走 data URI 无外部请求）
    const style = `<style id="${KATEX_STYLE_ID}" type="text/css"><![CDATA[${buildInlineKatexCss()}]]></style>`;
    const headClose = out.search(/<\/head\s*>/i);
    return headClose === -1 ? style + out : out.slice(0, headClose) + style + out.slice(headClose);
  },
};
