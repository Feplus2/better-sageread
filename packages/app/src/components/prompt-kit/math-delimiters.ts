/**
 * 数学定界符归一化（chat/笔记 Markdown 渲染的预处理，marked 分块之前执行）：
 *
 * 1. LLM 常用的 \(...\) / \[...\] → remark-math 认识的 $…$ / $$…$$（实测 deepseek 解释公式时
 *    会用 \(...\) 输出，渲染器此前直接当纯文本外泄源码）
 * 2. $$ 围栏与内容同行的多行公式（如 `$$\begin{cases}…\end{cases}$$`）改写成围栏独占行——
 *    否则 remark-math 既不认成行内也不认成行间，整段源码外泄；这也是"同一段方程组这次渲染
 *    成功那次失败"的根源：模型两次输出的围栏位置不同。
 *
 * 防护：代码围栏/行内代码原样跳过；`\\[6pt]` 这类 LaTeX 换行间距语法不误伤（\\ 先行跳过）。
 */

/** 找 fenced code 的闭合行（行首、同字符、数量 ≥ 开围栏），返回闭合行之后的下标；找不到返回 -1 */
function findCodeFenceClose(src: string, from: number, fenceChar: string, fenceLen: number): number {
  let pos = src.indexOf("\n", from);
  while (pos !== -1) {
    const lineStart = pos + 1;
    let k = lineStart;
    while (k < src.length && src[k] === " ") k++;
    if (k - lineStart <= 3 && src.startsWith(fenceChar.repeat(fenceLen), k)) {
      let m = k + fenceLen;
      while (m < src.length && src[m] === fenceChar) m++;
      const nl = src.indexOf("\n", m);
      const tail = src.slice(m, nl === -1 ? src.length : nl);
      if (tail.trim() === "") return nl === -1 ? src.length : nl + 1;
    }
    pos = src.indexOf("\n", lineStart);
  }
  return -1;
}

export function normalizeMathDelimiters(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;

  /** 输出 display 公式块：保证围栏独占行，且与前文之间有空行（remark-math 行间公式是块级构造） */
  const emitDisplay = (body: string, afterClose: number) => {
    const trimmed = body.replace(/^\n+|\n+$/g, "");
    if (out && !out.endsWith("\n\n") && !out.endsWith("\n")) out += "\n";
    if (out && !out.endsWith("\n\n")) out += "\n";
    out += `$$\n${trimmed}\n$$`;
    // 闭合围栏后还有同行内容时补换行（块级构造要求闭合围栏独占行）
    if (afterClose < n && src[afterClose] !== "\n") out += "\n";
  };

  while (i < n) {
    const ch = src[i];

    // 行首代码围栏（``` 或 ~~~）：整体复制到闭合围栏之后
    if ((i === 0 || src[i - 1] === "\n") && (ch === "`" || ch === "~")) {
      let j = i;
      while (j < n && src[j] === ch) j++;
      if (j - i >= 3) {
        const closeEnd = findCodeFenceClose(src, j, ch, j - i);
        const stop = closeEnd === -1 ? n : closeEnd;
        out += src.slice(i, stop);
        i = stop;
        continue;
      }
    }

    // 行内代码：`…`（按反引号个数配对）
    if (ch === "`") {
      let j = i;
      while (j < n && src[j] === "`") j++;
      const close = src.indexOf("`".repeat(j - i), j);
      const stop = close === -1 ? j : close + (j - i);
      out += src.slice(i, stop);
      i = stop;
      continue;
    }

    // 连续两个反斜杠：转义先行跳过（\\[6pt] 之类换行间距不会误判为 \[ 定界符）
    if (ch === "\\" && src[i + 1] === "\\") {
      out += "\\\\";
      i += 2;
      continue;
    }

    // \( … \) → $…$
    if (ch === "\\" && src[i + 1] === "(") {
      const end = src.indexOf("\\)", i + 2);
      if (end !== -1) {
        out += `$${src.slice(i + 2, end)}$`;
        i = end + 2;
        continue;
      }
    }

    // \[ … \] → 行间公式
    if (ch === "\\" && src[i + 1] === "[") {
      const end = src.indexOf("\\]", i + 2);
      if (end !== -1) {
        emitDisplay(src.slice(i + 2, end), end + 2);
        i = end + 2;
        continue;
      }
    }

    // $$ … $$：内容含换行时改写成围栏独占行；单行原样（行内 mathText 或下游段落级修补处理）
    if (ch === "$" && src[i + 1] === "$") {
      const end = src.indexOf("$$", i + 2);
      if (end !== -1) {
        const body = src.slice(i + 2, end);
        if (body.includes("\n")) {
          emitDisplay(body, end + 2);
        } else {
          out += src.slice(i, end + 2);
        }
        i = end + 2;
        continue;
      }
    }

    out += ch;
    i++;
  }
  return out;
}
