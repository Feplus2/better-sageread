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

    // L2 增量同步：变更日志表（同步触发器统一在 run_migrations 末尾创建——
    // folders/paper_folders/prompt_presets 等成员表在后面的迁移里才建，顺序不能反）
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
    println!("Migration applied: _sync_log.");

    // notes（笔记面板，2026-08 第二轮重建）：首轮"notes 概念废弃"迁移已把旧表 DROP，
    // 本轮以全新 schema 重建（IF NOT EXISTS 幂等）。注意：不可再保留 DROP TABLE IF EXISTS notes
    // 迁移——它每次启动都执行，会把新表一并清掉。
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS notes (
            id TEXT PRIMARY KEY NOT NULL,
            book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
            title TEXT NOT NULL DEFAULT '',
            content TEXT NOT NULL DEFAULT '',
            location_tag TEXT,
            location_block INTEGER,
            location_cfi TEXT,
            starred INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )",
    )
    .execute(pool)
    .await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_notes_book_id ON notes(book_id)")
        .execute(pool)
        .await?;
    println!("Migration applied: notes table (rebuilt).");

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

    // Zotero 批量导入：collection key → 文件夹映射缓存 + 论文 zotero_key 去重状态（IF NOT EXISTS 幂等）
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS zotero_collections (
            collection_key TEXT PRIMARY KEY,
            folder_id TEXT NOT NULL,
            name TEXT NOT NULL,
            parent_key TEXT,
            updated_at INTEGER NOT NULL
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS zotero_paper_state (
            paper_id TEXT PRIMARY KEY,
            zotero_key TEXT NOT NULL UNIQUE,
            collection_keys TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_zotero_paper_state_key ON zotero_paper_state(zotero_key)")
        .execute(pool)
        .await?;
    println!("Migration applied: zotero_collections + zotero_paper_state.");

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

    // 阅读助手系统提示词 v2.1（2026-08-04）：P0 注册 ragRange 工具后，RAG 小节补对应条目。
    // 手术式插入（锚点 = ragToc 条目行首），只在仍是官方文案（含锚点、不含 ragRange）时执行，
    // 用户自定义过的不动；第二次运行因已含 ragRange 自然幂等。
    let result = sqlx::query(
        "UPDATE skills SET content = REPLACE(content, '• **ragToc** - 获取完整章节内容', ? || '• **ragToc** - 获取完整章节内容'), updated_at = ?
         WHERE is_system = 1
           AND content LIKE '%• **ragToc** - 获取完整章节内容%'
           AND content NOT LIKE '%ragRange%'",
    )
    .bind("• **ragRange** - 按全局索引范围连续取块\n  - 使用场景：已知大致索引范围，需要跨章节的连续内容\n  - 策略：范围来自 ragSearch/ragContext 返回的全局索引，单次不超过 20 块\n\n")
    .bind(chrono::Utc::now().timestamp_millis())
    .execute(pool)
    .await;
    if let Ok(done) = result {
        if done.rows_affected() > 0 {
            println!("Migration applied: reader system prompt upgraded to v2.1 (ragRange).");
        }
    }

    // 阅读助手系统提示词 v2.2（2026-08-05）：P1 写工具下放 shared（reader/paper 整理笔记落盘），
    // 追加「文件工具 + 长期记忆」两节。追加式手术：只在仍是官方文案（含思维导图收尾句）时执行，
    // 用户自定义过的不动；第二次运行因已含锚点自然幂等。与 default-skills.json 同文案。
    let result = sqlx::query(
        "UPDATE skills SET content = content || ?, updated_at = ?
         WHERE is_system = 1
           AND content LIKE '%生成思维导图一定不要输出图片%'
           AND content NOT LIKE '%文件工具（笔记整理落盘）%'",
    )
    .bind("\n\n—— 文件工具（笔记整理落盘） ——\n你可以把整理好的阅读笔记/摘要写入本地文件（Agent 工作区，根目录见系统注入的「—— 当前工作区 ——」段）：\n• **writeFile** - 写入文件（整文件创建/覆盖，自动建父目录）\n• **editFile** - 精确修改文件局部（oldString 精确匹配，唯一命中）\n• **readLocalFile** - 读取本地文件（带行号，offset/limit 分页）\n• **searchFiles** - 搜索工作区文件（glob 按名 / grep 按内容）\n• **runCommand** - 在工作区执行命令行（数据处理/画图脚本等；执行前会弹确认卡等用户裁决）\n• **exportNotes** - 导出本书划线与想法为 Markdown（bookId 先用 getBooks 按书名查得）\n界内操作直接执行，界外写入会弹确认卡由用户决定。\n\n—— 长期记忆 ——\n工作区根目录下的 memory.md 是你的持久记忆文件（内容见【长期记忆】段，如有）。用户分享偏好、做出决定、给出长期事实，或明确要求「记住」时，用 writeFile/editFile 更新它（不存在则创建）；按主题分节、保持精炼（200 行内），只记跨对话有价值的信息。")
    .bind(chrono::Utc::now().timestamp_millis())
    .execute(pool)
    .await;
    if let Ok(done) = result {
        if done.rows_affected() > 0 {
            println!("Migration applied: reader system prompt upgraded to v2.2 (file tools + memory).");
        }
    }

    // 阅读助手系统提示词 v2.3（2026-08-05）：RAG 提示词侧收口（backlog D 批「RAG 精度增强」结论）——
    // RAG 小节补「查询构造」条目（英文书用英文术语、复杂问题拆 2-3 个措辞分次检索）。
    // 手术式插入（锚点 = 基本原则行首），只在仍是官方文案时执行；已含锚点自然幂等。
    let result = sqlx::query(
        "UPDATE skills SET content = REPLACE(content, '• **基本原则**：ragSearch 快速定位', ? || '• **基本原则**：ragSearch 快速定位'), updated_at = ?
         WHERE is_system = 1
           AND content LIKE '%• **基本原则**：ragSearch 快速定位%'
           AND content NOT LIKE '%查询构造%'",
    )
    .bind("• **查询构造** - 检索词即查询质量：英文书籍用英文术语检索（中文问题先把核心概念译成英文术语）；复杂问题拆 2-3 个不同措辞分次检索，比一次长查询召回更全\n\n")
    .bind(chrono::Utc::now().timestamp_millis())
    .execute(pool)
    .await;
    if let Ok(done) = result {
        if done.rows_affected() > 0 {
            println!("Migration applied: reader system prompt upgraded to v2.3 (query construction).");
        }
    }

    // 阅读助手系统提示词 v2.4（2026-08-05）：readBookSection 常驻注册后，
    // 「未向量化就直接基于知识回答」的旧指引会误导——改为「RAG 无结果时改用 readBookSection 直读原文」。
    // 手术式替换，只在仍是官方文案时执行；已含新文案自然幂等。
    let result = sqlx::query(
        "UPDATE skills SET content = REPLACE(content, '以及**当前书未向量化时**（RAG 工具不可用，直接基于元信息和你的知识回答，并说明原因）', ?), updated_at = ?
         WHERE is_system = 1
           AND content LIKE '%当前书未向量化时**（RAG 工具不可用%'
           AND content NOT LIKE '%readBookSection 按目录标题直读原文%'",
    )
    .bind("以及**本书未建索引时**（RAG 检索不到内容属正常——改用 readBookSection 按目录标题直读原文再作答，不要凭印象编造）")
    .bind(chrono::Utc::now().timestamp_millis())
    .execute(pool)
    .await;
    if let Ok(done) = result {
        if done.rows_affected() > 0 {
            println!("Migration applied: reader system prompt upgraded to v2.4 (readBookSection fallback guidance).");
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

    // book_status.rating（重要度打星 0-3，0=未打星）
    let result = sqlx::query("ALTER TABLE book_status ADD COLUMN rating INTEGER NOT NULL DEFAULT 0")
        .execute(pool)
        .await;

    match result {
        Ok(_) => println!("Migration applied: book_status.rating added."),
        Err(e) if e.to_string().contains("duplicate column name") => {}
        Err(e) => return Err(e.into()),
    }

    // L2 同步触发器统一最后建：
    // 成员表的建表/列迁移必须全部就绪（folders/paper_folders/prompt_presets 在上方才创建）；
    // 元组第二列是主键表达式：普通表为列名，paper_folders 复合主键用拼接表达式（{p} 为 NEW./OLD. 占位——
    // 2026-08-13 前生成式只给首列加前缀，"NEW.paper_id || ':' || folder_id" 的裸 folder_id 在触发器里
    // 解析到 _sync_log 上报 no such column，paper_folders 一切写入连带 books 级联删除全部失败）。
    // 每次启动 DROP+CREATE 自愈：坏触发器不会随 IF NOT EXISTS 更新，必须显式重建
    const SYNC_TABLES: [(&str, &str); 11] = [
        ("books", "id"),
        ("book_status", "book_id"),
        ("book_notes", "id"),
        ("threads", "id"),
        ("reading_sessions", "id"),
        ("skills", "id"),
        ("tags", "id"),
        ("folders", "id"),
        ("paper_folders", "{p}paper_id || ':' || {p}folder_id"),
        ("prompt_presets", "id"),
        ("notes", "id"),
    ];

    for (table, pk) in SYNC_TABLES {
        for (suffix, op, prefix) in [("ai", "INSERT", "NEW."), ("au", "UPDATE", "NEW."), ("ad", "DELETE", "OLD.")] {
            let key = if pk.contains("{p}") {
                pk.replace("{p}", prefix)
            } else {
                format!("{prefix}{pk}")
            };
            // DROP+CREATE 包进单事务：SQLite DDL 可事务化，原子提交——崩溃不留半态；
            // 并发双开初始化（dev 热重载遗留进程抢同一库，2026-08-13 实证 panic）退化为串行等待而非 already exists
            let mut tx = pool.begin().await?;
            sqlx::query(&format!("DROP TRIGGER IF EXISTS _sync_{table}_{suffix}"))
                .execute(&mut *tx)
                .await?;
            let sql = format!(
                "CREATE TRIGGER _sync_{table}_{suffix} AFTER {op} ON {table} BEGIN
                    INSERT INTO _sync_log (table_name, row_id, op, at)
                    VALUES ('{table}', {key}, '{op}', CAST(strftime('%s','now') AS INTEGER) * 1000);
                END"
            );
            sqlx::query(&sql).execute(&mut *tx).await?;
            tx.commit().await?;
        }
    }
    println!("Migration applied: sync triggers.");

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
