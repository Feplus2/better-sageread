/// 同步表注册表：主键与"已知列"清单（协议 §5 宽容读者原则的写入侧——只写已知列）
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ColType {
    Text,
    Int,
}

pub struct SyncTable {
    pub name: &'static str,
    /// 主键表达式（直接嵌入 SQL 与触发器）：普通表是列名（如 "id"），
    /// 复合主键关系表用拼接表达式（如 paper_folders 的 "paper_id || ':' || folder_id"，
    /// 触发器里展开为 NEW.paper_id || ':' || NEW.folder_id）
    pub pk: &'static str,
    pub columns: &'static [(&'static str, ColType)],
}

pub const TABLES: &[SyncTable] = &[
    SyncTable {
        name: "threads",
        pk: "id",
        columns: &[
            ("id", ColType::Text),
            ("book_id", ColType::Text),
            ("metadata", ColType::Text),
            ("title", ColType::Text),
            ("messages", ColType::Text),
            ("starred", ColType::Int),
            ("scope", ColType::Text),
            ("created_at", ColType::Int),
            ("updated_at", ColType::Int),
        ],
    },
    SyncTable {
        name: "books",
        pk: "id",
        columns: &[
            ("id", ColType::Text),
            ("title", ColType::Text),
            ("author", ColType::Text),
            ("format", ColType::Text),
            ("file_path", ColType::Text),
            ("cover_path", ColType::Text),
            ("file_size", ColType::Int),
            ("language", ColType::Text),
            ("tags", ColType::Text),
            ("trashed_at", ColType::Int),
            ("created_at", ColType::Int),
            ("updated_at", ColType::Int),
        ],
    },
    SyncTable {
        name: "book_status",
        pk: "book_id",
        columns: &[
            ("book_id", ColType::Text),
            ("status", ColType::Text),
            ("progress_current", ColType::Int),
            ("progress_total", ColType::Int),
            ("location", ColType::Text),
            ("last_read_at", ColType::Int),
            ("position_changed_at", ColType::Int),
            ("dwell_seconds", ColType::Int),
            ("rating", ColType::Int),
            ("started_at", ColType::Int),
            ("completed_at", ColType::Int),
            ("metadata", ColType::Text),
            ("created_at", ColType::Int),
            ("updated_at", ColType::Int),
        ],
    },
    SyncTable {
        name: "reading_sessions",
        pk: "id",
        columns: &[
            ("id", ColType::Text),
            ("book_id", ColType::Text),
            ("started_at", ColType::Int),
            ("ended_at", ColType::Int),
            ("duration_seconds", ColType::Int),
            ("created_at", ColType::Int),
            ("updated_at", ColType::Int),
        ],
    },
    SyncTable {
        name: "tags",
        pk: "id",
        columns: &[
            ("id", ColType::Text),
            ("name", ColType::Text),
            ("color", ColType::Text),
            ("created_at", ColType::Int),
            ("updated_at", ColType::Int),
        ],
    },
    SyncTable {
        name: "book_notes",
        pk: "id",
        columns: &[
            ("id", ColType::Text),
            ("book_id", ColType::Text),
            ("type", ColType::Text),
            ("cfi", ColType::Text),
            ("text", ColType::Text),
            ("style", ColType::Text),
            ("color", ColType::Text),
            ("note", ColType::Text),
            ("context_before", ColType::Text),
            ("context_after", ColType::Text),
            ("category", ColType::Text),
            ("source", ColType::Text),
            ("starred", ColType::Int),
            ("created_at", ColType::Int),
            ("updated_at", ColType::Int),
        ],
    },
    SyncTable {
        name: "skills",
        pk: "id",
        columns: &[
            ("id", ColType::Text),
            ("name", ColType::Text),
            ("content", ColType::Text),
            ("is_active", ColType::Int),
            ("is_system", ColType::Int),
            ("scope", ColType::Text),
            ("created_at", ColType::Int),
            ("updated_at", ColType::Int),
        ],
    },
    // ---- ④ 2026-08-10 扩容：文件夹/提示词预设入 L2b ----
    SyncTable {
        name: "folders",
        pk: "id",
        columns: &[
            ("id", ColType::Text),
            ("name", ColType::Text),
            ("parent_id", ColType::Text),
            ("trashed_at", ColType::Int),
            ("created_at", ColType::Int),
            ("updated_at", ColType::Int),
        ],
    },
    SyncTable {
        // 复合主键关系表：无 updated_at，INSERT 走 OR IGNORE（同 reading_sessions），
        // DELETE 按存在性判定（local_updated_at 对无 updated_at 的表退化为存在检查）
        name: "paper_folders",
        pk: "paper_id || ':' || folder_id",
        columns: &[("paper_id", ColType::Text), ("folder_id", ColType::Text)],
    },
    SyncTable {
        name: "prompt_presets",
        pk: "id",
        columns: &[
            ("id", ColType::Text),
            ("scope", ColType::Text),
            ("name", ColType::Text),
            ("content", ColType::Text),
            ("is_active", ColType::Int),
            ("created_at", ColType::Int),
            ("updated_at", ColType::Int),
        ],
    },
];

pub fn find_table(name: &str) -> Option<&'static SyncTable> {
    TABLES.iter().find(|t| t.name == name)
}
