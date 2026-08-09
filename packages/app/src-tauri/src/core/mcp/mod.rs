//! MCP stdio 子进程桥（批次 D1）：为本地 npm/uvx 类 MCP server 提供 stdio 传输。
//!
//! 命令：`mcp_stdio_start` / `mcp_stdio_write` / `mcp_stdio_close`。
//! - stdout 逐行 → `app.emit("mcp-stdio://{session_id}", line)` 推前端；
//! - stderr 逐行进审计日志（{appData}/agent-audit/mcp-stdio.jsonl，A5 脱敏）；
//! - 进程退出 → emit `mcp-stdio-exit://{session_id}`（{ code }）。
//! - env 值先 `resolve_secret_refs` 替换 `{{secret:NAME}}` 再注入（A3：真值不进 JS）；
//!   并按 proxy.json（F3-1 设置页写入）注入 HTTP_PROXY/HTTPS_PROXY/NO_PROXY/NODE_USE_ENV_PROXY（F3-2）。
//! - Windows：`npx`/`uvx` 实为 .cmd，用 `cmd /C` 包裹；CREATE_NO_WINDOW 防黑窗；
//!   全部子进程挂 Job Object（KILL_ON_JOB_CLOSE）防孤儿；close 用 `taskkill /T` 杀整棵进程树。
//! - app 退出：lib.rs CloseRequested 调 `close_all_sessions` 全部回收。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

struct McpSession {
    child: Child,
    stdin: ChildStdin,
    /** 展示名（审计/日志用） */
    label: String,
    pid: u32,
}

#[derive(Default)]
pub struct McpStdioState {
    sessions: Arc<Mutex<HashMap<String, Arc<Mutex<McpSession>>>>>,
}

// ---- Windows：Job Object（孤儿进程防护） ----

#[cfg(windows)]
mod job {
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    // HANDLE 是裸指针（非 Send/Sync），以 usize 存 OnceLock
    static JOB: OnceLock<usize> = OnceLock::new();

    /// 全局 Job Object：最后一个句柄关闭（app 退出）时杀死全部挂靠进程
    fn global_job() -> HANDLE {
        let stored = *JOB.get_or_init(|| unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if !job.is_null() {
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const std::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
            }
            job as usize
        });
        stored as HANDLE
    }

    /// 按 pid 挂靠 Job（best-effort，失败仅意味着该进程失去孤儿防护）
    pub fn assign_by_pid(pid: u32) {
        unsafe {
            let job = global_job();
            if job.is_null() {
                return;
            }
            let handle = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if handle.is_null() {
                return;
            }
            AssignProcessToJobObject(job, handle);
            CloseHandle(handle);
        }
    }
}

/// 杀整棵进程树：Windows 经 cmd /C 包裹时，kill 直接子进程杀不掉 node/uvx 孙进程
#[cfg(windows)]
async fn kill_tree(pid: u32) {
    let _ = Command::new("taskkill")
        .args(["/F", "/T", "/PID", &pid.to_string()])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .await;
}

// ---- 审计日志（A5：写盘前脱敏） ----

fn audit_line(app: &AppHandle, server: &str, kind: &str, text: &str) {
    let write = || -> Result<(), String> {
        use std::io::Write;
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("agent-audit");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let line = serde_json::json!({
            "ts": chrono::Utc::now().to_rfc3339(),
            "server": server,
            "kind": kind,
            "text": crate::core::secrets::redact_secrets(text),
        });
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("mcp-stdio.jsonl"))
            .map_err(|e| e.to_string())?;
        writeln!(file, "{line}").map_err(|e| e.to_string())?;
        Ok(())
    };
    if let Err(e) = write() {
        log::warn!("[mcp-stdio] 写审计日志失败: {e}");
    }
}

// ---- F3-2：代理 env 注入（配置由批次 F3-1 设置页写入 {config_dir}/proxy.json） ----

fn proxy_spawn_env(app: &AppHandle) -> Vec<(String, String)> {
    let Ok(dir) = app.path().app_config_dir() else {
        return vec![];
    };
    let Ok(text) = std::fs::read_to_string(dir.join("proxy.json")) else {
        return vec![];
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return vec![];
    };
    let mode = value.get("mode").and_then(|m| m.as_str()).unwrap_or("off");
    let ensure_scheme = |u: &str| if u.contains("://") { u.to_string() } else { format!("http://{u}") };
    match mode {
        "custom" => {
            let Some(url) = value
                .get("url")
                .and_then(|u| u.as_str())
                .map(str::trim)
                .filter(|u| !u.is_empty())
            else {
                return vec![];
            };
            let url = ensure_scheme(url);
            vec![
                ("HTTP_PROXY".into(), url.clone()),
                ("HTTPS_PROXY".into(), url),
                ("NO_PROXY".into(), "localhost,127.0.0.1".into()),
                // Node ≥22.21 才生效（npx 系 server 必需）
                ("NODE_USE_ENV_PROXY".into(), "1".into()),
            ]
        }
        // follow-env：子进程默认继承父 env 的 HTTP(S)_PROXY，只补 NO_PROXY 与 Node 开关
        "follow-env" => vec![
            ("NO_PROXY".into(), "localhost,127.0.0.1".into()),
            ("NODE_USE_ENV_PROXY".into(), "1".into()),
        ],
        _ => vec![],
    }
}

// ---- Tauri 命令 ----

/// 启动 MCP stdio 子进程。env 值支持 `{{secret:NAME}}`（Rust 侧替换，真值不进 JS）。
#[tauri::command]
pub async fn mcp_stdio_start(
    app: AppHandle,
    state: State<'_, McpStdioState>,
    server_id: String,
    command: String,
    args: Option<Vec<String>>,
    env: Option<HashMap<String, String>>,
) -> Result<String, String> {
    let command = command.trim().to_string();
    if command.is_empty() {
        return Err("缺少 command 配置".into());
    }
    let args = args.unwrap_or_default();

    // env：先做 {{secret:NAME}} 替换（A3），再叠加代理注入（F3-2）
    let mut resolved_env: Vec<(String, String)> = Vec::new();
    for (key, value) in env.unwrap_or_default() {
        let resolved = crate::core::secrets::resolve_secret_refs(&app, &value)
            .map_err(|e| format!("环境变量 {key}：{e}"))?;
        resolved_env.push((key, resolved));
    }
    resolved_env.extend(proxy_spawn_env(&app));

    // 构建命令：Windows 下裸命令（npx/uvx 等 .cmd）需 cmd /C 包裹
    let mut cmd = {
        #[cfg(windows)]
        {
            let is_direct_exe = std::path::Path::new(&command)
                .extension()
                .map(|e| e.eq_ignore_ascii_case("exe"))
                .unwrap_or(false);
            if is_direct_exe {
                let mut c = Command::new(&command);
                c.args(&args);
                c
            } else {
                let mut c = Command::new("cmd");
                c.arg("/C").arg(&command).args(&args);
                c
            }
        }
        #[cfg(not(windows))]
        {
            let mut c = Command::new(&command);
            c.args(&args);
            c
        }
    };
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    for (key, value) in &resolved_env {
        cmd.env(key, value);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动「{command}」失败：{e}（请确认命令已安装且在 PATH 中）"))?;
    let pid = child.id().unwrap_or(0);
    #[cfg(windows)]
    if pid > 0 {
        job::assign_by_pid(pid);
    }

    let stdin = child.stdin.take().ok_or("无法打开子进程 stdin")?;
    let stdout = child.stdout.take().ok_or("无法打开子进程 stdout")?;
    let stderr = child.stderr.take().ok_or("无法打开子进程 stderr")?;

    let session_id = uuid::Uuid::new_v4().to_string();
    let label = server_id.clone();
    let session = Arc::new(Mutex::new(McpSession {
        child,
        stdin,
        label: label.clone(),
        pid,
    }));
    state.sessions.lock().await.insert(session_id.clone(), session.clone());

    // stdout：逐行推前端
    let app_out = app.clone();
    let sid_out = session_id.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    if !line.trim().is_empty() {
                        let _ = app_out.emit(&format!("mcp-stdio://{sid_out}"), line);
                    }
                }
                _ => break,
            }
        }
    });

    // stderr：逐行进审计日志（脱敏）
    let app_err = app.clone();
    let label_err = label.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    if !line.trim().is_empty() {
                        audit_line(&app_err, &label_err, "stderr", &line);
                        // stderr 可能带 server 打印的密钥/令牌，进日志前同样脱敏（与审计 jsonl 口径一致）
                        log::debug!("[mcp-stdio][{}] stderr: {}", label_err, crate::core::secrets::redact_secrets(&line));
                    }
                }
                _ => break,
            }
        }
    });

    // 退出监视：try_wait 轮询（child 已入 session，无法另持句柄 wait）
    let app_w = app.clone();
    let sessions_w = state.sessions.clone();
    let sid_w = session_id.clone();
    let session_w = session.clone();
    let label_w = label.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(300)).await;
            let exited = {
                let mut s = session_w.lock().await;
                match s.child.try_wait() {
                    Ok(status) => status.map(|st| st.code()),
                    Err(_) => Some(None),
                }
            };
            let Some(code) = exited else { continue };
            sessions_w.lock().await.remove(&sid_w);
            audit_line(&app_w, &label_w, "exit", &format!("code={code:?}"));
            let _ = app_w.emit(&format!("mcp-stdio-exit://{sid_w}"), serde_json::json!({ "code": code }));
            break;
        }
    });

    audit_line(
        &app,
        &label,
        "start",
        &format!("pid={pid} command={command} args={}", args.join(" ")),
    );
    Ok(session_id)
}

/// 向子进程 stdin 写一行 JSON-RPC（换行结尾）
#[tauri::command]
pub async fn mcp_stdio_write(
    state: State<'_, McpStdioState>,
    session_id: String,
    message: String,
) -> Result<(), String> {
    let Some(session) = state.sessions.lock().await.get(&session_id).cloned() else {
        return Err("MCP stdio 会话不存在（进程可能已退出）".into());
    };
    let mut s = session.lock().await;
    let mut bytes = message.into_bytes();
    if !bytes.ends_with(b"\n") {
        bytes.push(b'\n');
    }
    s.stdin.write_all(&bytes).await.map_err(|e| format!("写入 stdin 失败：{e}"))?;
    s.stdin.flush().await.map_err(|e| format!("flush stdin 失败：{e}"))?;
    Ok(())
}

/// 关闭会话：杀进程树 + 回收（幂等，会话可能已被退出监视移除）
#[tauri::command]
pub async fn mcp_stdio_close(state: State<'_, McpStdioState>, session_id: String) -> Result<(), String> {
    if let Some(session) = state.sessions.lock().await.remove(&session_id) {
        let mut s = session.lock().await;
        #[cfg(windows)]
        if s.pid > 0 {
            kill_tree(s.pid).await;
        }
        let _ = s.child.kill().await;
    }
    Ok(())
}

/// app 退出清理（lib.rs CloseRequested 调用）：全部会话 kill + 回收
pub async fn close_all_sessions(app: &AppHandle) {
    let Some(state) = app.try_state::<McpStdioState>() else {
        return;
    };
    let ids: Vec<String> = state.sessions.lock().await.keys().cloned().collect();
    for id in ids {
        if let Some(session) = state.sessions.lock().await.remove(&id) {
            let mut s = session.lock().await;
            log::info!("[mcp-stdio] 退出清理：关闭会话 {}（pid={}）", s.label, s.pid);
            #[cfg(windows)]
            if s.pid > 0 {
                kill_tree(s.pid).await;
            }
            let _ = s.child.kill().await;
        }
    }
}
