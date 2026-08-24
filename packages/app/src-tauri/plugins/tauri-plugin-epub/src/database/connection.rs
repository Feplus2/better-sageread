use anyhow::{Context, Result};
use rusqlite::ffi::{sqlite3_auto_extension};
use rusqlite::Connection;
use sqlite_vec::sqlite3_vec_init;
use std::path::Path;

/// 数据库连接管理器
pub struct DatabaseConnection {
    conn: Connection,
    embedding_dimension: usize,
}

impl DatabaseConnection {
    /// 创建新的数据库连接
    pub fn new<P: AsRef<Path>>(db_path: P, embedding_dimension: usize) -> Result<Self> {
        let db_path = db_path.as_ref();
        log::info!("Attempting to create database connection at: {:?}", db_path);
        log::info!("Database embedding dimension: {}", embedding_dimension);

        // 检查父目录是否存在，如果不存在则创建
        if let Some(parent) = db_path.parent() {
            if !parent.exists() {
                log::info!("Creating parent directory: {:?}", parent);
                std::fs::create_dir_all(parent)
                    .with_context(|| format!("Failed to create parent directory: {:?}", parent))?;
            } else {
                log::info!("Parent directory exists: {:?}", parent);
            }
        }

        // 检查数据库文件状态
        if db_path.exists() {
            log::info!("Database file already exists");
        } else {
            log::info!("Creating new database file");
        }

        // 注册 sqlite-vec 扩展（使用正确的方式）
        unsafe {
            sqlite3_auto_extension(Some(std::mem::transmute(sqlite3_vec_init as *const ())));
        }

        // 打开数据库连接
        let conn = Connection::open(db_path)
            .with_context(|| format!("Failed to open database at {:?}", db_path))?;

        // 验证数据库连接
        conn.query_row("SELECT 1", [], |_row| Ok(()))
            .with_context(|| "Database connection is not functional")?;
            
        log::info!("Database connection established successfully");

        let mut db = Self {
            conn,
            embedding_dimension,
        };

        db.initialize_schema()
            .with_context(|| "Failed to initialize database schema")?;
        
        log::info!("Database initialized successfully");
        Ok(db)
    }

    /// 打开现有数据库（不初始化schema，仅用于搜索）
    pub fn open_existing<P: AsRef<Path>>(db_path: P, embedding_dimension: usize) -> Result<Self> {
        let db_path = db_path.as_ref();
        log::info!("Opening existing database for search at: {:?}", db_path);

        // 注册 sqlite-vec 扩展（搜索时也需要）
        unsafe {
            sqlite3_auto_extension(Some(std::mem::transmute(sqlite3_vec_init as *const ())));
        }

        // 打开数据库连接
        let conn = Connection::open(db_path)
            .with_context(|| format!("Failed to open database at {:?}", db_path))?;

        // 验证数据库连接
        conn.query_row("SELECT 1", [], |_row| Ok(()))
            .with_context(|| "Database connection is not functional")?;

        log::info!("Database connection established for search");

        let db = Self {
            conn,
            embedding_dimension,
        };

        // 确保BM25表存在（混合搜索需要）
        db.initialize_bm25_tables()
            .with_context(|| "Failed to initialize BM25 tables for search")?;

        // 老库幂等迁移：补充 paper_id 列与索引（全局论文库按 paper_id 过滤检索需要）
        db.migrate_paper_id_column()
            .with_context(|| "Failed to migrate paper_id column for search")?;

        // 老库幂等迁移：补充 is_references 列（检索默认排除参考文献区段需要）
        db.migrate_is_references_column()
            .with_context(|| "Failed to migrate is_references column for search")?;

        Ok(db)
    }

    /// 幂等迁移：document_chunks 增加 paper_id 列与 idx_paper_id 索引（已存在则跳过）
    fn migrate_paper_id_column(&self) -> Result<()> {
        let has_paper_id = self
            .conn
            .prepare("PRAGMA table_info(document_chunks)")?
            .query_map([], |row| row.get::<_, String>(1))?
            .any(|name| name.map(|n| n == "paper_id").unwrap_or(false));

        if !has_paper_id {
            log::info!("Migrating document_chunks: adding paper_id column");
            self.conn.execute(
                "ALTER TABLE document_chunks ADD COLUMN paper_id TEXT NOT NULL DEFAULT ''",
                [],
            ).with_context(|| "Failed to add paper_id column to document_chunks")?;
        }

        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_paper_id ON document_chunks(paper_id)",
            [],
        ).with_context(|| "Failed to create idx_paper_id index")?;

        Ok(())
    }

    /// 幂等迁移：document_chunks 增加 is_references 列（已存在则跳过，不建索引）
    fn migrate_is_references_column(&self) -> Result<()> {
        let has_is_references = self
            .conn
            .prepare("PRAGMA table_info(document_chunks)")?
            .query_map([], |row| row.get::<_, String>(1))?
            .any(|name| name.map(|n| n == "is_references").unwrap_or(false));

        if !has_is_references {
            log::info!("Migrating document_chunks: adding is_references column");
            self.conn.execute(
                "ALTER TABLE document_chunks ADD COLUMN is_references INTEGER NOT NULL DEFAULT 0",
                [],
            ).with_context(|| "Failed to add is_references column to document_chunks")?;
        }

        Ok(())
    }

    /// 初始化数据库模式
    fn initialize_schema(&mut self) -> Result<()> {
        log::info!("Setting SQLite pragmas for performance...");
        
        // 设置性能优化参数（容错处理）
        let _ = self.conn.execute("PRAGMA synchronous=NORMAL", []);
        let _ = self.conn.execute("PRAGMA cache_size=10000", []);
        let _ = self.conn.execute("PRAGMA temp_store=memory", []);
        log::info!("SQLite pragmas configured");

        // 创建主表
        self.conn.execute(
            r#"
            CREATE TABLE IF NOT EXISTS document_chunks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                book_title TEXT NOT NULL,
                book_author TEXT NOT NULL,
                paper_id TEXT NOT NULL DEFAULT '',
                md_file_path TEXT NOT NULL,
                file_order_in_book INTEGER NOT NULL,
                related_chapter_titles TEXT NOT NULL,
                chunk_text TEXT NOT NULL,
                chunk_order_in_file INTEGER NOT NULL,
                total_chunks_in_file INTEGER NOT NULL,
                global_chunk_index INTEGER NOT NULL,
                is_references INTEGER NOT NULL DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                
                -- 创建索引以提高查询性能
                UNIQUE(book_title, book_author, md_file_path, chunk_order_in_file)
            )
            "#,
            [],
        ).with_context(|| "Failed to create document_chunks table")?;

        // 老库幂等迁移：补充 paper_id 列与索引（打开 per-book 旧库时同样生效）
        self.migrate_paper_id_column()
            .with_context(|| "Failed to migrate paper_id column")?;

        // 老库幂等迁移：补充 is_references 列（打开 per-book 旧库时同样生效）
        self.migrate_is_references_column()
            .with_context(|| "Failed to migrate is_references column")?;

        // 创建索引
        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_book_info ON document_chunks(book_title, book_author)",
            [],
        ).with_context(|| "Failed to create idx_book_info index")?;
        
        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_file_order ON document_chunks(file_order_in_book)",
            [],
        ).with_context(|| "Failed to create idx_file_order index")?;
        
        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_global_chunk ON document_chunks(global_chunk_index)",
            [],
        ).with_context(|| "Failed to create idx_global_chunk index")?;

        // 创建向量表（如果不存在的话）
        let table_exists = self.conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='chunk_embeddings'",
            [],
            |row| Ok(row.get::<_, i64>(0)? > 0)
        )?;

        if !table_exists {
            if let Err(e) = self.create_vector_table() {
                log::warn!("sqlite-vec不可用，使用后备表: {}", e);
                log::info!("尝试创建后备表，维度: {}", self.embedding_dimension);
                self.create_fallback_table()
                    .with_context(|| "Failed to create fallback vector table")?;
            } else {
                log::info!("vec0虚拟表创建成功，维度: {}", self.embedding_dimension);
            }
        } else {
            // 维度自愈：vec0 表维度在建表时钉死（FLOAT[N]），换不同维度的嵌入模型后写不进——
            // 检出表维度与当前模型维度不一致则重建（旧向量随表废弃，论文经 stale 判定引导重向量化）
            match self.existing_vector_dimension() {
                Ok(Some(existing)) if existing != self.embedding_dimension => {
                    self.rebuild_vector_table()
                        .with_context(|| "Failed to rebuild vector table for new embedding dimension")?;
                }
                Ok(Some(_)) => log::info!("向量表已存在且维度一致，跳过创建"),
                Ok(None) => log::warn!("向量表已存在但维度无法解析，保持原样"),
                Err(e) => log::warn!("读取向量表维度失败，保持原样: {}", e),
            }
        }

        // 初始化BM25相关表
        self.initialize_bm25_tables()
            .with_context(|| "Failed to initialize BM25 tables")?;

        log::info!("Database schema initialized successfully");

        Ok(())
    }



    /// 检索路径维度自检：vec0 表维度与当前嵌入模型维度不一致时返回 true。
    /// 维度自愈只在写入路径（initialize_schema 重建向量表）生效；open_existing 不重建表，
    /// 换维度模型后、首次重向量化前，hybrid 检索会拿新维度查询向量打旧维度表
    /// （sqlite-vec 维度不匹配报错）——检索侧据此降级 BM25-only。
    /// 无 vec0 表（fallback 路径余弦按长度不等计 0，不报错）或维度无法解析时返回 false（保持原样）。
    pub fn vector_dimension_mismatch(&self) -> bool {
        if !self.supports_vector_search() {
            return false;
        }
        match self.existing_vector_dimension() {
            Ok(Some(existing)) => existing != self.embedding_dimension,
            _ => false,
        }
    }

    /// 读取现有 vec0 表的向量维度（vec0 不向 PRAGMA table_info 报列类型，
    /// 但 sqlite_master.sql 保留原始建表语句，形如 "embedding FLOAT[2048]"；解析失败返回 None）
    fn existing_vector_dimension(&self) -> Result<Option<usize>> {
        let sql: String = self.conn.query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='chunk_embeddings'",
            [],
            |row| row.get(0),
        )?;
        Ok(parse_vec0_dimension(&sql))
    }

    /// 维度不一致时重建向量表：drop 旧 vec0/fallback 表、清全部分片与 BM25 统计
    /// （分片脱离向量即成死索引，连同 document_chunks 一起清），再以当前维度重建。
    /// 全库旧论文向量随之失效——状态查询（分片数=0）自然判 stale，引导重新向量化
    fn rebuild_vector_table(&mut self) -> Result<()> {
        log::warn!(
            "嵌入模型维度变更：现有向量表维度与当前维度（{}）不一致，重建向量表（全库旧向量失效，需重新向量化）",
            self.embedding_dimension
        );
        self.conn
            .execute("DROP TABLE IF EXISTS chunk_embeddings", [])
            .with_context(|| "Failed to drop chunk_embeddings")?;
        self.conn
            .execute("DROP TABLE IF EXISTS chunk_embeddings_fallback", [])
            .with_context(|| "Failed to drop chunk_embeddings_fallback")?;
        self.conn
            .execute("DELETE FROM document_chunks", [])
            .with_context(|| "Failed to clear document_chunks")?;
        // bm25_stats 全库统计缓存，随内容清空（老库可能尚未建表，容错忽略）
        let _ = self.conn.execute("DELETE FROM bm25_stats", []);

        if let Err(e) = self.create_vector_table() {
            log::warn!("sqlite-vec不可用，使用后备表: {}", e);
            self.create_fallback_table()
                .with_context(|| "Failed to create fallback vector table")?;
        }
        log::warn!("向量表已按维度 {} 重建完成", self.embedding_dimension);
        Ok(())
    }

    /// 创建向量表（简单版本）
    fn create_vector_table(&self) -> Result<()> {
        let create_sql = format!(
            r#"
            CREATE VIRTUAL TABLE chunk_embeddings USING vec0(
                chunk_id INTEGER PRIMARY KEY,
                embedding FLOAT[{}]
            )
            "#,
            self.embedding_dimension
        );

        self.conn.execute(&create_sql, [])
            .with_context(|| format!("Failed to create vec0 virtual table with dimension {}", self.embedding_dimension))?;

        log::info!("向量表创建成功，维度: {}", self.embedding_dimension);
        Ok(())
    }

    /// 创建后备表（标准 SQLite 表）
    fn create_fallback_table(&self) -> Result<()> {
        let create_sql = r#"
            CREATE TABLE chunk_embeddings_fallback (
                chunk_id INTEGER PRIMARY KEY,
                embedding BLOB NOT NULL,
                FOREIGN KEY (chunk_id) REFERENCES document_chunks (id) ON DELETE CASCADE
            )
            "#;

        self.conn.execute(create_sql, [])
            .with_context(|| "Failed to create chunk_embeddings_fallback table")?;

        log::info!("后备表创建成功");
        Ok(())
    }

    /// 检查是否支持向量搜索
    pub fn supports_vector_search(&self) -> bool {
        // 检查是否存在 vec0 虚拟表
        let result: Result<i32, _> = self.conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='chunk_embeddings'",
            [],
            |row| row.get(0),
        );

        result.unwrap_or(0) > 0
    }

    /// 获取数据库连接的引用
    pub fn connection(&self) -> &Connection {
        &self.conn
    }

    /// 获取数据库连接的可变引用
    pub fn connection_mut(&mut self) -> &mut Connection {
        &mut self.conn
    }



    /// 开始事务
    pub fn begin_transaction(&mut self) -> Result<()> {
        self.conn.execute("BEGIN TRANSACTION", [])?;
        Ok(())
    }

    /// 提交事务
    pub fn commit_transaction(&mut self) -> Result<()> {
        self.conn.execute("COMMIT", [])?;
        Ok(())
    }

    /// 回滚事务
    pub fn rollback_transaction(&mut self) -> Result<()> {
        self.conn.execute("ROLLBACK", [])?;
        Ok(())
    }

    /// 初始化BM25相关表
    fn initialize_bm25_tables(&self) -> Result<()> {
        // 创建BM25统计信息表
        self.conn.execute(
            r#"
            CREATE TABLE IF NOT EXISTS bm25_stats (
                total_docs INTEGER NOT NULL,
                avg_doc_length REAL NOT NULL,
                updated_at TEXT NOT NULL
            )
            "#,
            [],
        ).with_context(|| "Failed to create bm25_stats table")?;

        log::info!("BM25 tables initialized successfully");
        Ok(())
    }

}

/// 从 vec0 建表语句解析向量维度（含 "FLOAT[2048]" → Some(2048)；不含/非法 → None，保持原样不重建）
fn parse_vec0_dimension(create_sql: &str) -> Option<usize> {
    let start = create_sql.find("FLOAT[")? + "FLOAT[".len();
    let rest = &create_sql[start..];
    let end = rest.find(']')?;
    if end == 0 {
        return None;
    }
    rest[..end].parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::DatabaseOperations;
    use tempfile::NamedTempFile;

    fn insert_one_chunk(db: &mut DatabaseConnection, dimension: usize, paper_id: &str) {
        let chunk = crate::models::DocumentChunk {
            id: None,
            book_title: "Test Paper".to_string(),
            book_author: "Test Author".to_string(),
            paper_id: paper_id.to_string(),
            md_file_path: "paper.md".to_string(),
            file_order_in_book: 0,
            related_chapter_titles: "Test Paper".to_string(),
            chunk_text: "chunk text".to_string(),
            chunk_order_in_file: 0,
            total_chunks_in_file: 1,
            embedding: vec![0.1; dimension],
            global_chunk_index: 0,
            is_references: false,
        };
        DatabaseOperations::new(db).insert_chunk(&chunk).unwrap();
    }

    fn chunk_count(db: &DatabaseConnection) -> i64 {
        db.connection()
            .query_row("SELECT COUNT(*) FROM document_chunks", [], |row| row.get(0))
            .unwrap()
    }

    #[test]
    fn test_parse_vec0_dimension() {
        let create_sql = "CREATE VIRTUAL TABLE chunk_embeddings USING vec0(\n chunk_id INTEGER PRIMARY KEY,\n embedding FLOAT[2048]\n)";
        assert_eq!(parse_vec0_dimension(create_sql), Some(2048));
        assert_eq!(parse_vec0_dimension("embedding FLOAT[384]"), Some(384));
        // 非法形态一律 None（不重建，保持原样）
        assert_eq!(parse_vec0_dimension("embedding FLOAT[]"), None);
        assert_eq!(parse_vec0_dimension("CREATE TABLE t (embedding BLOB)"), None);
        assert_eq!(parse_vec0_dimension(""), None);
        assert_eq!(parse_vec0_dimension("embedding FLOAT[abc]"), None);
    }

    #[test]
    fn test_dimension_unchanged_keeps_data() {
        let temp_file = NamedTempFile::new().unwrap();
        {
            let mut db = DatabaseConnection::new(temp_file.path(), 4).unwrap();
            insert_one_chunk(&mut db, 4, "paper-a");
        }
        // 同维度重开：不重建，分片保留
        let db = DatabaseConnection::new(temp_file.path(), 4).unwrap();
        assert_eq!(db.existing_vector_dimension().unwrap(), Some(4));
        assert_eq!(chunk_count(&db), 1);
    }

    #[test]
    fn test_dimension_change_rebuilds_table() {
        let temp_file = NamedTempFile::new().unwrap();
        {
            let mut db = DatabaseConnection::new(temp_file.path(), 4).unwrap();
            insert_one_chunk(&mut db, 4, "paper-a");
        }
        // 换不同维度的嵌入模型重开：vec0 表按新维度重建，旧分片/向量清空（stale 判定依赖分片数=0）
        let mut db = DatabaseConnection::new(temp_file.path(), 8).unwrap();
        assert_eq!(db.existing_vector_dimension().unwrap(), Some(8));
        assert_eq!(chunk_count(&db), 0);
        // 重建后可按新维度正常写入（自愈目标：不再因维度钉死而写不进）
        insert_one_chunk(&mut db, 8, "paper-b");
        assert_eq!(chunk_count(&db), 1);
    }

    #[test]
    fn test_open_existing_dimension_mismatch_detected() {
        let temp_file = NamedTempFile::new().unwrap();
        {
            let mut db = DatabaseConnection::new(temp_file.path(), 4).unwrap();
            insert_one_chunk(&mut db, 4, "paper-a");
        }
        // 检索路径（open_existing）不自愈不重建：换维度模型打开时检出维度不一致，供检索降级 BM25
        let db = DatabaseConnection::open_existing(temp_file.path(), 8).unwrap();
        assert!(db.vector_dimension_mismatch());
        // 同维度打开：不误报
        let db = DatabaseConnection::open_existing(temp_file.path(), 4).unwrap();
        assert!(!db.vector_dimension_mismatch());
    }

    #[test]
    fn test_open_existing_mismatch_bm25_fallback_works() {
        let temp_file = NamedTempFile::new().unwrap();
        {
            let mut db = DatabaseConnection::new(temp_file.path(), 4).unwrap();
            insert_one_chunk(&mut db, 4, "paper-a");
        }
        // 维度不一致时 hybrid 查询会撞 sqlite-vec 维度错误；降级路径（无查询向量）走 BM25 不报错
        let db = DatabaseConnection::open_existing(temp_file.path(), 8).unwrap();
        assert!(db.vector_dimension_mismatch());
        let vdb = crate::database::VectorDatabase::open_for_search(temp_file.path(), 8).unwrap();
        let config = crate::models::HybridSearchConfig::default();
        let results = vdb
            .search_with_mode_filtered("chunk text", None, 5, &config, None, false)
            .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].paper_id, "paper-a");
        // 对照：维度一致时 hybrid 向量检索正常（不触发降级）
        let vdb_ok = crate::database::VectorDatabase::open_for_search(temp_file.path(), 4).unwrap();
        assert!(!vdb_ok.vector_dimension_mismatch());
        let embedding = vec![0.1; 4];
        let results = vdb_ok
            .search_with_mode_filtered("chunk text", Some(&embedding), 5, &config, None, false)
            .unwrap();
        assert_eq!(results.len(), 1);
    }
}

