//! MarkItDown sidecar（附件 Phase B，2026-09-17）：一次性 文件 → Markdown（LLM 友好）。
//! 协议：stdout 逐行 JSON（与 books_converter 同款行协议），终态一行 {"type":"done",...}，
//! 进程恒 0 退出，成败看 JSON。孤儿防护挂全局 Job Object（与 converter.rs 同款）。

use serde::Deserialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

#[derive(Debug, Clone, serde::Serialize)]
pub struct MarkitdownOutcome {
    pub ok: bool,
    pub output: Option<String>,
    pub chars: Option<u64>,
    pub warnings: Vec<String>,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DoneLine {
    ok: bool,
    output: Option<String>,
    chars: Option<u64>,
    warnings: Option<Vec<String>>,
    error: Option<String>,
}

#[tauri::command]
pub async fn convert_file_markitdown(
    app: AppHandle,
    input_path: String,
    output_path: String,
) -> Result<MarkitdownOutcome, String> {
    log::info!("[markitdown] 转换: {}", input_path);
    let command = app
        .shell()
        .sidecar("sageread_markitdown")
        .map_err(|e| format!("无法创建 MarkItDown 命令: {}", e))?
        .args([&input_path, "--output", &output_path]);

    let (mut rx, child) = command
        .spawn()
        .map_err(|e| format!("启动 MarkItDown 进程失败: {}", e))?;

    // 孤儿防护：挂进全局 Job Object（app 退出/崩溃时整树陪葬）
    crate::core::process_tree::assign_by_pid(child.pid());

    let mut last_error: Option<String> = None;
    let mut done: Option<MarkitdownOutcome> = None;
    let mut buffer = String::new();

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                buffer.push_str(&String::from_utf8_lossy(&bytes));
                while let Some(pos) = buffer.find('\n') {
                    let line: String = buffer.drain(..=pos).collect();
                    let line = line.trim().to_string();
                    if line.is_empty() {
                        continue;
                    }
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                        if v.get("type").and_then(|t| t.as_str()) == Some("done") {
                            match serde_json::from_value::<DoneLine>(v) {
                                Ok(d) => {
                                    done = Some(MarkitdownOutcome {
                                        ok: d.ok,
                                        output: d.output,
                                        chars: d.chars,
                                        warnings: d.warnings.unwrap_or_default(),
                                        error: d.error,
                                    });
                                }
                                Err(e) => log::warn!("[markitdown] 终态行解析失败: {}", e),
                            }
                        }
                    }
                }
            }
            CommandEvent::Stderr(bytes) => {
                // pydub ffmpeg 警告等噪声只进 debug 日志
                log::debug!("[markitdown] {}", String::from_utf8_lossy(&bytes).trim());
            }
            CommandEvent::Error(err) => last_error = Some(err),
            _ => {}
        }
    }

    if let Some(d) = done {
        return Ok(d);
    }
    Err(last_error.unwrap_or_else(|| "MarkItDown 进程异常退出（无终态行）".to_string()))
}
