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

// ─── Phase C：扫描件引擎通道（复用 papers_converter sidecar）───

#[derive(Debug, Clone, serde::Serialize)]
pub struct OcrOutcome {
    pub ok: bool,
    pub md_path: Option<String>,
    pub chars: Option<u64>,
    pub error: Option<String>,
}

/// MarkItDown 提取为空/失败时的引擎兜底：papers_converter 一次性解析
/// （MinerU 优先、PaddleOCR 兜底——token 由前端按设置页配置择一传入）。
/// 不走论文导入流（不写 pending-done、不发进度事件），产物只落在附件目录。
#[tauri::command]
pub async fn ocr_pdf_for_attachment(
    app: AppHandle,
    pdf_path: String,
    output_dir: String,
    engine: String,
    mineru_token: Option<String>,
    paddleocr_token: Option<String>,
    llm_base_url: String,
    llm_api_key: String,
    llm_model: String,
) -> Result<OcrOutcome, String> {
    log::info!("[attachment-ocr] 引擎解析: {} (engine={})", pdf_path, engine);
    std::fs::create_dir_all(&output_dir).map_err(|e| format!("创建附件解析目录失败: {}", e))?;

    let mut args: Vec<String> = vec![
        pdf_path.clone(),
        "--headless".to_string(),
        "--output-dir".to_string(),
        output_dir.clone(),
    ];
    if engine != "paddleocr" {
        // paddleocr 是 sidecar 默认引擎（与 paper_converter.rs 同口径）
        args.push("--provider".to_string());
        args.push(engine.clone());
    }

    let command = app
        .shell()
        .sidecar("papers_converter")
        .map_err(|e| format!("无法创建引擎解析命令: {}", e))?
        .args(args)
        .envs(crate::core::mcp::proxy_spawn_env(&app))
        .env("MINERU_TOKEN", mineru_token.as_deref().unwrap_or(""))
        .env("PADDLEOCR_TOKEN", paddleocr_token.as_deref().unwrap_or(""))
        .env("GLM_OCR_API_KEY", "")
        .env("DEEPSEEK_BASE_URL", &llm_base_url)
        .env("DEEPSEEK_API_KEY", &llm_api_key)
        .env("DEEPSEEK_MODEL", &llm_model);

    let (mut rx, child) = command
        .spawn()
        .map_err(|e| format!("启动引擎解析进程失败: {}", e))?;
    crate::core::process_tree::assign_by_pid(child.pid());

    // 进度行只进日志（附件场景不驱动 UI 进度条；toasts 由 TS 侧给状态）
    let mut last_stderr = String::new();
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                log::debug!("[attachment-ocr] {}", String::from_utf8_lossy(&bytes).trim());
            }
            CommandEvent::Stderr(bytes) => {
                let s = String::from_utf8_lossy(&bytes).trim().to_string();
                if !s.is_empty() {
                    last_stderr = s.chars().take(300).collect();
                }
            }
            CommandEvent::Error(err) => {
                return Ok(OcrOutcome {
                    ok: false,
                    md_path: None,
                    chars: None,
                    error: Some(err),
                });
            }
            _ => {}
        }
    }

    // 产物定位：{output_dir}/{slug}/paper.md（与论文导入流同布局）
    let mut found: Option<std::path::PathBuf> = None;
    if let Ok(entries) = std::fs::read_dir(&output_dir) {
        for entry in entries.flatten() {
            let cand = entry.path().join("paper.md");
            if cand.is_file() {
                found = Some(cand);
                break;
            }
        }
    }
    match found {
        Some(p) => {
            let chars = std::fs::metadata(&p).ok().map(|m| m.len());
            Ok(OcrOutcome {
                ok: true,
                md_path: Some(p.to_string_lossy().to_string()),
                chars,
                error: None,
            })
        }
        None => Ok(OcrOutcome {
            ok: false,
            md_path: None,
            chars: None,
            error: Some(if last_stderr.is_empty() {
                "引擎解析结束但未产出 paper.md".to_string()
            } else {
                format!("引擎解析失败: {}", last_stderr)
            }),
        }),
    }
}
