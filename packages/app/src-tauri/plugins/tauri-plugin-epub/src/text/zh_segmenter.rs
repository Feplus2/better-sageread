//! 中文分词（jieba）：论文词级对齐的中文侧分词器。
//!
//! 词级对齐最初把中文按单字切分（无词典依赖，DP (1,k) 合并动态组词），
//! 实测单字向量区分度低导致映射常落在词中间/边界多带一字（"离"/"致"/"或者根"）；
//! 离线对比实验（scripts/experiment-jieba-vs-char.mjs，13 探针 11.5 vs 7.5）表明
//! jieba 分词后词向量信号显著更强、实义词边界精确，故中文侧改走本模块。
//!
//! 偏移口径：返回的 start/end 为 **UTF-16 code unit 偏移**，与前端 JS string 下标一致
//! （Rust 原生 byte/char 偏移直接传给 JS 会错位——CJK 在 UTF-8 占 3 字节、UTF-16 占 1 单元）。

use jieba_rs::Jieba;
use serde::Serialize;
use std::sync::OnceLock;

static JIEBA: OnceLock<Jieba> = OnceLock::new();

/// 全局共享实例（词典大，只加载一次；Jieba 不可变使用，线程安全）
fn jieba() -> &'static Jieba {
    JIEBA.get_or_init(Jieba::new)
}

/// 一个中文 token：UTF-16 半开区间 [start, end) + 原文切片
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ZhToken {
    pub start: usize,
    pub end: usize,
    pub text: String,
}

/// token 是否保留：至少含一个字母或数字字符（CJK 属 Alphabetic）。
/// 与前端单字路径口径一致——纯空白/标点/符号不成 token（对齐只落在实义单元上）。
fn is_meaningful(word: &str) -> bool {
    word.chars().any(|c| c.is_alphanumeric())
}

/// 批量中文分词：每条文本独立输出 token 序列（UTF-16 偏移，过滤空白/标点/符号）。
/// jieba.cut 产出输入的连续切片序列（拼接即原文），按序累计 UTF-16 长度即得偏移。
pub fn tokenize_zh(texts: &[String]) -> Vec<Vec<ZhToken>> {
    let jieba = jieba();
    texts
        .iter()
        .map(|text| {
            let mut tokens = Vec::new();
            let mut cursor = 0usize; // UTF-16 偏移游标
            for word in jieba.cut(text, false) {
                let width = word.encode_utf16().count();
                if is_meaningful(word) {
                    tokens.push(ZhToken {
                        start: cursor,
                        end: cursor + width,
                        text: word.to_string(),
                    });
                }
                cursor += width;
            }
            tokens
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_segment_academic_text() {
        let tokens = tokenize_zh(&["值得注意的是，远离分界线的其他区域也可能导致其他类型的过渡金属氧化物相".to_string()]);
        let tokens = &tokens[0];
        let words: Vec<&str> = tokens.iter().map(|t| t.text.as_str()).collect();
        // 学术词汇应按词切出（而非单字）
        assert!(words.contains(&"值得注意"), "应切出'值得注意': {:?}", words);
        assert!(words.contains(&"分界线"), "应切出'分界线': {:?}", words);
        assert!(words.contains(&"氧化物"), "应切出'氧化物': {:?}", words);
        // 标点被过滤
        assert!(!words.contains(&"，"), "标点应被过滤: {:?}", words);
        // 区间拼接的 text 拼接 + 被过滤标点 = 原文去标点（间接验证无遗漏）
    }

    #[test]
    fn test_utf16_offsets() {
        // 混合 CJK（UTF-16 1 单元）/ ASCII / emoji（UTF-16 2 单元）验证偏移口径
        let text = "稳定structure😀结构".to_string();
        let tokens = &tokenize_zh(&[text.clone()])[0];
        let units: Vec<u16> = text.encode_utf16().collect();
        for t in tokens {
            // 每个 token 的 [start,end) 按 UTF-16 单元切片必须还原其文本（JS string 下标语义）
            let restored = String::from_utf16(&units[t.start..t.end]).unwrap();
            assert_eq!(restored, t.text, "UTF-16 偏移切片应还原文本");
        }
        // token 顺序递增且落在文本长度内
        let mut prev_end = 0;
        for t in tokens {
            assert!(t.start >= prev_end && t.end <= units.len());
            prev_end = t.end;
        }
    }

    #[test]
    fn test_empty_and_punct_only() {
        let tokens = tokenize_zh(&["".to_string(), "，。！？".to_string()]);
        assert!(tokens[0].is_empty());
        assert!(tokens[1].is_empty(), "全标点文本应无 token: {:?}", tokens[1]);
    }
}
