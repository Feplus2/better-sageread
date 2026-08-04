import katex from "katex";
import { MATH_SEGMENT_RE } from "@/pages/paper-reader/paper-cross-anchor";
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
