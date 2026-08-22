import { MATH_SEGMENT_RE } from "@/pages/paper-reader/paper-cross-anchor";
import katex from "katex";
import { useMemo } from "react";

/**
 * 含 $...$ / $$...$$ 的纯文本 → 文本+KaTeX 混合渲染（非 react-markdown 场景：
 * 列表标题/摘要、标注 quote、图片图注、元数据标题等）。
 * KaTeX 解析失败保留 $ 源码文本（与阅读区同一容错语义）。
 */

function renderKaTeX(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex, { displayMode, throwOnError: true });
  } catch {
    const raw = displayMode ? `$$${tex}$$` : `$${tex}$`;
    return raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
}

interface MathPart {
  type: "text" | "math";
  value: string;
  display: boolean;
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 纯文本（含 $...$）→ HTML 字符串（文本段转义 + KaTeX 段）；供 imperative DOM 场景（chrome-tabs 标题等）使用 */
export function renderInlineMathHtml(text: string): string {
  return splitMathParts(text)
    .map((part) => (part.type === "text" ? escapeHtml(part.value) : renderKaTeX(part.value, part.display)))
    .join("");
}

function splitMathParts(text: string): MathPart[] {
  const parts: MathPart[] = [];
  let last = 0;
  for (const match of text.matchAll(MATH_SEGMENT_RE)) {
    if (match.index > last) parts.push({ type: "text", value: text.slice(last, match.index), display: false });
    const raw = match[0];
    const display = raw.startsWith("$$");
    parts.push({ type: "math", value: display ? raw.slice(2, -2) : raw.slice(1, -1), display });
    last = match.index + raw.length;
  }
  if (last < text.length) parts.push({ type: "text", value: text.slice(last), display: false });
  return parts;
}

export function InlineMathText({ text, className }: { text: string; className?: string }) {
  const parts = useMemo(() => splitMathParts(text), [text]);
  return (
    <span className={className}>
      {parts.map((part, index) =>
        part.type === "text" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: 静态分段不可变
          <span key={index}>{part.value}</span>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: 静态分段不可变
          <span key={index} dangerouslySetInnerHTML={{ __html: renderKaTeX(part.value, part.display) }} />
        ),
      )}
    </span>
  );
}
