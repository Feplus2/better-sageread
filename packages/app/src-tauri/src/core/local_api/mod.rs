//! I2：sageread-mcp 本地通道（密钥绝不出 app 进程）。
//!
//! app 启动时起 localhost-only 迷你 HTTP 服务（随机端口），把 `{port, token}` 写入
//! `{appData}/mcp-local.json`；外部 MCP 进程（Claude Desktop 等拉起的 sageread-mcp）
//! 凭 token 调用：
//! - `GET  /health`：存活探测（不需要 token）
//! - `POST /embed`  ：查询文本 → 向量。app 用当前选中向量模型 + keyring 密钥执行嵌入，
//!   只回结果——MCP 进程全程不接触任何密钥。
//!
//! 手搓 HTTP 解析（仅两个端点、本机回环、单客户端），避免引入 axum 等重依赖。

use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

const MAX_HEAD: usize = 64 * 1024;
const MAX_BODY: usize = 2 * 1024 * 1024;

fn respond(stream: &mut TcpStream, status: u16, body: &Value) {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        405 => "Method Not Allowed",
        413 => "Payload Too Large",
        _ => "Internal Server Error",
    };
    let body_str = body.to_string();
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body_str.as_bytes().len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body_str.as_bytes());
    let _ = stream.flush();
}

/// 读取最小 HTTP 请求：返回 (method, path, headers, body)
fn read_request(stream: &mut TcpStream) -> Option<(String, String, String, Vec<u8>)> {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 2048];
    let header_end;
    loop {
        let n = stream.read(&mut tmp).ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&tmp[..n]);
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            header_end = pos + 4;
            break;
        }
        if buf.len() > MAX_HEAD {
            return None;
        }
    }
    let head = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let first = head.lines().next()?;
    let mut it = first.split_whitespace();
    let method = it.next()?.to_string();
    let path = it.next()?.to_string();
    let content_len: usize = head
        .lines()
        .find(|l| l.to_ascii_lowercase().starts_with("content-length:"))
        .and_then(|l| l.split(':').nth(1))
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(0);
    if content_len > MAX_BODY {
        return None;
    }
    let mut body = buf[header_end..].to_vec();
    while body.len() < content_len {
        let n = stream.read(&mut tmp).ok()?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&tmp[..n]);
    }
    Some((method, path, head, body))
}

/// 解析当前选中的外部向量模型配置（llama-store.json 落盘 apiKey 恒空，密钥另从 keyring 取）
fn resolve_vector_config(app: &AppHandle) -> Result<(String, String, String), String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("llama-store.json");
    let raw =
        std::fs::read_to_string(&path).map_err(|_| "读取向量模型配置失败（llama-store.json）".to_string())?;
    let store: Value = serde_json::from_str(&raw).map_err(|e| format!("解析向量模型配置失败: {e}"))?;
    let state = store.get("state").ok_or("向量模型配置缺少 state")?;
    if state.get("vectorModelEnabled").and_then(|v| v.as_bool()) != Some(true) {
        return Err("未启用外部向量模型，请先在 SageRead 设置中配置".into());
    }
    let selected = state
        .get("selectedVectorModelId")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or("未选择向量模型，请先在 Better SageRead 设置中选择")?;
    let model = state
        .get("vectorModels")
        .and_then(|v| v.as_array())
        .and_then(|arr| {
            arr.iter()
                .find(|m| m.get("id").and_then(|i| i.as_str()) == Some(selected))
        })
        .ok_or("选中的向量模型配置不存在")?;
    let url = model
        .get("url")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or("向量模型 URL 为空")?
        .trim_end_matches('/')
        .to_string();
    let model_id = model
        .get("modelId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    // 密钥走 keyring（批次 A），绝不读落盘文件
    let api_key = crate::core::secrets::get_secret(app, "vector-model", selected)?.unwrap_or_default();
    Ok((url, model_id, api_key))
}

/// 执行单条嵌入（镜像前端两种协议：Ollama /api/embed 与 OpenAI 兼容 /v1/embeddings）
fn embed_text(url: &str, model_id: &str, api_key: &str, text: &str) -> Result<Vec<f64>, String> {
    let is_ollama = url.ends_with("/api/embed");
    let body = if is_ollama {
        json!({ "model": model_id, "input": text })
    } else {
        json!({ "input": [text], "model": model_id, "encoding_format": "float" })
    };
    // reqwest blocking client（每次新建，调用频率低，无需池化）
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("创建嵌入客户端失败: {e}"))?;
    let mut builder = client.post(url).header("Content-Type", "application/json");
    if !api_key.is_empty() {
        builder = builder.header("Authorization", format!("Bearer {api_key}"));
    }
    let res = builder
        .json(&body)
        .send()
        .map_err(|e| format!("嵌入请求失败: {e}"))?;
    if !res.status().is_success() {
        let status = res.status().as_u16();
        let body = res.text().unwrap_or_default();
        return Err(format!("嵌入接口返回 HTTP {status}: {body}"));
    }
    let json: Value = res.json().map_err(|e| format!("解析嵌入响应失败: {e}"))?;
    let arr = if is_ollama {
        json.get("embeddings").and_then(|v| v.as_array()).and_then(|a| a.first())
    } else {
        json.get("data")
            .and_then(|v| v.as_array())
            .and_then(|a| a.first())
            .and_then(|d| d.get("embedding"))
    };
    let vec: Vec<f64> = arr
        .and_then(|v| v.as_array())
        .ok_or("嵌入响应缺少向量数据")?
        .iter()
        .filter_map(|n| n.as_f64())
        .collect();
    if vec.is_empty() {
        return Err("嵌入响应向量为空".into());
    }
    Ok(vec)
}

fn handle_conn(app: AppHandle, token: String, stream: &mut TcpStream) {
    let Some((method, path, head, body)) = read_request(stream) else {
        return;
    };

    // 存活探测：无需 token（MCP 进程据此判断 app 是否运行）
    if method == "GET" && path == "/health" {
        respond(stream, 200, &json!({ "ok": true, "app": "sageread" }));
        return;
    }

    // 其余端点一律校验 token（Authorization: Bearer {token}）
    let auth_ok = head
        .lines()
        .find(|l| l.to_ascii_lowercase().starts_with("authorization:"))
        .and_then(|l| l.split(':').nth(1))
        .map(|v| v.trim() == format!("Bearer {token}"))
        .unwrap_or(false);
    if !auth_ok {
        audit_local_api(
            &app,
            json!({
                "ts": chrono::Utc::now().to_rfc3339(),
                "kind": "auth-fail",
                "method": method,
                "path": crate::core::secrets::redact_secrets(&path),
            }),
        );
        respond(stream, 401, &json!({ "error": "unauthorized" }));
        return;
    }

    if method == "POST" && path == "/embed" {
        let text = serde_json::from_slice::<Value>(&body)
            .ok()
            .and_then(|v| v.get("text").and_then(|t| t.as_str()).map(|s| s.to_string()))
            .filter(|s| !s.is_empty());
        let Some(text) = text else {
            respond(stream, 400, &json!({ "error": "missing text" }));
            return;
        };
        let outcome =
            match resolve_vector_config(&app) {
                Ok((url, model_id, api_key)) => {
                    embed_text(&url, &model_id, &api_key, &text).map(|vector| (model_id, vector))
                }
                Err(e) => Err(e),
            };
        // I2 审计：记长度与前 80 字符预览（嵌入文本可能是书摘，不全文落盘），写盘前脱敏
        let preview: String = text.chars().take(80).collect();
        audit_local_api(
            &app,
            json!({
                "ts": chrono::Utc::now().to_rfc3339(),
                "kind": "embed",
                "chars": text.chars().count(),
                "preview": crate::core::secrets::redact_secrets(&preview),
                "ok": outcome.is_ok(),
                "error": outcome.as_ref().err().map(|e| crate::core::secrets::redact_secrets(e)),
            }),
        );
        match outcome {
            Ok((model_id, vector)) => {
                let dimension = vector.len();
                respond(stream, 200, &json!({ "vector": vector, "model": model_id, "dimension": dimension }));
            }
            Err(e) => respond(stream, 500, &json!({ "error": e })),
        }
        return;
    }

    if method == "POST" || method == "GET" {
        respond(stream, 404, &json!({ "error": "not found" }));
    } else {
        respond(stream, 405, &json!({ "error": "method not allowed" }));
    }
}

/// I2 审计：{appData}/agent-audit/local-api.jsonl（与 mcp-stdio 审计同目录，写盘前已脱敏）
fn audit_local_api(app: &AppHandle, entry: Value) {
    let write = || -> Result<(), String> {
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("agent-audit");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("local-api.jsonl"))
            .map_err(|e| e.to_string())?;
        writeln!(file, "{entry}").map_err(|e| e.to_string())?;
        Ok(())
    };
    if let Err(e) = write() {
        log::warn!("[local-api] 写审计日志失败: {e}");
    }
}

/// 写敏感文件并尽量收紧权限：Unix 0600（含已存在文件的权限回填）；Windows 走用户目录默认 ACL
fn write_restrictive(path: &std::path::Path, content: String) -> Result<(), String> {
    let mut opts = std::fs::OpenOptions::new();
    opts.create(true).write(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts
        .open(path)
        .map_err(|e| format!("写入 {} 失败: {e}", path.display()))?;
    f.write_all(content.as_bytes())
        .map_err(|e| format!("写入 {} 失败: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

#[tauri::command]
pub async fn start_local_api(app: AppHandle) -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("本地通道绑定失败: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token = Uuid::new_v4().to_string();

    // 外部 MCP 进程从这里读 port+token（Unix 0600；Windows 依赖用户目录默认 ACL）
    let file = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("mcp-local.json");
    write_restrictive(&file, json!({ "port": port, "token": token }).to_string())?;

    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let mut stream = stream;
            let app = app.clone();
            let token = token.clone();
            std::thread::spawn(move || {
                handle_conn(app, token, &mut stream);
            });
        }
    });

    Ok(port)
}
