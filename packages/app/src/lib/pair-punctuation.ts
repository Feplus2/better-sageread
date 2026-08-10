/**
 * 输入框标点自动配对：开括号/引号自动成双并把光标置于中间。
 *
 * 行为（对齐常见编辑器）：
 * - 输入开符：插入成对符号，光标置中；有选区时把选区包起来
 * - 输入闭符且下一个字符就是同一闭符：跳过它（不重复插入）
 * - 空对中按 Backspace：整对删除
 * IME 组合期间由调用方拦截（isComposing 时不调用本函数），不干扰中文输入法。
 */
import type React from "react";

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

/** 返回 true = 已处理（调用方跳过默认插入逻辑） */
export function applyPairedPunctuation(
  e: React.KeyboardEvent<HTMLTextAreaElement>,
  value: string,
  setValue: (v: string) => void,
): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  const ta = e.currentTarget;
  const s = ta.selectionStart;
  const en = ta.selectionEnd;
  const key = e.key;

  // 开符：成双（有选区则包裹选区）
  if (PAIRS[key] !== undefined) {
    e.preventDefault();
    const sel = value.slice(s, en);
    setValue(value.slice(0, s) + key + sel + PAIRS[key] + value.slice(en));
    setCaret(ta, s + 1 + sel.length);
    return true;
  }

  // 闭符：下一个字符已是同一闭符 → 跳过
  if (CLOSERS.has(key) && s === en && value[s] === key) {
    e.preventDefault();
    setCaret(ta, s + 1);
    return true;
  }

  // 空对中 Backspace：整对删除
  if (key === "Backspace" && s === en && s > 0) {
    const open = value[s - 1];
    if (PAIRS[open] !== undefined && value[s] === PAIRS[open]) {
      e.preventDefault();
      setValue(value.slice(0, s - 1) + value.slice(s + 1));
      setCaret(ta, s - 1);
      return true;
    }
  }

  return false;
}
