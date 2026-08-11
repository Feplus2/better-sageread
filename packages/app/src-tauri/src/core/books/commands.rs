use super::models::*;
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::{Row, SqlitePool};
use std::fs;
use tauri::{AppHandle, Manager};

#[tauri::command]
pub async fn save_book(app_handle: AppHandle, data: BookUploadData) -> Result<SimpleBook, String> {
    let db_pool = get_db_pool(&app_handle).await?;

    let existing_book = get_book_by_id(app_handle.clone(), data.id.clone()).await?;
    if let Some(book) = existing_book {
        return Err(format!("书籍已存在: {} (ID: {})", book.title, book.id));
    }

    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用目录失败: {}", e))?;

    let books_dir = app_data_dir.join("books");
    let book_dir = books_dir.join(&data.id);
    fs::create_dir_all(&book_dir).map_err(|e| format!("创建目录失败: {}", e))?;

    let epub_filename = format!("book.{}", data.format.to_lowercase());
    let epub_path = book_dir.join(&epub_filename);
    std::fs::rename(&data.temp_file_path, &epub_path)
        .map_err(|e| format!("移动书籍文件失败: {}", e))?;

    let cover_path = if let Some(cover_temp_path) = &data.cover_temp_file_path {
        let cover_file = book_dir.join("cover.jpg");
        std::fs::rename(cover_temp_path, &cover_file)
            .map_err(|e| format!("移动封面文件失败: {}", e))?;
        Some(format!("books/{}/cover.jpg", data.id))
    } else {
        None
    };

    let metadata_path = book_dir.join("metadata.json");
    let metadata_json = serde_json::to_string_pretty(&data.metadata)
        .map_err(|e| format!("序列化元数据失败: {}", e))?;
    fs::write(&metadata_path, metadata_json).map_err(|e| format!("保存元数据失败: {}", e))?;

    let file_path = format!("books/{}/{}", data.id, epub_filename);
    let now = chrono::Utc::now().timestamp_millis();

    let mut tx = db_pool
        .begin()
        .await
        .map_err(|e| format!("开启事务失败: {}", e))?;

    sqlx::query(
        r#"
        INSERT INTO books (
            id, title, author, format, file_path, cover_path,
            file_size, language, tags,
            created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&data.id)
    .bind(&data.title)
    .bind(&data.author)
    .bind(&data.format)
    .bind(&file_path)
    .bind(&cover_path)
    .bind(data.file_size)
    .bind(&data.language)
    .bind(None::<String>) // tags
    .bind(now)
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(|e| format!("数据库插入失败: {}", e))?;

    sqlx::query(
        r#"
        INSERT INTO book_status (
            book_id, status, progress_current, progress_total, location,
            metadata, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&data.id)
    .bind("unread")
    .bind(0i64)
    .bind(0i64)
    .bind("")
    .bind(None::<String>)
    .bind(now)
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(|e| format!("创建书籍状态失败: {}", e))?;

    tx.commit()
        .await
        .map_err(|e| format!("提交事务失败: {}", e))?;

    Ok(SimpleBook::new(
        data.id,
        data.title,
        data.author,
        data.format,
        file_path,
        cover_path,
        data.file_size,
        data.language,
    ))
}

#[tauri::command]
pub async fn get_books(
    app_handle: AppHandle,
    options: Option<BookQueryOptions>,
) -> Result<Vec<SimpleBook>, String> {
    let db_pool = get_db_pool(&app_handle).await?;
    let opts = options.unwrap_or_default();

    let mut query = String::from("SELECT * FROM books");
    let mut conditions = vec!["trashed_at IS NULL".to_string()];

    if let Some(search_query) = &opts.search_query {
        if !search_query.trim().is_empty() {
            conditions.push(format!(
                "(title LIKE '%{}%' OR author LIKE '%{}%')",
                search_query.replace('\'', "''"),
                search_query.replace('\'', "''")
            ));
        }
    }

    if let Some(tags) = &opts.tags {
        if !tags.is_empty() {
            let tag_conditions: Vec<String> = tags
                .iter()
                .map(|tag| format!("tags LIKE '%\"{}\"%%'", tag.replace('\'', "''")))
                .collect();
            conditions.push(format!("({})", tag_conditions.join(" OR ")));
        }
    }

    if !conditions.is_empty() {
        query.push_str(&format!(" WHERE {}", conditions.join(" AND ")));
    }

    let sort_by = opts.sort_by.as_deref().unwrap_or("updated_at");
    let sort_order = opts.sort_order.as_deref().unwrap_or("desc");
    query.push_str(&format!(
        " ORDER BY {} {}",
        sort_by,
        sort_order.to_uppercase()
    ));

    if let Some(limit) = opts.limit {
        query.push_str(&format!(" LIMIT {}", limit));
        if let Some(offset) = opts.offset {
            query.push_str(&format!(" OFFSET {}", offset));
        }
    }

    let rows = sqlx::query(&query)
        .fetch_all(&db_pool)
        .await
        .map_err(|e| format!("查询书籍失败: {}", e))?;

    let books: Result<Vec<SimpleBook>, sqlx::Error> =
        rows.iter().map(SimpleBook::from_db_row).collect();

    books.map_err(|e| format!("转换查询结果失败: {}", e))
}

#[tauri::command]
pub async fn get_book_by_id(
    app_handle: AppHandle,
    id: String,
) -> Result<Option<SimpleBook>, String> {
    let db_pool = get_db_pool(&app_handle).await?;

    let row = sqlx::query("SELECT * FROM books WHERE id = ?")
        .bind(&id)
        .fetch_optional(&db_pool)
        .await
        .map_err(|e| format!("查询书籍失败: {}", e))?;

    match row {
        Some(row) => Ok(Some(
            SimpleBook::from_db_row(&row).map_err(|e| format!("转换查询结果失败: {}", e))?,
        )),
        None => Ok(None),
    }
}

#[tauri::command]
pub async fn update_book(
    app_handle: AppHandle,
    id: String,
    update_data: BookUpdateData,
) -> Result<SimpleBook, String> {
    let db_pool = get_db_pool(&app_handle).await?;
    let now = update_data
        .updated_at
        .unwrap_or_else(|| chrono::Utc::now().timestamp_millis());

    if let Some(title) = &update_data.title {
        sqlx::query("UPDATE books SET title = ?, updated_at = ? WHERE id = ?")
            .bind(title)
            .bind(now)
            .bind(&id)
            .execute(&db_pool)
            .await
            .map_err(|e| format!("更新标题失败: {}", e))?;
    }

    if let Some(author) = &update_data.author {
        sqlx::query("UPDATE books SET author = ?, updated_at = ? WHERE id = ?")
            .bind(author)
            .bind(now)
            .bind(&id)
            .execute(&db_pool)
            .await
            .map_err(|e| format!("更新作者失败: {}", e))?;
    }

    if let Some(tags) = &update_data.tags {
        let tags_json =
            serde_json::to_string(tags).map_err(|e| format!("序列化标签失败: {}", e))?;
        sqlx::query("UPDATE books SET tags = ?, updated_at = ? WHERE id = ?")
            .bind(tags_json)
            .bind(now)
            .bind(&id)
            .execute(&db_pool)
            .await
            .map_err(|e| format!("更新标签失败: {}", e))?;
    }

    if update_data.title.is_none() && update_data.author.is_none() && update_data.tags.is_none() {
        sqlx::query("UPDATE books SET updated_at = ? WHERE id = ?")
            .bind(now)
            .bind(&id)
            .execute(&db_pool)
            .await
            .map_err(|e| format!("更新时间戳失败: {}", e))?;
    }

    get_book_by_id(app_handle, id)
        .await?
        .ok_or_else(|| "更新后无法找到书籍".to_string())
}

#[tauri::command]
pub async fn delete_book(app_handle: AppHandle, id: String) -> Result<(), String> {
    let db_pool = get_db_pool(&app_handle).await?;

    // 软删除：仅标记 trashed_at，磁盘文件与关联数据（book_status/threads 等）全部保留，回收站可恢复
    // 必须同步推进 updated_at：L2 同步按 LWW 比较 updated_at，不推进则删除操作永远赢不了对端
    let now = chrono::Utc::now().timestamp_millis();
    let result = sqlx::query("UPDATE books SET trashed_at = ?, updated_at = ? WHERE id = ? AND trashed_at IS NULL")
        .bind(now)
        .bind(now)
        .bind(&id)
        .execute(&db_pool)
        .await
        .map_err(|e| format!("删除书籍失败: {}", e))?;

    if result.rows_affected() == 0 {
        return Err("书籍不存在或已在回收站".to_string());
    }

    Ok(())
}

/// 恢复：清除 trashed_at，书籍回到书架
#[tauri::command]
pub async fn restore_book(app_handle: AppHandle, id: String) -> Result<(), String> {
    let db_pool = get_db_pool(&app_handle).await?;

    let result = sqlx::query("UPDATE books SET trashed_at = NULL, updated_at = ? WHERE id = ?")
        .bind(chrono::Utc::now().timestamp_millis())
        .bind(&id)
        .execute(&db_pool)
        .await
        .map_err(|e| format!("恢复书籍失败: {}", e))?;

    if result.rows_affected() == 0 {
        return Err("书籍不存在".to_string());
    }

    Ok(())
}

/// 回收站列表：按删除时间倒序
#[tauri::command]
pub async fn get_trashed_books(app_handle: AppHandle) -> Result<Vec<SimpleBook>, String> {
    let db_pool = get_db_pool(&app_handle).await?;

    let rows = sqlx::query("SELECT * FROM books WHERE trashed_at IS NOT NULL ORDER BY trashed_at DESC")
        .fetch_all(&db_pool)
        .await
        .map_err(|e| format!("查询回收站失败: {}", e))?;

    let books: Result<Vec<SimpleBook>, sqlx::Error> = rows.iter().map(SimpleBook::from_db_row).collect();
    books.map_err(|e| format!("转换查询结果失败: {}", e))
}

/// 彻底删除（回收站操作/自动清理共用）：删磁盘目录 + DELETE 行（外键级联清关联数据）
async fn purge_book_by_id(app_handle: &AppHandle, db_pool: &SqlitePool, id: &str) -> Result<(), String> {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用目录失败: {}", e))?;

    // MARKDOWN 论文在全局论文向量库中还有分片/向量，需在删行前拿到 format 并顺带清理
    let format: Option<String> = sqlx::query_scalar("SELECT format FROM books WHERE id = ?")
        .bind(id)
        .fetch_optional(db_pool)
        .await
        .map_err(|e| format!("查询书籍格式失败: {}", e))?;

    let book_dir = app_data_dir.join("books").join(id);
    if book_dir.exists() {
        std::fs::remove_dir_all(&book_dir).map_err(|e| format!("删除书籍文件失败: {}", e))?;
    }

    sqlx::query("DELETE FROM books WHERE id = ?")
        .bind(id)
        .execute(db_pool)
        .await
        .map_err(|e| format!("彻底删除书籍失败: {}", e))?;

    if format.as_deref() == Some("MARKDOWN") {
        purge_paper_vectors(&app_data_dir, id);
    }

    Ok(())
}

/// 清理全局论文向量库（{app_data}/papers/vectors.sqlite）中该 paper_id 的分片与向量。
/// 与图书行为一致：软删不清理（回收站可恢复），仅彻底删除时调用。失败仅告警不阻塞主流程。
fn purge_paper_vectors(app_data_dir: &std::path::Path, paper_id: &str) {
    let db_path = app_data_dir.join("papers").join("vectors.sqlite");
    if !db_path.exists() {
        return;
    }
    if let Err(e) = purge_paper_vectors_inner(&db_path, paper_id) {
        log::warn!("清理论文向量失败 (paper_id={}): {}", paper_id, e);
    }
}

fn purge_paper_vectors_inner(db_path: &std::path::Path, paper_id: &str) -> rusqlite::Result<()> {
    // 注册 sqlite-vec 扩展（chunk_embeddings 是 vec0 虚拟表，删除行需要扩展）
    unsafe {
        rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute(
            sqlite_vec::sqlite3_vec_init as *const (),
        )));
    }
    let conn = rusqlite::Connection::open(db_path)?;

    let table_exists = |name: &str| -> rusqlite::Result<bool> {
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name = ?1",
            [name],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    };

    if !table_exists("document_chunks")? {
        return Ok(());
    }

    // 老库（迁移前）没有 paper_id 列，不可能存在论文分片
    let has_paper_id = conn
        .prepare("PRAGMA table_info(document_chunks)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .any(|name| name.map(|n| n == "paper_id").unwrap_or(false));
    if !has_paper_id {
        return Ok(());
    }

    if table_exists("chunk_embeddings")? {
        conn.execute(
            "DELETE FROM chunk_embeddings WHERE chunk_id IN (SELECT id FROM document_chunks WHERE paper_id = ?1)",
            [paper_id],
        )?;
    }
    if table_exists("chunk_embeddings_fallback")? {
        conn.execute(
            "DELETE FROM chunk_embeddings_fallback WHERE chunk_id IN (SELECT id FROM document_chunks WHERE paper_id = ?1)",
            [paper_id],
        )?;
    }
    let deleted = conn.execute("DELETE FROM document_chunks WHERE paper_id = ?1", [paper_id])?;

    // BM25 统计基于全库文档，内容变化后缓存即失效
    if deleted > 0 && table_exists("bm25_stats")? {
        conn.execute("DELETE FROM bm25_stats", [])?;
    }

    log::info!("已清理全局论文向量库：paper_id={}，删除 {} 个分片", paper_id, deleted);
    Ok(())
}

/// 彻底删除单本书（回收站手动操作）
#[tauri::command]
pub async fn purge_book(app_handle: AppHandle, id: String) -> Result<(), String> {
    let db_pool = get_db_pool(&app_handle).await?;
    purge_book_by_id(&app_handle, &db_pool, &id).await
}

/// 回收站保留天数（将来可做成用户配置）
const TRASH_RETENTION_DAYS: i64 = 30;

/// 启动时自动清理：超过保留期的回收站书籍执行彻底删除，返回清理数量
pub async fn purge_expired_trash(app_handle: &AppHandle) -> Result<usize, String> {
    let db_pool = get_db_pool(app_handle).await?;

    let cutoff = chrono::Utc::now().timestamp_millis() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    let rows = sqlx::query("SELECT id FROM books WHERE trashed_at IS NOT NULL AND trashed_at < ?")
        .bind(cutoff)
        .fetch_all(&db_pool)
        .await
        .map_err(|e| format!("查询过期回收站书籍失败: {}", e))?;

    let mut purged = 0;
    for row in rows {
        let id: String = row.get("id");
        purge_book_by_id(app_handle, &db_pool, &id).await?;
        purged += 1;
    }

    if purged > 0 {
        log::info!("回收站自动清理：彻底删除 {} 本超过 {} 天的书籍", purged, TRASH_RETENTION_DAYS);
    }

    Ok(purged)
}

#[tauri::command]
pub async fn get_book_status(
    app_handle: AppHandle,
    book_id: String,
) -> Result<Option<BookStatus>, String> {
    let db_pool = get_db_pool(&app_handle).await?;

    let result = sqlx::query("SELECT * FROM book_status WHERE book_id = ?")
        .bind(&book_id)
        .fetch_optional(&db_pool)
        .await
        .map_err(|e| format!("查询书籍状态失败: {}", e))?;

    match result {
        Some(row) => Ok(Some(
            BookStatus::from_db_row(&row).map_err(|e| format!("解析数据失败: {}", e))?,
        )),
        None => Ok(None),
    }
}

/// "真读"判定阈值（秒）：在上一位置活跃逗留达到该值才算真翻页（将来可做成用户配置）
const DWELL_THRESHOLD_SECS: i64 = 30;

/// position_changed_at 是否应当推进：位置真实变化 且 上一位置活跃逗留达标
pub fn should_bump_position_changed(current_location: &str, new_location: &str, dwell_seconds: i64) -> bool {
    new_location != current_location && dwell_seconds >= DWELL_THRESHOLD_SECS
}

#[tauri::command]
pub async fn update_book_status(
    app_handle: AppHandle,
    book_id: String,
    update_data: BookStatusUpdateData,
) -> Result<BookStatus, String> {
    let db_pool = get_db_pool(&app_handle).await?;
    let now = chrono::Utc::now().timestamp_millis();

    let current_status = get_book_status(app_handle.clone(), book_id.clone())
        .await?
        .ok_or_else(|| "书籍状态不存在".to_string())?;

    // position_changed_at（真进度，同步合并用）：仅当
    // (a) 位置与库中不同（真翻页）且 (b) 在上一位置的活跃逗留 >= 阈值时更新。
    // 位置没变（含"仅打开书"）只更新 progress/location/last_read_at/dwell_seconds。
    // 注意此判定须在下方 unwrap_or 消耗字段之前完成（只借用）。
    let mut new_position_changed_at = current_status.position_changed_at;
    if let Some(ref loc) = update_data.location {
        let dwell = update_data.dwell_seconds.unwrap_or(0);
        if should_bump_position_changed(&current_status.location, loc, dwell) {
            new_position_changed_at = Some(now);
        }
    }

    let new_status = update_data.status.unwrap_or(current_status.status);
    let new_progress_current = update_data
        .progress_current
        .unwrap_or(current_status.progress_current);
    let new_progress_total = update_data
        .progress_total
        .unwrap_or(current_status.progress_total);
    let new_location = update_data.location.unwrap_or(current_status.location);
    let new_last_read_at = update_data.last_read_at.or(current_status.last_read_at);
    let new_dwell_seconds = update_data.dwell_seconds.unwrap_or(current_status.dwell_seconds);
    let new_rating = update_data.rating.unwrap_or(current_status.rating);
    let new_started_at = update_data.started_at.or(current_status.started_at);
    let new_completed_at = update_data.completed_at.or(current_status.completed_at);
    let new_metadata = update_data.metadata.or(current_status.metadata);

    let result = sqlx::query(
        r#"
        UPDATE book_status SET
            status = ?, progress_current = ?, progress_total = ?, location = ?,
            last_read_at = ?, position_changed_at = ?, dwell_seconds = ?, rating = ?,
            started_at = ?, completed_at = ?, metadata = ?, updated_at = ?
        WHERE book_id = ?
        "#,
    )
    .bind(&new_status)
    .bind(new_progress_current)
    .bind(new_progress_total)
    .bind(&new_location)
    .bind(new_last_read_at)
    .bind(new_position_changed_at)
    .bind(new_dwell_seconds)
    .bind(new_rating)
    .bind(new_started_at)
    .bind(new_completed_at)
    .bind(
        new_metadata
            .as_ref()
            .map(|v| serde_json::to_string(v).unwrap_or_default()),
    )
    .bind(now)
    .bind(&book_id)
    .execute(&db_pool)
    .await
    .map_err(|e| format!("更新书籍状态失败: {}", e))?;

    if result.rows_affected() == 0 {
        return Err("书籍状态不存在".to_string());
    }

    get_book_status(app_handle, book_id)
        .await?
        .ok_or_else(|| "更新后无法找到书籍状态".to_string())
}

#[tauri::command]
pub async fn get_books_with_status(
    app_handle: AppHandle,
    options: Option<BookQueryOptions>,
) -> Result<Vec<BookWithStatus>, String> {
    let db_pool = get_db_pool(&app_handle).await?;
    let opts = options.unwrap_or_default();

    let mut query = String::from(
        "SELECT b.*, s.book_id as status_book_id, s.status, s.progress_current, s.progress_total, 
         s.last_read_at, s.rating, s.started_at, 
         s.completed_at, s.metadata, s.created_at as status_created_at, s.updated_at as status_updated_at 
         FROM books b LEFT JOIN book_status s ON b.id = s.book_id"
    );
    let mut conditions = vec!["b.trashed_at IS NULL".to_string()];

    if let Some(search_query) = &opts.search_query {
        if !search_query.trim().is_empty() {
            conditions.push("(b.title LIKE ? OR b.author LIKE ?)".to_string());
        }
    }

    let tag_condition = if let Some(tags) = &opts.tags {
        if !tags.is_empty() {
            let tag_conditions: Vec<String> =
                tags.iter().map(|_| "b.tags LIKE ?".to_string()).collect();
            Some(format!("({})", tag_conditions.join(" OR ")))
        } else {
            None
        }
    } else {
        None
    };

    if let Some(condition) = tag_condition {
        conditions.push(condition);
    }

    if !conditions.is_empty() {
        query.push_str(&format!(" WHERE {}", conditions.join(" AND ")));
    }

    if let Some(sort_by) = &opts.sort_by {
        let order = opts.sort_order.as_deref().unwrap_or("asc");
        match sort_by.as_str() {
            "title" => query.push_str(&format!(" ORDER BY b.title {}", order)),
            "author" => query.push_str(&format!(" ORDER BY b.author {}", order)),
            "createdAt" => query.push_str(&format!(" ORDER BY b.created_at {}", order)),
            "updatedAt" => query.push_str(&format!(" ORDER BY b.updated_at {}", order)),
            _ => query.push_str(" ORDER BY b.updated_at DESC"),
        }
    } else {
        query.push_str(" ORDER BY b.updated_at DESC");
    }

    if let Some(limit) = opts.limit {
        query.push_str(&format!(" LIMIT {}", limit));
        if let Some(offset) = opts.offset {
            query.push_str(&format!(" OFFSET {}", offset));
        }
    }

    let mut sql_query = sqlx::query(&query);

    let search_patterns = if let Some(search_query) = &opts.search_query {
        if !search_query.trim().is_empty() {
            let pattern = format!("%{}%", search_query);
            Some((pattern.clone(), pattern))
        } else {
            None
        }
    } else {
        None
    };

    if let Some((pattern1, pattern2)) = &search_patterns {
        sql_query = sql_query.bind(pattern1).bind(pattern2);
    }

    let tag_patterns: Vec<String> = if let Some(tags) = &opts.tags {
        tags.iter().map(|tag| format!("%\"{}\"", tag)).collect()
    } else {
        Vec::new()
    };

    for tag_pattern in &tag_patterns {
        sql_query = sql_query.bind(tag_pattern);
    }

    let rows = sql_query
        .fetch_all(&db_pool)
        .await
        .map_err(|e| format!("查询书籍失败: {}", e))?;

    let mut results = Vec::new();
    for row in rows {
        let book = SimpleBook::from_db_row(&row).map_err(|e| format!("解析书籍数据失败: {}", e))?;

        let status = if row
            .try_get::<Option<String>, _>("status_book_id")
            .unwrap_or(None)
            .is_some()
        {
            Some(BookStatus {
                book_id: row.try_get("status_book_id").unwrap_or_default(),
                status: row.try_get("status").unwrap_or_default(),
                progress_current: row.try_get("progress_current").unwrap_or_default(),
                progress_total: row.try_get("progress_total").unwrap_or_default(),
                location: row.try_get("location").unwrap_or_default(),
                last_read_at: row.try_get("last_read_at").unwrap_or_default(),
                position_changed_at: row.try_get("position_changed_at").unwrap_or_default(),
                dwell_seconds: row.try_get("dwell_seconds").unwrap_or_default(),
                rating: row.try_get("rating").unwrap_or_default(),
                started_at: row.try_get("started_at").unwrap_or_default(),
                completed_at: row.try_get("completed_at").unwrap_or_default(),
                metadata: {
                    let metadata_str: Option<String> = row.try_get("metadata").unwrap_or_default();
                    metadata_str.and_then(|s| serde_json::from_str(&s).ok())
                },
                created_at: row.try_get("status_created_at").unwrap_or_default(),
                updated_at: row.try_get("status_updated_at").unwrap_or_default(),
            })
        } else {
            None
        };

        results.push(BookWithStatus { book, status });
    }

    Ok(results)
}

#[tauri::command]
pub async fn get_book_with_status_by_id(
    app_handle: AppHandle,
    id: String,
) -> Result<Option<BookWithStatus>, String> {
    let db_pool = get_db_pool(&app_handle).await?;

    let query = "SELECT b.*, s.book_id as status_book_id, s.status, s.progress_current, s.progress_total, 
         s.location, s.last_read_at, s.rating, s.started_at, 
         s.completed_at, s.metadata, s.created_at as status_created_at, s.updated_at as status_updated_at 
         FROM books b LEFT JOIN book_status s ON b.id = s.book_id
         WHERE b.id = ?";

    let row = sqlx::query(query)
        .bind(&id)
        .fetch_optional(&db_pool)
        .await
        .map_err(|e| format!("查询书籍失败: {}", e))?;

    match row {
        Some(row) => {
            let book =
                SimpleBook::from_db_row(&row).map_err(|e| format!("解析书籍数据失败: {}", e))?;

            let status = if row
                .try_get::<Option<String>, _>("status_book_id")
                .unwrap_or(None)
                .is_some()
            {
                Some(BookStatus {
                    book_id: row.try_get("status_book_id").unwrap_or_default(),
                    status: row.try_get("status").unwrap_or_default(),
                    progress_current: row.try_get("progress_current").unwrap_or_default(),
                    progress_total: row.try_get("progress_total").unwrap_or_default(),
                    location: row.try_get("location").unwrap_or_default(),
                    last_read_at: row.try_get("last_read_at").unwrap_or_default(),
                    position_changed_at: row.try_get("position_changed_at").unwrap_or_default(),
                    dwell_seconds: row.try_get("dwell_seconds").unwrap_or_default(),
                    rating: row.try_get("rating").unwrap_or_default(),
                    started_at: row.try_get("started_at").unwrap_or_default(),
                    completed_at: row.try_get("completed_at").unwrap_or_default(),
                    metadata: {
                        let metadata_str: Option<String> =
                            row.try_get("metadata").unwrap_or_default();
                        metadata_str.and_then(|s| serde_json::from_str(&s).ok())
                    },
                    created_at: row.try_get("status_created_at").unwrap_or_default(),
                    updated_at: row.try_get("status_updated_at").unwrap_or_default(),
                })
            } else {
                None
            };

            Ok(Some(BookWithStatus { book, status }))
        }
        None => Ok(None),
    }
}

async fn get_db_pool(app_handle: &AppHandle) -> Result<SqlitePool, String> {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用目录失败: {}", e))?;

    let db_path = app_data_dir.join("database").join("app.db");
    let db_url = format!("sqlite:{}", db_path.display());

    SqlitePool::connect(&db_url)
        .await
        .map_err(|e| format!("数据库连接失败: {}", e))
}

impl Default for BookQueryOptions {
    fn default() -> Self {
        Self {
            limit: None,
            offset: None,
            search_query: None,
            tags: None,
            sort_by: None,
            sort_order: None,
        }
    }
}

// ReadingSession 相关命令函数

#[tauri::command]
pub async fn create_reading_session(
    app_handle: AppHandle,
    data: ReadingSessionCreateData,
) -> Result<ReadingSession, String> {
    let db_pool = get_db_pool(&app_handle).await?;

    let session = ReadingSession::new(data.book_id.clone(), data.started_at);

    sqlx::query(
        r#"
        INSERT INTO reading_sessions (
            id, book_id, started_at, ended_at, duration_seconds, 
            created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&session.id)
    .bind(&session.book_id)
    .bind(session.started_at)
    .bind(session.ended_at)
    .bind(session.duration_seconds)
    .bind(session.created_at)
    .bind(session.updated_at)
    .execute(&db_pool)
    .await
    .map_err(|e| format!("创建阅读会话失败: {}", e))?;

    Ok(session)
}

#[tauri::command]
pub async fn get_reading_session(
    app_handle: AppHandle,
    session_id: String,
) -> Result<Option<ReadingSession>, String> {
    let db_pool = get_db_pool(&app_handle).await?;

    let row = sqlx::query("SELECT * FROM reading_sessions WHERE id = ?")
        .bind(&session_id)
        .fetch_optional(&db_pool)
        .await
        .map_err(|e| format!("查询阅读会话失败: {}", e))?;

    match row {
        Some(row) => Ok(Some(
            ReadingSession::from_db_row(&row)
                .map_err(|e| format!("解析阅读会话数据失败: {}", e))?,
        )),
        None => Ok(None),
    }
}

#[tauri::command]
pub async fn update_reading_session(
    app_handle: AppHandle,
    session_id: String,
    update_data: ReadingSessionUpdateData,
) -> Result<ReadingSession, String> {
    let db_pool = get_db_pool(&app_handle).await?;
    let now = chrono::Utc::now().timestamp_millis();

    // 获取当前会话数据
    let current_session = get_reading_session(app_handle.clone(), session_id.clone())
        .await?
        .ok_or_else(|| "阅读会话不存在".to_string())?;

    // 准备更新的数据
    let new_ended_at = update_data.ended_at.or(current_session.ended_at);
    let new_duration_seconds = update_data
        .duration_seconds
        .unwrap_or(current_session.duration_seconds);

    sqlx::query(
        r#"
        UPDATE reading_sessions SET 
            ended_at = ?, duration_seconds = ?, updated_at = ?
        WHERE id = ?
        "#,
    )
    .bind(new_ended_at)
    .bind(new_duration_seconds)
    .bind(now)
    .bind(&session_id)
    .execute(&db_pool)
    .await
    .map_err(|e| format!("更新阅读会话失败: {}", e))?;

    get_reading_session(app_handle, session_id)
        .await?
        .ok_or_else(|| "更新后无法找到阅读会话".to_string())
}

#[tauri::command]
pub async fn get_reading_sessions_by_book(
    app_handle: AppHandle,
    book_id: String,
    limit: Option<i64>,
) -> Result<Vec<ReadingSession>, String> {
    let db_pool = get_db_pool(&app_handle).await?;

    let mut query =
        String::from("SELECT * FROM reading_sessions WHERE book_id = ? ORDER BY started_at DESC");

    if let Some(limit_value) = limit {
        query.push_str(&format!(" LIMIT {}", limit_value));
    }

    let rows = sqlx::query(&query)
        .bind(&book_id)
        .fetch_all(&db_pool)
        .await
        .map_err(|e| format!("查询阅读会话列表失败: {}", e))?;

    let sessions: Result<Vec<ReadingSession>, sqlx::Error> =
        rows.iter().map(ReadingSession::from_db_row).collect();

    sessions.map_err(|e| format!("转换查询结果失败: {}", e))
}

#[tauri::command]
pub async fn get_active_reading_session(
    app_handle: AppHandle,
    book_id: String,
) -> Result<Option<ReadingSession>, String> {
    let db_pool = get_db_pool(&app_handle).await?;

    let row = sqlx::query("SELECT * FROM reading_sessions WHERE book_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1")
        .bind(&book_id)
        .fetch_optional(&db_pool)
        .await
        .map_err(|e| format!("查询活跃阅读会话失败: {}", e))?;

    match row {
        Some(row) => Ok(Some(
            ReadingSession::from_db_row(&row)
                .map_err(|e| format!("解析阅读会话数据失败: {}", e))?,
        )),
        None => Ok(None),
    }
}

#[tauri::command]
pub async fn get_all_reading_sessions(
    app_handle: AppHandle,
    limit: Option<i64>,
    start_date: Option<i64>,
    end_date: Option<i64>,
) -> Result<Vec<ReadingSession>, String> {
    let db_pool = get_db_pool(&app_handle).await?;

    let mut query = String::from("SELECT * FROM reading_sessions WHERE 1=1");

    // 添加日期过滤
    if let Some(_start) = start_date {
        query.push_str(" AND started_at >= ?");
    }

    if let Some(_end) = end_date {
        query.push_str(" AND started_at <= ?");
    }

    query.push_str(" ORDER BY started_at DESC");

    if let Some(limit_value) = limit {
        query.push_str(&format!(" LIMIT {}", limit_value));
    }

    let mut sqlx_query = sqlx::query(&query);

    if let Some(start) = start_date {
        sqlx_query = sqlx_query.bind(start);
    }

    if let Some(end) = end_date {
        sqlx_query = sqlx_query.bind(end);
    }

    let rows = sqlx_query
        .fetch_all(&db_pool)
        .await
        .map_err(|e| format!("查询所有阅读会话失败: {}", e))?;

    let sessions: Result<Vec<ReadingSession>, sqlx::Error> =
        rows.iter().map(ReadingSession::from_db_row).collect();

    sessions.map_err(|e| format!("转换查询结果失败: {}", e))
}

// ==================== BookNote 相关命令 ====================

#[tauri::command]
pub async fn create_book_note(
    app_handle: AppHandle,
    note_data: BookNoteCreateData,
) -> Result<BookNote, String> {
    let db_pool = get_db_pool(&app_handle).await?;
    let id = uuid::Uuid::new_v4().to_string();

    // 提取 context 中的 before 和 after
    let (context_before, context_after) = if let Some(ref ctx) = note_data.context {
        (
            ctx.get("before")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            ctx.get("after")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
        )
    } else {
        (None, None)
    };

    // 来源只认 'ai'，其余（含缺省）一律按人工处理；类别仅 AI 标注携带，人工路径恒为 NULL
    let source = match note_data.source.as_deref() {
        Some("ai") => "ai".to_string(),
        _ => "user".to_string(),
    };
    let category = if source == "ai" {
        note_data.category.clone()
    } else {
        None
    };

    let book_note = BookNote::new(
        id.clone(),
        note_data.book_id,
        note_data.r#type,
        note_data.cfi,
        note_data.text,
        note_data.style,
        note_data.color,
        note_data.note,
        note_data.context,
        category,
        source,
    );

    sqlx::query(
        r#"
        INSERT INTO book_notes (id, book_id, type, cfi, text, style, color, note, context_before, context_after, category, source, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
        "#
    )
    .bind(&book_note.id)
    .bind(&book_note.book_id)
    .bind(&book_note.r#type)
    .bind(&book_note.cfi)
    .bind(&book_note.text)
    .bind(&book_note.style)
    .bind(&book_note.color)
    .bind(&book_note.note)
    .bind(&context_before)
    .bind(&context_after)
    .bind(&book_note.category)
    .bind(&book_note.source)
    .bind(book_note.created_at)
    .bind(book_note.updated_at)
    .execute(&db_pool)
    .await
    .map_err(|e| format!("创建笔记失败: {}", e))?;

    Ok(book_note)
}

#[tauri::command]
pub async fn get_book_notes(
    app_handle: AppHandle,
    book_id: String,
) -> Result<Vec<BookNote>, String> {
    let db_pool = get_db_pool(&app_handle).await?;

    let rows = sqlx::query(
        r#"
        SELECT id, book_id, type, cfi, text, style, color, note, context_before, context_after, category, source, starred, created_at, updated_at
        FROM book_notes
        WHERE book_id = ?1
        ORDER BY created_at ASC
        "#
    )
    .bind(&book_id)
    .fetch_all(&db_pool)
    .await
    .map_err(|e| format!("查询笔记失败: {}", e))?;

    let notes: Result<Vec<BookNote>, sqlx::Error> =
        rows.iter().map(BookNote::from_db_row).collect();

    notes.map_err(|e| format!("转换查询结果失败: {}", e))
}

/// 跨书标注查询（默认按 created_at DESC；note_type 给定时按 type 过滤；limit 缺省 200）
#[tauri::command]
pub async fn get_all_book_notes(
    app_handle: AppHandle,
    note_type: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<BookNoteWithBook>, String> {
    let db_pool = get_db_pool(&app_handle).await?;
    let limit = i64::from(limit.unwrap_or(200));

    const SELECT: &str = r#"
        SELECT n.id, n.book_id, n.type, n.cfi, n.text, n.style, n.color, n.note,
               n.context_before, n.context_after, n.category, n.source, n.starred,
               n.created_at, n.updated_at,
               b.title AS book_title, b.author AS book_author
        FROM book_notes n
        LEFT JOIN books b ON b.id = n.book_id
    "#;

    let rows = match note_type {
        Some(t) => {
            sqlx::query(&format!("{SELECT} WHERE n.type = ?1 ORDER BY n.created_at DESC LIMIT ?2"))
                .bind(t)
                .bind(limit)
                .fetch_all(&db_pool)
                .await
        }
        None => sqlx::query(&format!("{SELECT} ORDER BY n.created_at DESC LIMIT ?2"))
            .bind(limit)
            .fetch_all(&db_pool)
            .await,
    }
    .map_err(|e| format!("查询全部标注失败: {}", e))?;

    let notes: Result<Vec<BookNoteWithBook>, sqlx::Error> = rows
        .iter()
        .map(|row| {
            Ok(BookNoteWithBook {
                note: BookNote::from_db_row(row)?,
                book_title: row.try_get("book_title")?,
                book_author: row.try_get("book_author")?,
            })
        })
        .collect();

    notes.map_err(|e| format!("转换查询结果失败: {}", e))
}

#[tauri::command]
pub async fn update_book_note(
    app_handle: AppHandle,
    id: String,
    update_data: BookNoteUpdateData,
) -> Result<BookNote, String> {
    let db_pool = get_db_pool(&app_handle).await?;
    let now = chrono::Utc::now().timestamp_millis();

    // 提取 context 中的 before 和 after
    let (context_before, context_after) = if let Some(ref ctx) = update_data.context {
        (
            ctx.get("before")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            ctx.get("after")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
        )
    } else {
        (None, None)
    };

    // 简化：只更新提供的字段，使用单独的查询
    // 来源只认 'ai'，其余值一律收敛为 'user'（None 时 COALESCE 保留原值）
    let update_source = update_data
        .source
        .as_deref()
        .map(|s| if s == "ai" { "ai" } else { "user" });
    let query = sqlx::query(
        r#"
        UPDATE book_notes 
        SET type = COALESCE(?, type),
            cfi = COALESCE(?, cfi),
            text = COALESCE(?, text),
            style = COALESCE(?, style),
            color = COALESCE(?, color),
            note = COALESCE(?, note),
            context_before = COALESCE(?, context_before),
            context_after = COALESCE(?, context_after),
            category = COALESCE(?, category),
            source = COALESCE(?, source),
            starred = COALESCE(?, starred),
            updated_at = ?
        WHERE id = ?
        "#,
    )
    .bind(&update_data.r#type)
    .bind(&update_data.cfi)
    .bind(&update_data.text)
    .bind(&update_data.style)
    .bind(&update_data.color)
    .bind(&update_data.note)
    .bind(&context_before)
    .bind(&context_after)
    .bind(&update_data.category)
    .bind(update_source)
    .bind(update_data.starred.map(|b| if b { 1 } else { 0 }))
    .bind(now)
    .bind(&id);

    let result = query
        .execute(&db_pool)
        .await
        .map_err(|e| format!("更新笔记失败: {}", e))?;

    if result.rows_affected() == 0 {
        return Err("笔记不存在".to_string());
    }

    // 查询更新后的笔记
    let row = sqlx::query(
        r#"
        SELECT id, book_id, type, cfi, text, style, color, note, context_before, context_after, category, source, starred, created_at, updated_at
        FROM book_notes
        WHERE id = ?1
        "#
    )
    .bind(&id)
    .fetch_one(&db_pool)
    .await
    .map_err(|e| format!("查询更新后的笔记失败: {}", e))?;

    BookNote::from_db_row(&row).map_err(|e| format!("转换查询结果失败: {}", e))
}

#[tauri::command]
pub async fn delete_book_note(app_handle: AppHandle, id: String) -> Result<(), String> {
    let db_pool = get_db_pool(&app_handle).await?;

    let result = sqlx::query("DELETE FROM book_notes WHERE id = ?1")
        .bind(&id)
        .execute(&db_pool)
        .await
        .map_err(|e| format!("删除笔记失败: {}", e))?;

    if result.rows_affected() == 0 {
        return Err("笔记不存在".to_string());
    }

    Ok(())
}

/// 清空某本书的 C2 AI 重点标注（"重新生成"前置步骤）。
/// 删除条件显式带 source = 'ai' AND category IS NOT NULL：
/// 仅清 C2 重点标注（恒带 category）；对话创建的无 category AI 标注与人工标注（'user'）均保留。
/// 返回删除的行数。
#[tauri::command]
pub async fn delete_ai_book_notes(app_handle: AppHandle, book_id: String) -> Result<u64, String> {
    let db_pool = get_db_pool(&app_handle).await?;

    let result = sqlx::query("DELETE FROM book_notes WHERE book_id = ?1 AND source = 'ai' AND category IS NOT NULL")
        .bind(&book_id)
        .execute(&db_pool)
        .await
        .map_err(|e| format!("清空 AI 重点标注失败: {}", e))?;

    Ok(result.rows_affected())
}

// ==================== 论文（MARKDOWN）入库 ====================

/// 扫描到的论文目录信息（frontmatter 为原始 YAML 字符串，由前端解析）
#[derive(Serialize, Debug)]
pub struct ScannedPaper {
    pub dir: String,
    /// paper.md 内容的 sha256 前 16 位 hex（与书籍 id 同为内容哈希惯例）
    pub id: String,
    pub frontmatter: Option<String>,
    pub title_fallback: String,
    pub file_size: i64,
}

/// 提取首个 `---` / `---` 包裹的 YAML frontmatter 块（str::lines 已兼容 \r\n）
fn extract_frontmatter(content: &str) -> Option<String> {
    let mut lines = content.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    let mut yaml = String::new();
    for line in lines {
        if line.trim() == "---" {
            return Some(yaml);
        }
        yaml.push_str(line);
        yaml.push('\n');
    }
    None
}

/// 读取单个论文目录（必须含 paper.md），失败返回 None
fn scan_one_paper_dir(dir: &std::path::Path) -> Option<ScannedPaper> {
    let paper_path = dir.join("paper.md");
    let content = fs::read(&paper_path).ok()?;
    let id = format!("{:x}", Sha256::digest(&content))[..16].to_string();
    let frontmatter = std::str::from_utf8(&content)
        .ok()
        .and_then(extract_frontmatter);
    let title_fallback = dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    Some(ScannedPaper {
        dir: dir.to_string_lossy().to_string(),
        id,
        frontmatter,
        title_fallback,
        file_size: content.len() as i64,
    })
}

/// 扫描论文目录：dir 本身含 paper.md 则视为单篇；否则遍历一级子目录，凡含 paper.md 的都算
#[tauri::command]
pub async fn scan_papers_dir(dir: String) -> Result<Vec<ScannedPaper>, String> {
    let root = std::path::PathBuf::from(&dir);
    if !root.is_dir() {
        return Err(format!("目录不存在: {}", dir));
    }

    if root.join("paper.md").is_file() {
        return Ok(scan_one_paper_dir(&root).into_iter().collect());
    }

    let mut papers = Vec::new();
    let entries = fs::read_dir(&root).map_err(|e| format!("读取目录失败: {}", e))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && path.join("paper.md").is_file() {
            if let Some(paper) = scan_one_paper_dir(&path) {
                papers.push(paper);
            }
        }
    }
    Ok(papers)
}

/// 递归拷贝目录（内部会先创建目标目录）
fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| format!("创建目录失败 {}: {}", dst.display(), e))?;
    let entries =
        fs::read_dir(src).map_err(|e| format!("读取目录失败 {}: {}", src.display(), e))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let dest_path = dst.join(entry.file_name());
        if path.is_dir() {
            copy_dir_recursive(&path, &dest_path)?;
        } else if path.is_file() {
            fs::copy(&path, &dest_path)
                .map_err(|e| format!("拷贝文件失败 {}: {}", path.display(), e))?;
        }
    }
    Ok(())
}

/// 论文入库：拷贝 paper.md 与 images/ 到 books/{id}/，写 metadata.json，单事务 INSERT books + book_status
#[tauri::command]
pub async fn save_paper(
    app_handle: AppHandle,
    source_dir: String,
    id: String,
    metadata: serde_json::Value,
    title: String,
    author: String,
    language: String,
    // 是否把 source.pdf 拷入书库（None=拷；Zotero 导入传 Some(false)，以 zotero_pdf_path 回链代替）
    retain_source_pdf: Option<bool>,
) -> Result<SimpleBook, String> {
    let db_pool = get_db_pool(&app_handle).await?;

    // 幂等查重：id 已存在则报错，前端据"已存在"计 skipped（与 save_book 一致，回收站中的也算存在）
    if let Some(book) = get_book_by_id(app_handle.clone(), id.clone()).await? {
        return Err(format!("论文已存在: {} (ID: {})", book.title, book.id));
    }

    let source = std::path::PathBuf::from(&source_dir);
    let source_paper = source.join("paper.md");
    if !source_paper.is_file() {
        return Err(format!("paper.md 不存在: {}", source_dir));
    }

    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用目录失败: {}", e))?;

    let book_dir = app_data_dir.join("books").join(&id);
    fs::create_dir_all(&book_dir).map_err(|e| format!("创建目录失败: {}", e))?;

    let paper_path = book_dir.join("paper.md");
    fs::copy(&source_paper, &paper_path).map_err(|e| format!("拷贝 paper.md 失败: {}", e))?;
    let file_size = fs::metadata(&paper_path)
        .map_err(|e| format!("读取文件信息失败: {}", e))?
        .len() as i64;

    let source_images = source.join("images");
    if source_images.is_dir() {
        copy_dir_recursive(&source_images, &book_dir.join("images"))?;
    }

    // 源 PDF 留存（重解析用）：Zotero 导入走 zotero_pdf_path 回链不拷贝（用户偏好轻便），
    // 其余导入把 source.pdf 拷进书库目录自包含；拷贝失败仅告警不阻断入库
    if retain_source_pdf.unwrap_or(true) {
        let source_pdf = source.join("source.pdf");
        if source_pdf.is_file() {
            if let Err(e) = fs::copy(&source_pdf, book_dir.join("source.pdf")) {
                log::warn!("拷贝 source.pdf 失败（{}）: {}", source_pdf.display(), e);
            }
        }
    }

    let metadata_json = serde_json::to_string_pretty(&metadata)
        .map_err(|e| format!("序列化元数据失败: {}", e))?;
    fs::write(book_dir.join("metadata.json"), metadata_json)
        .map_err(|e| format!("保存元数据失败: {}", e))?;

    let file_path = format!("books/{}/paper.md", id);
    let now = chrono::Utc::now().timestamp_millis();

    let mut tx = db_pool
        .begin()
        .await
        .map_err(|e| format!("开启事务失败: {}", e))?;

    sqlx::query(
        r#"
        INSERT INTO books (
            id, title, author, format, file_path, cover_path,
            file_size, language, tags,
            created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&id)
    .bind(&title)
    .bind(&author)
    .bind("MARKDOWN")
    .bind(&file_path)
    .bind(None::<String>) // cover_path：论文无封面
    .bind(file_size)
    .bind(&language)
    .bind(None::<String>) // tags
    .bind(now)
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(|e| format!("数据库插入失败: {}", e))?;

    sqlx::query(
        r#"
        INSERT INTO book_status (
            book_id, status, progress_current, progress_total, location,
            metadata, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&id)
    .bind("unread")
    .bind(0i64)
    .bind(0i64)
    .bind("")
    .bind(None::<String>)
    .bind(now)
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(|e| format!("创建书籍状态失败: {}", e))?;

    tx.commit()
        .await
        .map_err(|e| format!("提交事务失败: {}", e))?;

    Ok(SimpleBook::new(
        id,
        title,
        author,
        "MARKDOWN".to_string(),
        file_path,
        None,
        file_size,
        language,
    ))
}

/// 文件/目录存在性检查（前端 plugin-fs 有作用域限制，Zotero storage 等库外路径必须走 Rust）
#[tauri::command]
pub async fn path_exists(path: String) -> Result<bool, String> {
    Ok(std::path::Path::new(&path).exists())
}

/// 重解析入库：用新的解析产物整体替换在库论文的 paper.md / images / metadata.json，
/// **保留论文 id**（文件夹归属、对话线程、标注全部随之存活；文内高亮靠 text 兜底重锚定）。
/// 调用方负责：source_dir 为新解析输出目录（含 paper.md），metadata 为新 frontmatter 解析结果。
#[tauri::command]
pub async fn replace_paper_content(
    app_handle: AppHandle,
    paper_id: String,
    source_dir: String,
    metadata: serde_json::Value,
) -> Result<(), String> {
    let db_pool = get_db_pool(&app_handle).await?;

    // 论文必须存在（回收站中的也允许重解析，与 save_paper 判存口径一致）
    let Some(book) = get_book_by_id(app_handle.clone(), paper_id.clone()).await? else {
        return Err(format!("论文不存在: {}", paper_id));
    };

    let source = std::path::PathBuf::from(&source_dir);
    let source_paper = source.join("paper.md");
    if !source_paper.is_file() {
        return Err(format!("paper.md 不存在: {}", source_dir));
    }

    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用目录失败: {}", e))?;
    let book_dir = app_data_dir.join("books").join(&paper_id);

    fs::copy(&source_paper, book_dir.join("paper.md")).map_err(|e| format!("替换 paper.md 失败: {}", e))?;
    let file_size = fs::metadata(book_dir.join("paper.md"))
        .map_err(|e| format!("读取文件信息失败: {}", e))?
        .len() as i64;

    // images 整体换新（先清后拷，避免残留旧图）
    let images_dir = book_dir.join("images");
    if images_dir.is_dir() {
        fs::remove_dir_all(&images_dir).map_err(|e| format!("清理旧 images 失败: {}", e))?;
    }
    let source_images = source.join("images");
    if source_images.is_dir() {
        copy_dir_recursive(&source_images, &images_dir)?;
    }

    let metadata_json = serde_json::to_string_pretty(&metadata)
        .map_err(|e| format!("序列化元数据失败: {}", e))?;
    fs::write(book_dir.join("metadata.json"), metadata_json)
        .map_err(|e| format!("保存元数据失败: {}", e))?;

    sqlx::query("UPDATE books SET file_size = ?, updated_at = ? WHERE id = ?")
        .bind(file_size)
        .bind(chrono::Utc::now().timestamp_millis())
        .bind(&book.id)
        .execute(&db_pool)
        .await
        .map_err(|e| format!("更新书籍记录失败: {}", e))?;

    Ok(())
}

// ==================== Note 相关命令（笔记面板，2026-08 重建） ====================

#[tauri::command]
pub async fn create_note(app_handle: AppHandle, note_data: NoteCreateData) -> Result<Note, String> {
    let db_pool = get_db_pool(&app_handle).await?;
    let now = chrono::Utc::now().timestamp_millis();

    let note = Note {
        id: uuid::Uuid::new_v4().to_string(),
        book_id: note_data.book_id,
        title: note_data.title.unwrap_or_default(),
        content: note_data.content.unwrap_or_default(),
        location_tag: note_data.location_tag,
        location_block: note_data.location_block,
        location_cfi: note_data.location_cfi,
        starred: false,
        created_at: now,
        updated_at: now,
    };

    sqlx::query(
        r#"
        INSERT INTO notes (id, book_id, title, content, location_tag, location_block, location_cfi, starred, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
        "#,
    )
    .bind(&note.id)
    .bind(&note.book_id)
    .bind(&note.title)
    .bind(&note.content)
    .bind(&note.location_tag)
    .bind(note.location_block)
    .bind(&note.location_cfi)
    .bind(0)
    .bind(note.created_at)
    .bind(note.updated_at)
    .execute(&db_pool)
    .await
    .map_err(|e| format!("创建笔记失败: {}", e))?;

    Ok(note)
}

/// 某本书/论文的全部笔记：星标置顶，组内按阅读流（location_block，空值排后）再按创建时间
#[tauri::command]
pub async fn get_notes(app_handle: AppHandle, book_id: String) -> Result<Vec<Note>, String> {
    let db_pool = get_db_pool(&app_handle).await?;

    let rows = sqlx::query(
        r#"
        SELECT id, book_id, title, content, location_tag, location_block, location_cfi, starred, created_at, updated_at
        FROM notes
        WHERE book_id = ?1
        ORDER BY starred DESC, location_block IS NULL, location_block ASC, created_at ASC
        "#,
    )
    .bind(&book_id)
    .fetch_all(&db_pool)
    .await
    .map_err(|e| format!("查询笔记失败: {}", e))?;

    let notes: Result<Vec<Note>, sqlx::Error> = rows.iter().map(Note::from_db_row).collect();
    notes.map_err(|e| format!("转换查询结果失败: {}", e))
}

#[tauri::command]
pub async fn update_note(
    app_handle: AppHandle,
    id: String,
    update_data: NoteUpdateData,
) -> Result<Note, String> {
    let db_pool = get_db_pool(&app_handle).await?;
    let now = chrono::Utc::now().timestamp_millis();

    let result = sqlx::query(
        r#"
        UPDATE notes
        SET title = COALESCE(?, title),
            content = COALESCE(?, content),
            location_tag = COALESCE(?, location_tag),
            location_block = COALESCE(?, location_block),
            location_cfi = COALESCE(?, location_cfi),
            starred = COALESCE(?, starred),
            updated_at = ?
        WHERE id = ?
        "#,
    )
    .bind(&update_data.title)
    .bind(&update_data.content)
    .bind(&update_data.location_tag)
    .bind(update_data.location_block)
    .bind(&update_data.location_cfi)
    .bind(update_data.starred.map(|b| if b { 1 } else { 0 }))
    .bind(now)
    .bind(&id)
    .execute(&db_pool)
    .await
    .map_err(|e| format!("更新笔记失败: {}", e))?;

    if result.rows_affected() == 0 {
        return Err("笔记不存在".to_string());
    }

    let row = sqlx::query(
        r#"
        SELECT id, book_id, title, content, location_tag, location_block, location_cfi, starred, created_at, updated_at
        FROM notes
        WHERE id = ?1
        "#,
    )
    .bind(&id)
    .fetch_one(&db_pool)
    .await
    .map_err(|e| format!("查询更新后的笔记失败: {}", e))?;

    Note::from_db_row(&row).map_err(|e| format!("转换查询结果失败: {}", e))
}

#[tauri::command]
pub async fn delete_note(app_handle: AppHandle, id: String) -> Result<(), String> {
    let db_pool = get_db_pool(&app_handle).await?;

    let result = sqlx::query("DELETE FROM notes WHERE id = ?1")
        .bind(&id)
        .execute(&db_pool)
        .await
        .map_err(|e| format!("删除笔记失败: {}", e))?;

    if result.rows_affected() == 0 {
        return Err("笔记不存在".to_string());
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::should_bump_position_changed;

    #[test]
    fn test_dwell_threshold() {
        // dwell < 30 的翻页：不推进（随手乱翻不算真读）
        assert!(!should_bump_position_changed("cfi-A", "cfi-B", 5));
        assert!(!should_bump_position_changed("cfi-A", "cfi-B", 29));
        // dwell >= 30 的翻页：推进（真读后的翻页）
        assert!(should_bump_position_changed("cfi-A", "cfi-B", 30));
        assert!(should_bump_position_changed("cfi-A", "cfi-B", 120));
        // 位置没变：无论 dwell 多少都不推进（仅打开书/原地活动）
        assert!(!should_bump_position_changed("cfi-A", "cfi-A", 999));
    }
}
