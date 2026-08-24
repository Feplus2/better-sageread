use super::models::{l2_root, BackupInfo, BackupManifest, BackupOutcome, SyncState, WebdavConfig};
use super::{assets, backup, engine, files, restore, webdav};
use crate::core::state::AppState;
use sqlx::{Row, SqlitePool};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager, State};

/// 取数据库连接池克隆（立即释放全局锁——锁只护句柄获取，不护后续网络 await）
async fn clone_db_pool(state: &State<'_, AppState>) -> Result<SqlitePool, String> {
    let guard = state.db_pool.lock().await;
    guard.as_ref().cloned().ok_or_else(|| "数据库未初始化".to_string())
}

const CONFIG_FILE: &str = "webdav-config.json";

/// 密码掩码（S3）：返回前端与前端提交均使用此占位；提交掩码时保留已存真密码
pub const PASSWORD_MASK: &str = "********";

/// 提交配置时解析真实密码：掩码/未变 → 沿用已存密码；新值 → 用新值
fn resolve_password(submitted: &str, saved: Option<&WebdavConfig>) -> String {
    if submitted == PASSWORD_MASK {
        saved.map(|c| c.password.clone()).unwrap_or_default()
    } else {
        submitted.to_string()
    }
}

/// 云端目录布局：统一收在 bettersageread/ 下；旧版为两个并列顶层目录
const CLOUD_HOME: &str = "bettersageread";
const L2_ROOT: &str = "bettersageread/sync";
const BACKUP_DIR: &str = "bettersageread/backups";
const LEGACY_L2_ROOT: &str = "bettersageread-sync";
const LEGACY_BACKUP_DIR: &str = "bettersageread-backups";

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(config_dir.join(CONFIG_FILE))
}

fn load_config(app: &AppHandle) -> Result<WebdavConfig, String> {
    let path = config_path(app)?;
    if !path.exists() {
        return Err("尚未配置 WebDAV".to_string());
    }
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut config: WebdavConfig =
        serde_json::from_str(&content).map_err(|e| format!("解析 WebDAV 配置失败: {e}"))?;
    // 批次 A：密码由 keyring 保管，JSON 里为空时从凭据管理器补水
    if config.password.is_empty() {
        config.password = crate::core::secrets::get_secret(app, "webdav", "password")
            .ok()
            .flatten()
            .unwrap_or_default();
    }
    Ok(config)
}

/// 读取 WebDAV 配置（供退出前推送等非命令路径复用）
pub fn load_webdav_config(app: &AppHandle) -> Result<WebdavConfig, String> {
    load_config(app)
}

/// 云端目录布局迁移：sageread-{sync,backups} → sageread/{sync,backups}（幂等，绝不搞断同步）
///
/// - 旧目录存在且新目录不存在时尝试 WebDAV MOVE 整体搬家
/// - 服务器拒绝 MOVE（坚果云对集合 MOVE 返回 403）时**回退旧目录继续使用**：
///   L2 把覆盖值写进配置 l2_root，备份保持 remote_dir 旧值，同步/备份均不受影响
/// - 新旧目录同时存在（搬迁中断/多端时差）时以旧目录为准并告警，提示手动清理
/// - 成功后把 endpoint 记入 sync-state 哨兵，之后零网络开销短路
/// - 用户在 WebDAV 后台手动搬完家后，启动时复查会自动清除覆盖、回到新布局
pub async fn migrate_cloud_layout(app: &AppHandle) -> Result<(), String> {
    migrate_cloud_layout_inner(app, false).await
}

/// 启动时调用：忽略哨兵复查一遍（用户可能在 WebDAV 后台手动搬了家）
pub async fn migrate_cloud_layout_at_startup(app: &AppHandle) -> Result<(), String> {
    migrate_cloud_layout_inner(app, true).await
}

async fn migrate_cloud_layout_inner(app: &AppHandle, force: bool) -> Result<(), String> {
    let mut config = match load_config(app) {
        Ok(c) => c,
        Err(_) => return Ok(()), // 未配置 WebDAV：无事可迁
    };
    if config.endpoint.trim().is_empty() {
        return Ok(());
    }
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let mut state = backup::read_sync_state(&config_dir);
    let endpoint_key = config.endpoint.trim_end_matches('/').to_string();
    if !force && state.cloud_layout_migrated_for.as_deref() == Some(endpoint_key.as_str()) {
        return Ok(());
    }

    let legacy_l2_exists = webdav::path_exists(&config, LEGACY_L2_ROOT).await?;
    let new_l2_exists = webdav::path_exists(&config, L2_ROOT).await?;
    let mut config_dirty = false;

    if legacy_l2_exists && !new_l2_exists {
        // 标准搬家：旧的在、新的不在 → MOVE
        if let Err(e) = async {
            webdav::ensure_remote_dirs(&config, &[CLOUD_HOME.to_string()]).await?;
            webdav::move_path(&config, LEGACY_L2_ROOT, L2_ROOT).await
        }
        .await
        {
            log::warn!("云端目录搬家失败（{e}），本端继续使用 {LEGACY_L2_ROOT}，同步不受影响");
            config.l2_root = Some(LEGACY_L2_ROOT.to_string());
            config_dirty = true;
        } else {
            log::info!("云端目录迁移：{LEGACY_L2_ROOT} → {L2_ROOT}");
        }
    } else if legacy_l2_exists && new_l2_exists && config.l2_root.is_none() {
        // 两边都在：以历史更全的旧目录为准，提示手动清理多余的新目录
        log::warn!("云端 {LEGACY_L2_ROOT} 与 {L2_ROOT} 同时存在，以旧目录为准；建议确认后手动删除 {L2_ROOT}");
        config.l2_root = Some(LEGACY_L2_ROOT.to_string());
        config_dirty = true;
    } else if !legacy_l2_exists && new_l2_exists && config.l2_root.is_some() {
        // 用户已手动搬完家：清除覆盖，回到新布局
        config.l2_root = None;
        config_dirty = true;
    }

    if config.remote_dir.trim_matches('/') == LEGACY_BACKUP_DIR {
        let legacy_bak_exists = webdav::path_exists(&config, LEGACY_BACKUP_DIR).await?;
        let new_bak_exists = webdav::path_exists(&config, BACKUP_DIR).await?;
        if legacy_bak_exists && !new_bak_exists {
            if let Err(e) = async {
                webdav::ensure_remote_dirs(&config, &[CLOUD_HOME.to_string()]).await?;
                webdav::move_path(&config, LEGACY_BACKUP_DIR, BACKUP_DIR).await
            }
            .await
            {
                log::warn!("云端备份目录搬家失败（{e}），本端继续使用 {LEGACY_BACKUP_DIR}，备份不受影响");
            // remote_dir 保持旧值不动
            } else {
                log::info!("云端目录迁移：{LEGACY_BACKUP_DIR} → {BACKUP_DIR}");
                config.remote_dir = BACKUP_DIR.to_string();
                config_dirty = true;
            }
        } else {
            // 旧目录无数据可搬（或新目录已就位）：直接切到新默认
            config.remote_dir = BACKUP_DIR.to_string();
            config_dirty = true;
        }
    }

    if config_dirty {
        // 批次 A 口径：密码住 keyring；load_config 已补水，写盘前必须置空，防真密码明文回写
        config.password = String::new();
        let content = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
        fs::write(config_path(app)?, content).map_err(|e| e.to_string())?;
    }

    state.cloud_layout_migrated_for = Some(endpoint_key);
    backup::write_sync_state(&config_dir, &state)
}

/// 返回前端的配置视图：密码字段永远掩码，另附 has_password 标记（S3）
#[derive(serde::Serialize)]
pub struct WebdavConfigView {
    #[serde(flatten)]
    pub config: WebdavConfig,
    pub has_password: bool,
}

#[tauri::command]
pub async fn sync_get_config(app: AppHandle) -> Result<Option<WebdavConfigView>, String> {
    let path = config_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut config: WebdavConfig =
        serde_json::from_str(&content).map_err(|e| format!("解析 WebDAV 配置失败: {e}"))?;
    // A 批后密码住 keyring、JSON 恒空：「已保存」判定须查凭据管理器（兼顾旧版 JSON 残留）
    let has_password = !config.password.is_empty()
        || crate::core::secrets::get_secret(&app, "webdav", "password")
            .ok()
            .flatten()
            .is_some_and(|p| !p.is_empty());
    // S3：真密码不返回前端，前端只见掩码
    config.password = if has_password { PASSWORD_MASK.to_string() } else { String::new() };
    Ok(Some(WebdavConfigView { config, has_password }))
}

/// 保存配置到本地 webdav-config.json（只存本地，不进备份包）；
/// 前端提交掩码密码时保留原密码不变（S3）；批次 A 后密码入 keyring，JSON 不存明文
#[tauri::command]
pub async fn sync_save_config(app: AppHandle, mut config: WebdavConfig) -> Result<(), String> {
    let saved = load_config(&app).ok();
    config.password = resolve_password(&config.password, saved.as_ref());
    // 批次 A：密码写入凭据管理器，JSON 落盘置空
    if !config.password.is_empty() {
        crate::core::secrets::set_secret(&app, "webdav", "password", &config.password)?;
    } else {
        let _ = crate::core::secrets::delete_secret(&app, "webdav", "password");
    }
    config.password = String::new();
    let path = config_path(&app)?;
    let content = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(path, content).map_err(|e| e.to_string())
}

/// 测试连接：密码用真值（前端提交掩码时 Rust 侧自取已存密码），不经过前端明文回传（S3）
#[tauri::command]
pub async fn sync_test_connection(app: AppHandle, mut config: WebdavConfig) -> Result<String, String> {
    let saved = load_config(&app).ok();
    config.password = resolve_password(&config.password, saved.as_ref());
    if config.password.is_empty() {
        return Err("尚未设置密码".to_string());
    }
    webdav::test_connection(&config).await
}

#[tauri::command]
pub async fn sync_backup_now(app: AppHandle, state: State<'_, AppState>) -> Result<BackupOutcome, String> {
    // 防重入：备份在 Rust 侧跑全程（关设置页不中断），重复发起只会徒增请求与限流风险
    if state.backup_running.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return Err("已有备份任务正在进行中，请等待其完成".to_string());
    }
    let result = async {
        migrate_cloud_layout(&app).await?;
        let config = load_config(&app)?;
        let db_pool_guard = state.db_pool.lock().await;
        let pool = db_pool_guard.as_ref().ok_or("数据库未初始化")?;
        backup::run_backup(&app, pool, &config).await
    }
    .await;
    state.backup_running.store(false, std::sync::atomic::Ordering::SeqCst);
    // 完成/失败发事件：全局监听写进通知中心——备份在 Rust 侧跑全程，
    // 设置页关掉不影响执行，结果落在通知中心可回看（含手动/自动/Agent 三条触发路径）
    let _ = app.emit(
        "sync-backup-done",
        match &result {
            Ok(outcome) => serde_json::json!({ "ok": true, "message": outcome.message }),
            Err(e) => serde_json::json!({ "ok": false, "message": e }),
        },
    );
    result
}

/// 备份是否进行中（设置页重开时恢复"备份中"按钮态用）
#[tauri::command]
pub async fn sync_is_backup_running(state: State<'_, AppState>) -> Result<bool, String> {
    Ok(state.backup_running.load(std::sync::atomic::Ordering::SeqCst))
}

#[tauri::command]
pub async fn sync_list_backups(app: AppHandle) -> Result<Vec<BackupInfo>, String> {
    migrate_cloud_layout(&app).await?;
    let config = load_config(&app)?;
    webdav::read_index(&config).await
}

/// 删除指定远端备份（zip 文件 + index.json 条目）
#[tauri::command]
pub async fn sync_delete_backup(app: AppHandle, backup_name: String) -> Result<(), String> {
    migrate_cloud_layout(&app).await?;
    let config = load_config(&app)?;
    webdav::delete_file(&config, &backup_name).await?;
    let mut index = webdav::read_index(&config).await.unwrap_or_default();
    index.retain(|entry| entry.name != backup_name);
    webdav::write_index(&config, &index).await
}

#[tauri::command]
pub async fn sync_get_state(app: AppHandle) -> Result<SyncState, String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(backup::read_sync_state(&config_dir))
}

#[tauri::command]
pub async fn sync_restore(app: AppHandle, backup_name: String) -> Result<BackupManifest, String> {
    migrate_cloud_layout(&app).await?;
    let config = load_config(&app)?;
    restore::stage_restore(&app, &config, &backup_name).await
}

#[tauri::command]
pub async fn sync_rollback(app: AppHandle) -> Result<String, String> {
    restore::rollback(&app)
}

/// 恢复已暂存后重启应用（启动时检测 pending-restore 完成实际替换）
#[tauri::command]
pub fn sync_restart_app(app: AppHandle) {
    app.restart();
}

/* ---------------- L2 增量同步 ---------------- */

/// L2 状态（设置页展示）
#[derive(serde::Serialize)]
pub struct L2Status {
    pub enabled: bool,
    pub frequency: String,
    pub device_id: Option<String>,
    pub last_pushed_seq: i64,
    pub last_pulled: std::collections::HashMap<String, i64>,
    pub last_sync_at: Option<i64>,
    pub last_result: Option<String>,
}

#[tauri::command]
pub async fn sync_get_l2_status(app: AppHandle) -> Result<L2Status, String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let state = super::backup::read_sync_state(&config_dir);
    let config = load_config(&app).unwrap_or(WebdavConfig {
        endpoint: String::new(),
        username: String::new(),
        password: String::new(),
        remote_dir: BACKUP_DIR.to_string(),
        auto_backup: "off".to_string(),
        backup_keep: 10,
        l2_enabled: false,
        sync_frequency: super::models::default_sync_frequency(),
        l2_root: None,
    });

    Ok(L2Status {
        enabled: config.l2_enabled,
        frequency: config.sync_frequency,
        device_id: state.device_id,
        last_pushed_seq: state.last_pushed_seq.unwrap_or(0),
        last_pulled: state.last_pulled.unwrap_or_default(),
        last_sync_at: state.last_l2_sync_at,
        last_result: state.last_l2_result,
    })
}

/// 记录 L2 失败原因到 sync-state（设置页"最近一次"展示）
fn record_l2_failure(app: &AppHandle, error: &str) {
    if let Ok(config_dir) = app.path().app_config_dir().map_err(|e| e.to_string()) {
        // 读-改-写走全局锁（P1：与引擎写点并发交错会互覆字段/写坏 JSON）
        let _ = backup::update_sync_state(&config_dir, |state| {
            state.last_l2_sync_at = Some(chrono::Utc::now().timestamp_millis());
            state.last_l2_result = Some(format!("失败: {error}"));
        });
    }
}

/// 立即执行一轮 L2 增量同步（推送本地变更 + 拉取应用远端变更）
#[tauri::command]
pub async fn sync_run_now(app: AppHandle, state: State<'_, AppState>) -> Result<engine::SyncRunResult, String> {
    migrate_cloud_layout(&app).await?;
    let config = load_config(&app)?;
    let pool = clone_db_pool(&state).await?;
    match engine::run_sync(&app, &pool, &config).await {
        Ok(result) => Ok(result),
        Err(error) => {
            record_l2_failure(&app, &error);
            Err(error)
        }
    }
}

/// 只拉不推：打开书时的单点快拉（前端带超时调用，超时/失败静默放行本地）
#[tauri::command]
pub async fn sync_pull_now(app: AppHandle, state: State<'_, AppState>) -> Result<engine::SyncRunResult, String> {
    migrate_cloud_layout(&app).await?;
    let config = load_config(&app)?;
    let pool = clone_db_pool(&state).await?;
    match engine::run_pull_only(&app, &pool, &config).await {
        Ok(result) => Ok(result),
        Err(error) => {
            record_l2_failure(&app, &error);
            Err(error)
        }
    }
}

/// 是否有未推送的本地变更（纯本地查询，无网络请求；事件驱动推送的调度依据）
#[tauri::command]
pub async fn sync_has_unpushed(app: AppHandle, state: State<'_, AppState>) -> Result<bool, String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let sync_state = backup::read_sync_state(&config_dir);
    let db_pool_guard = state.db_pool.lock().await;
    let pool = db_pool_guard.as_ref().ok_or("数据库未初始化")?;
    engine::has_unpushed(pool, sync_state.last_pushed_seq.unwrap_or(0)).await
}

/* ---------------- L2 书籍文件通道 ---------------- */

/// 上传单本书的文件到云端
#[tauri::command]
pub async fn sync_upload_book(app: AppHandle, state: State<'_, AppState>, book_id: String) -> Result<files::FileEntry, String> {
    let config = load_config(&app)?;
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let sync_state = backup::read_sync_state(&config_dir);
    let device_id = sync_state.device_id.ok_or("L2 未初始化（无 device_id）")?;

    let db_pool_guard = state.db_pool.lock().await;
    let pool = db_pool_guard.as_ref().ok_or("数据库未初始化")?;

    let row = sqlx::query("SELECT title, file_path, format FROM books WHERE id = ?")
        .bind(&book_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("查询书籍失败: {e}"))?
        .ok_or_else(|| format!("书籍不存在: {book_id}"))?;

    let title: String = row.get("title");
    let file_path: String = row.get("file_path");
    let format: String = row.get("format");

    files::upload_book(&config, &app_data_dir, &device_id, &book_id, &file_path, &title, &format).await
}

/// 下载单本书的文件（懒加载）
#[tauri::command]
pub async fn sync_download_book(app: AppHandle, state: State<'_, AppState>, book_id: String) -> Result<String, String> {
    let config = load_config(&app)?;
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;

    // 锁只护 DB：读出必要字段后即释放（clone_db_pool 不持锁），网络下载不持全局锁
    let pool = clone_db_pool(&state).await?;
    let row = sqlx::query("SELECT file_path, format FROM books WHERE id = ?")
        .bind(&book_id)
        .fetch_optional(&pool)
        .await
        .map_err(|e| format!("查询书籍失败: {e}"))?
        .ok_or_else(|| format!("书籍不存在: {book_id}"))?;

    let file_path: String = row.get("file_path");
    let format: String = row.get("format");

    // 从 files-index 查找 sha256
    let index = files::read_files_index(&config).await?;
    let entry = index.get(&book_id).ok_or_else(|| format!("云端无此书文件: {book_id}"))?;

    if format == "MARKDOWN" {
        // 论文是 zip 捆：校验+整目录解包
        log::info!("开始下载论文: 《{}》({} bytes, sha256={})", entry.title, entry.size, &entry.sha256[..8]);
        return match files::download_paper_bundle(&config, &app_data_dir, &book_id, &entry.sha256).await {
            Ok(path) => {
                log::info!("论文下载完成: 《{}》", entry.title);
                Ok(path.to_string_lossy().to_string())
            }
            Err(e) => {
                log::error!("论文下载失败: 《{}》: {e}", entry.title);
                Err(e)
            }
        };
    }

    log::info!("开始下载书籍: 《{}》({} bytes, sha256={})", entry.title, entry.size, &entry.sha256[..8]);
    match files::download_book(&config, &app_data_dir, &book_id, &file_path, &entry.sha256).await {
        Ok(path) => {
            log::info!("书籍下载完成: 《{}》", entry.title);
            Ok(path.to_string_lossy().to_string())
        }
        Err(e) => {
            log::error!("书籍下载失败: 《{}》: {e}", entry.title);
            Err(e)
        }
    }
}

/// 获取云端书目列表（含本地是否已有标记）
#[tauri::command]
pub async fn sync_get_cloud_books(app: AppHandle, state: State<'_, AppState>) -> Result<Vec<files::CloudBookInfo>, String> {
    let config = load_config(&app)?;
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;

    let db_pool_guard = state.db_pool.lock().await;
    let pool = db_pool_guard.as_ref().ok_or("数据库未初始化")?;

    files::get_cloud_books(&config, pool, &app_data_dir).await
}

/// 批量上传本地所有书籍文件（首次引导用）
#[tauri::command]
pub async fn sync_upload_all_books(app: AppHandle, state: State<'_, AppState>) -> Result<files::UploadAllResult, String> {
    let config = load_config(&app)?;
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let sync_state = backup::read_sync_state(&config_dir);
    let device_id = sync_state.device_id.ok_or("L2 未初始化（无 device_id）")?;

    let db_pool_guard = state.db_pool.lock().await;
    let pool = db_pool_guard.as_ref().ok_or("数据库未初始化")?;

    files::upload_all_books(&config, pool, &app_data_dir, &device_id).await
}

/// 同步偏好补丁（只含非敏感字段）：agent/前端改频率与开关走此通道，
/// endpoint/用户名/密码绝不经过——补丁在 Rust 端合并，密钥不出后端
#[derive(serde::Deserialize)]
pub struct SyncPrefsPatch {
    pub auto_backup: Option<String>,
    pub backup_keep: Option<usize>,
    pub sync_frequency: Option<String>,
    pub l2_enabled: Option<bool>,
}

/// 返回前端的非敏感视图
#[derive(serde::Serialize)]
pub struct SyncPrefsView {
    pub auto_backup: String,
    pub backup_keep: usize,
    pub sync_frequency: String,
    pub l2_enabled: bool,
}

/// 更新同步偏好（自动备份频率/保留份数/拉取频率/增量同步开关）
#[tauri::command]
pub async fn sync_update_prefs(app: AppHandle, patch: SyncPrefsPatch) -> Result<SyncPrefsView, String> {
    let mut config = load_config(&app)?;
    if let Some(v) = patch.auto_backup {
        config.auto_backup = v;
    }
    if let Some(v) = patch.backup_keep {
        config.backup_keep = v;
    }
    if let Some(v) = patch.sync_frequency {
        config.sync_frequency = v;
    }
    if let Some(v) = patch.l2_enabled {
        config.l2_enabled = v;
    }
    // 批次 A 口径：密码住 keyring；load_config 已补水，写盘前必须置空，防真密码明文回写
    config.password = String::new();
    let content = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(config_path(&app)?, content).map_err(|e| e.to_string())?;
    Ok(SyncPrefsView {
        auto_backup: config.auto_backup,
        backup_keep: config.backup_keep,
        sync_frequency: config.sync_frequency,
        l2_enabled: config.l2_enabled,
    })
}

/* ---------------- L2 安全快照回滚 ---------------- */

/// 列出 L2 同步前安全快照
#[tauri::command]
pub async fn sync_list_l2_snapshots(app: AppHandle) -> Result<Vec<restore::SnapshotInfo>, String> {
    restore::list_l2_snapshots(&app)
}

/// 回滚到指定 L2 安全快照（重启生效）
#[tauri::command]
pub async fn sync_rollback_l2(app: AppHandle, name: String) -> Result<String, String> {
    restore::rollback_to_l2_snapshot(&app, &name)
}

/* ---------------- L2 资产通道（字体/背景图） ---------------- */

/// 资产同步状态（云端/本地的字体与背景数量）
#[tauri::command]
pub async fn sync_get_cloud_assets(app: AppHandle) -> Result<assets::AssetsStatus, String> {
    let config = load_config(&app)?;
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    assets::get_assets_status(&config, &app_data_dir, &config_dir).await
}

/* ---------------- L2 UI 配置同步（背景选择/辅助模型） ---------------- */

/// 上传 UI 配置 JSON（不透明搬运，不解析）
#[tauri::command]
pub async fn sync_put_ui_config(app: AppHandle, json: String) -> Result<(), String> {
    let config = load_config(&app)?;
    webdav::put_path(&config, &format!("{}/ui-config.json", l2_root(&config)), json.into_bytes()).await
}

/// 下载 UI 配置 JSON（不存在返回 None）
#[tauri::command]
pub async fn sync_get_ui_config(app: AppHandle) -> Result<Option<String>, String> {
    let config = load_config(&app)?;
    match webdav::get_path(&config, &format!("{}/ui-config.json", l2_root(&config))).await? {
        Some(bytes) => Ok(Some(
            String::from_utf8(bytes).map_err(|e| format!("ui-config.json 编码非法: {e}"))?,
        )),
        None => Ok(None),
    }
}
