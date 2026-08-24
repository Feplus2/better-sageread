use sqlx::SqlitePool;
use tokio::sync::Mutex;

#[derive(Default)]
pub struct AppState {
    pub db_pool: Mutex<Option<SqlitePool>>,
    /// 备份进行中标记（Rust 侧权威状态）：备份跑在后台全程，UI 重建后据此恢复"备份中"展示，并防重复发起
    pub backup_running: std::sync::atomic::AtomicBool,
    /// L2 增量同步进行中标记（P4 防重入）：调度 tick / 开书快拉 / 手动按钮 / Agent 工具
    /// 多入口并发会让两份 SyncState 读-改-写互覆（水位回退）。引擎入口 swap 占锁、收尾释放
    pub l2_running: std::sync::atomic::AtomicBool,
}
