//! AI 用量流水（2026-08-28 统计面板）：每条 AI 回复 finish 时由前端落一行，
//! 聚合（时间窗/模型占比）全在前端做——命令只提供插入与区间取回。

use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};
use tauri::{AppHandle, Manager};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiUsageEntryData {
    pub thread_id: Option<String>,
    pub scope: String,
    pub provider_id: String,
    pub model_id: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiUsageEntry {
    pub id: i64,
    pub thread_id: Option<String>,
    pub scope: String,
    pub provider_id: String,
    pub model_id: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub created_at: i64,
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

#[tauri::command]
pub async fn record_ai_usage(
    app_handle: AppHandle,
    entry: AiUsageEntryData,
) -> Result<(), String> {
    let db_pool = get_db_pool(&app_handle).await?;
    let now = chrono::Utc::now().timestamp_millis();

    sqlx::query(
        r#"
        INSERT INTO ai_usage (
            thread_id, scope, provider_id, model_id, input_tokens, output_tokens, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&entry.thread_id)
    .bind(&entry.scope)
    .bind(&entry.provider_id)
    .bind(&entry.model_id)
    .bind(entry.input_tokens)
    .bind(entry.output_tokens)
    .bind(now)
    .execute(&db_pool)
    .await
    .map_err(|e| format!("记录 AI 用量失败: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn get_ai_usage_entries(
    app_handle: AppHandle,
    start_date: Option<i64>,
    end_date: Option<i64>,
) -> Result<Vec<AiUsageEntry>, String> {
    let db_pool = get_db_pool(&app_handle).await?;

    let rows = sqlx::query(
        r#"
        SELECT id, thread_id, scope, provider_id, model_id, input_tokens, output_tokens, created_at
        FROM ai_usage
        WHERE (?1 IS NULL OR created_at >= ?1) AND (?2 IS NULL OR created_at <= ?2)
        ORDER BY created_at ASC
        "#,
    )
    .bind(start_date)
    .bind(end_date)
    .fetch_all(&db_pool)
    .await
    .map_err(|e| format!("查询 AI 用量失败: {}", e))?;

    Ok(rows
        .iter()
        .map(|row| AiUsageEntry {
            id: row.try_get("id").unwrap_or(0),
            thread_id: row.try_get("thread_id").unwrap_or(None),
            scope: row.try_get("scope").unwrap_or_default(),
            provider_id: row.try_get("provider_id").unwrap_or_default(),
            model_id: row.try_get("model_id").unwrap_or_default(),
            input_tokens: row.try_get("input_tokens").unwrap_or(0),
            output_tokens: row.try_get("output_tokens").unwrap_or(0),
            created_at: row.try_get("created_at").unwrap_or(0),
        })
        .collect())
}
