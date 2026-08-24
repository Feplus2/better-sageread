use super::models::{AssetRef, AssetsIndex, BackupInfo, BackupManifest, BackupOutcome, SyncState, WebdavConfig, CONFIG_JSON_EXCLUDES};
use super::webdav;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::fs;
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

/// 轮转保留的备份份数（配置缺失时的回落值）
const DEFAULT_MAX_KEEP: usize = 10;
/// 本地资产哈希缓存（大文件 mtime+size 不变则免重哈希）
const ASSET_CACHE_FILE: &str = "backup-assets-cache.json";
/// 单文件 ≥4MB 用 Stored 直接打包（EPUB/PDF/woff2/sqlite 已压缩，Deflate 白烧 CPU）
const STORED_THRESHOLD: u64 = 4 * 1024 * 1024;

/// 云端资产捆目录（跟随备份 remote_dir；每捆一个 zip，请求数 = 书数+5）
fn bundles_dir(config: &WebdavConfig) -> String {
    format!("{}/asset-bundles", config.remote_dir.trim_matches('/'))
}

/// 云端资产捆索引路径（GC 引用计数 + 免 PROPFIND 判存依据）
fn bundles_index_path(config: &WebdavConfig) -> String {
    format!("{}/asset-bundles-index.json", config.remote_dir.trim_matches('/'))
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
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
    Ok(sha256_hex(&hasher.finalize()))
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

// ---- 资产捆：扫描、哈希、打包 ----

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

/// 一个资产捆：目录（或单文件）打成一个 zip 上传
struct Bundle {
    kind: &'static str,
    name: String,
    /// 恢复落盘的目标目录（包内相对路径以其为根）
    target_dir: PathBuf,
    /// (绝对路径, 包内相对路径)
    files: Vec<(PathBuf, String)>,
    /// 内容清单哈希（全部文件 rel:sha256 组合哈希）
    content_hash: String,
}

/// 文件级哈希（带缓存）：cache_key 已含捆路径，天然区分同 rel 不同捆
fn hash_file_cached(cache: &mut AssetCache, cache_key: &str, file: &Path) -> Result<String, String> {
    let size = fs::metadata(file).map(|m| m.len()).unwrap_or(0);
    let mtime = mtime_ms(file);
    if let Some(entry) = cache.get(cache_key) {
        if entry.size == size && entry.mtime_ms == mtime {
            return Ok(entry.sha256.clone());
        }
    }
    let hash = sha256_file(file)?;
    cache.insert(cache_key.to_string(), AssetCacheEntry { sha256: hash.clone(), size, mtime_ms: mtime });
    Ok(hash)
}

/// 目录内容清单哈希：sorted "rel:sha256" 行组合哈希（恢复端跳过同内容捆用，不走缓存）
pub(crate) fn dir_content_hash(dir: &Path) -> Result<Option<String>, String> {
    if !dir.exists() {
        return Ok(None);
    }
    let mut files: Vec<PathBuf> = Vec::new();
    collect_files(dir, dir, &mut files);
    files.sort();
    let mut lines = String::new();
    for file in &files {
        let rel = file.strip_prefix(dir).unwrap_or(file).to_string_lossy().replace('\\', "/");
        lines.push_str(&format!("{rel}:{}\n", sha256_file(file)?));
    }
    Ok(Some(sha256_hex(lines.as_bytes())))
}

fn collect_files(dir: &Path, base: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_files(&path, base, out);
        } else {
            out.push(path);
        }
    }
}

/// 把一个目录组装成捆（含内容清单哈希；走文件级缓存）
fn bundle_from_dir(
    cache: &mut AssetCache,
    kind: &'static str,
    name: String,
    target_dir: PathBuf,
) -> Result<Option<Bundle>, String> {
    if !target_dir.is_dir() {
        return Ok(None);
    }
    let mut files_abs: Vec<PathBuf> = Vec::new();
    collect_files(&target_dir, &target_dir, &mut files_abs);
    files_abs.sort();
    if files_abs.is_empty() {
        return Ok(None);
    }
    let mut files = Vec::with_capacity(files_abs.len());
    let mut lines = String::new();
    for abs in files_abs {
        let rel = abs.strip_prefix(&target_dir).unwrap_or(&abs).to_string_lossy().replace('\\', "/");
        let sha = hash_file_cached(cache, &format!("{kind}/{name}/{rel}"), &abs)?;
        lines.push_str(&format!("{rel}:{sha}\n"));
        files.push((abs, rel));
    }
    Ok(Some(Bundle {
        kind,
        name,
        target_dir,
        files,
        content_hash: sha256_hex(lines.as_bytes()),
    }))
}

/// 扫描全部资产捆：books/{id} 每本一捆、向量库单文件、字体/背景/工作区/聊天附件各一捆
fn collect_bundles(app: &AppHandle, config_dir: &Path) -> Result<(Vec<Bundle>, AssetCache), String> {
    let mut cache = load_asset_cache(config_dir);
    let mut bundles: Vec<Bundle> = Vec::new();

    if let Ok(app_data) = app.path().app_data_dir() {
        // 书籍/论文：每本一捆（EPUB、paper.md、images、译文、封面）
        let books_dir = app_data.join("books");
        if books_dir.is_dir() {
            let mut ids: Vec<String> = fs::read_dir(&books_dir)
                .map_err(|e| e.to_string())?
                .flatten()
                .filter(|e| e.path().is_dir())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect();
            ids.sort();
            for id in ids {
                if let Some(b) = bundle_from_dir(&mut cache, "book", id.clone(), books_dir.join(&id))? {
                    bundles.push(b);
                }
            }
        }
        // 全局向量库（books+papers 统一；远程 embedding 重建要 API 费）
        // 热文件一致性：活库直接拷贝会带上 WAL 未合并的不完整页——先 VACUUM INTO 出一致快照再打包
        let vectors = app_data.join("papers").join("vectors.sqlite");
        if vectors.is_file() {
            let snapshot = config_dir.join("sync-staging").join("vectors-snapshot.sqlite");
            if snapshot.exists() {
                fs::remove_file(&snapshot).map_err(|e| e.to_string())?;
            }
            let conn = {
                // 注册 sqlite-vec（chunk_embeddings 是 vec0 虚拟表，VACUUM 读行需要扩展；
                // 与 books/commands.rs 同款注册，进程级幂等）
                unsafe {
                    rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute(
                        sqlite_vec::sqlite3_vec_init as *const (),
                    )));
                }
                rusqlite::Connection::open(&vectors).map_err(|e| format!("打开向量库失败: {e}"))?
            };
            conn.execute("VACUUM INTO ?1", [snapshot.to_string_lossy().replace('\\', "/")])
                .map_err(|e| format!("向量库快照失败: {e}"))?;
            drop(conn);
            let sha = hash_file_cached(&mut cache, "vectors/vectors/vectors.sqlite", &snapshot)?;
            bundles.push(Bundle {
                kind: "vectors",
                name: "vectors".to_string(),
                target_dir: app_data.join("papers"),
                files: vec![(snapshot, "vectors.sqlite".to_string())],
                content_hash: sha,
            });
        }
        // 字体（.woff2）
        if let Some(b) = bundle_from_dir(&mut cache, "fonts", "fonts".to_string(), app_data.join("fonts"))? {
            bundles.push(b);
        }
        // Agent 工作区（仅默认路径；用户改到外部目录的不替其备份第三方目录）
        if let Some(b) = bundle_from_dir(&mut cache, "workspace", "workspace".to_string(), app_data.join("agent-workspace"))? {
            bundles.push(b);
        }
        // 聊天图片附件（D4 起消息只存 attachment:// 引用，字节在 {appData}/attachments；
        // 不进备份则换机恢复后对话图片全丢——按需产物通常不大，全量带上）
        if let Some(b) = bundle_from_dir(&mut cache, "attachments", "attachments".to_string(), app_data.join("attachments"))? {
            bundles.push(b);
        }
    }
    if let Ok(config_dir_path) = app.path().app_config_dir() {
        // 阅读背景图
        if let Some(b) =
            bundle_from_dir(&mut cache, "backgrounds", "backgrounds".to_string(), config_dir_path.join("reader-backgrounds"))?
        {
            bundles.push(b);
        }
    }
    Ok((bundles, cache))
}

/// 捆 zip 字节：小文件 Deflate、≥4MB Stored（EPUB/PDF/woff2/sqlite 已压缩）
fn build_bundle_zip(bundle: &Bundle) -> Result<Vec<u8>, String> {
    let mut zw = ZipWriter::new(Cursor::new(Vec::new()));
    for (abs, rel) in &bundle.files {
        let size = fs::metadata(abs).map(|m| m.len()).unwrap_or(0);
        let method = if size >= STORED_THRESHOLD {
            CompressionMethod::Stored
        } else {
            CompressionMethod::Deflated
        };
        let options = SimpleFileOptions::default().compression_method(method);
        zw.start_file(rel, options).map_err(|e| format!("捆写入失败: {e}"))?;
        let bytes = fs::read(abs).map_err(|e| format!("读取资产失败 {}: {e}", abs.display()))?;
        zw.write_all(&bytes).map_err(|e| format!("捆写入失败: {e}"))?;
    }
    let cursor = zw.finish().map_err(|e| format!("捆打包失败: {e}"))?;
    Ok(cursor.into_inner())
}

/// 捆恢复落盘的目标目录（备份/恢复共用）
pub(crate) fn bundle_target_dir(app: &AppHandle, kind: &str, name: &str) -> Option<PathBuf> {
    match kind {
        "book" => Some(app.path().app_data_dir().ok()?.join("books").join(name)),
        "vectors" => Some(app.path().app_data_dir().ok()?.join("papers")),
        "fonts" => Some(app.path().app_data_dir().ok()?.join("fonts")),
        "workspace" => Some(app.path().app_data_dir().ok()?.join("agent-workspace")),
        "attachments" => Some(app.path().app_data_dir().ok()?.join("attachments")),
        "backgrounds" => Some(app.path().app_config_dir().ok()?.join("reader-backgrounds")),
        _ => None,
    }
}

// ---- 云端资产捆索引（GC 引用计数） ----

async fn read_bundles_index(config: &WebdavConfig) -> Result<AssetsIndex, String> {
    match webdav::get_path(config, &bundles_index_path(config)).await? {
        // 404=首次使用（空索引）；解析失败/网络失败必须中止——
        // 默认空索引继续跑会让 GC 把他端引用的资产误判为孤儿（devices.json 同款教训）
        None => Ok(AssetsIndex::default()),
        Some(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("资产索引解析失败（中止备份防误删）: {e}")),
    }
}

/// 计算孤儿资产并裁剪索引：只保留存活备份的引用，引用并集之外的全部删除
fn gc_assets_index(mut index: AssetsIndex, surviving: &[String]) -> (Vec<String>, AssetsIndex) {
    index.by_backup.retain(|name, _| surviving.iter().any(|s| s == name));
    let referenced: std::collections::HashSet<&String> = index.by_backup.values().flatten().collect();
    let orphans: Vec<String> = index.sizes.keys().filter(|sha| !referenced.contains(*sha)).cloned().collect();
    for sha in &orphans {
        index.sizes.remove(sha);
        index.bundle_files.remove(sha);
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

/// 执行一次备份：VACUUM INTO 快照 → 小包（db+配置+themes）+ 资产捆 → 整包哈希无变化跳过 →
/// 上传缺失捆（索引判存，零 PROPFIND）→ 小包上传 → 轮转 + 孤儿 GC
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

    // 3. 扫描资产捆（书按本、向量库/字体/背景/工作区/聊天附件各一捆；内容清单哈希）
    let _ = app.emit("sync-backup-progress", serde_json::json!({ "stage": "scan" }));
    let (bundles, asset_cache) = collect_bundles(app, &config_dir)?;
    let assets: Vec<AssetRef> = bundles
        .iter()
        .map(|b| AssetRef {
            kind: b.kind.to_string(),
            name: b.name.clone(),
            sha256: b.content_hash.clone(),
            size: 0, // 上传时才知 zip 体积；索引用 sizes 记实际值
        })
        .collect();

    // 4. 整包内容哈希（db+全部 JSON+themes+资产清单）：无变化零流量
    let mut pack_hasher = Sha256::new();
    for (name, bytes) in &entries {
        pack_hasher.update(name.as_bytes());
        pack_hasher.update(bytes);
    }
    let assets_manifest = serde_json::to_string(&assets).map_err(|e| e.to_string())?;
    pack_hasher.update(assets_manifest.as_bytes());
    let pack_sha256 = sha256_hex(&pack_hasher.finalize());

    let state = read_sync_state(&config_dir);
    if state.last_pack_sha256.as_deref() == Some(pack_sha256.as_str()) && state.last_backup_name.is_some() {
        return Ok(BackupOutcome {
            status: "skipped".to_string(),
            message: "数据无变化，已跳过上传".to_string(),
            backup_name: None,
        });
    }

    // 5. 读资产索引（读失败中止防误删；同时作为"云端已有哪些捆"的免 PROPFIND 判存依据——
    //    坚果云免费版每 30 分钟 600 次请求，逐文件上传会把首次备份打穿限流窗口）
    let mut assets_index = read_bundles_index(config).await?;

    // 6. 上传缺失捆（索引判存零请求跳过；PUT 内容寻址幂等，重复覆盖无害）
    webdav::ensure_remote_dirs(config, &[bundles_dir(config)]).await?;
    let total = bundles.len();
    let mut bundles_uploaded = 0usize;
    let mut final_assets: Vec<AssetRef> = Vec::with_capacity(total);
    for (i, bundle) in bundles.iter().enumerate() {
        let mut asset = assets[i].clone();
        if assets_index.sizes.contains_key(&bundle.content_hash) {
            // 云端已有同内容捆：体积从索引带出，免重传
            asset.size = assets_index.sizes.get(&bundle.content_hash).copied().unwrap_or(0);
            final_assets.push(asset);
            continue;
        }
        let _ = app.emit(
            "sync-backup-progress",
            serde_json::json!({ "stage": "assets", "current": i + 1, "total": total, "name": bundle.name }),
        );
        let zip_bytes = build_bundle_zip(bundle)?;
        asset.size = zip_bytes.len() as u64;
        let remote = format!("{}/{}", bundles_dir(config), asset.bundle_remote_name());
        webdav::put_path(config, &remote, zip_bytes).await?;
        bundles_uploaded += 1;
        final_assets.push(asset);
        // 突发平滑（通用防爆发，非针对特定厂商）；限流由 send() 的自适应退避兜底
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let assets = final_assets;

    // 7. 打包上传小包
    let created_at = chrono::Utc::now().timestamp_millis();
    let manifest = BackupManifest {
        format: "bettersageread-backup".to_string(),
        version: 3,
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
        assets_index
            .bundle_files
            .insert(asset.sha256.clone(), asset.bundle_remote_name());
    }
    // 先按"存活备份引用并集"找出孤儿并取其云端文件名（GC 裁剪后映射即消失，顺序不能反）
    let mut referenced: std::collections::HashSet<String> = std::collections::HashSet::new();
    for name in &surviving {
        if let Some(shas) = assets_index.by_backup.get(name) {
            referenced.extend(shas.iter().cloned());
        }
    }
    let orphan_files: Vec<String> = assets_index
        .sizes
        .keys()
        .filter(|sha| !referenced.contains(*sha))
        .filter_map(|sha| assets_index.bundle_files.get(sha).cloned())
        .collect();
    let (_orphans, new_index) = gc_assets_index(assets_index, &surviving);
    for file in &orphan_files {
        let _ = webdav::delete_path(config, &format!("{}/{}", bundles_dir(config), file)).await;
    }
    if !removed.is_empty() || !orphan_files.is_empty() {
        log::info!("备份轮转：删除旧包 {} 个，GC 孤儿资产 {} 个", removed.len(), orphan_files.len());
    }
    webdav::put_path(config, &bundles_index_path(config), serde_json::to_vec_pretty(&new_index).map_err(|e| e.to_string())?).await?;

    // 10. 一次性清理 v2 时代的逐文件资产池（逐文件 PUT 已在 v3 废弃；忽略结果）
    let legacy_assets = format!("{}/assets", config.remote_dir.trim_matches('/'));
    if webdav::path_exists(config, &legacy_assets).await.unwrap_or(false) {
        let _ = webdav::delete_path(config, &legacy_assets).await;
        log::info!("已清理 v2 逐文件资产池目录 {legacy_assets}");
    }

    // 11. 记录本地状态与资产哈希缓存
    let _ = write_sync_state(
        &config_dir,
        &backup_success_state(state, created_at, backup_name.clone(), manifest.db_sha256.clone(), pack_sha256),
    );
    save_asset_cache(&config_dir, &asset_cache);

    let message = if bundles_uploaded > 0 {
        format!("已上传 {backup_name}（新增资产包 {bundles_uploaded}/{total} 个）")
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
            format: "bettersageread-backup".to_string(),
            version: 3,
            created_at: 0,
            device: "test".to_string(),
            app_version: "0.1.0".to_string(),
            contents: vec!["app.db".to_string(), "app-settings.json".to_string()],
            db_sha256: sha256_hex(&db_bytes),
            assets: vec![AssetRef {
                kind: "book".to_string(),
                name: "b1".to_string(),
                sha256: "a".repeat(64),
                size: 100,
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
        assert_eq!(parsed.format, "bettersageread-backup");
        assert_eq!(parsed.version, 3);
        assert_eq!(parsed.contents.len(), 2);
        assert_eq!(parsed.assets.len(), 1);
        assert_eq!(parsed.assets[0].bundle_remote_name(), format!("book-b1-{}.zip", "a".repeat(16)));

        let _ = fs::remove_dir_all(&staging);
    }

    /// 附件捆（S4）：{appData}/attachments 目录打捆 → 解包到另一个数据目录 →
    /// 文件逐字节一致、内容清单哈希与备份侧相同（stage_restore 损包校验同口径）——
    /// 换机恢复后 attachment:// 引用指向的图片文件必须可用
    #[test]
    fn test_attachments_bundle_roundtrip() {
        let root = std::env::temp_dir().join(format!("sageread-attachments-test-{}", uuid::Uuid::new_v4()));
        // 源机：对话图片落盘目录（attachment://img1.png 引用的实体）
        let src = root.join("src-appdata").join("attachments");
        fs::create_dir_all(&src).unwrap();
        let png = b"\x89PNG\r\n\x1a\n-fake-png-bytes";
        let jpg = b"\xff\xd8\xff\xe0-fake-jpg-bytes";
        fs::write(src.join("img1.png"), png).unwrap();
        fs::write(src.join("img2.jpg"), jpg).unwrap();

        // 备份侧：组装捆（kind=attachments，与 collect_bundles 同参数）+ 打 zip
        let mut cache = AssetCache::new();
        let bundle = bundle_from_dir(&mut cache, "attachments", "attachments".to_string(), src.clone())
            .unwrap()
            .expect("attachments 目录应打成捆");
        assert_eq!(bundle.kind, "attachments");
        assert_eq!(bundle.files.len(), 2, "两个附件文件都应入捆");
        let zip_bytes = build_bundle_zip(&bundle).unwrap();

        // 恢复侧：解到另一台机器的数据目录（apply_staged_assets 的整目录时点替换语义）
        let restored = root.join("dst-appdata").join("attachments");
        fs::create_dir_all(&restored).unwrap();
        zip::ZipArchive::new(Cursor::new(&zip_bytes))
            .unwrap()
            .extract(&restored)
            .unwrap();

        // 图片文件逐字节可见
        assert_eq!(fs::read(restored.join("img1.png")).unwrap(), png);
        assert_eq!(fs::read(restored.join("img2.jpg")).unwrap(), jpg);
        // 损包校验口径：恢复目录的内容清单哈希 == 备份 manifest 里的 sha256
        assert_eq!(
            dir_content_hash(&restored).unwrap().as_deref(),
            Some(bundle.content_hash.as_str()),
            "恢复后目录内容哈希应与备份清单一致"
        );

        let _ = fs::remove_dir_all(&root);
    }
}
