use super::models::*;
use sqlx::SqlitePool;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

/// scope 合法性校验（'reader' | 'paper'；全局助手 central 本批不做）
fn validate_scope(scope: &str) -> Result<(), String> {
    match scope {
        "reader" | "paper" => Ok(()),
        _ => Err(format!(
            "非法的提示词预设 scope: '{}'（仅支持 reader/paper）",
            scope
        )),
    }
}

#[tauri::command]
pub async fn list_prompt_presets(
    app_handle: AppHandle,
    scope: Option<String>,
) -> Result<Vec<PromptPreset>, String> {
    let db_pool = get_db_pool(&app_handle).await?;

    let rows = match &scope {
        Some(scope) => {
            validate_scope(scope)?;
            sqlx::query("SELECT * FROM prompt_presets WHERE scope = ? ORDER BY created_at ASC")
                .bind(scope)
                .fetch_all(&db_pool)
                .await
        }
        None => {
            sqlx::query("SELECT * FROM prompt_presets ORDER BY scope ASC, created_at ASC")
                .fetch_all(&db_pool)
                .await
        }
    }
    .map_err(|e| format!("获取提示词预设列表失败: {}", e))?;

    let presets: Result<Vec<PromptPreset>, sqlx::Error> =
        rows.iter().map(PromptPreset::from_db_row).collect();

    presets.map_err(|e| format!("转换查询结果失败: {}", e))
}

#[tauri::command]
pub async fn create_prompt_preset(
    app_handle: AppHandle,
    scope: String,
    name: String,
    content: String,
) -> Result<PromptPreset, String> {
    validate_scope(&scope)?;
    let db_pool = get_db_pool(&app_handle).await?;

    // 同 scope 内预设名唯一（互斥切换列表里重名无法区分）
    let existing = sqlx::query("SELECT id FROM prompt_presets WHERE scope = ? AND name = ?")
        .bind(&scope)
        .bind(&name)
        .fetch_optional(&db_pool)
        .await
        .map_err(|e| format!("检查预设名失败: {}", e))?;

    if existing.is_some() {
        return Err(format!("预设 '{}' 已存在", name));
    }

    let preset_id = Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp_millis();

    sqlx::query(
        r#"
        INSERT INTO prompt_presets (id, scope, name, content, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, 0, ?, ?)
        "#,
    )
    .bind(&preset_id)
    .bind(&scope)
    .bind(&name)
    .bind(&content)
    .bind(now)
    .bind(now)
    .execute(&db_pool)
    .await
    .map_err(|e| format!("创建提示词预设失败: {}", e))?;

    Ok(PromptPreset::new(preset_id, scope, name, content, false))
}

#[tauri::command]
pub async fn update_prompt_preset(
    app_handle: AppHandle,
    id: String,
    name: String,
    content: String,
) -> Result<PromptPreset, String> {
    let db_pool = get_db_pool(&app_handle).await?;
    let now = chrono::Utc::now().timestamp_millis();

    let preset = get_preset_by_id(&db_pool, &id)
        .await?
        .ok_or_else(|| "提示词预设不存在".to_string())?;

    // 改名时检查同 scope 内不重名
    if name != preset.name {
        let existing =
            sqlx::query("SELECT id FROM prompt_presets WHERE scope = ? AND name = ? AND id != ?")
                .bind(&preset.scope)
                .bind(&name)
                .bind(&id)
                .fetch_optional(&db_pool)
                .await
                .map_err(|e| format!("检查预设名失败: {}", e))?;

        if existing.is_some() {
            return Err(format!("预设名 '{}' 已被同组其他预设使用", name));
        }
    }

    sqlx::query("UPDATE prompt_presets SET name = ?, content = ?, updated_at = ? WHERE id = ?")
        .bind(&name)
        .bind(&content)
        .bind(now)
        .bind(&id)
        .execute(&db_pool)
        .await
        .map_err(|e| format!("更新提示词预设失败: {}", e))?;

    get_preset_by_id(&db_pool, &id)
        .await?
        .ok_or_else(|| "更新后无法找到提示词预设".to_string())
}

#[tauri::command]
pub async fn delete_prompt_preset(app_handle: AppHandle, id: String) -> Result<(), String> {
    let db_pool = get_db_pool(&app_handle).await?;

    // 删除激活中的预设即回落到内置默认提示词（同 scope 不再有激活行）
    let result = sqlx::query("DELETE FROM prompt_presets WHERE id = ?")
        .bind(&id)
        .execute(&db_pool)
        .await
        .map_err(|e| format!("删除提示词预设失败: {}", e))?;

    if result.rows_affected() == 0 {
        return Err("提示词预设不存在".to_string());
    }

    Ok(())
}

/// 激活指定预设：事务内把同 scope 其他行置 0、该行置 1，保证同组互斥。
#[tauri::command]
pub async fn set_active_prompt_preset(
    app_handle: AppHandle,
    id: String,
) -> Result<PromptPreset, String> {
    let db_pool = get_db_pool(&app_handle).await?;

    let preset = get_preset_by_id(&db_pool, &id)
        .await?
        .ok_or_else(|| "提示词预设不存在".to_string())?;

    let now = chrono::Utc::now().timestamp_millis();
    let mut tx = db_pool
        .begin()
        .await
        .map_err(|e| format!("开启事务失败: {}", e))?;

    sqlx::query("UPDATE prompt_presets SET is_active = 0, updated_at = ? WHERE scope = ?")
        .bind(now)
        .bind(&preset.scope)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("停用同组预设失败: {}", e))?;

    sqlx::query("UPDATE prompt_presets SET is_active = 1, updated_at = ? WHERE id = ?")
        .bind(now)
        .bind(&id)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("激活提示词预设失败: {}", e))?;

    tx.commit()
        .await
        .map_err(|e| format!("提交事务失败: {}", e))?;

    get_preset_by_id(&db_pool, &id)
        .await?
        .ok_or_else(|| "激活后无法找到提示词预设".to_string())
}

/// 清除某 scope 的激活预设 = 恢复内置默认提示词
#[tauri::command]
pub async fn clear_active_prompt_preset(
    app_handle: AppHandle,
    scope: String,
) -> Result<(), String> {
    validate_scope(&scope)?;
    let db_pool = get_db_pool(&app_handle).await?;

    sqlx::query("UPDATE prompt_presets SET is_active = 0, updated_at = ? WHERE scope = ?")
        .bind(chrono::Utc::now().timestamp_millis())
        .bind(&scope)
        .execute(&db_pool)
        .await
        .map_err(|e| format!("恢复默认提示词失败: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn get_active_prompt_preset(
    app_handle: AppHandle,
    scope: String,
) -> Result<Option<PromptPreset>, String> {
    validate_scope(&scope)?;
    let db_pool = get_db_pool(&app_handle).await?;

    let row = sqlx::query("SELECT * FROM prompt_presets WHERE scope = ? AND is_active = 1 LIMIT 1")
        .bind(&scope)
        .fetch_optional(&db_pool)
        .await
        .map_err(|e| format!("查询激活提示词预设失败: {}", e))?;

    match row {
        Some(row) => Ok(Some(
            PromptPreset::from_db_row(&row).map_err(|e| format!("转换查询结果失败: {}", e))?,
        )),
        None => Ok(None),
    }
}

async fn get_preset_by_id(db_pool: &SqlitePool, id: &str) -> Result<Option<PromptPreset>, String> {
    let row = sqlx::query("SELECT * FROM prompt_presets WHERE id = ?")
        .bind(id)
        .fetch_optional(db_pool)
        .await
        .map_err(|e| format!("查询提示词预设失败: {}", e))?;

    match row {
        Some(row) => Ok(Some(
            PromptPreset::from_db_row(&row).map_err(|e| format!("转换查询结果失败: {}", e))?,
        )),
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
