/**
 * 输入框标点自动配对（beforeinput 层）。
 *
 * 为什么在 beforeinput 而不是 keydown：中文全角符号经 IME 组合提交，keydown 阶段
 * 拿不到字符（且 isComposing 守卫必须跳过），只有提交态的 insertText 能拿到最终
 * 字符——此层中英文、IME 提交全角均可覆盖。
 *
 * 行为（对齐常见编辑器）：
 * - 输入开符：插入成对符号，光标置中；有选区时把选区包起来
 * - 输入闭符且下一个字符就是同一闭符：跳过它（不重复插入）
 * - 空对中按 Backspace：整对删除
 * - 连续三个句点 `...` 或中点 `···`：收成标准省略号 `…`（两组即成中文全角 `……`）
 */
const PAIRS: Record<string, string> = {
  '"': '"',
  "'": "'",
  "(": ")",
  "[": "]",
  "{": "}",
  "（": "）",
  "【": "】",
  "「": "」",
  "『": "』",
  "《": "》",
  "〈": "〉",
};
const CLOSERS = new Set(Object.values(PAIRS));

function setCaret(ta: HTMLTextAreaElement, pos: number) {
  requestAnimationFrame(() => {
    ta.selectionStart = pos;
    ta.selectionEnd = pos;
  });
}

/** 返回 true = 已处理（本函数已 preventDefault，不再走默认插入） */
export function applyPairedPunctuation(
  ne: InputEvent,
  ta: HTMLTextAreaElement,
  value: string,
  setValue: (v: string) => void,
): boolean {
  const s = ta.selectionStart;
  const en = ta.selectionEnd;

  // 省略号归一：再输入一个 . 或 · 凑满三点时收成 …
  if (ne.inputType === "insertText" && (ne.data === "." || ne.data === "·")) {
    const prev2 = value.slice(Math.max(0, s - 2), s);
    if (s === en && (prev2 === ".." || prev2 === "··")) {
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
