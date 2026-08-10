/**
 * 原生 HTML 表格内的公式预烘焙（渲染器缺口补钉）。
 *
 * 论文转换产物的表格是 raw HTML（<table>），rehype-katex 只处理 remark-math
 * 产出的 math-inline/math-display 类元素，raw HTML 文本里的 $...$ 会原样露出。
 * 这里在进 ReactMarkdown 前把 <table> 区域内的 $...$/$$...$$ 预烘焙为
 * KaTeX HTML——它走 rehypeRaw 通道解析成真实元素，与正文公式同效。
 *
 * 边界：
 * - 只处理 <table> 区域，正文公式仍归 remark-math/rehype-katex 管线，不重复烘焙
 * - 顶层块结构不变（表格本就是一个块），不影响翻译/标注的块索引对齐；
 *   表格单元格内 textContent 因 KaTeX 标记而变长，页内搜索对"表格内公式原文"
 *   不再命中原文文本（已知取舍，影响面=表格内搜公式）
 * - 渲染失败（非法 LaTeX）不抛错：throwOnError=false 以红色错误文本呈现，
 *   与正文公式的行为一致
 */
import katex from "katex";

const TABLE_RE = /<table[\s\S]*?<\/table>/gi;
const MATH_RE = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;

export function renderMathInRawTables(markdown: string): string {
  if (!markdown.includes("<table") || !markdown.includes("$")) {
    return markdown;
  }
  return markdown.replace(TABLE_RE, (tableHtml) =>
    tableHtml.replace(MATH_RE, (match, display: string | undefined, inline: string | undefined) => {
      const source = display ?? inline ?? "";
      try {
        return katex.renderToString(source, { displayMode: display !== undefined, throwOnError: false });
      } catch {
        return match;
      }
    }),
  );
}
