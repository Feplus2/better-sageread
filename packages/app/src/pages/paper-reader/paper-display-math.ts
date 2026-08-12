/**
 * 论文 display 公式归一化（2026-08-13）
 *
 * 背景（三症根因）：remark-math 只把多行围栏 `$$…$$` 识别为 display 公式（math 节点）；
 * 整段一行的 `$$…$$` 一律解析为 inlineMath —— 渲染成行内公式、后一段文字直接接排、
 * 行内分式的高结构叠到上一行。库里 247 处单行写法均为旧引擎解析产物（新引擎原生多行）。
 *
 * 处理（只动 $$ display 段，$…$ 行内公式不受影响）：
 * 1) 单行 `$$x$$` → 多行围栏（remark flow math 可中断段落，前后文本行自动分段，无需补空行）；
 * 2) 公式尾部「空格 + (N)」→ `\tag{N}`（KaTeX display 模式编号自动右对齐）；
 * 3) 编号被断行拆到下一行行首的变体（`(1) where …`）→ 移入 `\tag{N}`，余文保留为独立段落。
 *
 * 幂等：已是多行围栏且无编号的输入原样通过。
 * 注意：公式块渲染为 div.katex-display，不占 listBlocks 块序号；单行公式独立段在归一后
 * 不再占块序号（旧解析产物的译文块索引可能因此偏移，重解析/重译后自愈）。
 */
export function normalizeDisplayMath(body: string): string {
  // 1) 单行 $$…$$ → 多行围栏。内容不含 $ 才转（排除 "$a$$b$" 邻接伪命中）；
  // 行尾锚定（\r?\n 或 EOS）防 "…$$ 后还有字" 的行内混排误伤；行尾统一按 \n 重发
  let out = body.replace(
    /^\$\$([^$\r\n]+?)\$\$[ \t]*(\r?\n|$)/gm,
    (_m, c: string, nl?: string) => `$$\n${c.trim()}\n$$${nl ? "\n" : ""}`,
  );

  // 2) 公式尾部编号 → \tag。编号前须有空格（排除 f(2) 这类调用尾），只处理单行内容（含环境的多行公式不动）
  out = out.replace(
    /^(\$\$\r?\n)([^\r\n]*?\S)[ \t]+\((\d{1,3}[a-z]?)\)[ \t]*\r?(\n\$\$)/gm,
    (m: string, open: string, content: string, num: string, close: string) =>
      content.includes("\\tag{") ? m : `${open}${content} \\tag{${num}}${close}`,
  );

  // 3) 编号在下一行行首（紧贴围栏无空行）→ 移入 \tag，余文另起一段
  out = out.replace(
    /^(\$\$\r?\n)([^\r\n]*?)(\r?\n\$\$)\r?\n\((\d{1,3}[a-z]?)\)[ \t]*([^\r\n]*)$/gm,
    (m: string, open: string, content: string, close: string, num: string, rest: string) => {
      if (content.includes("\\tag{")) return m;
      const tagged = `${open}${content} \\tag{${num}}${close}`;
      return rest ? `${tagged}\n\n${rest}` : tagged;
    },
  );

  return out;
}
