/**
 * 输入框标点自动配对（双通道）。
 *
 * 通道一（beforeinput 拦截）：英文直输的 insertText——开符插入成对、闭符跳过、
 * 空对 Backspace 整对删除、... 归一为 …。
 *
 * 通道二（compositionend 收尾）：中文全角符号。探针实测（2026-08-11，微软拼音/WebView2）：
 * IME 提交帧是 isComposing=true 的 insertCompositionText，且一个字符两帧
 * （先插临时文本、再选区替换定稿）——beforeinput 层拦截既滤不准 isComposing，
 * preventDefault 还会和 IME 的两帧定稿打架。故中文不拦、组合结束后再转换，
 * 此时 IME 无活状态，DOM 值即终稿，转换经 setValue 覆写不会破坏 IME。
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
 * 通道二：IME 提交收尾（compositionend 时调用）。rAF 后读 DOM 终稿做转换：
 * - 光标前是开符（且后方不是同一闭符）→ 补闭符，光标保持开符后
 * - 光标前是闭符且后方恰是同一闭符（配对后的闭符输入）→ 删后方闭符（等效"跳过"）
 * - 光标前三字符是 ··· → 收成 …
 */
export function applyCompositionPairing(ta: HTMLTextAreaElement, setValue: (v: string) => void): void {
  requestAnimationFrame(() => {
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
    if (CLOSERS.has(prev) && value[s] === prev) {
      setValue(value.slice(0, s) + value.slice(s + 1));
      setCaret(ta, s);
      return;
    }
    const prev3 = value.slice(Math.max(0, s - 3), s);
    if (prev3 === "···") {
      setValue(`${value.slice(0, s - 3)}…${value.slice(s)}`);
      setCaret(ta, s - 2);
    }
  });
}
