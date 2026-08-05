/**
 * 解析产物退化检测：OCR 引擎 VLM 偶发"模式延续"失控（如 "385 nm, 395 nm, …, 15800 nm"
 * 或 "fire fire fire …"），数字递增/单词重复，精确重复检测抓不到数字递增情形。
 * 思路：把文本映射为粗粒度签名（字母→a、数字→0、空白折叠），按行找短周期连续重复。
 */

export interface DegenerateFinding {
  /** 命中的行号（0 基） */
  line: number;
  /** 重复周期（签名字符数） */
  period: number;
  /** 连续重复次数 */
  repeats: number;
  /** 重复片段预览（原文，截断） */
  preview: string;
}

const MIN_LINE_LEN = 200;
const MIN_SPAN = 300;
const MIN_REPEATS = 10;
const MAX_PERIOD = 50;

function toSignature(s: string): string {
  return s
    .replace(/[\p{L}]/gu, "a")
    .replace(/\d/g, "0")
    .replace(/\s+/g, " ");
}

/** 在签名的 start 处，周期 p 连续重复的次数（从 start 起算，至少 1） */
function countRepeats(sig: string, start: number, p: number): number {
  let count = 1;
  let pos = start + p;
  while (pos + p <= sig.length && sig.startsWith(sig.slice(start, start + p), pos)) {
    count += 1;
    pos += p;
  }
  return count;
}

/**
 * 检测正文中的退化循环。返回首个最强证据（找不到返回 null）。
 * 只查单行：周期 ≤50、连续重复 ≥10 次、覆盖跨度 ≥300 字符才判定——宽表/编号列表不会误中。
 */
export function findDegenerateLoop(body: string): DegenerateFinding | null {
  const lines = body.split("\n");
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (line.length < MIN_LINE_LEN) continue;
    const sig = toSignature(line);
    // 步进 10 抽样起点，命中即可，不需要穷举
    for (let start = 0; start + MAX_PERIOD * MIN_REPEATS <= sig.length; start += 10) {
      for (let p = 4; p <= MAX_PERIOD; p++) {
        const repeats = countRepeats(sig, start, p);
        if (repeats >= MIN_REPEATS && repeats * p >= MIN_SPAN) {
          return {
            line: li,
            period: p,
            repeats,
            preview: line.slice(start, start + Math.min(120, repeats * p)),
          };
        }
      }
    }
  }
  return null;
}
