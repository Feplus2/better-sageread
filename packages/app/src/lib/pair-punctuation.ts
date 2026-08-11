/**
 * 输入框标点自动配对（双通道）。
 *
 * 通道一（beforeinput 拦截）：英文直输的 insertText——开符插入成对、闭符跳过、
 * 空对 Backspace 整对删除、... 归一为 …（英文省略号保留：同步转换无竞态）。
 *
 * 通道二（compositionend 收尾）：中文全角符号。探针实测（2026-08-11，微软拼音/WebView2）：
 * IME 提交帧是 isComposing=true 的 insertCompositionText，且一个字符两帧
 * （先插临时文本、再选区替换定稿）——beforeinput 层拦截既滤不准 isComposing，
 * preventDefault 还会和 IME 的两帧定稿打架。故中文不拦、组合结束后再转换，
 * 此时 IME 无活状态，DOM 值即终稿，转换经 setValue 覆写不会破坏 IME。
 * （中文 · 省略号归一已去除：快速连按时多帧收尾竞态，转换结果基线/居中混杂，不如不做）
 */
const PAIRS: Record<string, string> = {
  '"': '"',
  "'": "'",
  "(": ")",
  "[": "]",
  "{": "}",
  // 全角括号
  "（": "）",
  "【": "】",
  "「": "」",
  "『": "』",
  "《": "》",
  "〈": "〉",
  // 中文弯引号（IME 直出的就是这两个码位）
  "“": "”",
  "‘": "’",
};
const CLOSERS = new Set(Object.values(PAIRS));

function setCaret(ta: HTMLTextAreaElement, pos: number) {
  requestAnimationFrame(() => {
    ta.selectionStart = pos;
    ta.selectionEnd = pos;
  });
}

/** 前文是否存在未配对的开符（引号配对计数：开 +1 闭 -1，>0 即有未闭合开符） */
function hasUnmatchedOpen(text: string, open: string, close: string): boolean {
  let balance = 0;
  for (const ch of text) {
    if (ch === open) balance += 1;
    else if (ch === close) balance -= 1;
  }
  return balance > 0;
}

/** 通道一：beforeinput 拦截（英文直输 insertText；IME 的 composition 帧一律放行）。返回 true = 已处理 */
export function applyPairedPunctuation(
  ne: InputEvent,
  ta: HTMLTextAreaElement,
  value: string,
  setValue: (v: string) => void,
): boolean {
  const s = ta.selectionStart;
  const en = ta.selectionEnd;

  // 省略号归一：再输入一个 . 凑满三点时收成 …（中文中点 · 走通道二）
  if (ne.inputType === "insertText" && ne.data === ".") {
    const prev2 = value.slice(Math.max(0, s - 2), s);
    if (s === en && prev2 === "..") {
      ne.preventDefault();
      setValue(`${value.slice(0, s - 2)}…${value.slice(en)}`);
      setCaret(ta, s - 2 + 1);
      return true;
    }
    return false;
  }

  if (ne.inputType === "insertText" && ne.data && PAIRS[ne.data] !== undefined) {
    ne.preventDefault();
    const sel = value.slice(s, en);
    setValue(value.slice(0, s) + ne.data + sel + PAIRS[ne.data] + value.slice(en));
    setCaret(ta, s + 1 + sel.length);
    return true;
  }

  if (ne.inputType === "insertText" && ne.data && CLOSERS.has(ne.data) && s === en && value[s] === ne.data) {
    ne.preventDefault();
    setCaret(ta, s + 1);
    return true;
  }

  if (ne.inputType === "deleteContentBackward" && s === en && s > 0) {
    const open = value[s - 1];
    if (PAIRS[open] !== undefined && value[s] === PAIRS[open]) {
      ne.preventDefault();
      setValue(value.slice(0, s - 1) + value.slice(s + 1));
      setCaret(ta, s - 1);
      return true;
    }
  }

  return false;
}

/**
 * 通道二：IME 提交收尾（compositionend 时调用，同步执行——此前 rAF 等帧是百毫秒感知延迟的来源之一；
 * compositionend 时 DOM 已是终稿，无需再等帧）：
 * - 光标前是开符（且后方不是同一闭符）→ 补闭符，光标保持开符后
 * - 光标前是闭符且后方恰是同一闭符（配对后的闭符输入）→ 删后方闭符（等效"跳过"）
 * - 引号键不分左右：闭符引号（”’）前方没有未配对开符时，按用户本意落成新的一对（光标居中）
 */
export function applyCompositionPairing(ta: HTMLTextAreaElement, setValue: (v: string) => void): void {
  const value = ta.value;
  const s = ta.selectionStart;
  if (s !== ta.selectionEnd || s === 0) return;
  const prev = value[s - 1];

  if (PAIRS[prev] !== undefined) {
    if (value[s] === PAIRS[prev]) return; // 后方已是配对闭符，不重复补
    setValue(value.slice(0, s) + PAIRS[prev] + value.slice(s));
    setCaret(ta, s);
    return;
  }

  if (CLOSERS.has(prev)) {
    if (value[s] === prev) {
      // 闭符跳过：刚提交的闭符与原配对的闭符重复 → 删后方那个
      setValue(value.slice(0, s) + value.slice(s + 1));
      setCaret(ta, s);
      return;
    }
    // 引号键左右交替错位（典型：删完整对后 IME 仍按交替出闭符）：
    // 前文无未配对开符的闭符引号，落成新的一对（只对引号启用，括号闭符允许单独存在）
    if (prev === "”" || prev === "’") {
      const open = prev === "”" ? "“" : "‘";
      if (!hasUnmatchedOpen(value.slice(0, s - 1), open, prev)) {
        setValue(`${value.slice(0, s - 1)}${open}${prev}${value.slice(s)}`);
        setCaret(ta, s);
      }
    }
  }
}
