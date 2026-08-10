use sqlx::SqlitePool;
use tokio::sync::Mutex;

#[derive(Default)]
pub struct AppState {
    pub db_pool: Mutex<Option<SqlitePool>>,
    /// 备份进行中标记（Rust 侧权威状态）：备份跑在后台全程，UI 重建后据此恢复"备份中"展示，并防重复发起
    pub backup_running: std::sync::atomic::AtomicBool,
}
