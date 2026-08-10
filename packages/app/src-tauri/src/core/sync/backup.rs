use super::models::{AssetRef, AssetsIndex, BackupInfo, BackupManifest, BackupOutcome, SyncState, WebdavConfig, CONFIG_JSON_EXCLUDES};
use super::webdav;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::fs;
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

/// 轮转保留的备份份数（配置缺失时的回落值）
const DEFAULT_MAX_KEEP: usize = 10;
/// 本地资产哈希缓存（大文件 mtime+size 不变则免重哈希）
const ASSET_CACHE_FILE: &str = "backup-assets-cache.json";

/// 云端资产池目录（跟随备份 remote_dir，兼容旧布局 sageread-backups）
fn assets_dir(config: &WebdavConfig) -> String {
    format!("{}/assets", config.remote_dir.trim_matches('/'))
}

/// 云端资产池索引路径（GC 引用计数用）
fn assets_index_path(config: &WebdavConfig) -> String {
    format!("{}/assets-index.json", config.remote_dir.trim_matches('/'))
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{:02x}", b)).collect()
}

/// 流式计算文件 sha256（大文件不全量读入内存）
pub(crate) fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|e| format!("读取文件失败 {}: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 1024 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// 计算内存字节块的 sha256（恢复时校验下载资产用）
pub(crate) fn sha256_file_bytes(bytes: &[u8]) -> String {
    sha256_hex(bytes)
}

fn device_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "unknown".to_string())
}

pub fn read_sync_state(config_dir: &Path) -> SyncState {
    fs::read_to_string(config_dir.join("sync-state.json"))
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default()
}

pub fn write_sync_state(config_dir: &Path, state: &SyncState) -> Result<(), String> {
    let content = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    fs::write(config_dir.join("sync-state.json"), content).map_err(|e| e.to_string())
}

/// 打包备份 zip：条目 + manifest.json（抽出以便测试）
pub fn build_backup_zip(entries: &[(String, Vec<u8>)], manifest: &BackupManifest) -> Result<Vec<u8>, String> {
    let mut zw = ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    for (name, bytes) in entries {
        zw.start_file(name, options).map_err(|e| format!("zip 写入失败: {e}"))?;
        zw.write_all(bytes).map_err(|e| format!("zip 写入失败: {e}"))?;
    }

    let manifest_json = serde_json::to_string_pretty(manifest).map_err(|e| e.to_string())?;
    zw.start_file("manifest.json", options)
        .map_err(|e| format!("zip 写入失败: {e}"))?;
    zw.write_all(manifest_json.as_bytes())
        .map_err(|e| format!("zip 写入失败: {e}"))?;

    let cursor = zw.finish().map_err(|e| format!("zip 完成失败: {e}"))?;
    Ok(cursor.into_inner())
}

/// 备份成功后的状态更新：只动备份字段，保留 device_id / 推送拉取水位等 L2 状态
fn backup_success_state(state: SyncState, created_at: i64, backup_name: String, db_sha256: String, pack_sha256: String) -> SyncState {
    SyncState {
        last_backup_at: Some(created_at),
        last_backup_name: Some(backup_name),
        last_db_sha256: Some(db_sha256),
        last_pack_sha256: Some(pack_sha256),
        last_result: Some("uploaded".to_string()),
        ..state
    }
}

// ---- 大包资产扫描与哈希缓存 ----

#[derive(Serialize, Deserialize, Clone)]
struct AssetCacheEntry {
    sha256: String,
    size: u64,
    mtime_ms: u64,
}

type AssetCache = HashMap<String, AssetCacheEntry>;

fn load_asset_cache(config_dir: &Path) -> AssetCache {
    fs::read_to_string(config_dir.join(ASSET_CACHE_FILE))
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_default()
}

fn save_asset_cache(config_dir: &Path, cache: &AssetCache) {
    if let Ok(content) = serde_json::to_string_pretty(cache) {
        let _ = fs::write(config_dir.join(ASSET_CACHE_FILE), content);
    }
}

fn mtime_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 资产扫描根：{目录, root 标签, kind 标签, 是否递归}
fn asset_roots(app: &AppHandle) -> Vec<(PathBuf, &'static str, &'static str, bool)> {
    let mut roots = Vec::new();
    if let Ok(app_data) = app.path().app_data_dir() {
        // 书籍/论文全部文件（EPUB、paper.md、images、译文、封面）
        roots.push((app_data.join("books"), "appData", "book", true));
        // 全局向量库（books+papers 统一；远程 embedding 重建要 API 费）
        roots.push((app_data.join("papers").join("vectors.sqlite"), "appData", "vectors", false));
        // 字体（.woff2）
        roots.push((app_data.join("fonts"), "appData", "font", true));
        // Agent 工作区（仅默认路径；用户改到外部目录的不替其备份第三方目录）
        roots.push((app_data.join("agent-workspace"), "appData", "workspace", true));
    }
    if let Ok(config) = app.path().app_config_dir() {
        // 阅读背景图
        roots.push((config.join("reader-backgrounds"), "config", "background", true));
    }
    roots
}

fn scan_files_recursive(dir: &Path, base: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            scan_files_recursive(&path, base, out);
        } else {
            out.push(path);
        }
    }
    let _ = base;
}

/// 扫描资产并计算哈希（mtime+size 命中缓存则免重算）；返回资产清单（含缓存回写）
fn collect_assets(app: &AppHandle, config_dir: &Path) -> Result<(Vec<AssetRef>, AssetCache), String> {
    let mut cache = load_asset_cache(config_dir);
    let mut assets = Vec::new();

    for (root_path, root_tag, kind, recursive) in asset_roots(app) {
        let mut files = Vec::new();
        if root_path.is_file() {
            files.push(root_path.clone());
        } else if root_path.is_dir() {
            if recursive {
                scan_files_recursive(&root_path, &root_path, &mut files);
            } else if let Ok(entries) = fs::read_dir(&root_path) {
                files.extend(entries.flatten().map(|e| e.path()).filter(|p| p.is_file()));
            }
        }
        files.sort();
        for file in files {
            let rel = file
                .strip_prefix(&root_path)
                .map(|r| r.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| file.file_name().unwrap_or_default().to_string_lossy().to_string());
            // 单文件根（vectors.sqlite）：用文件名作相对路径
            let rel = if root_path.is_file() {
                file.file_name().unwrap_or_default().to_string_lossy().to_string()
            } else {
                rel
            };
            let cache_key = format!("{root_tag}:{kind}/{rel}");
            let size = fs::metadata(&file).map(|m| m.len()).unwrap_or(0);
            let mtime = mtime_ms(&file);
            let sha256 = match cache.get(&cache_key) {
                Some(entry) if entry.size == size && entry.mtime_ms == mtime => entry.sha256.clone(),
                _ => {
                    let hash = sha256_file(&file)?;
                    cache.insert(cache_key.clone(), AssetCacheEntry { sha256: hash.clone(), size, mtime_ms: mtime });
                    hash
                }
            };
            assets.push(AssetRef {
                path: format!("{kind}/{rel}"),
                root: root_tag.to_string(),
                sha256,
                size,
                kind: kind.to_string(),
            });
        }
    }
    Ok((assets, cache))
}

/// 资产对应的本地文件绝对路径（备份上传与恢复落盘共用）
pub(crate) fn asset_local_path(app: &AppHandle, asset: &AssetRef) -> Option<PathBuf> {
    let rel = asset.path.strip_prefix(&format!("{}/", asset.kind)).unwrap_or(&asset.path);
    let base = match (asset.root.as_str(), asset.kind.as_str()) {
        ("appData", "book") => app.path().app_data_dir().ok()?.join("books"),
        ("appData", "vectors") => app.path().app_data_dir().ok()?.join("papers"),
        ("appData", "font") => app.path().app_data_dir().ok()?.join("fonts"),
        ("appData", "workspace") => app.path().app_data_dir().ok()?.join("agent-workspace"),
        ("config", "background") => app.path().app_config_dir().ok()?.join("reader-backgrounds"),
        _ => return None,
    };
    Some(base.join(rel))
}

// ---- 云端资产池索引（GC 引用计数） ----

async fn read_assets_index(config: &WebdavConfig) -> Result<AssetsIndex, String> {
    match webdav::get_path(config, &assets_index_path(config)).await? {
        // 404=首次使用（空索引）；解析失败/网络失败必须中止——
        // 默认空索引继续跑会让 GC 把他端引用的资产误判为孤儿（devices.json 同款教训）
        None => Ok(AssetsIndex::default()),
        Some(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("assets-index 解析失败（中止备份防误删）: {e}")),
    }
}

/// 计算孤儿资产并裁剪索引：只保留存活备份的引用，引用并集之外的 sha256 全部删除
fn gc_assets_index(mut index: AssetsIndex, surviving: &[String]) -> (Vec<String>, AssetsIndex) {
    index.by_backup.retain(|name, _| surviving.iter().any(|s| s == name));
    let referenced: std::collections::HashSet<&String> = index.by_backup.values().flatten().collect();
    let orphans: Vec<String> = index.sizes.keys().filter(|sha| !referenced.contains(*sha)).cloned().collect();
    for sha in &orphans {
        index.sizes.remove(sha);
    }
    for shas in index.by_backup.values_mut() {
        shas.retain(|s| !orphans.contains(s));
    }
    (orphans, index)
}

/// 收集小包 JSON：配置目录顶层 *.json 全收，减去排除清单（新增配置文件自动纳入）
fn collect_config_jsons(config_dir: &Path, entries: &mut Vec<(String, Vec<u8>)>) -> Result<(), String> {
    let mut names: Vec<String> = Vec::new();
    if let Ok(read_dir) = fs::read_dir(config_dir) {
        for entry in read_dir.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if name.ends_with(".json") && !CONFIG_JSON_EXCLUDES.contains(&name.as_str()) {
                names.push(name);
            }
        }
    }
    names.sort();
    for name in names {
        let content = fs::read(config_dir.join(&name)).map_err(|e| format!("读取 {name} 失败: {e}"))?;
        entries.push((name, content));
    }
    Ok(())
}

/// 执行一次备份：VACUUM INTO 快照 → 扫描小包+大包 → 整包哈希无变化跳过 → 上传缺失资产 → 打包上传 → 轮转+GC
pub async fn run_backup(
    app: &AppHandle,
    pool: &SqlitePool,
    config: &WebdavConfig,
) -> Result<BackupOutcome, String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let staging_dir = config_dir.join("sync-staging");
    fs::create_dir_all(&staging_dir).map_err(|e| e.to_string())?;

    // 1. 在线一致性快照（VACUUM INTO 要求目标文件不存在）
    let staged_db = staging_dir.join("app.db");
    if staged_db.exists() {
        fs::remove_file(&staged_db).map_err(|e| e.to_string())?;
    }
    sqlx::query("VACUUM INTO ?")
        .bind(staged_db.to_string_lossy().replace('\\', "/"))
        .execute(pool)
        .await
        .map_err(|e| format!("数据库快照失败: {e}"))?;

    let db_bytes = fs::read(&staged_db).map_err(|e| format!("读取数据库快照失败: {e}"))?;
    let db_sha256 = sha256_hex(&db_bytes);

    // 2. 收集小包内容：app.db + 配置目录顶层 JSON（全收减排除）+ themes/*.css
    let mut entries: Vec<(String, Vec<u8>)> = vec![("app.db".to_string(), db_bytes)];
    collect_config_jsons(&config_dir, &mut entries)?;
    let themes_dir = config_dir.join("themes");
    if themes_dir.is_dir() {
        let mut theme_files: Vec<PathBuf> = fs::read_dir(&themes_dir)
            .map_err(|e| e.to_string())?
            .filter_map(|entry| entry.ok().map(|e| e.path()))
            .filter(|path| path.is_file() && path.extension().is_some_and(|ext| ext == "css"))
            .collect();
        theme_files.sort();
        for path in theme_files {
            let name = format!("themes/{}", path.file_name().unwrap().to_string_lossy());
            entries.push((name, fs::read(&path).map_err(|e| e.to_string())?));
        }
    }

    // 3. 扫描大包资产（内容寻址）
    let (assets, asset_cache) = collect_assets(app, &config_dir)?;

    // 4. 整包内容哈希（db+全部 JSON+themes+资产清单）：无变化零流量
    let mut pack_hasher = Sha256::new();
    for (name, bytes) in &entries {
        pack_hasher.update(name.as_bytes());
        pack_hasher.update(bytes);
    }
    let assets_manifest = serde_json::to_string(&assets).map_err(|e| e.to_string())?;
    pack_hasher.update(assets_manifest.as_bytes());
    let pack_sha256: String = pack_hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();

    let state = read_sync_state(&config_dir);
    if state.last_pack_sha256.as_deref() == Some(pack_sha256.as_str()) && state.last_backup_name.is_some() {
        return Ok(BackupOutcome {
            status: "skipped".to_string(),
            message: "数据无变化，已跳过上传".to_string(),
            backup_name: None,
        });
    }

    // 5. 读资产索引（读失败中止防误删；同时作为"云端已有哪些资产"的免 PROPFIND 判存依据——
    //    坚果云免费版每 30 分钟 600 次请求，逐资产 PROPFIND 会把单次备份请求数翻倍）
    let mut assets_index = read_assets_index(config).await?;

    // 6. 上传缺失资产（索引里已有的 sha256 直接零请求跳过；PUT 内容寻址幂等，重复覆盖无害）
    webdav::ensure_remote_dirs(config, &[assets_dir(config)]).await?;
    let mut assets_uploaded = 0usize;
    for asset in &assets {
        if assets_index.sizes.contains_key(&asset.sha256) {
            continue;
        }
        let local = asset_local_path(app, asset).ok_or_else(|| format!("资产路径非法: {}", asset.path))?;
        let bytes = fs::read(&local).map_err(|e| format!("读取资产失败 {}: {e}", asset.path))?;
        webdav::put_path(config, &format!("{}/{}", assets_dir(config), asset.sha256), bytes).await?;
        assets_uploaded += 1;
        // 突发平滑（通用防爆发，非针对特定厂商）；限流由 send() 的自适应退避兜底
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    // 7. 打包上传小包
    let created_at = chrono::Utc::now().timestamp_millis();
    let manifest = BackupManifest {
        format: "sageread-backup".to_string(),
        version: 2,
        created_at,
        device: device_name(),
        app_version: app.package_info().version.to_string(),
        contents: entries.iter().map(|(name, _)| name.clone()).collect(),
        db_sha256: db_sha256.clone(),
        assets: assets.clone(),
    };
    let zip_bytes = build_backup_zip(&entries, &manifest)?;

    webdav::ensure_dir(config).await?;
    let backup_name = format!("backup-{}.zip", chrono::Local::now().format("%Y%m%d-%H%M%S"));
    webdav::put_file(config, &backup_name, zip_bytes.clone()).await?;

    // 8. 更新远端 index.json 并轮转（保留最新 N 份，多余的连 zip 一起删）
    let max_keep = if config.backup_keep > 0 { config.backup_keep } else { DEFAULT_MAX_KEEP };
    let mut index = webdav::read_index(config).await.unwrap_or_default();
    index.push(BackupInfo {
        name: backup_name.clone(),
        size: zip_bytes.len() as u64,
        created_at,
        device: manifest.device.clone(),
        app_version: manifest.app_version.clone(),
        db_sha256,
    });
    index.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    let mut removed: Vec<String> = Vec::new();
    while index.len() > max_keep {
        if let Some(oldest) = index.pop() {
            removed.push(oldest.name.clone());
            let _ = webdav::delete_file(config, &oldest.name).await;
        }
    }
    webdav::write_index(config, &index).await?;

    // 9. 资产索引：登记本包引用 → GC 孤儿 → 回写
    let surviving: Vec<String> = index.iter().map(|b| b.name.clone()).collect();
    assets_index.by_backup.insert(
        backup_name.clone(),
        assets.iter().map(|a| a.sha256.clone()).collect(),
    );
    for asset in &assets {
        assets_index.sizes.insert(asset.sha256.clone(), asset.size);
    }
    let (orphans, new_index) = gc_assets_index(assets_index, &surviving);
    for sha in &orphans {
        let _ = webdav::delete_path(config, &format!("{}/{}", assets_dir(config), sha)).await;
    }
    if !removed.is_empty() || !orphans.is_empty() {
        log::info!("备份轮转：删除旧包 {} 个，GC 孤儿资产 {} 个", removed.len(), orphans.len());
    }
    webdav::put_path(config, &assets_index_path(config), serde_json::to_vec_pretty(&new_index).map_err(|e| e.to_string())?).await?;

    // 10. 记录本地状态与资产哈希缓存
    let _ = write_sync_state(
        &config_dir,
        &backup_success_state(state, created_at, backup_name.clone(), manifest.db_sha256.clone(), pack_sha256),
    );
    save_asset_cache(&config_dir, &asset_cache);

    let message = if assets_uploaded > 0 {
        format!("已上传 {backup_name}（新增资产 {assets_uploaded} 个）")
    } else {
        format!("已上传 {backup_name}（资产无变化）")
    };
    Ok(BackupOutcome {
        status: "uploaded".to_string(),
        message,
        backup_name: Some(backup_name),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 回归：备份成功后写状态不得重置 L2 字段（device_id / 推送拉取水位）
    #[test]
    fn test_backup_success_state_preserves_l2() {
        let mut pulled = std::collections::HashMap::new();
        pulled.insert("dev-b".to_string(), 42);
        let old = SyncState {
            device_id: Some("dev-a".to_string()),
            last_pushed_seq: Some(100),
            last_pulled: Some(pulled),
            last_l2_sync_at: Some(999),
            last_l2_result: Some("无新变更".to_string()),
            ..Default::default()
        };

        let new = backup_success_state(old, 123, "backup-1.zip".to_string(), "abc".to_string(), "pack".to_string());

        assert_eq!(new.device_id.as_deref(), Some("dev-a"));
        assert_eq!(new.last_pushed_seq, Some(100));
        assert_eq!(new.last_pulled.as_ref().and_then(|m| m.get("dev-b")), Some(&42));
        assert_eq!(new.last_l2_sync_at, Some(999));
        assert_eq!(new.last_l2_result.as_deref(), Some("无新变更"));
        assert_eq!(new.last_backup_at, Some(123));
        assert_eq!(new.last_backup_name.as_deref(), Some("backup-1.zip"));
        assert_eq!(new.last_db_sha256.as_deref(), Some("abc"));
        assert_eq!(new.last_pack_sha256.as_deref(), Some("pack"));
        assert_eq!(new.last_result.as_deref(), Some("uploaded"));
    }

    /// GC：只有存活备份引用的资产保留；孤儿全部删除；已删备份的索引条目一并清理
    #[test]
    fn test_gc_assets_index() {
        let mut index = AssetsIndex::default();
        index.by_backup.insert("b1".to_string(), vec!["sha-a".to_string(), "sha-b".to_string()]);
        index.by_backup.insert("b2".to_string(), vec!["sha-b".to_string(), "sha-c".to_string()]);
        index.sizes.insert("sha-a".to_string(), 1);
        index.sizes.insert("sha-b".to_string(), 2);
        index.sizes.insert("sha-c".to_string(), 3);
        index.sizes.insert("sha-x".to_string(), 9); // 从未被引用的残留

        let (orphans, new_index) = gc_assets_index(index, &["b2".to_string()]);
        let mut orphans_sorted = orphans.clone();
        orphans_sorted.sort();
        assert_eq!(orphans_sorted, vec!["sha-a".to_string(), "sha-x".to_string()]);
        assert!(!new_index.by_backup.contains_key("b1"), "已删备份的索引条目应清除");
        assert_eq!(new_index.sizes.len(), 2, "sha-b/sha-c 存活");
        assert_eq!(new_index.by_backup["b2"], vec!["sha-b".to_string(), "sha-c".to_string()]);
    }

    /// 验证打包流程：VACUUM INTO 快照可读、zip 结构完整、manifest 可解析
    #[tokio::test]
    async fn test_vacuum_and_package() {
        let staging = std::env::temp_dir().join(format!("sageread-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&staging).unwrap();

        // 临时文件库造数据（sqlx 建新文件需要 mode=rwc）
        let src = staging.join("src.db");
        let url = format!("sqlite:{}?mode=rwc", src.to_string_lossy().replace('\\', "/"));
        let pool = SqlitePool::connect(&url).await.unwrap();
        sqlx::query("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO t (v) VALUES ('hello')")
            .execute(&pool)
            .await
            .unwrap();

        // VACUUM INTO 快照
        let staged_db = staging.join("app.db");
        sqlx::query("VACUUM INTO ?")
            .bind(staged_db.to_string_lossy().replace('\\', "/"))
            .execute(&pool)
            .await
            .unwrap();
        assert!(staged_db.exists(), "VACUUM INTO 未生成快照文件");

        // 重新打开快照，数据应可读
        let check = SqlitePool::connect(&format!("sqlite:{}", staged_db.to_string_lossy().replace('\\', "/")))
            .await
            .unwrap();
        let row: (String,) = sqlx::query_as("SELECT v FROM t")
            .fetch_one(&check)
            .await
            .unwrap();
        assert_eq!(row.0, "hello");

        // 打包
        let db_bytes = fs::read(&staged_db).unwrap();
        let manifest = BackupManifest {
            format: "sageread-backup".to_string(),
            version: 2,
            created_at: 0,
            device: "test".to_string(),
            app_version: "0.1.0".to_string(),
            contents: vec!["app.db".to_string(), "app-settings.json".to_string()],
            db_sha256: sha256_hex(&db_bytes),
            assets: vec![AssetRef {
                path: "book/b1/book.epub".to_string(),
                root: "appData".to_string(),
                sha256: "sha".to_string(),
                size: 100,
                kind: "book".to_string(),
            }],
        };
        let zip_bytes = build_backup_zip(
            &[
                ("app.db".to_string(), db_bytes),
                ("app-settings.json".to_string(), b"{}".to_vec()),
            ],
            &manifest,
        )
        .unwrap();

        // 解包验证结构与 manifest
        let mut archive = zip::ZipArchive::new(Cursor::new(zip_bytes)).unwrap();
        assert!(archive.by_name("app.db").is_ok());
        assert!(archive.by_name("app-settings.json").is_ok());
        let mut manifest_file = archive.by_name("manifest.json").unwrap();
        let mut manifest_bytes = Vec::new();
        std::io::Read::read_to_end(&mut manifest_file, &mut manifest_bytes).unwrap();
        let parsed: BackupManifest = serde_json::from_slice(&manifest_bytes).unwrap();
        assert_eq!(parsed.format, "sageread-backup");
        assert_eq!(parsed.version, 2);
        assert_eq!(parsed.contents.len(), 2);
        assert_eq!(parsed.assets.len(), 1);
        assert_eq!(parsed.assets[0].path, "book/b1/book.epub");

        let _ = fs::remove_dir_all(&staging);
    }
}
