use super::models::{BackupInfo, WebdavConfig};
use reqwest::{Client, Method, Url};

/// 拼接远端 URL：endpoint + remote_dir 相对路径（path 不含 remote_dir 前缀时由调用方带上）
fn remote_url(config: &WebdavConfig, path: &str) -> Result<Url, String> {
    let base = config.endpoint.trim_end_matches('/');
    let mut url = Url::parse(base).map_err(|e| format!("无效的 WebDAV 地址: {e}"))?;
    if !path.is_empty() {
        url.path_segments_mut()
            .map_err(|_| "WebDAV 地址无法作为路径基底".to_string())?
            .extend(path.split('/').filter(|s| !s.is_empty()));
    }
    Ok(url)
}

/// 远端文件路径（remote_dir/name）
fn file_path(config: &WebdavConfig, name: &str) -> String {
    format!("{}/{}", config.remote_dir.trim_matches('/'), name)
}

/// 统一 HTTP client：connect 10s / 总 120s 超时（防弱网下载悬挂）；代理走应用级设置（批次 F3-1）
fn client() -> Result<Client, String> {
    crate::core::proxy::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("创建 HTTP client 失败: {e}"))
}

/// 限流重试上限与基础退避（坚果云高频请求会 429/503）
const RATE_LIMIT_MAX_RETRIES: u32 = 5;

async fn send(
    config: &WebdavConfig,
    method: Method,
    path: &str,
    body: Option<Vec<u8>>,
) -> Result<reqwest::Response, String> {
    // 429/503 指数退避：2s/4s/8s/16s/32s + 抖动（备份资产池把单次备份的请求数放大了一个量级，退避是刚需）
    let mut attempt = 0u32;
    loop {
        let url = remote_url(config, path)?;
        let client = client()?;
        let mut builder = client
            .request(method.clone(), url)
            .basic_auth(&config.username, Some(&config.password));
        if let Some(body) = body.clone() {
            builder = builder.body(body);
        }
        let resp = builder.send().await.map_err(|e| format!("网络请求失败: {e}"))?;
        let status = resp.status().as_u16();
        if (status == 429 || status == 503) && attempt < RATE_LIMIT_MAX_RETRIES {
            attempt += 1;
            let jitter = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.subsec_millis() as u64 % 500)
                .unwrap_or(0);
            let backoff_ms = (1000u64 << attempt) + jitter;
            log::warn!("WebDAV 限流 (HTTP {status})，{backoff_ms}ms 后第 {attempt}/{RATE_LIMIT_MAX_RETRIES} 次重试: {path}");
            tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)).await;
            continue;
        }
        return Ok(resp);
    }
}

/// 逐级 MKCOL 创建远端目录；201=已创建、405=已存在，均视为成功
pub async fn ensure_dir(config: &WebdavConfig) -> Result<(), String> {
    let mut current = String::new();
    for segment in config.remote_dir.split('/').filter(|s| !s.is_empty()) {
        if !current.is_empty() {
            current.push('/');
        }
        current.push_str(segment);
        let resp = send(config, Method::from_bytes(b"MKCOL").unwrap(), &current, None).await?;
        let status = resp.status().as_u16();
        if !(200..300).contains(&status) && status != 405 {
            return Err(format!("创建远端目录失败 (HTTP {status})"));
        }
    }
    Ok(())
}

pub async fn test_connection(config: &WebdavConfig) -> Result<String, String> {
    ensure_dir(config).await?;
    Ok("连接成功".to_string())
}

/// 按需确保多个远端目录存在（每个目录逐级 MKCOL，201/405 均视为成功；
/// 逐级是为了兼容嵌套路径——坚果云等不允许在缺失的父目录下直接建子目录）
pub async fn ensure_remote_dirs(config: &WebdavConfig, dirs: &[String]) -> Result<(), String> {
    for dir in dirs {
        let mut current = String::new();
        for segment in dir.split('/').filter(|s| !s.is_empty()) {
            if !current.is_empty() {
                current.push('/');
            }
            current.push_str(segment);
            let resp = send(config, Method::from_bytes(b"MKCOL").unwrap(), &current, None).await?;
            let status = resp.status().as_u16();
            if !(200..300).contains(&status) && status != 405 {
                return Err(format!("创建同步目录失败 (HTTP {status}): {current}"));
            }
        }
    }
    Ok(())
}

pub async fn put_file(config: &WebdavConfig, name: &str, bytes: Vec<u8>) -> Result<(), String> {
    let path = file_path(config, name);
    let resp = send(config, Method::PUT, &path, Some(bytes)).await?;
    let status = resp.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(format!("上传失败 (HTTP {status})"));
    }
    Ok(())
}

/// 读取远端文件；404 返回 None
pub async fn get_file(config: &WebdavConfig, name: &str) -> Result<Option<Vec<u8>>, String> {
    let path = file_path(config, name);
    let resp = send(config, Method::GET, &path, None).await?;
    let status = resp.status().as_u16();
    if status == 404 {
        return Ok(None);
    }
    if !(200..300).contains(&status) {
        return Err(format!("下载失败 (HTTP {status})"));
    }
    let bytes = resp.bytes().await.map_err(|e| format!("读取响应失败: {e}"))?;
    Ok(Some(bytes.to_vec()))
}

pub async fn get_file_required(config: &WebdavConfig, name: &str) -> Result<Vec<u8>, String> {
    get_file(config, name)
        .await?
        .ok_or_else(|| "备份文件不存在".to_string())
}

pub async fn delete_file(config: &WebdavConfig, name: &str) -> Result<(), String> {
    let path = file_path(config, name);
    let resp = send(config, Method::DELETE, &path, None).await?;
    let status = resp.status().as_u16();
    if !(200..300).contains(&status) && status != 404 {
        return Err(format!("删除远端文件失败 (HTTP {status})"));
    }
    Ok(())
}

/// 远端备份清单（index.json），不存在时为空列表
pub async fn read_index(config: &WebdavConfig) -> Result<Vec<BackupInfo>, String> {
    match get_file(config, "index.json").await? {
        Some(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("解析 index.json 失败: {e}")),
        None => Ok(vec![]),
    }
}

pub async fn write_index(config: &WebdavConfig, entries: &[BackupInfo]) -> Result<(), String> {
    let bytes =
        serde_json::to_vec_pretty(entries).map_err(|e| format!("序列化 index.json 失败: {e}"))?;
    put_file(config, "index.json", bytes).await
}

/* ---------------- L2 增量同步：绝对远端路径操作（不经 remote_dir 前缀） ---------------- */

pub async fn put_path(config: &WebdavConfig, path: &str, bytes: Vec<u8>) -> Result<(), String> {
    let resp = send(config, Method::PUT, path, Some(bytes)).await?;
    let status = resp.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(format!("上传失败 (HTTP {status}): {path}"));
    }
    Ok(())
}

/// 读取远端绝对路径文件；404 返回 None
pub async fn get_path(config: &WebdavConfig, path: &str) -> Result<Option<Vec<u8>>, String> {
    let resp = send(config, Method::GET, path, None).await?;
    let status = resp.status().as_u16();
    if status == 404 {
        return Ok(None);
    }
    if !(200..300).contains(&status) {
        return Err(format!("下载失败 (HTTP {status}): {path}"));
    }
    let bytes = resp.bytes().await.map_err(|e| format!("读取响应失败: {e}"))?;
    Ok(Some(bytes.to_vec()))
}

pub async fn delete_path(config: &WebdavConfig, path: &str) -> Result<(), String> {
    let resp = send(config, Method::DELETE, path, None).await?;
    let status = resp.status().as_u16();
    if !(200..300).contains(&status) && status != 404 {
        return Err(format!("删除远端文件失败 (HTTP {status}): {path}"));
    }
    Ok(())
}

/// 远端路径（文件或目录）是否存在：PROPFIND Depth:0，2xx/207=存在，404=不存在
pub async fn path_exists(config: &WebdavConfig, path: &str) -> Result<bool, String> {
    let url = remote_url(config, path)?;
    let resp = client()?
        .request(Method::from_bytes(b"PROPFIND").unwrap(), url)
        .basic_auth(&config.username, Some(&config.password))
        .header("Depth", "0")
        .header("Content-Type", "application/xml")
        .body(r#"<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>"#)
        .send()
        .await
        .map_err(|e| format!("网络请求失败: {e}"))?;
    let status = resp.status().as_u16();
    if status == 404 {
        return Ok(false);
    }
    if (200..300).contains(&status) {
        return Ok(true);
    }
    Err(format!("PROPFIND 失败 (HTTP {status}): {path}"))
}

/// WebDAV MOVE（文件/集合通用），用于云端目录整体搬家
/// Overwrite: F——目标已存在直接报错，调用方须先用 path_exists 判空，避免互相覆盖
pub async fn move_path(config: &WebdavConfig, src: &str, dst: &str) -> Result<(), String> {
    let src_url = remote_url(config, src)?;
    let dst_url = remote_url(config, dst)?;
    let resp = client()?
        .request(Method::from_bytes(b"MOVE").unwrap(), src_url)
        .basic_auth(&config.username, Some(&config.password))
        .header("Destination", dst_url.to_string())
        .header("Overwrite", "F")
        .send()
        .await
        .map_err(|e| format!("网络请求失败: {e}"))?;
    let status = resp.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(format!("远端目录迁移失败 (HTTP {status}): {src} → {dst}"));
    }
    Ok(())
}
