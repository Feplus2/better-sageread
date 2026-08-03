use sqlx::{migrate::MigrateDatabase, Sqlite, SqlitePool};
use std::fs;
use tauri::{AppHandle, Manager};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Deserialize, Serialize, Debug)]
struct DefaultSkill {
    name: String,
    content: String,
    is_system: bool,
    is_active: bool,
}

pub async fn initialize(app_handle: &AppHandle) -> Result<SqlitePool, Box<dyn std::error::Error>> {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;

    let db_dir = app_data_dir.join("database");
    fs::create_dir_all(&db_dir)?;

    let db_path = db_dir.join("app.db");
    let db_url = format!(
        "sqlite:{}",
        db_path.to_str().ok_or("Invalid database path")?
    );

    let is_new_db = !Sqlite::database_exists(&db_url).await.unwrap_or(false);
    
    if is_new_db {
        Sqlite::create_database(&db_url).await?;
        println!("Database created at: {}", db_url);
    } else {
        println!("Database found at: {}", db_url);
    }

    let pool = SqlitePool::connect(&db_url).await?;

    sqlx::query(include_str!("./schema.sql"))
        .execute(&pool)
        .await?;
    println!("Database schema initialized.");

    run_migrations(&pool).await?;

    if is_new_db {
        initialize_default_skills(&pool).await?;
    }

    Ok(pool)
}

/// fork 专属迁移通道：上游同步 schema.sql 时的增量变更都放这里，避免改 schema.sql 冲突。
/// 所有迁移必须幂等。
async fn run_migrations(pool: &SqlitePool) -> Result<(), Box<dyn std::error::Error>> {
    // threads.starred（对话星标）：已存在时忽略 duplicate column 错误
    let result = sqlx::query("ALTER TABLE threads ADD COLUMN starred INTEGER NOT NULL DEFAULT 0")
        .execute(pool)
        .await;

    match result {
        Ok(_) => println!("Migration applied: threads.starred added."),
        Err(e) if e.to_string().contains("duplicate column name") => {}
        Err(e) => return Err(e.into()),
    }

    // books.trashed_at（回收站软删除时间戳，毫秒，可空）
    let result = sqlx::query("ALTER TABLE books ADD COLUMN trashed_at INTEGER")
        .execute(pool)
        .await;

    match result {
        Ok(_) => println!("Migration applied: books.trashed_at added."),
        Err(e) if e.to_string().contains("duplicate column name") => {}
        Err(e) => return Err(e.into()),
    }

    // book_status.position_changed_at（真进度时间戳，同步合并用，回填 = last_read_at）
    let result = sqlx::query("ALTER TABLE book_status ADD COLUMN position_changed_at INTEGER")
        .execute(pool)
        .await;

    match result {
        Ok(_) => println!("Migration applied: book_status.position_changed_at added."),
        Err(e) if e.to_string().contains("duplicate column name") => {}
        Err(e) => return Err(e.into()),
    }

    // book_status.dwell_seconds（当前位置的累计活跃阅读秒数，位置变化时清零）
    let result = sqlx::query("ALTER TABLE book_status ADD COLUMN dwell_seconds INTEGER DEFAULT 0")
        .execute(pool)
        .await;

    match result {
        Ok(_) => println!("Migration applied: book_status.dwell_seconds added."),
        Err(e) if e.to_string().contains("duplicate column name") => {}
        Err(e) => return Err(e.into()),
    }

    // 回填：已有进度的 position_changed_at 视为 last_read_at（幂等，只填 NULL）
    sqlx::query("UPDATE book_status SET position_changed_at = last_read_at WHERE position_changed_at IS NULL AND last_read_at IS NOT NULL")
        .execute(pool)
        .await?;
    println!("Migration applied: book_status.position_changed_at backfilled.");

    // threads.scope（对话作用域：'global'=全局助手, 'book'=阅读助手）
    let result = sqlx::query("ALTER TABLE threads ADD COLUMN scope TEXT NOT NULL DEFAULT 'book'")
        .execute(pool)
        .await;

    match result {
        Ok(_) => println!("Migration applied: threads.scope added."),
        Err(e) if e.to_string().contains("duplicate column name") => {}
        Err(e) => return Err(e.into()),
    }

    // skills.scope（技能生效对象：'reader'/'central'/'both'）
    let result = sqlx::query("ALTER TABLE skills ADD COLUMN scope TEXT NOT NULL DEFAULT 'both'")
        .execute(pool)
        .await;

    match result {
        Ok(_) => println!("Migration applied: skills.scope added."),
        Err(e) if e.to_string().contains("duplicate column name") => {}
        Err(e) => return Err(e.into()),
    }

    // 将现有 isSystem 技能固定为 scope='reader'
    sqlx::query("UPDATE skills SET scope = 'reader' WHERE is_system = 1")
        .execute(pool)
        .await?;

    // L2 增量同步：变更日志表 + 七张同步表的触发器（CREATE TRIGGER IF NOT EXISTS 幂等）
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS _sync_log (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            table_name TEXT NOT NULL,
            row_id TEXT NOT NULL,
            op TEXT NOT NULL,
            at INTEGER NOT NULL
        )",
    )
    .execute(pool)
    .await?;

    const SYNC_TABLES: [(&str, &str); 7] = [
        ("books", "id"),
        ("book_status", "book_id"),
        ("book_notes", "id"),
        ("threads", "id"),
        ("reading_sessions", "id"),
        ("skills", "id"),
        ("tags", "id"),
    ];

    for (table, pk) in SYNC_TABLES {
        for (suffix, op, key) in [
            ("ai", "INSERT", format!("NEW.{pk}")),
            ("au", "UPDATE", format!("NEW.{pk}")),
            ("ad", "DELETE", format!("OLD.{pk}")),
        ] {
            let sql = format!(
                "CREATE TRIGGER IF NOT EXISTS _sync_{table}_{suffix} AFTER {op} ON {table} BEGIN
                    INSERT INTO _sync_log (table_name, row_id, op, at)
                    VALUES ('{table}', {key}, '{op}', CAST(strftime('%s','now') AS INTEGER) * 1000);
                END"
            );
            sqlx::query(&sql).execute(pool).await?;
        }
    }
    println!("Migration applied: _sync_log + sync triggers.");

    // notes 概念废弃（2026-08）：独立"笔记"全部迁移到 book_notes，删表清库。
    // DROP TABLE 幂等，且连带删除其上的 _sync_notes_* 触发器；同时清掉 _sync_log 里的残留行
    sqlx::query("DROP TABLE IF EXISTS notes").execute(pool).await?;
    sqlx::query("DELETE FROM _sync_log WHERE table_name = 'notes'")
        .execute(pool)
        .await?;
    println!("Migration applied: notes table dropped.");

    // 文献库文件夹模型（§3.2）：folders 树表 + paper_folders 多对多关系表（IF NOT EXISTS 幂等）。
    // 删除文件夹时：子文件夹经 parent_id 级联删除，paper_folders 行经 folder_id 级联删除（论文本身不动）。
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS folders (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS paper_folders (
            paper_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
            folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
            PRIMARY KEY (paper_id, folder_id)
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_paper_folders_folder ON paper_folders(folder_id)")
        .execute(pool)
        .await?;
    println!("Migration applied: folders + paper_folders.");

    // folders.trashed_at（文件夹回收站软删除时间戳，毫秒，可空）
    let result = sqlx::query("ALTER TABLE folders ADD COLUMN trashed_at INTEGER")
        .execute(pool)
        .await;

    match result {
        Ok(_) => println!("Migration applied: folders.trashed_at added."),
        Err(e) if e.to_string().contains("duplicate column name") => {}
        Err(e) => return Err(e.into()),
    }

    // 提示词预设（B 批）：阅读/论文助手的命名系统提示词，同 scope 内 is_active 互斥，
    // 无激活行 = 使用内置默认提示词（IF NOT EXISTS 幂等）。
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS prompt_presets (
            id TEXT PRIMARY KEY,
            scope TEXT NOT NULL,
            name TEXT NOT NULL,
            content TEXT NOT NULL,
            is_active INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_prompt_presets_scope ON prompt_presets(scope)")
        .execute(pool)
        .await?;
    println!("Migration applied: prompt_presets.");

    // 阅读助手系统提示词 v2（2026-07-27）：Agent 一分为二后聚焦"读懂这本书"，
    // 新增全局事务引导、webSearch、只读声明。仅升级未被用户修改过的 v1
    // （v1 以固定开场白开头且不含"全局助手"字样），用户自定义过的不动。
    if let Ok(default_skills) = serde_json::from_str::<Vec<DefaultSkill>>(include_str!("./default-skills.json")) {
        if let Some(system_skill) = default_skills.iter().find(|s| s.is_system) {
            let result = sqlx::query(
                "UPDATE skills SET content = ?, updated_at = ?
                 WHERE is_system = 1
                   AND content LIKE '你是一位**亲切、耐心的阅读向导**%'
                   AND content NOT LIKE '%全局助手%'",
            )
            .bind(&system_skill.content)
            .bind(chrono::Utc::now().timestamp_millis())
            .execute(pool)
            .await;
            if let Ok(done) = result {
                if done.rows_affected() > 0 {
                    println!("Migration applied: reader system prompt upgraded to v2 ({} row(s)).", done.rows_affected());
                }
            }
        }
    }

    // book_notes.category（C2 AI 重点标注的类别 id，如 goal/methods；NULL=人工标注）
    let result = sqlx::query("ALTER TABLE book_notes ADD COLUMN category TEXT")
        .execute(pool)
        .await;

    match result {
        Ok(_) => println!("Migration applied: book_notes.category added."),
        Err(e) if e.to_string().contains("duplicate column name") => {}
        Err(e) => return Err(e.into()),
    }

    // book_notes.source（标注来源：'user'=人工（默认，存量行回填）|'ai'=AI 生成）
    let result = sqlx::query("ALTER TABLE book_notes ADD COLUMN source TEXT NOT NULL DEFAULT 'user'")
        .execute(pool)
        .await;

    match result {
        Ok(_) => println!("Migration applied: book_notes.source added."),
        Err(e) if e.to_string().contains("duplicate column name") => {}
        Err(e) => return Err(e.into()),
    }

    // book_notes.starred（标注星标，0/1）
    let result = sqlx::query("ALTER TABLE book_notes ADD COLUMN starred INTEGER NOT NULL DEFAULT 0")
        .execute(pool)
        .await;

    match result {
        Ok(_) => println!("Migration applied: book_notes.starred added."),
        Err(e) if e.to_string().contains("duplicate column name") => {}
        Err(e) => return Err(e.into()),
    }

    Ok(())
}

async fn initialize_default_skills(pool: &SqlitePool) -> Result<(), Box<dyn std::error::Error>> {
    let default_skills_json = include_str!("./default-skills.json");
    let default_skills: Vec<DefaultSkill> = serde_json::from_str(default_skills_json)?;

    println!("Initializing {} default skills...", default_skills.len());

    for skill in default_skills {
        let skill_id = Uuid::new_v4().to_string();
        let now = chrono::Utc::now().timestamp_millis();

        sqlx::query(
            r#"
            INSERT INTO skills (id, name, content, is_active, is_system, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&skill_id)
        .bind(&skill.name)
        .bind(&skill.content)
        .bind(if skill.is_active { 1 } else { 0 })
        .bind(if skill.is_system { 1 } else { 0 })
        .bind(now)
        .bind(now)
        .execute(pool)
        .await?;

        println!("✅ Default skill initialized: {}", skill.name);
    }

    println!("Default skills initialization completed.");
    Ok(())
}
