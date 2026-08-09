//! 应用级代理设置（批次 F3-1）：三档 off / custom / follow-env，无需 TUN。
//!
//! 存储：{config_dir}/proxy.json（批次 D1 的 mcp_stdio_start 亦读此文件做 spawn env 注入）。
//! 作用于 Rust reqwest 层：`builder()` 返回已应用代理的 ClientBuilder，
//! 覆盖 webdav 同步 / web_search / agent_http_request 等 Rust 侧请求。
//! follow-env/off 走 reqwest 默认行为（自动识别系统代理与 HTTP(S)_PROXY 环境变量）。
//! NO_PROXY 恒含 localhost,127.0.0.1。

use serde::{Deserialize, Serialize};
use std::sync::{OnceLock, RwLock};
use tauri::{AppHandle, Manager};

pub const MODE_OFF: &str = "off";
pub const MODE_CUSTOM: &str = "custom";
pub const MODE_FOLLOW_ENV: &str = "follow-env";

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProxyConfig {
    /** off | custom | follow-env */
    pub mode: String,
    /** custom 模式下的代理地址（如 http://127.0.0.1:7890） */
    pub url: String,
}

static SNAPSHOT: OnceLock<RwLock<ProxyConfig>> = OnceLock::new();

fn snapshot() -> &'static RwLock<ProxyConfig> {
    SNAPSHOT.get_or_init(|| RwLock::new(ProxyConfig::default()))
}

fn config_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("proxy.json"))
}

/// 启动时从 proxy.json 载入内存快照（失败视为 off，不阻塞启动）
pub fn load(app: &AppHandle) {
    let cfg = (|| -> Option<ProxyConfig> {
        let text = std::fs::read_to_string(config_path(app).ok()?).ok()?;
        serde_json::from_str(&text).ok()
    })()
    .unwrap_or_default();
    *snapshot().write().unwrap_or_else(|e| e.into_inner()) = cfg;
}

pub fn current() -> ProxyConfig {
    snapshot().read().unwrap_or_else(|e| e.into_inner()).clone()
}

/// 保存：写盘 + 更新内存快照
pub fn save(app: &AppHandle, cfg: ProxyConfig) -> Result<(), String> {
    let path = config_path(app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    *snapshot().write().unwrap_or_else(|e| e.into_inner()) = cfg;
    Ok(())
}

fn ensure_scheme(url: &str) -> String {
    if url.contains("://") {
        url.to_string()
    } else {
        format!("http://{url}")
    }
}

/** 已应用代理设置的 ClientBuilder：custom → Proxy::all；其余走 reqwest 默认。
 * NO_PROXY 恒含 localhost,127.0.0.1（本机服务绝不走代理）。 */
pub fn builder() -> reqwest::ClientBuilder {
    let mut b = reqwest::Client::builder();
    let cfg = current();
    if cfg.mode == MODE_CUSTOM && !cfg.url.trim().is_empty() {
        let url = ensure_scheme(cfg.url.trim());
        match reqwest::Proxy::all(&url) {
            Ok(proxy) => {
                let no_proxy = reqwest::NoProxy::from_string("localhost,127.0.0.1");
                b = b.proxy(proxy.no_proxy(no_proxy));
            }
            Err(e) => {
                log::warn!("[proxy] 代理地址无效（{url}），按直连处理: {e}");
            }
        }
    }
    b
}

// ---- Tauri 命令 ----

#[tauri::command]
pub fn proxy_get_config() -> ProxyConfig {
    current()
}

#[tauri::command]
pub fn proxy_save_config(app: AppHandle, mode: String, url: String) -> Result<(), String> {
    if ![MODE_OFF, MODE_CUSTOM, MODE_FOLLOW_ENV].contains(&mode.as_str()) {
        return Err(format!("不支持的代理模式: {mode}"));
    }
    let url = url.trim().to_string();
    if mode == MODE_CUSTOM && url.is_empty() {
        return Err("custom 模式需要填写代理地址".into());
    }
    save(&app, ProxyConfig { mode, url })?;
    log::info!("[proxy] 代理设置已保存");
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyTestResult {
    pub zotero: bool,
    pub unpaywall: bool,
    pub message: String,
}

/** 测试代理：按当前配置请求境外 API（zotero + unpaywall），验证可达性 */
#[tauri::command]
pub async fn proxy_test() -> Result<ProxyTestResult, String> {
    let client = builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    let check = |url: &'static str, client: &reqwest::Client| {
        let client = client.clone();
        async move {
            client
                .head(url)
                .send()
                .await
                .map(|r| r.status().as_u16() < 500)
                .unwrap_or(false)
        }
    };
    let zotero = check("https://api.zotero.org", &client).await;
    let unpaywall = check("https://api.unpaywall.org", &client).await;

    let message = if zotero && unpaywall {
        "代理可用：Zotero 与 Unpaywall 均可达".to_string()
    } else if zotero || unpaywall {
        "部分可达：请确认代理软件正在运行且端口正确".to_string()
    } else {
        "均不可达：请确认代理软件正在运行且端口正确（应用级代理即可，无需 TUN）".to_string()
    };
    Ok(ProxyTestResult { zotero, unpaywall, message })
}
