pub mod connection;
pub mod operations;
pub mod search;
pub mod bm25;
pub mod hybrid;

// Re-export public types for convenience
pub use connection::*;
pub use operations::*;
pub use search::*;
pub use bm25::*;
pub use hybrid::*;

// Backward compatibility wrapper
use anyhow::{Result};
use std::path::Path;
use rusqlite::params;
use crate::models::{DocumentChunk, SearchResult};

/// 向量数据库包装器，提供向后兼容的API
pub struct VectorDatabase {
    db: DatabaseConnection,
}

impl VectorDatabase {
    /// 创建或打开向量数据库（会初始化schema）
    pub fn new<P: AsRef<Path>>(db_path: P, embedding_dimension: usize) -> Result<Self> {
        let db = DatabaseConnection::new(db_path, embedding_dimension)?;
        Ok(Self { db })
    }

    /// 打开现有的向量数据库（仅用于搜索，不初始化schema）
    pub fn open_for_search<P: AsRef<Path>>(db_path: P, embedding_dimension: usize) -> Result<Self> {
        let db = DatabaseConnection::open_existing(db_path, embedding_dimension)?;
        Ok(Self { db })
    }





    /// 初始化向量表（向后兼容）
    pub fn initialize_vec_table(&mut self) -> Result<()> {
        // 在新的模块化设计中，表初始化在 DatabaseConnection::new 中自动完成
        // 这个方法保留用于向后兼容
        Ok(())
    }



    /// 批量插入文档块
    pub fn insert_chunks_batch(&mut self, chunks: &[DocumentChunk]) -> Result<Vec<i64>> {
        let mut ops = DatabaseOperations::new(&mut self.db);
        ops.insert_chunks_batch(chunks)
    }

    /// 按 paper_id 删除文档块及其向量（全局论文库重索引/论文彻底删除时的清理）
    pub fn delete_chunks_by_paper_id(&mut self, paper_id: &str) -> Result<usize> {
        let mut ops = DatabaseOperations::new(&mut self.db);
        ops.delete_chunks_by_paper_id(paper_id)
    }

    /// 执行向量相似性搜索
    pub fn vector_search(&self, query_embedding: &[f32], limit: usize) -> Result<Vec<SearchResult>> {
        let search = DatabaseSearch::new(&self.db);
        search.vector_search(query_embedding, limit)
    }

    /// 执行向量相似性搜索（可选按 paper_id 集合过滤）
    /// include_references 为 false 时排除参考文献区段分片
    pub fn vector_search_filtered(
        &self,
        query_embedding: &[f32],
        limit: usize,
        paper_ids: Option<&[String]>,
        include_references: bool,
    ) -> Result<Vec<SearchResult>> {
        let search = DatabaseSearch::new(&self.db);
        search.vector_search_filtered(query_embedding, limit, paper_ids, include_references)
    }

    /// 执行混合搜索（BM25 + 向量搜索）
    /// include_references 为 false 时排除参考文献区段分片
    pub fn hybrid_search(
        &self,
        query: &str,
        query_embedding: &[f32],
        limit: usize,
        config: &crate::models::HybridSearchConfig,
        include_references: bool,
    ) -> Result<Vec<SearchResult>> {
        let hybrid_search = HybridSearch::new(&self.db);
        hybrid_search.search_filtered(query, query_embedding, limit, config, None, include_references)
    }

    /// 执行BM25文本搜索
    pub fn bm25_search(&self, query: &str, limit: usize) -> Result<Vec<SearchResult>> {
        let config = crate::models::HybridSearchConfig::default();
        let bm25_search = BM25Search::new(&self.db, config.k1, config.b);
        let bm25_results = bm25_search.search(query, limit)?;

        // 转换为SearchResult格式
        Ok(bm25_results.into_iter().map(|r| {
            let mut result = r.search_result;
            result.similarity_score = r.score;
            result
        }).collect())
    }

    /// 执行BM25文本搜索（可选按 paper_id 集合过滤）
    /// include_references 为 false 时排除参考文献区段分片
    pub fn bm25_search_filtered(
        &self,
        query: &str,
        limit: usize,
        paper_ids: Option<&[String]>,
        include_references: bool,
    ) -> Result<Vec<SearchResult>> {
        let config = crate::models::HybridSearchConfig::default();
        let bm25_search = BM25Search::new(&self.db, config.k1, config.b);
        let bm25_results = bm25_search.search_filtered(query, limit, paper_ids, include_references)?;

        // 转换为SearchResult格式
        Ok(bm25_results.into_iter().map(|r| {
            let mut result = r.search_result;
            result.similarity_score = r.score;
            result
        }).collect())
    }



    // 移除了未使用的search_similar方法

    /// 统一搜索接口，支持所有搜索模式
    /// 旧封装：不过滤参考文献区段（行为不变）
    pub fn search_with_mode(
        &self,
        query: &str,
        query_embedding: Option<&[f32]>,
        limit: usize,
        config: &crate::models::HybridSearchConfig,
    ) -> Result<Vec<SearchResult>> {
        use crate::models::SearchMode;

        match config.mode {
            SearchMode::VectorOnly => {
                if let Some(embedding) = query_embedding {
                    self.vector_search(embedding, limit)
                } else {
                    Err(anyhow::anyhow!("Vector embedding required for vector-only search"))
                }
            }
            SearchMode::BM25Only => {
                self.bm25_search(query, limit)
            }
            SearchMode::Hybrid => {
                if let Some(embedding) = query_embedding {
                    self.hybrid_search(query, embedding, limit, config, true)
                } else {
                    // 如果没有向量，回退到BM25搜索
                    self.bm25_search(query, limit)
                }
            }
        }
    }

    /// 统一搜索接口（可选按 paper_id 集合过滤，供全局论文库使用）
    /// include_references 为 false 时排除参考文献区段分片
    pub fn search_with_mode_filtered(
        &self,
        query: &str,
        query_embedding: Option<&[f32]>,
        limit: usize,
        config: &crate::models::HybridSearchConfig,
        paper_ids: Option<&[String]>,
        include_references: bool,
    ) -> Result<Vec<SearchResult>> {
        use crate::models::SearchMode;

        match config.mode {
            SearchMode::VectorOnly => {
                if let Some(embedding) = query_embedding {
                    self.vector_search_filtered(embedding, limit, paper_ids, include_references)
                } else {
                    Err(anyhow::anyhow!("Vector embedding required for vector-only search"))
                }
            }
            SearchMode::BM25Only => {
                self.bm25_search_filtered(query, limit, paper_ids, include_references)
            }
            SearchMode::Hybrid => {
                if let Some(embedding) = query_embedding {
                    let hybrid_search = HybridSearch::new(&self.db);
                    hybrid_search.search_filtered(query, embedding, limit, config, paper_ids, include_references)
                } else {
                    // 如果没有向量，回退到BM25搜索
                    self.bm25_search_filtered(query, limit, paper_ids, include_references)
                }
            }
        }
    }

    pub fn get_chunk_with_context(
        &self,
        chunk_id: i64,
        prev_count: usize,
        next_count: usize,
    ) -> Result<Vec<DocumentChunk>> {
        // 先获取目标chunk的global_chunk_index
        let target_global_index: i64 = self.db.connection().query_row(
            "SELECT global_chunk_index FROM document_chunks WHERE id = ?1",
            params![chunk_id],
            |row| row.get(0),
        )?;
        
        // 计算范围
        let start_index = (target_global_index - prev_count as i64).max(0);
        let end_index = target_global_index + next_count as i64;
        
        // 查询范围内的所有分块
        let mut stmt = self.db.connection().prepare(
            r#"
            SELECT 
                id, book_title, book_author, paper_id, md_file_path, file_order_in_book,
                related_chapter_titles, chunk_text, chunk_order_in_file,
                total_chunks_in_file, global_chunk_index, created_at
            FROM document_chunks 
            WHERE global_chunk_index BETWEEN ?1 AND ?2
            ORDER BY global_chunk_index
            "#
        )?;

        let rows = stmt.query_map(params![start_index, end_index], |row| {
            Ok(DocumentChunk {
                id: Some(row.get(0)?),
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
                embedding: Vec::new(), // 向量数据不需要返回
                is_references: false,  // 上下文扩展不从 SELECT 带出该列，恒 false
            })
        })?;

        let chunks: Result<Vec<_>, _> = rows.collect();
        chunks.map_err(|e| anyhow::anyhow!("Failed to collect context chunks: {}", e))
    }

    /// 按 chunk_id 取同一 paper_id 内的前后邻居分块（全局论文库版 get_chunk_with_context）。
    /// 全局库中 global_chunk_index 是每篇论文内递增的，必须按 paper_id 过滤，否则会串到相邻论文的分块。
    pub fn get_paper_chunk_context(
        &self,
        chunk_id: i64,
        before: usize,
        after: usize,
    ) -> Result<Vec<DocumentChunk>> {
        // 先定位目标分块所属的 paper_id 与论文内序号
        let (paper_id, target_global_index): (String, i64) = self.db.connection().query_row(
            "SELECT paper_id, global_chunk_index FROM document_chunks WHERE id = ?1",
            params![chunk_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;

        // 计算范围
        let start_index = (target_global_index - before as i64).max(0);
        let end_index = target_global_index + after as i64;

        // 查询同一论文内的邻域分块
        let mut stmt = self.db.connection().prepare(
            r#"
            SELECT
                id, book_title, book_author, paper_id, md_file_path, file_order_in_book,
                related_chapter_titles, chunk_text, chunk_order_in_file,
                total_chunks_in_file, global_chunk_index
            FROM document_chunks
            WHERE paper_id = ?1 AND global_chunk_index BETWEEN ?2 AND ?3
            ORDER BY global_chunk_index
            "#
        )?;

        let rows = stmt.query_map(params![paper_id, start_index, end_index], |row| {
            Ok(DocumentChunk {
                id: Some(row.get(0)?),
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
                embedding: Vec::new(), // 向量数据不需要返回
                is_references: false,  // 上下文扩展不从 SELECT 带出该列，恒 false
            })
        })?;

        let chunks: Result<Vec<_>, _> = rows.collect();
        chunks.map_err(|e| anyhow::anyhow!("Failed to collect paper context chunks: {}", e))
    }

    /// 基于章节标题搜索分块（向后兼容）
    pub fn search_chunks_by_chapter(&self, chapter_query: &str, limit: usize) -> Result<Vec<DocumentChunk>> {
        let search = DatabaseSearch::new(&self.db);
        let results = search.text_search(chapter_query, limit)?;
        Ok(results.into_iter().map(|r| DocumentChunk {
            id: Some(r.chunk_id),
            book_title: r.book_title,
            book_author: r.book_author,
            paper_id: r.paper_id,
            md_file_path: r.md_file_path,
            file_order_in_book: r.file_order_in_book,
            related_chapter_titles: r.related_chapter_titles,
            chunk_text: r.chunk_text,
            chunk_order_in_file: r.chunk_order_in_file,
            total_chunks_in_file: r.total_chunks_in_file,
            global_chunk_index: r.global_chunk_index,
            embedding: Vec::new(),
            is_references: false, // SearchResult 不带出该列，恒 false
        }).collect())
    }

    /// 通过章节标题精确获取所有相关分块（向后兼容）
    pub fn get_chunks_by_chapter_title(&self, chapter_title: &str) -> Result<Vec<DocumentChunk>> {
        self.search_chunks_by_chapter(chapter_title, 100)
    }



    /// 根据全局分块索引范围获取分块（向后兼容）
    pub fn get_chunks_by_global_index_range(&self, start_index: usize, end_index: usize) -> Result<Vec<DocumentChunk>> {
        use rusqlite::params;
        use anyhow::Context;

        let mut stmt = self.db.connection().prepare(
            r#"
            SELECT
                id, book_title, book_author, paper_id, md_file_path,
                file_order_in_book, related_chapter_titles, chunk_text,
                chunk_order_in_file, total_chunks_in_file, global_chunk_index
            FROM document_chunks
            WHERE global_chunk_index >= ?1 AND global_chunk_index < ?2
            ORDER BY global_chunk_index ASC
            "#,
        )?;

        let chunks = stmt.query_map(params![start_index, end_index], |row| {
            Ok(DocumentChunk {
                id: Some(row.get(0)?),
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
                embedding: Vec::new(),
                is_references: false, // 不从 SELECT 带出该列，恒 false
            })
        })?;

        let mut results = Vec::new();
        for chunk in chunks {
            results.push(chunk.context("Failed to load chunk from database")?);
        }

        Ok(results)
    }

}


