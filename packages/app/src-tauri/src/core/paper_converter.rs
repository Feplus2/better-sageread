//! 单篇 PDF 论文解析：调用 Papers_Converter sidecar，流式回传进度。
//!
//! sidecar 以 headless 模式运行（`--headless`），向 stdout 逐行打印 JSON 进度
//! （start/progress/stage_done/done/error，与 Books_Converter 协议同构），本模块逐行解析并
//! 通过 `paper-convert://progress` 事件转发给前端。解析产物（paper.md + images/）落在
//! `{appData}/papers-converter/{slug}/`，入库由前端复用既有 save_paper 链路完成。
//! LLM 配置复用辅助模型（OpenAI 兼容端点），各引擎 Token 由前端设置项传入。

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

use crate::core::process_tree::kill_tree;

/// 已完成的解析产物快照（done 行落槽）：页面刷新窗口内 done 事件无人接收时，
/// 前端重启后经查 `paper_convert_status` 取回补做落库；消费成功后经
/// `clear_paper_convert_pending_done` 确认清除。
/// 同写 `{appData}/papers-converter/pending-done.json`——app 整体重启（内存槽丢失）也能恢复。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperConvertDone {
    pub pdf_path: String,
    pub paper_dir: String,
    pub title: Option<String>,
    pub slug: Option<String>,
    /// 缺省 false：容错读取旧版/手写缺字段文件（防整槽被静默丢弃）
    #[serde(default)]
    pub degenerate: bool,
    #[serde(default)]
    pub incomplete: bool,
}

/// 保存在跑的论文解析子进程（P3 有界并发：按 pdf_path 定向寻址取消/查询）
pub struct PaperConverterState {
    /// 在跑子进程句柄表：pdf_path → child（取消时定向取出树杀；进程收尾时移除）
    pub children: tokio::sync::Mutex<std::collections::HashMap<String, tauri_plugin_shell::process::CommandChild>>,
    /// 在跑任务的 pdf_path 集合（前端刷新恢复查询用；进程收尾时移除。
    /// 与 children 分离：取消只摘句柄，running 标识保留到 Terminated 收尾——
    /// 对齐旧 current_pdf「取消窗口内仍报在跑」语义）
    pub running_pdfs: tokio::sync::Mutex<std::collections::HashSet<String>>,
    /// 已完成但前端可能尚未消费的 done 产物（刷新恢复兜底槽；同 pdf_path 新 done 替换旧槽）
    pub pending_done: tokio::sync::Mutex<Vec<PaperConvertDone>>,
}

impl Default for PaperConverterState {
    fn default() -> Self {
        Self {
            children: tokio::sync::Mutex::new(std::collections::HashMap::new()),
            running_pdfs: tokio::sync::Mutex::new(std::collections::HashSet::new()),
            pending_done: tokio::sync::Mutex::new(Vec::new()),
        }
    }
}

// ---- pending_done 持久化（app 重启级恢复：内存槽随进程消失，落盘文件兜底） ----

fn pending_done_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("papers-converter").join("pending-done.json"))
}

/// 整表落盘（数组形态）；空表删文件（保持「无槽即无文件」口径，幂等）
fn persist_pending_done(app: &AppHandle, dones: &[PaperConvertDone]) {
    let Some(path) = pending_done_path(app) else { return };
    if dones.is_empty() {
        let _ = std::fs::remove_file(&path); // 不存在则报错，吞掉（幂等）
        return;
    }
    match serde_json::to_string(dones) {
        Ok(json) => {
            if let Err(e) = std::fs::write(&path, json) {
                log::warn!("[PaperConverter] pending_done 落盘失败: {}", e);
            }
        }
        Err(e) => log::warn!("[PaperConverter] pending_done 序列化失败: {}", e),
    }
}

/// 磁盘兜底读 pending_done：产物目录仍在的槽才认为可恢复；
/// 文件损坏 → 顺手清理返回空；部分槽产物目录已删 → 丢弃该槽（全废则删文件）。
/// 向后兼容：旧版单对象文件读作单元素数组（静默迁移，下次落盘即数组形态）。
fn load_pending_done_from_disk(app: &AppHandle) -> Vec<PaperConvertDone> {
    let Some(path) = pending_done_path(app) else { return Vec::new() };
    let Ok(raw) = std::fs::read_to_string(&path) else { return Vec::new() };
    let parsed = serde_json::from_str::<Vec<PaperConvertDone>>(&raw)
        .ok()
        .or_else(|| serde_json::from_str::<PaperConvertDone>(&raw).ok().map(|d| vec![d]));
    match parsed {
        Some(dones) => {
            let valid: Vec<PaperConvertDone> = dones
                .into_iter()
                .filter(|d| std::path::Path::new(&d.paper_dir).exists())
                .collect();
            if valid.is_empty() {
                let _ = std::fs::remove_file(&path);
            }
            valid
        }
        None => {
            let _ = std::fs::remove_file(&path);
            Vec::new()
        }
    }
}

/// 取 pending_done 内存槽的可变守卫；空则先从磁盘水合——重启窗口内磁盘是权威，
/// 否则变更（启动清槽/done 落槽/消费确认）会把磁盘上其它未消费槽整体冲掉
async fn hydrated_pending_done<'a>(
    app: &AppHandle,
    state: &'a PaperConverterState,
) -> tokio::sync::MutexGuard<'a, Vec<PaperConvertDone>> {
    let mut guard = state.pending_done.lock().await;
    if guard.is_empty() {
        *guard = load_pending_done_from_disk(app);
    }
    guard
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperConvertParams {
    pub pdf_path: String,
    /// 解析引擎（None=sidecar 默认 paddleocr；"paddleocr"|"mineru"|"mineru-pipeline"；GLM 已下线）
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

    // 孤儿防护：挂进全局 Job Object（app 退出/崩溃时整树陪葬；PyInstaller 孙进程默认随父入 Job）
    crate::core::process_tree::assign_by_pid(child.pid());

    // 保存子进程句柄以便定向取消；登记在跑任务标识（前端刷新恢复查询）；
    // 同 pdf_path 的滞留 done 槽作废（新解析产物将取代它），其它任务的槽保留
    {
        let state = app.state::<PaperConverterState>();
        state
            .children
            .lock()
            .await
            .insert(params.pdf_path.clone(), child);
        state.running_pdfs.lock().await.insert(params.pdf_path.clone());
        let mut pendings = hydrated_pending_done(&app, &state).await;
        pendings.retain(|d| d.pdf_path != params.pdf_path);
        persist_pending_done(&app, &pendings);
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
                                // done 行落槽：前端此刻若已刷新（事件无人接收），恢复时据此补落库
                                if v.get("type").and_then(|t| t.as_str()) == Some("done") {
                                    if let Some(dir) = v.get("paper_dir").and_then(|d| d.as_str()) {
                                        let done = PaperConvertDone {
                                            pdf_path: pdf_path.clone(),
                                            paper_dir: dir.to_string(),
                                            title: v
                                                .get("title")
                                                .and_then(|t| t.as_str())
                                                .map(|s| s.to_string()),
                                            slug: v
                                                .get("slug")
                                                .and_then(|s| s.as_str())
                                                .map(|s| s.to_string()),
                                            degenerate: v
                                                .get("degenerate")
                                                .and_then(|b| b.as_bool())
                                                .unwrap_or(false),
                                            incomplete: v
                                                .get("incomplete")
                                                .and_then(|b| b.as_bool())
                                                .unwrap_or(false),
                                        };
                                        let state = app_handle.state::<PaperConverterState>();
                                        // done 落槽：同 pdf_path 替换旧槽（重复 done 幂等），其它任务槽位不动
                                        let mut pendings = hydrated_pending_done(&app_handle, &state).await;
                                        pendings.retain(|d| d.pdf_path != done.pdf_path);
                                        pendings.push(done);
                                        persist_pending_done(&app_handle, &pendings);
                                    }
                                }
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
        // 清理子进程句柄与在跑任务标识（pending_done 有意保留：刷新窗口内丢的 done 由恢复逻辑消费）
        let state = app_handle.state::<PaperConverterState>();
        state.children.lock().await.remove(&pdf_path);
        state.running_pdfs.lock().await.remove(&pdf_path);
    });

    Ok(())
}

/// 取消正在进行的论文解析：pdf_path 定向取消（P3 多句柄）；None 取消全部（旧语义，幂等）。
/// 对同一 pdf_path 连发两次不报错——第二次摘不到句柄直接 Ok。
#[tauri::command]
pub async fn cancel_paper_convert(app: AppHandle, pdf_path: Option<String>) -> Result<(), String> {
    let state = app.state::<PaperConverterState>();
    let targets: Vec<tauri_plugin_shell::process::CommandChild> = {
        let mut guard = state.children.lock().await;
        match &pdf_path {
            Some(p) => guard.remove(p).into_iter().collect(),
            None => guard.drain().map(|(_, child)| child).collect(),
        }
    };
    for child in targets {
        // papers_converter.exe 是 PyInstaller 单文件包（bootloader 父 + 实际转换子进程）：
        // 只 kill 直接子进程（TerminateProcess）杀不掉孙进程，孤儿拖 30-60s 才退出。
        // 先 taskkill /T /F 杀整棵树，再 child.kill() 兜底收句柄；进程已退出的报错吞掉（幂等）。
        let pid = child.pid();
        kill_tree(pid).await;
        if let Err(e) = child.kill() {
            log::info!("[PaperConverter] kill 直接子进程返回（进程或已退出）: {}", e);
        }
        log::info!("[PaperConverter] 已取消解析进程 (pdf_path={:?})", pdf_path);
    }
    Ok(())
}

/// 解析通道状态查询（前端页面刷新后的恢复探测）：
/// running_pdf_paths = 仍在跑的解析任务；pending_dones = 已完成但可能未被消费的产物。
/// pdf_path 给了则定向过滤（只回该篇的在跑/滞留），None 返回全部。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperConvertStatus {
    pub running_pdf_paths: Vec<String>,
    pub pending_dones: Vec<PaperConvertDone>,
}

#[tauri::command]
pub async fn paper_convert_status(app: AppHandle, pdf_path: Option<String>) -> Result<PaperConvertStatus, String> {
    let state = app.state::<PaperConverterState>();
    let mut running: Vec<String> = state.running_pdfs.lock().await.iter().cloned().collect();
    running.sort(); // HashSet 无序，排序保稳定输出（恢复链路逐条 occupy 顺序确定）
    // 内存槽优先；空则读磁盘兜底（app 整体重启后恢复场景）
    let pending = {
        let mem = state.pending_done.lock().await.clone();
        if mem.is_empty() {
            load_pending_done_from_disk(&app)
        } else {
            mem
        }
    };
    let (running_pdf_paths, pending_dones) = match pdf_path {
        Some(p) => (
            running.into_iter().filter(|r| r == &p).collect(),
            pending.into_iter().filter(|d| d.pdf_path == p).collect(),
        ),
        None => (running, pending),
    };
    Ok(PaperConvertStatus {
        running_pdf_paths,
        pending_dones,
    })
}

/// 前端消费（import/replace）成功后确认清除 pending_done 槽（幂等；内存+磁盘双清）：
/// pdf_path 定向清除该篇槽位；None 清空全部（旧语义）
#[tauri::command]
pub async fn clear_paper_convert_pending_done(app: AppHandle, pdf_path: Option<String>) -> Result<(), String> {
    let state = app.state::<PaperConverterState>();
    let mut pendings = hydrated_pending_done(&app, &state).await;
    match &pdf_path {
        Some(p) => pendings.retain(|d| d.pdf_path != *p),
        None => pendings.clear(),
    }
    persist_pending_done(&app, &pendings);
    Ok(())
}
