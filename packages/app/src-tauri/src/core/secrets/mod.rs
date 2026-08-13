//! 密钥模块（批次 A）：所有 key 迁入 OS 凭据管理器（Windows 凭据管理器 / macOS Keychain / Linux Secret Service）
//!
//! 威胁模型：key 可存在于 app 进程内存（前端经 secret_get_for_runtime 取入内存用于发请求），
//! 但绝不进模型消息、磁盘明文（keyring 后端失效时降级明文文件仅保可用并告警）、日志、备份。
//!
//! account 命名约定 `{category}:{key}`：
//! - model-provider:{providerId}、vector-model:{modelId}、converter:{service}
//! - webdav:password、web-search:{provider}、tts:{service}
//! - mcp:{serverId}:{envKey}、user:{NAME}（用户密钥保管箱，供 skill/集成以 {{secret:NAME}} 引用）

pub mod migrate;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};

const SERVICE: &str = "com.bettersageread.app";
/// keyring 后端不可用时的降级存储（headless Linux 等场景；主发 Windows/macOS 不会触发）
const FALLBACK_FILE: &str = "secrets-fallback.json";

fn account_name(category: &str, key: &str) -> String {
    format!("{category}:{key}")
}

fn fallback_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(FALLBACK_FILE))
}

fn fallback_read(app: &AppHandle) -> HashMap<String, String> {
    fallback_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_default()
}

fn fallback_write(app: &AppHandle, map: &HashMap<String, String>) {
    if let Ok(path) = fallback_path(app) {
        if let Ok(content) = serde_json::to_string_pretty(map) {
            let _ = std::fs::write(path, content);
        }
    }
}

/// 写入密钥：优先 keyring；后端不可用时降级明文文件 + 日志警告。
/// 注：Linux headless 等场景后端失败发生在 set/get 而非 Entry::new，两处都要兜底
pub fn set_secret(app: &AppHandle, category: &str, key: &str, value: &str) -> Result<(), String> {
    let account = account_name(category, key);
    let fallback = |app: &AppHandle, reason: String| {
        log::warn!("keyring 不可用（{reason}），密钥降级存入本地文件 {FALLBACK_FILE}");
        let mut map = fallback_read(app);
        map.insert(account.clone(), value.to_string());
        fallback_write(app, &map);
        Ok(())
    };
    match keyring::Entry::new(SERVICE, &account) {
        Ok(entry) => match entry.set_password(value) {
            Ok(()) => Ok(()),
            Err(e) => fallback(app, e.to_string()),
        },
        Err(e) => fallback(app, e.to_string()),
    }
}

/// 读取密钥：优先 keyring，miss 或后端不可用时查降级文件。不存在返回 Ok(None)
pub fn get_secret(app: &AppHandle, category: &str, key: &str) -> Result<Option<String>, String> {
    let account = account_name(category, key);
    match keyring::Entry::new(SERVICE, &account) {
        Ok(entry) => match entry.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(fallback_read(app).remove(&account)),
            // 后端不可用（headless Linux 等）：降级查文件，不视为硬错误
            Err(e) => {
                log::warn!("keyring 读取失败（{e}），降级查本地文件 {FALLBACK_FILE}");
                Ok(fallback_read(app).remove(&account))
            }
        },
        Err(_) => Ok(fallback_read(app).remove(&account)),
    }
}

/// 删除密钥（keyring 与降级文件双清；keyring 后端不可用时仅告警并继续清文件）
pub fn delete_secret(app: &AppHandle, category: &str, key: &str) -> Result<(), String> {
    let account = account_name(category, key);
    if let Ok(entry) = keyring::Entry::new(SERVICE, &account) {
        // NoEntry 视为已删除
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => log::warn!("keyring 删除失败（{e}），仅清理降级文件 {FALLBACK_FILE}"),
        }
    }
    let mut map = fallback_read(app);
    if map.remove(&account).is_some() {
        fallback_write(app, &map);
    }
    Ok(())
}

// ---- {{secret:NAME}} 引用机制（A3） ----

static SECRET_REF_RE: OnceLock<regex::Regex> = OnceLock::new();

fn secret_ref_regex() -> &'static regex::Regex {
    SECRET_REF_RE.get_or_init(|| regex::Regex::new(r"\{\{secret:([A-Za-z0-9_-]{1,64})\}\}").expect("正则编译失败"))
}

/// 把文本中的 {{secret:NAME}} 替换为 user:{NAME} 的真值；未知名称返回结构化错误（不静默置空）
pub fn resolve_secret_refs(app: &AppHandle, text: &str) -> Result<String, String> {
    let re = secret_ref_regex();
    let mut missing: Vec<String> = Vec::new();
    let out = re
        .replace_all(text, |caps: &regex::Captures| {
            let name = caps.get(1).map(|m| m.as_str()).unwrap_or_default();
            match get_secret(app, "user", name) {
                Ok(Some(v)) => v,
                _ => {
                    missing.push(name.to_string());
                    caps.get(0).map(|m| m.as_str()).unwrap_or("").to_string()
                }
            }
        })
        .to_string();
    if !missing.is_empty() {
        return Err(format!(
            "密钥引用未找到：{}。请先在 设置 → 密钥保管箱 中添加同名密钥",
            missing.join("、")
        ));
    }
    Ok(out)
}

// ---- Tauri 命令 ----

#[tauri::command]
pub fn secret_set(app: AppHandle, category: String, key: String, value: String) -> Result<(), String> {
    set_secret(&app, &category, &key, &value)
}

#[tauri::command]
pub fn secret_delete(app: AppHandle, category: String, key: String) -> Result<(), String> {
    delete_secret(&app, &category, &key)
}

#[tauri::command]
pub fn secret_has(app: AppHandle, category: String, key: String) -> Result<bool, String> {
    Ok(get_secret(&app, &category, &key)?.is_some())
}

/// 执行边界内部取值（仅前端代码 invoke，用于启动时把 key 载入内存发请求；不暴露给 Agent 工具）
#[tauri::command]
pub fn secret_get_for_runtime(app: AppHandle, category: String, key: String) -> Result<String, String> {
    Ok(get_secret(&app, &category, &key)?.unwrap_or_default())
}

/// 批量替换 {{secret:NAME}}（MCP http/sse headers 在前端创建 transport 前调用；
/// key 短暂经过 JS 内存但不进模型上下文——此取舍为既定设计）
#[tauri::command]
pub fn secret_resolve_batch(app: AppHandle, texts: Vec<String>) -> Result<Vec<String>, String> {
    texts.into_iter().map(|t| resolve_secret_refs(&app, &t)).collect()
}

/// 用户密钥保管箱名称列表（仅名称，不含真值；供设置页展示）
#[tauri::command]
pub fn secret_list_user(app: AppHandle) -> Result<Vec<String>, String> {
    let mut names: Vec<String> = Vec::new();
    // keyring 无列举 API：从降级文件 + 已知引用登记文件取名称
    let map = fallback_read(&app);
    for account in map.keys() {
        if let Some(name) = account.strip_prefix("user:") {
            names.push(name.to_string());
        }
    }
    // 名称登记（keyring 主路径下唯一可列举来源）：{config_dir}/secret-names.json
    if let Ok(dir) = app.path().app_config_dir() {
        let registry = dir.join("secret-names.json");
        if let Ok(content) = std::fs::read_to_string(&registry) {
            if let Ok(list) = serde_json::from_str::<Vec<String>>(&content) {
                for name in list {
                    if !names.contains(&name) {
                        names.push(name);
                    }
                }
            }
        }
    }
    names.sort();
    Ok(names)
}

/// 用户密钥写入/删除时同步维护名称登记
fn update_name_registry(app: &AppHandle, name: &str, add: bool) {
    let Ok(dir) = app.path().app_config_dir() else { return };
    let registry = dir.join("secret-names.json");
    let mut list: Vec<String> = std::fs::read_to_string(&registry)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_default();
    if add {
        if !list.contains(&name.to_string()) {
            list.push(name.to_string());
        }
    } else {
        list.retain(|n| n != name);
    }
    list.sort();
    if let Ok(content) = serde_json::to_string(&list) {
        let _ = std::fs::write(registry, content);
    }
}

/// 用户保管箱写入（维护名称登记）
#[tauri::command]
pub fn secret_user_set(app: AppHandle, name: String, value: String) -> Result<(), String> {
    validate_secret_name(&name)?;
    set_secret(&app, "user", &name, &value)?;
    update_name_registry(&app, &name, true);
    Ok(())
}

/// 用户保管箱删除（维护名称登记）
#[tauri::command]
pub fn secret_user_delete(app: AppHandle, name: String) -> Result<(), String> {
    delete_secret(&app, "user", &name)?;
    update_name_registry(&app, &name, false);
    Ok(())
}

/// 供迁移器登记搬入保管箱的密钥名（使其在 设置 → 密钥保管箱 中可见、可管理）
pub(crate) fn register_secret_name(app: &AppHandle, name: &str) {
    update_name_registry(app, name, true);
}

fn validate_secret_name(name: &str) -> Result<(), String> {
    let re = regex::Regex::new(r"^[A-Za-z0-9_-]{1,64}$").expect("正则编译失败");
    if re.is_match(name) {
        Ok(())
    } else {
        Err("密钥名称仅限字母、数字、下划线与连字符（1-64 位）".to_string())
    }
}

// ---- 审计日志脱敏（A5，模式清单与前端 secret-patterns.ts 同款） ----

static REDACT_PATTERNS: OnceLock<Vec<(&'static str, regex::Regex)>> = OnceLock::new();

fn redact_patterns() -> &'static Vec<(&'static str, regex::Regex)> {
    REDACT_PATTERNS.get_or_init(|| {
        vec![
            ("OpenAI-Key", regex::Regex::new(r"sk-[A-Za-z0-9_-]{20,}").unwrap()),
            ("Google-Key", regex::Regex::new(r"AIza[0-9A-Za-z_-]{35}").unwrap()),
            ("GitHub-Token", regex::Regex::new(r"ghp_[A-Za-z0-9]{36}").unwrap()),
            ("GitHub-PAT", regex::Regex::new(r"github_pat_[A-Za-z0-9_]{22,}").unwrap()),
            ("Slack-Token", regex::Regex::new(r"xox[baprs]-[A-Za-z0-9-]{10,}").unwrap()),
            (
                "JWT",
                regex::Regex::new(r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}").unwrap(),
            ),
            ("PrivateKey", regex::Regex::new(r"-----BEGIN [A-Z ]*PRIVATE KEY-----").unwrap()),
            (
                "KeyValuePair",
                regex::Regex::new(r#"(?i)(api[_-]?key|token|secret|password)\s*[:=]\s*[\"']?[A-Za-z0-9_-]{16,}"#)
                    .unwrap(),
            ),
        ]
    })
}

/// 命中常见密钥模式的片段替换为 «REDACTED:{模式名}»（审计日志写盘前调用）
pub fn redact_secrets(text: &str) -> String {
    let mut out = text.to_string();
    for (name, re) in redact_patterns() {
        if re.is_match(&out) {
            out = re.replace_all(&out, format!("«REDACTED:{name}»")).to_string();
        }
    }
    out
}

// ---- agent_http_request（A3：httpRequest 走 Rust 发射，secret 引用在 Rust 侧替换） ----

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHttpResult {
    pub status: u16,
    pub status_text: String,
    pub body: String,
}

/// Agent httpRequest 的 Rust 发射通道：URL/headers/body 三处先做 {{secret:NAME}} 替换再出网。
/// 模型只见占位符，真值不出后端。
#[tauri::command]
pub async fn agent_http_request(
    app: AppHandle,
    method: String,
    url: String,
    headers: std::collections::HashMap<String, String>,
    body: Option<String>,
) -> Result<AgentHttpResult, String> {
    let url = resolve_secret_refs(&app, &url)?;
    let body = match body {
        Some(b) => Some(resolve_secret_refs(&app, &b)?),
        None => None,
    };
    let reqwest_method: reqwest::Method = method
        .parse()
        .map_err(|_| format!("不支持的 HTTP 方法: {method}"))?;
    let mut builder = crate::core::proxy::builder().build().map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?.request(reqwest_method.clone(), &url);
    for (k, v) in &headers {
        let v = resolve_secret_refs(&app, v)?;
        builder = builder.header(k.as_str(), v);
    }
    if !matches!(reqwest_method, reqwest::Method::GET | reqwest::Method::HEAD) {
        builder = builder.body(body.unwrap_or_default());
    }
    let resp = builder.send().await.map_err(|e| format!("请求失败: {e}"))?;
    let status = resp.status().as_u16();
    let status_text = resp
        .status()
        .canonical_reason()
        .unwrap_or_default()
        .to_string();
    let text = resp.text().await.unwrap_or_default();
    // 截断上限与前端现网惯例一致（8000 字符）
    let body = if text.chars().count() > 8000 {
        let kept: String = text.chars().take(8000).collect();
        format!("{}…[截断，共 {} 字符]", kept, text.chars().count())
    } else {
        text
    };
    Ok(AgentHttpResult {
        status,
        status_text,
        body,
    })
}
