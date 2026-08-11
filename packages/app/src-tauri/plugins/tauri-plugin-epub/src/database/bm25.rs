use anyhow::{Context, Result};
use rusqlite::params;
use std::collections::HashMap;

use crate::database::DatabaseConnection;
use crate::models::{SearchResult, BM25Stats, BM25SearchResult};

/// BM25搜索实现
pub struct BM25Search<'a> {
    db: &'a DatabaseConnection,
    k1: f32,
    b: f32,
}

impl<'a> BM25Search<'a> {
    /// 创建新的BM25搜索实例
    pub fn new(db: &'a DatabaseConnection, k1: f32, b: f32) -> Self {
        Self { db, k1, b }
    }

    /// 执行BM25搜索
    /// 旧封装：不过滤参考文献区段（行为不变）
    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<BM25SearchResult>> {
        self.search_filtered(query, limit, None, true)
    }

    /// 执行BM25搜索（可选按 paper_id 集合过滤，供全局论文库使用）
    /// include_references 为 false 时排除参考文献区段分片
    pub fn search_filtered(
        &self,
        query: &str,
        limit: usize,
        paper_ids: Option<&[String]>,
        include_references: bool,
    ) -> Result<Vec<BM25SearchResult>> {
        // 1. 预处理查询文本
        let query_terms = self.preprocess_text(query);
        if query_terms.is_empty() {
            return Ok(Vec::new());
        }

        // 2. 获取BM25统计信息
        let stats = self.get_bm25_stats()?;

        // 3. 计算每个文档的BM25分数
        let mut scores: HashMap<i64, f32> = HashMap::new();

        for term in &query_terms {
            let term_scores = self.calculate_term_scores(term, &stats, paper_ids, include_references)?;
            for (chunk_id, score) in term_scores {
                *scores.entry(chunk_id).or_insert(0.0) += score;
            }
        }

        // 4. 排序并限制结果
        let mut scored_chunks: Vec<(i64, f32)> = scores.into_iter().collect();
        // 防御：分数万一含 NaN（统计缓存陈旧等边界），partial_cmp 得 None，unwrap 会 panic
        scored_chunks.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        scored_chunks.truncate(limit);

        // 5. 归一化分数到[0,1]区间
        let normalized_scores = self.normalize_bm25_scores(&scored_chunks);

        // 6. 获取完整的搜索结果
        let mut results = Vec::new();
        for ((chunk_id, _), normalized_score) in scored_chunks.iter().zip(normalized_scores.iter()) {
            if let Ok(search_result) = self.get_search_result_by_id(*chunk_id) {
                results.push(BM25SearchResult {
                    score: *normalized_score,
                    search_result,
                });
            }
        }

        Ok(results)
    }

    /// 文本预处理和分词
    fn preprocess_text(&self, text: &str) -> Vec<String> {
        text.to_lowercase()
            .split_whitespace()
            .filter(|word| word.len() > 1) // 过滤单字符
            .map(|word| {
                // 移除标点符号
                word.chars()
                    .filter(|c| c.is_alphanumeric() || c.is_ascii_alphabetic())
                    .collect::<String>()
            })
            .filter(|word| !word.is_empty())
            .collect()
    }

    /// 获取BM25统计信息
    fn get_bm25_stats(&self) -> Result<BM25Stats> {
        // 尝试从缓存表获取
        if let Ok(stats) = self.get_cached_stats() {
            return Ok(stats);
        }

        // 重新计算统计信息
        let mut stmt = self.db.connection().prepare(
            "SELECT COUNT(*) as total_docs, AVG(LENGTH(chunk_text)) as avg_length FROM document_chunks"
        )?;

        let stats = stmt.query_row([], |row| {
            Ok(BM25Stats {
                total_docs: row.get::<_, i64>(0)? as usize,
                avg_doc_length: row.get::<_, f64>(1)? as f32,
            })
        })?;

        // 缓存统计信息
        self.cache_stats(&stats)?;

        Ok(stats)
    }

    /// 从缓存获取统计信息
    fn get_cached_stats(&self) -> Result<BM25Stats> {
        let mut stmt = self.db.connection().prepare(
            "SELECT total_docs, avg_doc_length FROM bm25_stats ORDER BY updated_at DESC LIMIT 1"
        )?;

        stmt.query_row([], |row| {
            Ok(BM25Stats {
                total_docs: row.get::<_, i64>(0)? as usize,
                avg_doc_length: row.get::<_, f64>(1)? as f32,
            })
        }).context("No cached BM25 stats found")
    }

    /// 缓存统计信息
    fn cache_stats(&self, stats: &BM25Stats) -> Result<()> {
        // 清除旧的统计信息
        self.db.connection().execute("DELETE FROM bm25_stats", [])?;

        // 插入新的统计信息
        self.db.connection().execute(
            "INSERT INTO bm25_stats (total_docs, avg_doc_length, updated_at) VALUES (?1, ?2, datetime('now'))",
            params![stats.total_docs as i64, stats.avg_doc_length],
        )?;

        Ok(())
    }

    /// 计算单个词项的BM25分数
    fn calculate_term_scores(
        &self,
        term: &str,
        stats: &BM25Stats,
        paper_ids: Option<&[String]>,
        include_references: bool,
    ) -> Result<HashMap<i64, f32>> {
        let mut scores = HashMap::new();

        // 获取包含该词项的所有文档
        let mut sql = String::from(
            r#"
            SELECT id, chunk_text, LENGTH(chunk_text) as doc_length
            FROM document_chunks
            WHERE (LOWER(chunk_text) LIKE ?1
               OR LOWER(related_chapter_titles) LIKE ?1
               OR LOWER(book_title) LIKE ?1)
            "#,
        );

        let mut param_values: Vec<rusqlite::types::Value> =
            vec![rusqlite::types::Value::Text(format!("%{}%", term))];
        if let Some(ids) = paper_ids {
            let placeholders: Vec<String> = (0..ids.len()).map(|i| format!("?{}", i + 2)).collect();
            sql.push_str(&format!(" AND paper_id IN ({})", placeholders.join(",")));
            param_values.extend(ids.iter().map(|id| rusqlite::types::Value::Text(id.clone())));
        }
        // 默认排除参考文献区段分片（字面量条件，不占参数位）
        if !include_references {
            sql.push_str(" AND is_references = 0");
        }

        let mut stmt = self.db.connection().prepare(&sql)?;

        let rows = stmt.query_map(rusqlite::params_from_iter(param_values.iter()), |row| {
            Ok((
                row.get::<_, i64>(0)?,      // chunk_id
                row.get::<_, String>(1)?,   // chunk_text
                row.get::<_, i64>(2)? as usize, // doc_length
            ))
        })?;

        let mut matching_docs = Vec::new();
        for row in rows {
            let (chunk_id, text, doc_length) = row?;
            let tf = self.calculate_term_frequency(term, &text);
            if tf > 0 {
                matching_docs.push((chunk_id, tf, doc_length));
            }
        }

        // 计算文档频率 (DF)
        let df = matching_docs.len();
        if df == 0 {
            return Ok(scores);
        }

        // 计算逆文档频率 (IDF)；参数 <= 0（统计缓存陈旧导致 df > N 的边界）时按 0 权重处理，防 NaN
        let idf_arg = (stats.total_docs as f32 - df as f32 + 0.5) / (df as f32 + 0.5);
        let idf = if idf_arg > 0.0 { idf_arg.ln() } else { 0.0 };

        // 为每个匹配的文档计算BM25分数
        for (chunk_id, tf, doc_length) in matching_docs {
            let score = self.calculate_bm25_score(tf, doc_length, stats.avg_doc_length, idf);
            scores.insert(chunk_id, score);
        }

        Ok(scores)
    }

    /// 计算词频
    fn calculate_term_frequency(&self, term: &str, text: &str) -> usize {
        let text_lower = text.to_lowercase();
        let term_lower = term.to_lowercase();
        
        // 简单的词频计算（可以优化为更精确的分词）
        text_lower.matches(&term_lower).count()
    }

    /// 计算BM25分数
    fn calculate_bm25_score(&self, tf: usize, doc_length: usize, avg_doc_length: f32, idf: f32) -> f32 {
        let tf_f32 = tf as f32;
        let doc_length_f32 = doc_length as f32;
        // 防御：空库/异常统计下 avg_doc_length 可能为 0，除零会产生 inf/NaN
        let avg_len = if avg_doc_length > f32::EPSILON { avg_doc_length } else { 1.0 };

        let numerator = tf_f32 * (self.k1 + 1.0);
        let denominator = tf_f32 + self.k1 * (1.0 - self.b + self.b * (doc_length_f32 / avg_len));

        idf * (numerator / denominator)
    }
    
    /// 将BM25分数归一化到[0,1]区间
    fn normalize_bm25_scores(&self, scored_chunks: &[(i64, f32)]) -> Vec<f32> {
        if scored_chunks.is_empty() {
            return Vec::new();
        }
        
        let scores: Vec<f32> = scored_chunks.iter().map(|(_, score)| *score).collect();
        let min_score = scores.iter().fold(f32::INFINITY, |a, &b| a.min(b));
        let max_score = scores.iter().fold(f32::NEG_INFINITY, |a, &b| a.max(b));
        
        // 如果所有分数相同，返回均匀的高分
        if (max_score - min_score).abs() < f32::EPSILON {
            return vec![1.0; scores.len()];
        }
        
        // Min-Max归一化到[0,1]区间
        scores
            .into_iter()
            .map(|score| (score - min_score) / (max_score - min_score))
            .collect()
    }

    /// 根据chunk_id获取完整的搜索结果
    fn get_search_result_by_id(&self, chunk_id: i64) -> Result<SearchResult> {
        let mut stmt = self.db.connection().prepare(
            r#"
            SELECT 
                id, book_title, book_author, paper_id, md_file_path, file_order_in_book,
                related_chapter_titles, chunk_text, chunk_order_in_file,
                total_chunks_in_file, global_chunk_index, created_at
            FROM document_chunks 
            WHERE id = ?1
            "#
        )?;

        stmt.query_row(params![chunk_id], |row| {
            Ok(SearchResult {
                chunk_id: row.get(0)?,
                book_title: row.get(1)?,
                book_author: row.get(2)?,
                paper_id: row.get(3)?,
                md_file_path: row.get(4)?,
                file_order_in_book: row.get(5)?,
                related_chapter_titles: row.get(6)?,
                chunk_text: row.get(7)?,
                chunk_order_in_file: row.get(8)?,
                total_chunks_in_file: row.get(9)?,
                global_chunk_index: row.get(10)?,
                similarity_score: 1.0, // BM25分数将在外层设置
            })
        }).context("Failed to get search result by chunk_id")
    }
}
