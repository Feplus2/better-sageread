use super::models::*;
use sqlx::{Row, SqlitePool};
use std::collections::HashMap;
use tauri::{AppHandle, Manager};

/// 可见文件夹（扁平返回，树由前端组装），按创建时间升序保证顺序稳定。
/// 排除"自身或任一祖先被 trashed"的文件夹：被删文件夹的子树整体隐藏
#[tauri::command]
pub async fn list_folders(app_handle: AppHandle) -> Result<Vec<Folder>, String> {
    let db_pool = get_db_pool(&app_handle).await?;

    let rows = sqlx::query("SELECT * FROM folders ORDER BY created_at ASC")
        .fetch_all(&db_pool)
        .await
        .map_err(|e| format!("查询文件夹失败: {}", e))?;

    let folders: Vec<Folder> = rows
        .iter()
        .map(Folder::from_db_row)
        .collect::<Result<_, _>>()
        .map_err(|e| format!("转换查询结果失败: {}", e))?;

    // 树规模小，内存中沿父链检查每个文件夹的可见性
    let by_id: HashMap<&str, &Folder> = folders.iter().map(|f| (f.id.as_str(), f)).collect();
    Ok(folders
        .iter()
        .filter(|folder| {
            let mut cursor = Some(*folder);
            while let Some(cur) = cursor {
                if cur.trashed_at.is_some() {
                    return false;
                }
                cursor = cur.parent_id.as_deref().and_then(|pid| by_id.get(pid).copied());
            }
            true
        })
        .cloned()
        .collect())
}

/// 回收站中的文件夹（只看自身 trashed_at；随祖先被删而隐藏的子孙自身未被标记，不在此列）
#[tauri::command]
pub async fn list_trashed_folders(app_handle: AppHandle) -> Result<Vec<Folder>, String> {
    let db_pool = get_db_pool(&app_handle).await?;

    let rows = sqlx::query("SELECT * FROM folders WHERE trashed_at IS NOT NULL ORDER BY trashed_at DESC")
        .fetch_all(&db_pool)
        .await
        .map_err(|e| format!("查询回收站文件夹失败: {}", e))?;

    let folders: Result<Vec<Folder>, sqlx::Error> = rows.iter().map(Folder::from_db_row).collect();
    folders.map_err(|e| format!("转换查询结果失败: {}", e))
}

#[tauri::command]
pub async fn create_folder(
    app_handle: AppHandle,
    name: String,
    parent_id: Option<String>,
) -> Result<Folder, String> {
    let db_pool = get_db_pool(&app_handle).await?;

    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("文件夹名称不能为空".to_string());
    }

    // 父文件夹必须存在且可见（不能在已删除文件夹或其子树下新建）
    if let Some(ref pid) = parent_id {
        if !folder_visible(&db_pool, pid).await? {
            return Err("父文件夹不存在或已在回收站".to_string());
        }
    }

    let now = chrono::Utc::now().timestamp_millis();
    let folder = Folder {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        parent_id,
        trashed_at: None,
        created_at: now,
        updated_at: now,
    };

    sqlx::query("INSERT INTO folders (id, name, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .bind(&folder.id)
        .bind(&folder.name)
        .bind(&folder.parent_id)
        .bind(folder.created_at)
        .bind(folder.updated_at)
        .execute(&db_pool)
        .await
        .map_err(|e| format!("创建文件夹失败: {}", e))?;

    Ok(folder)
}

#[tauri::command]
pub async fn rename_folder(app_handle: AppHandle, id: String, name: String) -> Result<(), String> {
    let db_pool = get_db_pool(&app_handle).await?;

    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("文件夹名称不能为空".to_string());
    }

    let result = sqlx::query("UPDATE folders SET name = ?, updated_at = ? WHERE id = ? AND trashed_at IS NULL")
        .bind(&name)
        .bind(chrono::Utc::now().timestamp_millis())
        .bind(&id)
        .execute(&db_pool)
        .await
        .map_err(|e| format!("重命名文件夹失败: {}", e))?;

    if result.rows_affected() == 0 {
        return Err("文件夹不存在或已在回收站".to_string());
    }

    Ok(())
}

/// 软删除（移入回收站）：仅给该文件夹本身置 trashed_at，子树因祖先被删而整体隐藏；
/// paper_folders 成员关系原样保留，论文不动，恢复后结构与归属原样回来
#[tauri::command]
pub async fn delete_folder(app_handle: AppHandle, id: String) -> Result<(), String> {
    let db_pool = get_db_pool(&app_handle).await?;

    let now = chrono::Utc::now().timestamp_millis();
    let result = sqlx::query("UPDATE folders SET trashed_at = ?, updated_at = ? WHERE id = ? AND trashed_at IS NULL")
        .bind(now)
        .bind(now)
        .bind(&id)
        .execute(&db_pool)
        .await
        .map_err(|e| format!("删除文件夹失败: {}", e))?;

    if result.rows_affected() == 0 {
        return Err("文件夹不存在或已在回收站".to_string());
    }

    Ok(())
}

/// 从回收站恢复：清除 trashed_at，子树随该文件夹重现（成员关系一直在，未动过）
#[tauri::command]
pub async fn restore_folder(app_handle: AppHandle, id: String) -> Result<(), String> {
    let db_pool = get_db_pool(&app_handle).await?;

    let result = sqlx::query("UPDATE folders SET trashed_at = NULL, updated_at = ? WHERE id = ? AND trashed_at IS NOT NULL")
        .bind(chrono::Utc::now().timestamp_millis())
        .bind(&id)
        .execute(&db_pool)
        .await
        .map_err(|e| format!("恢复文件夹失败: {}", e))?;

    if result.rows_affected() == 0 {
        return Err("文件夹不存在或不在回收站".to_string());
    }

    Ok(())
}

/// 彻底清除：子文件夹经 parent_id 外键级联删除，paper_folders 行经 folder_id 外键级联清除；
/// 论文本身不删除，仅失去归属
#[tauri::command]
pub async fn purge_folder(app_handle: AppHandle, id: String) -> Result<(), String> {
    let db_pool = get_db_pool(&app_handle).await?;

    let result = sqlx::query("DELETE FROM folders WHERE id = ?")
        .bind(&id)
        .execute(&db_pool)
        .await
        .map_err(|e| format!("彻底删除文件夹失败: {}", e))?;

    if result.rows_affected() == 0 {
        return Err("文件夹不存在".to_string());
    }

    Ok(())
}

/// 移动文件夹到新父节点（None = 移到根级）。环检测：目标父链上不能出现自身
#[tauri::command]
pub async fn move_folder(
    app_handle: AppHandle,
    id: String,
    new_parent_id: Option<String>,
) -> Result<(), String> {
    let db_pool = get_db_pool(&app_handle).await?;

    if !folder_exists(&db_pool, &id).await? {
        return Err("文件夹不存在".to_string());
    }
    if folder_is_trashed(&db_pool, &id).await? {
        return Err("文件夹已在回收站，无法移动".to_string());
    }

    if let Some(ref pid) = new_parent_id {
        if !folder_visible(&db_pool, pid).await? {
            return Err("目标父文件夹不存在或已在回收站".to_string());
        }
        // 环检测：从目标父文件夹沿父链向上走，撞到自身即拒绝（不能移到自己或后代之下）
        let mut cursor = Some(pid.clone());
        while let Some(cur) = cursor {
            if cur == id {
                return Err("不能将文件夹移动到自身或其子孙之下".to_string());
            }
            cursor = parent_of(&db_pool, &cur).await?;
        }
    }

    sqlx::query("UPDATE folders SET parent_id = ?, updated_at = ? WHERE id = ?")
        .bind(&new_parent_id)
        .bind(chrono::Utc::now().timestamp_millis())
        .bind(&id)
        .execute(&db_pool)
        .await
        .map_err(|e| format!("移动文件夹失败: {}", e))?;

    Ok(())
}

/// 整体替换某篇论文的文件夹归属（事务内 delete + insert；folder_id 不存在由外键报错）
#[tauri::command]
pub async fn set_paper_folders(
    app_handle: AppHandle,
    paper_id: String,
    folder_ids: Vec<String>,
) -> Result<(), String> {
    let db_pool = get_db_pool(&app_handle).await?;

    // 防御性检查：不能挂载到不存在或已软删（含祖先被删而隐藏）的文件夹
    for folder_id in &folder_ids {
        if !folder_visible(&db_pool, folder_id).await? {
            return Err("目标文件夹不存在或已在回收站".to_string());
        }
    }

    let mut tx = db_pool
        .begin()
        .await
        .map_err(|e| format!("开启事务失败: {}", e))?;

    sqlx::query("DELETE FROM paper_folders WHERE paper_id = ?")
        .bind(&paper_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("清除文件夹归属失败: {}", e))?;

    // 去重：主键 (paper_id, folder_id)，重复插入会报错
    let mut ids = folder_ids;
    ids.sort();
    ids.dedup();

    for folder_id in &ids {
        sqlx::query("INSERT INTO paper_folders (paper_id, folder_id) VALUES (?, ?)")
            .bind(&paper_id)
            .bind(folder_id)
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("设置文件夹归属失败: {}", e))?;
    }

    tx.commit()
        .await
        .map_err(|e| format!("提交事务失败: {}", e))?;

    Ok(())
}

/// 全量成员关系（前端一次拿全，避免 N+1）
#[tauri::command]
pub async fn get_paper_folder_map(app_handle: AppHandle) -> Result<Vec<PaperFolder>, String> {
    let db_pool = get_db_pool(&app_handle).await?;

    let rows = sqlx::query("SELECT paper_id, folder_id FROM paper_folders")
        .fetch_all(&db_pool)
        .await
        .map_err(|e| format!("查询论文文件夹关系失败: {}", e))?;

    Ok(rows
        .iter()
        .map(|row| PaperFolder {
            paper_id: row.get("paper_id"),
            folder_id: row.get("folder_id"),
        })
        .collect())
}

async fn folder_exists(db_pool: &SqlitePool, id: &str) -> Result<bool, String> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM folders WHERE id = ?")
        .bind(id)
        .fetch_one(db_pool)
        .await
        .map_err(|e| format!("查询文件夹失败: {}", e))?;
    Ok(count > 0)
}

async fn parent_of(db_pool: &SqlitePool, id: &str) -> Result<Option<String>, String> {
    sqlx::query_scalar("SELECT parent_id FROM folders WHERE id = ?")
        .bind(id)
        .fetch_optional(db_pool)
        .await
        .map(|row| row.flatten())
        .map_err(|e| format!("查询文件夹失败: {}", e))
}

/// 文件夹自身是否已软删除（id 不存在时返回 false，存在性由 folder_exists 检查）
async fn folder_is_trashed(db_pool: &SqlitePool, id: &str) -> Result<bool, String> {
    let trashed_at: Option<Option<i64>> = sqlx::query_scalar("SELECT trashed_at FROM folders WHERE id = ?")
        .bind(id)
        .fetch_optional(db_pool)
        .await
        .map_err(|e| format!("查询文件夹失败: {}", e))?;
    Ok(trashed_at.flatten().is_some())
}

/// 文件夹是否可见：存在，且自身与所有祖先都未被软删除（被删文件夹的子孙整体隐藏）
async fn folder_visible(db_pool: &SqlitePool, id: &str) -> Result<bool, String> {
    let mut cursor = Some(id.to_string());
    while let Some(cur) = cursor {
        let row: Option<(Option<String>, Option<i64>)> =
            sqlx::query_as("SELECT parent_id, trashed_at FROM folders WHERE id = ?")
                .bind(&cur)
                .fetch_optional(db_pool)
                .await
                .map_err(|e| format!("查询文件夹失败: {}", e))?;
        match row {
            None => return Ok(false),
            Some((_, Some(_))) => return Ok(false),
            Some((parent_id, None)) => cursor = parent_id,
        }
    }
    Ok(true)
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
