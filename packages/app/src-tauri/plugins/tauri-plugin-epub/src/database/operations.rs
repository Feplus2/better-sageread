use anyhow::Result;
use rusqlite::params;

use crate::database::DatabaseConnection;
use crate::models::DocumentChunk;

/// 数据库操作管理器
pub struct DatabaseOperations<'a> {
    db: &'a mut DatabaseConnection,
}

impl<'a> DatabaseOperations<'a> {
    /// 创建新的数据库操作管理器
    pub fn new(db: &'a mut DatabaseConnection) -> Self {
        Self { db }
    }

    /// 插入单个文档块
    pub fn insert_chunk(&mut self, chunk: &DocumentChunk) -> Result<i64> {
        // 插入文档分块元数据
        let chunk_id = self.db.connection_mut().query_row(
            r#"
            INSERT INTO document_chunks (
                book_title, book_author, paper_id, md_file_path, file_order_in_book,
                related_chapter_titles, chunk_text, chunk_order_in_file,
                total_chunks_in_file, global_chunk_index, is_references
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
            RETURNING id
            "#,
            params![
                chunk.book_title,
                chunk.book_author,
                chunk.paper_id,
                chunk.md_file_path,
                chunk.file_order_in_book,
                chunk.related_chapter_titles,
                chunk.chunk_text,
                chunk.chunk_order_in_file,
                chunk.total_chunks_in_file,
                chunk.global_chunk_index,
                chunk.is_references,
            ],
            |row| row.get(0),
        )?;

        // 插入向量数据
        self.insert_embedding(chunk_id, &chunk.embedding)?;

        Ok(chunk_id)
    }

    /// 按 paper_id 删除文档块及其向量（全局论文库重索引/论文彻底删除时的清理）
    /// 返回删除的分片数；同时使 BM25 统计缓存失效
    pub fn delete_chunks_by_paper_id(&mut self, paper_id: &str) -> Result<usize> {
        fn table_exists(db: &DatabaseConnection, name: &str) -> Result<bool> {
            let count: i64 = db.connection().query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name = ?1",
                params![name],
                |row| row.get(0),
            )?;
            Ok(count > 0)
        }

        let has_vec_table = table_exists(self.db, "chunk_embeddings")?;
        let has_fallback_table = table_exists(self.db, "chunk_embeddings_fallback")?;
        let has_bm25_stats = table_exists(self.db, "bm25_stats")?;

        // vec0 虚拟表与普通表都不支持外键级联，需手工清理
        if has_vec_table {
            self.db.connection_mut().execute(
                "DELETE FROM chunk_embeddings WHERE chunk_id IN (SELECT id FROM document_chunks WHERE paper_id = ?1)",
                params![paper_id],
            )?;
        }
        if has_fallback_table {
            self.db.connection_mut().execute(
                "DELETE FROM chunk_embeddings_fallback WHERE chunk_id IN (SELECT id FROM document_chunks WHERE paper_id = ?1)",
                params![paper_id],
            )?;
        }

        let deleted = self.db.connection_mut().execute(
            "DELETE FROM document_chunks WHERE paper_id = ?1",
            params![paper_id],
        )?;

        // BM25 统计基于全库文档，内容变化后缓存即失效
        if deleted > 0 && has_bm25_stats {
            self.db.connection_mut().execute("DELETE FROM bm25_stats", [])?;
        }

        Ok(deleted)
    }

    /// 插入向量数据到相应的表中
    fn insert_embedding(&mut self, chunk_id: i64, embedding: &[f32]) -> Result<()> {
        if self.db.supports_vector_search() {
            // 使用 sqlite-vec 虚拟表，按照示例代码的方式转换为字节
            let embedding_bytes: Vec<u8> = embedding
                .iter()
                .flat_map(|f| f.to_le_bytes())
                .collect();

            self.db.connection_mut().execute(
                "INSERT INTO chunk_embeddings (chunk_id, embedding) VALUES (?1, ?2)",
                params![chunk_id, embedding_bytes],
            )?;
        } else {
            // 使用后备表存储向量为 BLOB
            let embedding_bytes: Vec<u8> = embedding
                .iter()
                .flat_map(|f| f.to_le_bytes())
                .collect();

            self.db.connection_mut().execute(
                "INSERT INTO chunk_embeddings_fallback (chunk_id, embedding) VALUES (?1, ?2)",
                params![chunk_id, embedding_bytes],
            )?;
        }

        Ok(())
    }

    /// 批量插入文档块
    pub fn insert_chunks_batch(&mut self, chunks: &[DocumentChunk]) -> Result<Vec<i64>> {
        if chunks.is_empty() {
            return Ok(vec![]);
        }

        self.db.begin_transaction()?;

        let result = self.insert_chunks_batch_inner(chunks);

        match result {
            Ok(ids) => {
                self.db.commit_transaction()?;
                // BM25 统计基于全库文档，新增分片后缓存即失效。
                // 删除侧（delete_chunks_by_paper_id）只覆盖"重索引有旧行"的情形；
                // 首次向已有库添加新论文（deleted=0）也必须失效，否则 stale total_docs
                // 会让 idf = ln((N - df + 0.5)/(df + 0.5)) 参数变负产生 NaN 分数。
                self.db.connection_mut().execute("DELETE FROM bm25_stats", [])?;
                Ok(ids)
            }
            Err(e) => {
                self.db.rollback_transaction()?;
                Err(e)
            }
        }
    }

    fn insert_chunks_batch_inner(&mut self, chunks: &[DocumentChunk]) -> Result<Vec<i64>> {
        let mut chunk_ids = Vec::new();
        
        for chunk in chunks {
            let chunk_id = self.insert_chunk(chunk)?;
            chunk_ids.push(chunk_id);
        }
        
        Ok(chunk_ids)
    }
}
