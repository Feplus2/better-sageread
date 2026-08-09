use super::{display_path, guard, resolve_root, GuardVerdict};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::io::AsyncReadExt;

// ---- 共享常量 ----
/// 读取：单文件大小上限（防御超大二进制/数据集文件）
const READ_MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
/// 读取：单次返回行数上限 / 字节上限 / 单行字符上限
const READ_MAX_LINES: usize = 2000;
const READ_MAX_OUT_BYTES: usize = 200_000;
const READ_MAX_LINE_CHARS: usize = 2000;
/// 搜索：glob 结果上限 / grep 命中上限 / grep 单文件大小上限
const GLOB_MAX_MATCHES: usize = 200;
const GREP_MAX_MATCHES: usize = 100;
const GREP_MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
/// 命令执行：默认/最大超时（秒），输出双侧各截断字符数
const RUN_DEFAULT_TIMEOUT_SECS: u64 = 120;
const RUN_MAX_TIMEOUT_SECS: u64 = 600;
const RUN_MAX_OUTPUT_CHARS: usize = 20_000;
/// 遍历时跳过的目录名（工作区可能指向用户项目夹）
const SKIP_DIRS: [&str; 3] = [".git", "node_modules", "__pycache__"];
/// 敏感路径 denylist（A4，全模式生效，不可被 allow_outside 覆盖）：命中即拒读
const DENY_EXACT_NAMES: [&str; 5] = [
    "model-provider.json",
    "llama-store.json",
    "converter-store.json",
    "mcp-servers.json",
    "webdav-config.json",
];

/// 敏感路径判定：凭据类 JSON / 证书私钥 / .env（纵深防御，迁移后这些 JSON 已无 key 仍保留）
fn is_denied_path(resolved: &str) -> bool {
    let path = Path::new(resolved);
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let lower = file_name.to_ascii_lowercase();
    if DENY_EXACT_NAMES.contains(&lower.as_str()) {
        return true;
    }
    if lower.ends_with(".pem") || lower.ends_with(".key") {
        return true;
    }
    if lower == "id_rsa" || lower.starts_with("id_rsa.") {
        return true;
    }
    if lower == ".env" || lower.starts_with(".env.") {
        return true;
    }
    false
}

const DENY_MESSAGE: &str = "该文件可能包含凭据，已由安全策略拦截";

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let kept: String = s.chars().take(max).collect();
    format!("{}…[截断]", kept)
}

// ---- agent_resolve_path ----

#[tauri::command]
pub fn agent_resolve_path(
    app: AppHandle,
    root: Option<String>,
    path: String,
) -> Result<GuardVerdict, String> {
    let root = resolve_root(&app, &root)?;
    Ok(guard(&root, &path))
}

// ---- agent_read_file ----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadResult {
    pub resolved: String,
    pub total_lines: usize,
    pub truncated: bool,
    pub content: String,
}

#[tauri::command]
pub fn agent_read_file(
    app: AppHandle,
    root: Option<String>,
    path: String,
    offset: Option<usize>,
    limit: Option<usize>,
    allow_outside: Option<bool>,
) -> Result<ReadResult, String> {
    let root = resolve_root(&app, &root)?;
    let v = guard(&root, &path);
    // A4：Rust 侧补界外拦截（默认拒绝；allow_outside 由 tool-guard 按模式注入，不进模型 schema）
    if v.verdict == "out" && allow_outside != Some(true) {
        return Err(format!("路径在工作区外且未经用户确认: {}", v.resolved));
    }
    // A4：敏感路径 denylist（全模式生效，不可被 allow_outside 覆盖）
    if is_denied_path(&v.resolved) {
        return Err(DENY_MESSAGE.to_string());
    }
    if !v.exists || v.is_dir {
        return Err(format!("文件不存在或是目录: {}", v.resolved));
    }
    let meta = std::fs::metadata(&v.resolved).map_err(|e| format!("读取文件元信息失败: {}", e))?;
    if meta.len() > READ_MAX_FILE_BYTES {
        return Err(format!("文件过大（>8MB），请改用 searchFiles 定位片段: {}", v.resolved));
    }
    let raw = std::fs::read(&v.resolved).map_err(|e| format!("读取文件失败: {}", e))?;
    let text = String::from_utf8_lossy(&raw);
    let lines: Vec<&str> = text.lines().collect();
    let total_lines = lines.len();

    let offset = offset.unwrap_or(1).max(1); // 1-based
    let limit = limit.unwrap_or(READ_MAX_LINES).min(READ_MAX_LINES);
    let start = (offset - 1).min(total_lines);
    let end = (start + limit).min(total_lines);

    let mut content = String::new();
    let mut truncated = end < total_lines;
    for (i, line) in lines[start..end].iter().enumerate() {
        let line_no = start + i + 1;
        content.push_str(&format!("{}\t{}\n", line_no, truncate_chars(line, READ_MAX_LINE_CHARS)));
        if content.len() > READ_MAX_OUT_BYTES {
            truncated = true;
            break;
        }
    }

    Ok(ReadResult {
        resolved: v.resolved,
        total_lines,
        truncated,
        content,
    })
}

// ---- agent_write_file ----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub resolved: String,
    pub bytes: usize,
    pub created: bool,
}

#[tauri::command]
pub fn agent_write_file(
    app: AppHandle,
    root: Option<String>,
    path: String,
    content: String,
    allow_outside: bool,
) -> Result<WriteResult, String> {
    let root = resolve_root(&app, &root)?;
    let v = guard(&root, &path);
    if v.verdict == "out" && !allow_outside {
        return Err(format!("路径在工作区外且未经用户确认: {}", v.resolved));
    }
    if v.is_dir {
        return Err(format!("目标是目录，无法写入: {}", v.resolved));
    }
    let target = PathBuf::from(&v.resolved);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建父目录失败: {}", e))?;
    }
    let created = !v.exists;
    let bytes = content.len();
    std::fs::write(&target, content).map_err(|e| format!("写入文件失败: {}", e))?;
    Ok(WriteResult {
        resolved: v.resolved,
        bytes,
        created,
    })
}

// ---- agent_edit_file ----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditResult {
    pub resolved: String,
    pub replacements: usize,
}

#[tauri::command]
pub fn agent_edit_file(
    app: AppHandle,
    root: Option<String>,
    path: String,
    old_string: String,
    new_string: String,
    replace_all: bool,
    allow_outside: bool,
) -> Result<EditResult, String> {
    let root = resolve_root(&app, &root)?;
    let v = guard(&root, &path);
    if v.verdict == "out" && !allow_outside {
        return Err(format!("路径在工作区外且未经用户确认: {}", v.resolved));
    }
    if !v.exists || v.is_dir {
        return Err(format!("文件不存在或是目录: {}", v.resolved));
    }
    if old_string.is_empty() {
        return Err("oldString 不能为空".to_string());
    }
    let raw = std::fs::read(&v.resolved).map_err(|e| format!("读取文件失败: {}", e))?;
    let content =
        String::from_utf8(raw).map_err(|_| format!("文件不是有效 UTF-8，无法用 editFile 编辑: {}", v.resolved))?;

    let matches = content.matches(&old_string).count();
    if matches == 0 {
        return Err(format!(
            "未找到匹配内容。请确认 oldString 与文件完全一致（含缩进与换行）；可先用 readFile 核对: {}",
            v.resolved
        ));
    }
    if matches > 1 && !replace_all {
        return Err(format!(
            "oldString 命中 {} 处，非唯一。请扩大范围使其唯一，或设 replaceAll=true 全部替换",
            matches
        ));
    }

    let new_content = if replace_all {
        content.replace(&old_string, &new_string)
    } else {
        content.replacen(&old_string, &new_string, 1)
    };
    let replacements = if replace_all { matches } else { 1 };
    std::fs::write(&v.resolved, new_content).map_err(|e| format!("写入文件失败: {}", e))?;
    Ok(EditResult {
        resolved: v.resolved,
        replacements,
    })
}

// ---- agent_search_files ----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub matches: Vec<String>,
    pub truncated: bool,
    pub searched_files: usize,
}

// ---- agent_list_dir（readLocalFile 的 list 模式；与 read 同套守卫，不用 plugin-fs 避免 scope 拦截） ----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryInfo {
    pub name: String,
    pub is_directory: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListDirResult {
    pub resolved: String,
    pub items: Vec<DirEntryInfo>,
}

#[tauri::command]
pub fn agent_list_dir(
    app: AppHandle,
    root: Option<String>,
    path: String,
    allow_outside: Option<bool>,
) -> Result<ListDirResult, String> {
    let root = resolve_root(&app, &root)?;
    let v = guard(&root, &path);
    if v.verdict == "out" && allow_outside != Some(true) {
        return Err(format!("路径在工作区外且未经用户确认: {}", v.resolved));
    }
    if is_denied_path(&v.resolved) {
        return Err(DENY_MESSAGE.to_string());
    }
    if !v.exists || !v.is_dir {
        return Err(format!("目录不存在: {}", v.resolved));
    }
    let entries = std::fs::read_dir(&v.resolved).map_err(|e| format!("读取目录失败: {e}"))?;
    let mut items: Vec<DirEntryInfo> = entries
        .flatten()
        .map(|entry| DirEntryInfo {
            name: entry.file_name().to_string_lossy().to_string(),
            is_directory: entry.file_type().map(|t| t.is_dir()).unwrap_or(false),
        })
        .collect();
    // 目录在前 + 名称排序；截断防巨型目录把模型上下文打爆
    items.sort_by(|a, b| {
        b.is_directory
            .cmp(&a.is_directory)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    items.truncate(500);
    Ok(ListDirResult {
        resolved: v.resolved,
        items,
    })
}

fn walk_files(base: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![base.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if path.is_dir() {
                if !SKIP_DIRS.contains(&name.as_str()) {
                    stack.push(path);
                }
            } else {
                out.push(path);
            }
        }
    }
    out
}

#[tauri::command]
pub fn agent_search_files(
    app: AppHandle,
    root: Option<String>,
    mode: String,
    pattern: String,
    subdir: Option<String>,
) -> Result<SearchResult, String> {
    let root = resolve_root(&app, &root)?;
    let base = match &subdir {
        Some(s) if !s.trim().is_empty() => {
            let v = guard(&root, s);
            if !v.is_dir {
                return Err(format!("子目录不存在: {}", v.resolved));
            }
            PathBuf::from(&v.resolved)
        }
        _ => root.clone(),
    };

    match mode.as_str() {
        "glob" => {
            let glob = globset::GlobBuilder::new(&pattern)
                .build()
                .map_err(|e| format!("glob 模式无效: {}", e))?;
            let matcher = glob.compile_matcher();
            let mut hits: Vec<(PathBuf, std::time::SystemTime)> = Vec::new();
            let files = walk_files(&base);
            let mut searched = 0usize;
            for f in files {
                // A4：denylist 与 read_file/list_dir 同口径，glob 结果同样不暴露敏感文件
                if is_denied_path(f.to_string_lossy().as_ref()) {
                    continue;
                }
                searched += 1;
                let rel = f.strip_prefix(&root).unwrap_or(&f);
                if matcher.is_match(rel) || matcher.is_match(&f) {
                    let modified = std::fs::metadata(&f).and_then(|m| m.modified()).unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                    hits.push((f, modified));
                }
            }
            // 按修改时间倒序
            hits.sort_by(|a, b| b.1.cmp(&a.1));
            let truncated = hits.len() > GLOB_MAX_MATCHES;
            let matches = hits
                .into_iter()
                .take(GLOB_MAX_MATCHES)
                .map(|(f, _)| display_path(&f))
                .collect();
            Ok(SearchResult {
                matches,
                truncated,
                searched_files: searched,
            })
        }
        "grep" => {
            let re = regex::Regex::new(&pattern).map_err(|e| format!("正则无效: {}", e))?;
            let mut matches = Vec::new();
            let mut searched = 0usize;
            'outer: for f in walk_files(&base) {
                // A4：denylist 与 read_file/list_dir 同口径，敏感文件内容不进模型上下文
                if is_denied_path(f.to_string_lossy().as_ref()) {
                    continue;
                }
                let meta = match std::fs::metadata(&f) {
                    Ok(m) => m,
                    Err(_) => continue,
                };
                if meta.len() > GREP_MAX_FILE_BYTES {
                    continue;
                }
                let raw = match std::fs::read(&f) {
                    Ok(r) => r,
                    Err(_) => continue,
                };
                // 二进制粗判：前 8KB 含 NUL 则跳过
                if raw[..raw.len().min(8192)].contains(&0) {
                    continue;
                }
                searched += 1;
                let text = String::from_utf8_lossy(&raw);
                let rel = display_path(&f);
                for (i, line) in text.lines().enumerate() {
                    if re.is_match(line) {
                        // A5 同款脱敏：命中行可能带密钥字面量，进模型上下文前先过模式脱敏
                        let line = crate::core::secrets::redact_secrets(&truncate_chars(line, 200));
                        matches.push(format!("{}:{}:{}", rel, i + 1, line));
                        if matches.len() >= GREP_MAX_MATCHES {
                            break 'outer;
                        }
                    }
                }
            }
            let truncated = matches.len() >= GREP_MAX_MATCHES;
            Ok(SearchResult {
                matches,
                truncated,
                searched_files: searched,
            })
        }
        other => Err(format!("未知 mode: {}（可选 glob | grep）", other)),
    }
}

// ---- agent_run_command ----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub truncated: bool,
}

/// 审计日志：{appData}/agent-audit/commands.jsonl，任何模式都写（best-effort，失败仅 warn）；
/// A5：写盘前对 command/stdout/stderr 三字段跑密钥模式脱敏
fn audit_command(app: &AppHandle, root: &Path, command: &str, result: &RunResult) {
    let write = || -> Result<(), String> {
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("{}", e))?
            .join("agent-audit");
        std::fs::create_dir_all(&dir).map_err(|e| format!("{}", e))?;
        let line = serde_json::json!({
            "ts": chrono::Utc::now().to_rfc3339(),
            "root": display_path(root),
            "command": crate::core::secrets::redact_secrets(command),
            "exitCode": result.exit_code,
            "timedOut": result.timed_out,
            "stdoutPreview": crate::core::secrets::redact_secrets(&truncate_chars(&result.stdout, 200)),
            "stderrPreview": crate::core::secrets::redact_secrets(&truncate_chars(&result.stderr, 200)),
        });
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("commands.jsonl"))
            .map_err(|e| format!("{}", e))?;
        writeln!(file, "{}", line).map_err(|e| format!("{}", e))?;
        Ok(())
    };
    if let Err(e) = write() {
        log::warn!("[agent-audit] 写审计日志失败: {}", e);
    }
}

#[tauri::command]
pub async fn agent_run_command(
    app: AppHandle,
    root: Option<String>,
    command: String,
    timeout_secs: Option<u64>,
) -> Result<RunResult, String> {
    let root = resolve_root(&app, &root)?;
    let timeout = timeout_secs
        .unwrap_or(RUN_DEFAULT_TIMEOUT_SECS)
        .clamp(1, RUN_MAX_TIMEOUT_SECS);

    let mut cmd = if cfg!(windows) {
        let mut c = tokio::process::Command::new("cmd");
        c.args(["/C", &command]);
        c
    } else {
        let mut c = tokio::process::Command::new("sh");
        c.args(["-c", &command]);
        c
    };
    cmd.current_dir(&root)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW：不弹控制台黑窗

    let mut child = cmd.spawn().map_err(|e| format!("启动命令失败: {}", e))?;

    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();
    let out_handle = tokio::spawn(async move {
        let mut buf = Vec::new();
        if let Some(mut pipe) = stdout_pipe.take() {
            let _ = pipe.read_to_end(&mut buf).await;
        }
        buf
    });
    let err_handle = tokio::spawn(async move {
        let mut buf = Vec::new();
        if let Some(mut pipe) = stderr_pipe.take() {
            let _ = pipe.read_to_end(&mut buf).await;
        }
        buf
    });

    let mut timed_out = false;
    let status = match tokio::time::timeout(Duration::from_secs(timeout), child.wait()).await {
        Ok(s) => Some(s.map_err(|e| format!("等待命令结束失败: {}", e))?),
        Err(_) => {
            timed_out = true;
            let _ = child.kill().await;
            let _ = child.wait().await;
            None
        }
    };

    let stdout_raw = out_handle.await.unwrap_or_default();
    let stderr_raw = err_handle.await.unwrap_or_default();
    let stdout_full = String::from_utf8_lossy(&stdout_raw).to_string();
    let stderr_full = String::from_utf8_lossy(&stderr_raw).to_string();
    let truncated =
        stdout_full.chars().count() > RUN_MAX_OUTPUT_CHARS || stderr_full.chars().count() > RUN_MAX_OUTPUT_CHARS;

    let result = RunResult {
        exit_code: status.and_then(|s| s.code()),
        stdout: truncate_chars(&stdout_full, RUN_MAX_OUTPUT_CHARS),
        stderr: truncate_chars(&stderr_full, RUN_MAX_OUTPUT_CHARS),
        timed_out,
        truncated,
    };
    audit_command(&app, &root, &command, &result);
    Ok(result)
}
