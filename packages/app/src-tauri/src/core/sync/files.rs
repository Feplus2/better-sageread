//! L2 书籍文件通道：sha256 内容寻址上传 / 懒下载 / files-index 管理
//! 协议依据：docs/sync-protocol.md §8

use super::models::WebdavConfig;
use super::webdav;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqlitePool};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// L2 云端根目录（与 engine.rs 保持一致：按配置动态解析，见 models::l2_root）
use super::models::l2_root;

/* ---------------- 数据结构 ---------------- */

/// files-index.json 中每本书的条目
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct FileEntry {
    pub sha256: String,
    pub size: u64,
    pub format: String,
    pub title: String,
    pub uploaded_by: String,
    pub uploaded_at: i64,
}

/// 前端展示用：云端书目 + 本地是否已有文件
#[derive(Serialize, Debug)]
pub struct CloudBookInfo {
    pub book_id: String,
    pub title: String,
    pub format: String,
    pub size: u64,
    pub sha256: String,
    /// 本地文件是否已存在
    pub local_exists: bool,
}

/// 批量上传结果
#[derive(Serialize, Debug)]
pub struct UploadAllResult {
    pub total: usize,
    pub uploaded: usize,
    pub skipped: usize,
    pub failed: usize,
    /// 首个失败原因（供前端展示，便于排查）
    pub first_error: Option<String>,
}

/* ---------------- 工具函数 ---------------- */

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// 流式计算文件 sha256（64KB buffer，不一次性加载到内存）
pub fn compute_sha256(path: &Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path).map_err(|e| format!("打开文件失败: {e}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let n = file.read(&mut buffer).map_err(|e| format!("读取文件失败: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// 云端文件路径：sageread/sync/files/<sha256前2位>/<sha256>
fn cloud_file_path(config: &WebdavConfig, sha256: &str) -> String {
    let prefix = &sha256[..2];
    format!("{}/files/{prefix}/{sha256}", l2_root(config))
}

/* ---------------- files-index.json 读写 ---------------- */

/// 拉取云端 files-index.json（不存在返回空 map）
pub async fn read_files_index(config: &WebdavConfig) -> Result<HashMap<String, FileEntry>, String> {
    let path = format!("{}/files-index.json", l2_root(config));
    match webdav::get_path(config, &path).await? {
        Some(bytes) => {
            let index: HashMap<String, FileEntry> =
                serde_json::from_slice(&bytes).map_err(|e| format!("解析 files-index.json 失败: {e}"))?;
            log::info!("读取 files-index.json：{} 条条目", index.len());
            Ok(index)
        }
        None => {
            log::info!("files-index.json 不存在（404），返回空");
            Ok(HashMap::new())
        }
    }
}

/// 写入 files-index.json（直接 PUT 覆盖）
async fn write_files_index(config: &WebdavConfig, index: &HashMap<String, FileEntry>) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(index).map_err(|e| format!("序列化 files-index.json 失败: {e}"))?;
    let path = format!("{}/files-index.json", l2_root(config));
    webdav::put_path(config, &path, bytes).await
}

/// 读-合并-写 files-index.json（竞态重试一次）
async fn merge_files_index(config: &WebdavConfig, book_id: &str, entry: FileEntry) -> Result<(), String> {
    for attempt in 0..2 {
        let mut index = read_files_index(config).await?;
        index.insert(book_id.to_string(), entry.clone());
        match write_files_index(config, &index).await {
            Ok(()) => return Ok(()),
            Err(e) if attempt == 0 => {
                log::warn!("files-index 写入冲突，重试: {e}");
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            }
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

/* ---------------- MARKDOWN 论文：整目录 zip 捆（paper.md+images/ 多文件适配） ---------------- */

fn collect_dir_files(dir: &Path, base: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_dir_files(&path, base, out);
        } else {
            out.push(path);
        }
    }
}

/// 目录打 zip（与备份捆同策略：小文件 Deflate、≥4MB Stored）
fn build_dir_zip(dir: &Path) -> Result<Vec<u8>, String> {
    let mut files: Vec<PathBuf> = Vec::new();
    collect_dir_files(dir, dir, &mut files);
    files.sort();
    let mut zw = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for abs in &files {
        let rel = abs.strip_prefix(dir).unwrap_or(abs).to_string_lossy().replace('\\', "/");
        let size = std::fs::metadata(abs).map(|m| m.len()).unwrap_or(0);
        let method = if size >= 4 * 1024 * 1024 {
            zip::CompressionMethod::Stored
        } else {
            zip::CompressionMethod::Deflated
        };
        let options = zip::write::SimpleFileOptions::default().compression_method(method);
        zw.start_file(rel, options).map_err(|e| format!("捆写入失败: {e}"))?;
        let bytes = std::fs::read(abs).map_err(|e| format!("读取资产失败 {}: {e}", abs.display()))?;
        zw.write_all(&bytes).map_err(|e| format!("捆写入失败: {e}"))?;
    }
    let cursor = zw.finish().map_err(|e| format!("捆打包失败: {e}"))?;
    Ok(cursor.into_inner())
}

fn sha256_hex_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// MARKDOWN 论文上传：books/<id>/ 整目录 zip 作 blob，沿用内容寻址与 files-index 条目
async fn upload_paper_bundle(
    config: &WebdavConfig,
    app_data_dir: &Path,
    device_id: &str,
    book_id: &str,
    book_title: &str,
) -> Result<FileEntry, String> {
    let dir = app_data_dir.join("books").join(book_id);
    if !dir.is_dir() {
        return Err(format!("论文目录不存在: books/{book_id}"));
    }

    let zip_bytes = tokio::task::spawn_blocking({
        let dir = dir.clone();
        move || build_dir_zip(&dir)
    })
    .await
    .map_err(|e| format!("论文捆打包任务失败: {e}"))??;
    let sha256 = sha256_hex_bytes(&zip_bytes);

    let entry = FileEntry {
        sha256: sha256.clone(),
        size: zip_bytes.len() as u64,
        format: "MARKDOWN".to_string(),
        title: book_title.to_string(),
        uploaded_by: device_id.to_string(),
        uploaded_at: now_ms(),
    };

    let cloud_path = cloud_file_path(config, &sha256);
    if webdav::get_path(config, &cloud_path).await?.is_none() {
        let prefix = &sha256[..2];
        webdav::ensure_remote_dirs(
            config,
            &[format!("{}/files", l2_root(config)), format!("{}/files/{prefix}", l2_root(config))],
        )
        .await?;
        webdav::put_path(config, &cloud_path, zip_bytes).await?;
        log::info!("论文文件已上传: {book_title} (sha256={})", &sha256[..8]);
    }

    merge_files_index(config, book_id, entry.clone()).await?;
    Ok(entry)
}

/// MARKDOWN 论文下载：sha256 校验后整目录时点替换解包（防 zip-slip）
pub async fn download_paper_bundle(
    config: &WebdavConfig,
    app_data_dir: &Path,
    book_id: &str,
    sha256: &str,
) -> Result<PathBuf, String> {
    let cloud_path = cloud_file_path(config, sha256);
    let bytes = webdav::get_path(config, &cloud_path)
        .await?
        .ok_or_else(|| format!("云端文件不存在: {sha256}"))?;
    let actual = sha256_hex_bytes(&bytes);
    if actual != sha256 {
        return Err(format!("sha256 校验失败: 期望 {sha256}，实际 {actual}"));
    }

    let target = app_data_dir.join("books").join(book_id);
    if target.exists() {
        std::fs::remove_dir_all(&target).map_err(|e| format!("清理目标目录失败: {e}"))?;
    }
    std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| format!("论文捆损坏: {e}"))?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| format!("读取捆条目失败: {e}"))?;
        let Some(enclosed) = entry.enclosed_name() else {
            continue; // 防 zip-slip（含 .. 的条目直接丢弃）
        };
        let out_path = target.join(enclosed);
        if entry.is_dir() {
            std::fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut out_file = std::fs::File::create(&out_path).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut out_file).map_err(|e| e.to_string())?;
        }
    }
    log::info!("论文文件已下载: {book_id}");
    Ok(target)
}

/* ---------------- 上传 ---------------- */

/// 上传单本书的文件到云端（幂等：sha256 已存在则跳过文件传输，只确保 index 有条目）
pub async fn upload_book(
    config: &WebdavConfig,
    app_data_dir: &Path,
    device_id: &str,
    book_id: &str,
    book_src: &str,
    book_title: &str,
    book_format: &str,
) -> Result<FileEntry, String> {
    // MARKDOWN 论文是 paper.md+images/ 多文件目录：整目录 zip 捆上传（协议仍是每书一 blob）
    if book_format == "MARKDOWN" {
        return upload_paper_bundle(config, app_data_dir, device_id, book_id, book_title).await;
    }

    let local_path = app_data_dir.join(book_src);
    if !local_path.exists() {
        return Err(format!("书籍文件不存在: {book_src}"));
    }

    let sha256 = tokio::task::spawn_blocking({
        let path = local_path.clone();
        move || compute_sha256(&path)
    })
    .await
    .map_err(|e| format!("sha256 计算任务失败: {e}"))??;

    let size = std::fs::metadata(&local_path)
        .map_err(|e| format!("获取文件大小失败: {e}"))?
        .len();

    let entry = FileEntry {
        sha256: sha256.clone(),
        size,
        format: book_format.to_string(),
        title: book_title.to_string(),
        uploaded_by: device_id.to_string(),
        uploaded_at: now_ms(),
    };

    // 检查云端是否已有该 sha256 的文件（内容寻址去重）
    let cloud_path = cloud_file_path(config, &sha256);
    let exists = webdav::get_path(config, &cloud_path).await?.is_some();
    if !exists {
        // 确保目录存在（MKCOL 要求父目录已存在，须先建 files 再建 files/<prefix>）
        let prefix = &sha256[..2];
        webdav::ensure_remote_dirs(
            config,
            &[format!("{}/files", l2_root(config)), format!("{}/files/{prefix}", l2_root(config))],
        )
        .await?;

        // 读取文件并上传
        let bytes = tokio::task::spawn_blocking({
            let path = local_path.clone();
            move || std::fs::read(&path).map_err(|e| format!("读取文件失败: {e}"))
        })
        .await
        .map_err(|e| format!("文件读取任务失败: {e}"))??;

        webdav::put_path(config, &cloud_path, bytes).await?;
        log::info!("书籍文件已上传: {book_title} ({size} bytes, sha256={})", &sha256[..8]);
    }

    // 更新 files-index（读-合并-写）
    merge_files_index(config, book_id, entry.clone()).await?;

    Ok(entry)
}

/// 批量上传本地所有有文件的书（首次引导用）
pub async fn upload_all_books(
    config: &WebdavConfig,
    pool: &SqlitePool,
    app_data_dir: &Path,
    device_id: &str,
) -> Result<UploadAllResult, String> {
    let rows = sqlx::query("SELECT id, title, file_path, format FROM books WHERE trashed_at IS NULL")
        .fetch_all(pool)
        .await
        .map_err(|e| format!("查询书籍列表失败: {e}"))?;

    let index = read_files_index(config).await?;
    let total = rows.len();
    let mut uploaded = 0usize;
    let mut skipped = 0usize;
    let mut failed = 0usize;
    let mut first_error: Option<String> = None;

    for row in &rows {
        let book_id: String = row.get("id");
        let title: String = row.get("title");
        let file_path: String = row.get("file_path");
        let format: String = row.get("format");

        // 已在 index 中则跳过
        if index.contains_key(&book_id) {
            skipped += 1;
            continue;
        }

        let local_path = app_data_dir.join(&file_path);
        if !local_path.exists() {
            skipped += 1;
            continue;
        }

        match upload_book(config, app_data_dir, device_id, &book_id, &file_path, &title, &format).await {
            Ok(_) => uploaded += 1,
            Err(e) => {
                log::warn!("上传书籍失败（跳过）: {title}: {e}");
                if first_error.is_none() {
                    first_error = Some(format!("《{title}》: {e}"));
                }
                failed += 1;
            }
        }
    }

    Ok(UploadAllResult {
        total,
        uploaded,
        skipped,
        failed,
        first_error,
    })
}

/* ---------------- 下载 ---------------- */

/// 下载单本书的文件（sha256 校验，写入本地 books 目录）
pub async fn download_book(
    config: &WebdavConfig,
    app_data_dir: &Path,
    book_id: &str,
    book_src: &str,
    sha256: &str,
) -> Result<PathBuf, String> {
    let cloud_path = cloud_file_path(config, sha256);
    let bytes = webdav::get_path(config, &cloud_path)
        .await?
        .ok_or_else(|| format!("云端文件不存在: {sha256}"))?;

    // 校验 sha256
    let actual_hash = {
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        format!("{:x}", hasher.finalize())
    };
    if actual_hash != sha256 {
        return Err(format!("sha256 校验失败: 期望 {sha256}，实际 {actual_hash}"));
    }

    // 写入本地
    let local_path = app_data_dir.join(book_src);
    if let Some(parent) = local_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    std::fs::write(&local_path, &bytes).map_err(|e| format!("写入文件失败: {e}"))?;

    log::info!("书籍文件已下载: {book_id} ({} bytes)", bytes.len());
    Ok(local_path)
}

/* ---------------- 查询 ---------------- */

/// 比对 files-index 与本地 books 表，返回云端书目列表（含本地是否已有文件标记）
pub async fn get_cloud_books(
    config: &WebdavConfig,
    pool: &SqlitePool,
    app_data_dir: &Path,
) -> Result<Vec<CloudBookInfo>, String> {
    let index = read_files_index(config).await?;

    // 查本地 books 表的 file_path 字段
    let rows = sqlx::query("SELECT id, file_path FROM books WHERE trashed_at IS NULL")
        .fetch_all(pool)
        .await
        .map_err(|e| format!("查询书籍失败: {e}"))?;

    let local_paths: HashMap<String, String> = rows
        .iter()
        .map(|r| (r.get::<String, _>("id"), r.get::<String, _>("file_path")))
        .collect();

    let mut result = Vec::new();
    for (book_id, entry) in &index {
        let local_exists = local_paths
            .get(book_id)
            .map(|fp| app_data_dir.join(fp).exists())
            .unwrap_or(false);

        result.push(CloudBookInfo {
            book_id: book_id.clone(),
            title: entry.title.clone(),
            format: entry.format.clone(),
            size: entry.size,
            sha256: entry.sha256.clone(),
            local_exists,
        });
    }

    Ok(result)
}

/// 查找本地有文件但云端 index 中没有的书（供 run_sync 自动上传）
pub async fn find_unuploaded_books(
    config: &WebdavConfig,
    pool: &SqlitePool,
    app_data_dir: &Path,
) -> Result<Vec<(String, String, String, String)>, String> {
    let index = read_files_index(config).await?;

    let rows = sqlx::query("SELECT id, title, file_path, format FROM books WHERE trashed_at IS NULL")
        .fetch_all(pool)
        .await
        .map_err(|e| format!("查询书籍失败: {e}"))?;

    let mut result = Vec::new();
    for row in &rows {
        let book_id: String = row.get("id");
        if index.contains_key(&book_id) {
            continue;
        }
        let file_path: String = row.get("file_path");
        let local_path = app_data_dir.join(&file_path);
        if local_path.exists() {
            result.push((book_id, row.get("title"), file_path, row.get("format")));
        }
    }

    Ok(result)
}
