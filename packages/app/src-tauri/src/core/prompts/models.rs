use serde::{Deserialize, Serialize};

/// 提示词预设（prompt preset）：阅读/论文助手的命名系统提示词。
/// 同 scope 内 is_active 互斥（由 set_active_prompt_preset 在事务内保证），
/// 无激活行 = 使用内置默认提示词。
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PromptPreset {
    pub id: String,
    /// 生效的 Agent 作用域：'reader' | 'paper'
    pub scope: String,
    pub name: String,
    pub content: String,
    #[serde(rename = "isActive")]
    pub is_active: bool,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
}

impl PromptPreset {
    pub fn new(id: String, scope: String, name: String, content: String, is_active: bool) -> Self {
        let now = chrono::Utc::now().timestamp_millis();
        Self {
            id,
            scope,
            name,
            content,
            is_active,
            created_at: now,
            updated_at: now,
        }
    }

    pub fn from_db_row(row: &sqlx::sqlite::SqliteRow) -> Result<Self, sqlx::Error> {
        use sqlx::Row;

        Ok(Self {
            id: row.try_get("id")?,
            scope: row.try_get("scope")?,
            name: row.try_get("name")?,
            content: row.try_get("content")?,
            is_active: row.try_get::<i32, _>("is_active")? != 0,
            created_at: row.try_get("created_at")?,
            updated_at: row.try_get("updated_at")?,
        })
    }
}
