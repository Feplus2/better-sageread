use serde::{Deserialize, Serialize};
use sqlx::Row;

/// 文献库文件夹（树表）：论文可挂任意层级节点，成员关系在 paper_folders（多对多）。
/// trashed_at 非空 = 已软删除（回收站）；子孙文件夹因祖先被删而整体隐藏，成员关系保留
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Folder {
    pub id: String,
    pub name: String,
    #[serde(rename = "parentId")]
    pub parent_id: Option<String>,
    #[serde(rename = "trashedAt")]
    pub trashed_at: Option<i64>,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
}

impl Folder {
    pub fn from_db_row(row: &sqlx::sqlite::SqliteRow) -> Result<Self, sqlx::Error> {
        Ok(Self {
            id: row.try_get("id")?,
            name: row.try_get("name")?,
            parent_id: row.try_get("parent_id")?,
            trashed_at: row.try_get("trashed_at")?,
            created_at: row.try_get("created_at")?,
            updated_at: row.try_get("updated_at")?,
        })
    }
}

/// paper_folders 关系行：一篇论文可属多个文件夹；迁移论文只动这张表，向量数据不动
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PaperFolder {
    #[serde(rename = "paperId")]
    pub paper_id: String,
    #[serde(rename = "folderId")]
    pub folder_id: String,
}
