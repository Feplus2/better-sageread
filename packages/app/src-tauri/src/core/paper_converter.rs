//! 单篇 PDF 论文解析：调用 Papers_Converter sidecar，流式回传进度。
//!
//! sidecar 以 headless 模式运行（`--headless`），向 stdout 逐行打印 JSON 进度
//! （start/progress/stage_done/done/error，与 Books_Converter 协议同构），本模块逐行解析并
//! 通过 `paper-convert://progress` 事件转发给前端。解析产物（paper.md + images/）落在
//! `{appData}/papers-converter/{slug}/`，入库由前端复用既有 save_paper 链路完成。
//! LLM 配置复用辅助模型（OpenAI 兼容端点），各引擎 Token 由前端设置项传入。

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

/// 保存当前正在运行的论文解析子进程，供取消使用
pub struct PaperConverterState {
    pub child: tokio::sync::Mutex<Option<tauri_plugin_shell::process::CommandChild>>,
}

impl Default for PaperConverterState {
    fn default() -> Self {
        Self {
            child: tokio::sync::Mutex::new(None),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperConvertParams {
    pub pdf_path: String,
    /// 解析引擎（None=sidecar 默认 paddleocr；"paddleocr"|"mineru"|"glm"）
    pub engine: Option<String>,
    pub mineru_token: Option<String>,
    pub paddleocr_token: Option<String>,
    pub glm_api_key: Option<String>,
    pub llm_base_url: String,
    pub llm_api_key: String,
    pub llm_model: String,
}

/// 启动单篇 PDF→paper.md 解析（异步，进度经 `paper-convert://progress` 事件回传）
#[tauri::command]
pub async fn convert_paper_pdf(app: AppHandle, params: PaperConvertParams) -> Result<(), String> {
    // 输出目录：应用数据目录下的 papers-converter/
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用目录失败: {}", e))?;
    let output_dir = app_data_dir.join("papers-converter");
    std::fs::create_dir_all(&output_dir).map_err(|e| format!("创建论文解析输出目录失败: {}", e))?;

    // 组装 CLI 参数
    let mut args: Vec<String> = vec![
        params.pdf_path.clone(),
        "--headless".to_string(),
        "--output-dir".to_string(),
        output_dir.to_string_lossy().to_string(),
    ];
    let engine = params.engine.as_deref().unwrap_or("paddleocr");
    // mineru-pipeline：MinerU pipeline 后端 + 不强制 OCR（文字版论文直取文本层——
    // 零幻觉、按整块裁图不拆子图；扫描版/疑难件仍用 vlm 或 paddleocr）
    let (engine, model, no_ocr) = match engine {
        "mineru-pipeline" => ("mineru", Some("pipeline"), true),
        other => (other, None, false),
    };
    if engine != "paddleocr" {
        // paddleocr 是 sidecar 默认引擎，显式参数只在非默认时传（保持默认行为面不变）
        args.push("--provider".to_string());
        args.push(engine.to_string());
    }
    if let Some(m) = model {
        args.push("--model".to_string());
        args.push(m.to_string());
    }
    if no_ocr {
        args.push("--no-ocr".to_string());
    }

    log::info!("[PaperConverter] 启动解析: {} (engine={})", params.pdf_path, engine);

    let command = app
        .shell()
        .sidecar("papers_converter")
        .map_err(|e| format!("无法创建论文解析命令: {}", e))?
        .args(args)
        .env("MINERU_TOKEN", params.mineru_token.as_deref().unwrap_or(""))
        .env("PADDLEOCR_TOKEN", params.paddleocr_token.as_deref().unwrap_or(""))
        .env("GLM_OCR_API_KEY", params.glm_api_key.as_deref().unwrap_or(""))
        .env("DEEPSEEK_BASE_URL", &params.llm_base_url)
        .env("DEEPSEEK_API_KEY", &params.llm_api_key)
        .env("DEEPSEEK_MODEL", &params.llm_model);

    let (mut rx, child) = command.spawn().map_err(|e| format!("启动论文解析进程失败: {}", e))?;

    // 保存子进程句柄以便取消
    {
        let state = app.state::<PaperConverterState>();
        *state.child.lock().await = Some(child);
    }

    let app_handle = app.clone();
    // 任务归属标识：随每条进度事件回传给前端，多任务并发时前端据此过滤（防串台）
    let pdf_path = params.pdf_path.clone();
    tauri::async_runtime::spawn(async move {
        let mut buffer = String::new();
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    buffer.push_str(&String::from_utf8_lossy(&bytes));
                    // 按行切分，逐行转发 JSON 进度
                    while let Some(pos) = buffer.find('\n') {
                        let line: String = buffer.drain(..=pos).collect();
                        let line = line.trim().to_string();
                        if line.is_empty() {
                            continue;
                        }
                        // 注入 pdf_path 任务标识；非 JSON 对象行（异常输出）按原样转发
                        let payload = match serde_json::from_str::<serde_json::Value>(&line) {
                            Ok(mut v) if v.is_object() => {
                                v["pdf_path"] = serde_json::Value::String(pdf_path.clone());
                                v.to_string()
                            }
                            _ => line,
                        };
                        let _ = app_handle.emit("paper-convert://progress", payload);
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    let msg = String::from_utf8_lossy(&bytes);
                    for l in msg.lines() {
                        let l = l.trim();
                        if !l.is_empty() {
                            log::info!("[PaperConverter] {}", l);
                        }
                    }
                }
                CommandEvent::Terminated(status) => {
                    let success = status.code == Some(0);
                    log::info!("[PaperConverter] 进程退出, code={:?}", status.code);
                    let payload =
                        serde_json::json!({"type":"terminated","success":success,"pdf_path":pdf_path}).to_string();
                    let _ = app_handle.emit("paper-convert://progress", payload);
                    break;
                }
                CommandEvent::Error(e) => {
                    log::error!("[PaperConverter] 进程错误: {}", e);
                    let payload = serde_json::json!({"type":"error","message":e,"pdf_path":pdf_path}).to_string();
                    let _ = app_handle.emit("paper-convert://progress", payload);
                    break;
                }
                _ => {}
            }
        }
        // 清理子进程句柄
        let state = app_handle.state::<PaperConverterState>();
        *state.child.lock().await = None;
    });

    Ok(())
}

/// 取消正在进行的论文解析
#[tauri::command]
pub async fn cancel_paper_convert(app: AppHandle) -> Result<(), String> {
    let state = app.state::<PaperConverterState>();
    let mut guard = state.child.lock().await;
    if let Some(child) = guard.take() {
        child.kill().map_err(|e| format!("取消论文解析失败: {}", e))?;
        log::info!("[PaperConverter] 已取消解析进程");
    }
    Ok(())
}
