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
            log::warn!("向量表已存在，跳过创建");
        }

        // 初始化BM25相关表
        self.initialize_bm25_tables()
            .with_context(|| "Failed to initialize BM25 tables")?;

        log::info!("Database schema initialized successfully");

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
