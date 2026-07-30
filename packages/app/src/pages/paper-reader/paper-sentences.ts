/**
 * 论文正文切句器（纯函数，无 DOM 依赖）。
 *
 * 共享基建，当前与规划中的消费方：
 * - 阅读区句子悬浮高亮 / 右键调标注弹窗（paper-reader.tsx）：按块 textContent 切句，偏移命中句子；
 * - C2「AI 重点句标亮」：AI 返回的重点句区间经 snapRangeToSentences 吸附到句边界后再标亮；
 * - 句级翻译对齐：原文/译文各自 segmentSentences 后按下标对齐，findSentenceAt 做偏移 → 句子映射。
 *
 * 边界规则：在 . ! ? 。！？ 之后满足其一才切——
 *   a)（可选的闭合引号/括号/参考文献角标之后）空白 + 大写字母/开引号/开括号/数字/CJK 字符；
 *   b) 行尾或文本末尾。中文终止符（。！？）在闭合符之后直接切。
 * 保护规则（不切）：缩写白名单（et al. / e.g. / Fig. / Dr. / U.S. / Jan.-Dec. 等，小写比较）、
 *   单字母大写缩写（J. R. R.）、小数点（数字.数字）、省略号 .../…。
 * 尾随的闭合引号/括号与参考文献角标（[12]、(3)）归前一句；连续终止符（?!）视作一体。
 * 已知取舍：白名单大小写不敏感（"…said no. Next" 这类罕见情形不切）；表外缩写会误切。
 */

export interface SentenceSpan {
  /** 句子在块 textContent 内的起始字符偏移（含；span 不含首尾空白） */
  start: number;
  /** 结束字符偏移（不含） */
  end: number;
}

const ASCII_TERMINATORS = new Set([".", "!", "?"]);
const CJK_TERMINATORS = new Set(["。", "！", "？"]);
const CLOSER_CHARS = ")]}\"'”’»』」）】》〉";
const isCloser = (ch: string) => CLOSER_CHARS.includes(ch);
const isDigit = (ch: string | undefined) => ch !== undefined && ch >= "0" && ch <= "9";

/** 边界后允许开启新句的首字符：大写字母/数字/开引号/开括号/CJK */
const BOUNDARY_START_RE = /[A-Z0-9"'“‘«([{一-鿿]/;
/** 尾随参考文献角标：[12]、[1, 2]、(3) */
const CITATION_RE = /^(?:\[\d[\d,;\s–-]*\]|\(\d[\d,;\s–-]*\))/;

/** 缩写白名单（小写比较；含多点写法如 u.s / e.g；"al" 覆盖 et al.） */
const ABBREVIATIONS = new Set([
  "al",
  "etc",
  "e.g",
  "i.e",
  "fig",
  "figs",
  "eq",
  "eqs",
  "sec",
  "dr",
  "prof",
  "mr",
  "mrs",
  "ms",
  "sr",
  "jr",
  "st",
  "vs",
  "ca",
  "cf",
  "ibid",
  "no",
  "vol",
  "pp",
  "ed",
  "eds",
  "rev",
  "u.s",
  "u.k",
  "u.s.a",
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "sept",
  "oct",
  "nov",
  "dec",
  "ave",
  "dept",
  "univ",
  "inc",
  "ltd",
]);

/** 点号是否受保护（不作句边界）：省略号 / 小数点 / 缩写 */
function isProtectedPeriod(text: string, i: number): boolean {
  if (text[i - 1] === "." || text[i + 1] === ".") return true; // 省略号 ...
  if (isDigit(text[i - 1]) && isDigit(text[i + 1])) return true; // 小数点 2.5
  let s = i - 1;
  while (s >= 0 && /[A-Za-z.]/.test(text[s])) s--;
  const token = text.slice(s + 1, i);
  if (!token) return false;
  if (token.length === 1 && /[A-Z]/.test(token)) return true; // 单字母大写缩写 J. R. R.
  return ABBREVIATIONS.has(token.toLowerCase());
}

export function segmentSentences(text: string): SentenceSpan[] {
  const spans: SentenceSpan[] = [];
  const len = text.length;
  let start = 0;
  let i = 0;

  const pushSpan = (rawStart: number, rawEnd: number) => {
    let s = rawStart;
    let e = rawEnd;
    while (s < e && /\s/.test(text[s])) s++;
    while (e > s && /\s/.test(text[e - 1])) e--;
    if (e > s) spans.push({ start: s, end: e });
  };

  while (i < len) {
    const ch = text[i];
    const isAscii = ASCII_TERMINATORS.has(ch);
    const isCjk = CJK_TERMINATORS.has(ch);
    if (!isAscii && !isCjk) {
      i++;
      continue;
    }
    if (ch === "." && isProtectedPeriod(text, i)) {
      i++;
      continue;
    }

    // 连续终止符（?!、!!）视作一体
    let j = i + 1;
    while (j < len && (ASCII_TERMINATORS.has(text[j]) || CJK_TERMINATORS.has(text[j]))) j++;
    // 尾随闭合符与参考文献角标归前一句
    for (;;) {
      while (j < len && isCloser(text[j])) j++;
      const citation = CITATION_RE.exec(text.slice(j));
      if (!citation) break;
      j += citation[0].length;
    }

    let boundary = false;
    if (j >= len || isCjk) {
      boundary = true;
    } else if (text[j] === "\n" || text[j] === "\r") {
      boundary = true; // 行尾
    } else if (/\s/.test(text[j])) {
      let k = j;
      while (k < len && /\s/.test(text[k])) k++;
      boundary = k >= len || BOUNDARY_START_RE.test(text[k]);
    }
    if (boundary) {
      pushSpan(start, j);
      start = j;
    }
    i = j;
  }
  pushSpan(start, len);
  return spans;
}

/**
 * 偏移 → 所在句子（spans 须为 segmentSentences 产物，二分查找）。
 * 落在句间空白返回 null；恰好等于末句 end（光标在段尾）归末句。
 */
export function findSentenceAt(spans: SentenceSpan[], offset: number): SentenceSpan | null {
  let lo = 0;
  let hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const span = spans[mid];
    if (offset < span.start) hi = mid - 1;
    else if (offset >= span.end) lo = mid + 1;
    else return span;
  }
  const last = spans[spans.length - 1];
  return last && offset === last.end ? last : null;
}

/**
 * 把任意字符区间吸附到覆盖它的最小整句范围（C2 AI 标亮 / 句级翻译映射用）。
 * start 落在空白则归入后一句，end 落在空白则归入前一句；与任何句子无交叠返回 null。
 */
export function snapRangeToSentences(spans: SentenceSpan[], start: number, end: number): SentenceSpan | null {
  if (start >= end) return null;
  let snappedStart = -1;
  let snappedEnd = -1;
  for (const span of spans) {
    if (span.end > start && snappedStart === -1) snappedStart = span.start;
    if (span.start < end) snappedEnd = span.end;
  }
  if (snappedStart === -1 || snappedEnd === -1 || snappedStart >= snappedEnd) return null;
  return { start: snappedStart, end: snappedEnd };
}
