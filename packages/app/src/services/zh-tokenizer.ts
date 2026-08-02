import { type WordToken, tokenizeWords } from "@/pages/paper-reader/paper-cross-anchor";
/**
 * 中文分词（jieba，Rust 侧 tauri-plugin-epub 的 tokenize_zh 命令）。
 *
 * 用于论文词级对齐的中文侧分词：词向量信号在"词"粒度上区分度远高于单字
 * （离线对比实验 13 探针 11.5 vs 7.5，见 docs 记录与 scripts/experiment-jieba-vs-char.mjs）。
 *
 * 无 Tauri 环境（无头测试）或命令不可用时回退单字分词——行为与词级相位接入前一致，
 * 保证降级不中断（对齐本体不受影响）。
 */
import { invoke } from "@tauri-apps/api/core";

export interface ZhToken {
  start: number;
  end: number;
  text: string;
}

let fallbackWarned = false;

/** 单字兜底（与接入前词级相位的中文分词行为一致） */
function tokenizeChars(text: string): ZhToken[] {
  return tokenizeWords(text).map((t: WordToken) => ({
    start: t.start,
    end: t.end,
    text: text.slice(t.start, t.end),
  }));
}

/**
 * 批量中文分词：每条文本独立输出 token 序列（UTF-16 偏移；空白/标点/符号已由 Rust 侧过滤）。
 * 一次 IPC 拿全部（对齐词级相位按句对汇总传入，百条量级）。
 */
export async function tokenizeZhBatch(texts: string[]): Promise<ZhToken[][]> {
  if (texts.length === 0) return [];
  try {
    const result = await invoke<ZhToken[][]>("plugin:epub|tokenize_zh", { texts });
    // 防御：条数必须与输入一致（不然按条回退，不牵连整批）
    if (Array.isArray(result) && result.length === texts.length) return result;
    throw new Error(`tokenize_zh 返回条数异常: ${Array.isArray(result) ? result.length : typeof result}`);
  } catch (error) {
    if (!fallbackWarned) {
      console.warn("jieba 分词不可用，词级对齐回退单字分词:", error);
      fallbackWarned = true;
    }
    return texts.map(tokenizeChars);
  }
}
