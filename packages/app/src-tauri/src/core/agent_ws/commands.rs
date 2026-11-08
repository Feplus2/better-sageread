use super::{display_path, guard, resolve_preview_root, resolve_root, GuardVerdict};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::{Read as StdRead, Seek, SeekFrom};
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

// ---- agent_resolve_path / agent_read_image ----

const IMAGE_MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;

fn resolve_image_roots(
    app: &AppHandle,
    root: &Option<String>,
    additional_roots: &Option<Vec<String>>,
) -> Result<Vec<PathBuf>, String> {
    let mut roots = vec![app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用目录失败: {}", e))?];
    roots.push(resolve_root(app, root)?);
    for custom in additional_roots.iter().flatten() {
        roots.push(resolve_root(app, &Some(custom.clone()))?);
    }
    Ok(roots)
}

#[tauri::command]
pub fn agent_resolve_path(
    app: AppHandle,
    root: Option<String>,
    path: String,
    additional_roots: Option<Vec<String>>,
    include_app_data: Option<bool>,
) -> Result<GuardVerdict, String> {
    if include_app_data == Some(true) {
        let roots = resolve_image_roots(&app, &root, &additional_roots)?;
        return Ok(super::guard_with_roots(&roots, &path));
    }
    let root = resolve_root(&app, &root)?;
    Ok(guard(&root, &path))
}

#[tauri::command]
pub fn agent_preview_resolve_path(
    app: AppHandle,
    root: Option<String>,
    path: String,
) -> Result<GuardVerdict, String> {
    let root = resolve_preview_root(&app, &root)?;
    Ok(guard(&root, &path))
}

fn read_image_bytes(
    roots: &[PathBuf],
    path: &str,
    allow_outside: bool,
    expected_path: Option<&str>,
    expected_resolved: Option<&str>,
) -> Result<Vec<u8>, String> {
    let verdict = super::guard_with_roots(roots, path);
    if is_denied_path(&verdict.resolved) {
        return Err(DENY_MESSAGE.to_string());
    }
    if verdict.verdict == "out" && !allow_outside {
        return Err(format!(
            "路径在工作区外且未经用户确认: {}",
            verdict.resolved
        ));
    }
    if expected_path.is_some_and(|expected| expected != path) {
        return Err("图片读取授权的原始路径不匹配".to_string());
    }
    if expected_resolved.is_some_and(|expected| expected != verdict.resolved) {
        return Err("图片的规范化路径已变化，需重新确认".to_string());
    }
    if verdict.verdict == "out" && (expected_path.is_none() || expected_resolved.is_none()) {
        return Err("界外图片读取缺少原始路径或规范化路径绑定".to_string());
    }
    if !verdict.exists || verdict.is_dir {
        return Err(format!("图片不存在或是目录: {}", verdict.resolved));
    }
    let meta =
        std::fs::metadata(&verdict.resolved).map_err(|e| format!("读取图片元信息失败: {}", e))?;
    if meta.len() > IMAGE_MAX_FILE_BYTES {
        return Err(format!("图片体积超过 20MB 上限: {}", verdict.resolved));
    }
    std::fs::read(&verdict.resolved).map_err(|e| format!("读取图片失败: {}", e))
}

#[tauri::command]
pub fn agent_read_image(
    app: AppHandle,
    root: Option<String>,
    additional_roots: Option<Vec<String>>,
    path: String,
    allow_outside: Option<bool>,
    expected_path: Option<String>,
    expected_resolved: Option<String>,
) -> Result<tauri::ipc::Response, String> {
    let roots = resolve_image_roots(&app, &root, &additional_roots)?;
    let bytes = read_image_bytes(
        &roots,
        &path,
        allow_outside == Some(true),
        expected_path.as_deref(),
        expected_resolved.as_deref(),
    )?;
    Ok(tauri::ipc::Response::new(bytes))
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
        return Err(format!(
            "文件过大（>8MB），请改用 searchFiles 定位片段: {}",
            v.resolved
        ));
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
        content.push_str(&format!(
            "{}\t{}\n",
            line_no,
            truncate_chars(line, READ_MAX_LINE_CHARS)
        ));
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

pub fn write_file_core(
    root: &Path,
    path: &str,
    content: &str,
    allow_outside: bool,
) -> Result<WriteResult, String> {
    let v = guard(root, path);
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

#[tauri::command]
pub fn agent_write_file(
    app: AppHandle,
    root: Option<String>,
    path: String,
    content: String,
    allow_outside: bool,
) -> Result<WriteResult, String> {
    let root = resolve_root(&app, &root)?;
    write_file_core(&root, &path, &content, allow_outside)
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
    let content = String::from_utf8(raw)
        .map_err(|_| format!("文件不是有效 UTF-8，无法用 editFile 编辑: {}", v.resolved))?;

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
                    let modified = std::fs::metadata(&f)
                        .and_then(|m| m.modified())
                        .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
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

// ---- Agent 文件工作区只读预览（分块/分页，前端 tool-guard 负责确认） ----

fn preview_verdict(
    root: &Path,
    path: &str,
    allow_outside: bool,
    expected_resolved: Option<&str>,
) -> Result<GuardVerdict, String> {
    let verdict = guard(root, path);
    if is_denied_path(&verdict.resolved) {
        return Err(DENY_MESSAGE.to_string());
    }
    if verdict.verdict == "out" {
        if !allow_outside {
            return Err(format!(
                "路径在工作区外且未经用户确认: {}",
                verdict.resolved
            ));
        }
        if expected_resolved.is_none() || expected_resolved != Some(verdict.resolved.as_str()) {
            return Err("界外预览的规范化路径已变化，需重新确认".to_string());
        }
    }
    Ok(verdict)
}

fn modified_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceStat {
    pub resolved: String,
    pub exists: bool,
    pub is_directory: bool,
    pub size: u64,
    pub modified_ms: u64,
}

pub fn workspace_stat(
    root: &Path,
    path: &str,
    allow_outside: bool,
    expected_resolved: Option<&str>,
) -> Result<WorkspaceStat, String> {
    let verdict = preview_verdict(root, path, allow_outside, expected_resolved)?;
    let size = if verdict.exists && !verdict.is_dir {
        std::fs::metadata(&verdict.resolved)
            .map(|metadata| metadata.len())
            .unwrap_or(0)
    } else {
        0
    };
    Ok(WorkspaceStat {
        modified_ms: modified_ms(Path::new(&verdict.resolved)),
        resolved: verdict.resolved,
        exists: verdict.exists,
        is_directory: verdict.is_dir,
        size,
    })
}

#[tauri::command]
pub fn agent_workspace_stat(
    app: AppHandle,
    root: Option<String>,
    path: String,
    allow_outside: Option<bool>,
    expected_resolved: Option<String>,
) -> Result<WorkspaceStat, String> {
    let root = resolve_preview_root(&app, &root)?;
    workspace_stat(
        &root,
        &path,
        allow_outside == Some(true),
        expected_resolved.as_deref(),
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceChunk {
    pub resolved: String,
    pub content: String,
    pub next_offset: u64,
    pub truncated: bool,
    pub binary: bool,
    pub total_size: u64,
    pub modified_ms: u64,
}

pub fn workspace_read_chunk(
    root: &Path,
    path: &str,
    offset: u64,
    limit: usize,
    allow_outside: bool,
    expected_resolved: Option<&str>,
) -> Result<WorkspaceChunk, String> {
    let stat = workspace_stat(root, path, allow_outside, expected_resolved)?;
    if !stat.exists || stat.is_directory {
        return Err(format!("文件不存在或是目录: {}", stat.resolved));
    }
    let limit = limit.clamp(1, 512 * 1024);
    let mut file =
        std::fs::File::open(&stat.resolved).map_err(|e| format!("打开预览文件失败: {e}"))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| format!("定位预览文件失败: {e}"))?;
    let mut bytes = Vec::new();
    StdRead::by_ref(&mut file)
        .take(limit as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("读取预览文件失败: {e}"))?;
    let mut next_offset = offset + bytes.len() as u64;
    let mut extra = 0;
    while next_offset < stat.size && extra < 3 {
        match std::str::from_utf8(&bytes) {
            Ok(_) => break,
            Err(error) if error.error_len().is_none() => {
                let mut next = [0u8; 1];
                let count = file
                    .read(&mut next)
                    .map_err(|e| format!("读取预览文件失败: {e}"))?;
                if count == 0 {
                    break;
                }
                bytes.push(next[0]);
                next_offset += 1;
                extra += 1;
            }
            Err(_) => break,
        }
    }
    let binary = bytes.contains(&0) || std::str::from_utf8(&bytes).is_err();
    let content = if binary {
        String::new()
    } else {
        String::from_utf8(bytes).unwrap()
    };
    Ok(WorkspaceChunk {
        resolved: stat.resolved.clone(),
        content,
        next_offset,
        truncated: next_offset < stat.size,
        binary,
        total_size: stat.size,
        modified_ms: stat.modified_ms,
    })
}

#[tauri::command]
pub fn agent_workspace_read_chunk(
    app: AppHandle,
    root: Option<String>,
    path: String,
    offset: Option<u64>,
    limit: Option<usize>,
    allow_outside: Option<bool>,
    expected_resolved: Option<String>,
) -> Result<WorkspaceChunk, String> {
    let root = resolve_preview_root(&app, &root)?;
    workspace_read_chunk(
        &root,
        &path,
        offset.unwrap_or(0),
        limit.unwrap_or(256 * 1024),
        allow_outside == Some(true),
        expected_resolved.as_deref(),
    )
}

pub fn workspace_read_binary(
    root: &Path,
    path: &str,
    allow_outside: bool,
    expected_resolved: Option<&str>,
) -> Result<Vec<u8>, String> {
    const MAX_BYTES: u64 = 64 * 1024 * 1024;
    let stat = workspace_stat(root, path, allow_outside, expected_resolved)?;
    if !stat.exists || stat.is_directory {
        return Err(format!("文件不存在或是目录: {}", stat.resolved));
    }
    if stat.size > MAX_BYTES {
        return Err("图片或 PDF 超过 64 MiB，不能安全内嵌预览".to_string());
    }
    let mut file =
        std::fs::File::open(&stat.resolved).map_err(|e| format!("打开预览文件失败: {e}"))?;
    let mut bytes = Vec::new();
    StdRead::by_ref(&mut file)
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("读取预览文件失败: {e}"))?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("图片或 PDF 超过 64 MiB，不能安全内嵌预览".to_string());
    }
    let after = workspace_stat(root, path, allow_outside, expected_resolved)?;
    if !after.exists
        || after.is_directory
        || after.resolved != stat.resolved
        || after.size != stat.size
        || after.modified_ms != stat.modified_ms
    {
        return Err("预览文件在读取期间发生变化，请重新加载".to_string());
    }
    Ok(bytes)
}

#[tauri::command]
pub fn agent_workspace_read_binary(
    app: AppHandle,
    root: Option<String>,
    path: String,
    allow_outside: Option<bool>,
    expected_resolved: Option<String>,
) -> Result<tauri::ipc::Response, String> {
    let root = resolve_preview_root(&app, &root)?;
    let bytes = workspace_read_binary(
        &root,
        &path,
        allow_outside == Some(true),
        expected_resolved.as_deref(),
    )?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
    pub size: u64,
    pub modified_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceList {
    pub resolved: String,
    pub items: Vec<WorkspaceEntry>,
    pub next_offset: usize,
    pub truncated: bool,
}

pub fn workspace_list(
    root: &Path,
    path: &str,
    offset: usize,
    limit: usize,
    allow_outside: bool,
    expected_resolved: Option<&str>,
) -> Result<WorkspaceList, String> {
    let verdict = preview_verdict(root, path, allow_outside, expected_resolved)?;
    if !verdict.exists || !verdict.is_dir {
        return Err(format!("目录不存在: {}", verdict.resolved));
    }
    let mut items = Vec::new();
    for entry in std::fs::read_dir(&verdict.resolved)
        .map_err(|e| format!("读取目录失败: {e}"))?
        .flatten()
    {
        let path = entry.path();
        if is_denied_path(&path.to_string_lossy()) {
            continue;
        }
        let metadata = entry.metadata().ok();
        items.push(WorkspaceEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            path: display_path(&path),
            is_directory: metadata.as_ref().is_some_and(|meta| meta.is_dir()),
            size: metadata.as_ref().map(|meta| meta.len()).unwrap_or(0),
            modified_ms: modified_ms(&path),
        });
    }
    items.sort_by(|a, b| {
        b.is_directory
            .cmp(&a.is_directory)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    let limit = limit.clamp(1, 500);
    let next_offset = (offset + limit).min(items.len());
    let truncated = next_offset < items.len();
    Ok(WorkspaceList {
        resolved: verdict.resolved,
        items: items.into_iter().skip(offset).take(limit).collect(),
        next_offset,
        truncated,
    })
}

#[tauri::command]
pub fn agent_workspace_list(
    app: AppHandle,
    root: Option<String>,
    path: String,
    offset: Option<usize>,
    limit: Option<usize>,
    allow_outside: Option<bool>,
    expected_resolved: Option<String>,
) -> Result<WorkspaceList, String> {
    let root = resolve_preview_root(&app, &root)?;
    workspace_list(
        &root,
        &path,
        offset.unwrap_or(0),
        limit.unwrap_or(100),
        allow_outside == Some(true),
        expected_resolved.as_deref(),
    )
}

// ---- agent_run_command ----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandFileChange {
    pub path: String,
    pub kind: String,
    pub verified: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub truncated: bool,
    pub changes: Vec<CommandFileChange>,
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

fn shell_command(command: &str) -> tokio::process::Command {
    #[cfg(windows)]
    let cmd = {
        let mut c = tokio::process::Command::new("cmd");
        c.args(["/D", "/S", "/C"]).raw_arg(format!("\"{command}\""));
        c
    };
    #[cfg(not(windows))]
    let cmd = {
        let mut c = tokio::process::Command::new("sh");
        c.args(["-c", command]);
        c
    };
    cmd
}

#[derive(PartialEq)]
struct ArtifactState {
    exists: bool,
    fingerprint: Option<[u8; 32]>,
}

async fn artifact_state(path: &str) -> Result<ArtifactState, String> {
    let path = Path::new(path);
    if !path.exists() {
        return Ok(ArtifactState {
            exists: false,
            fingerprint: None,
        });
    }
    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|e| format!("读取命令产物元信息失败: {e}"))?;
    if metadata.is_dir() {
        return Err(format!(
            "命令产物必须是文件而非目录: {}",
            display_path(path)
        ));
    }
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|e| format!("读取命令产物失败: {e}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .await
            .map_err(|e| format!("读取命令产物失败: {e}"))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(ArtifactState {
        exists: true,
        fingerprint: Some(hasher.finalize().into()),
    })
}

fn resolve_artifact_path(root: &Path, raw: &str) -> Result<String, String> {
    let verdict = guard(root, raw);
    if verdict.verdict == "out" {
        return Err(format!("命令产物不能越出工作区: {}", verdict.resolved));
    }
    if is_denied_path(&verdict.resolved) {
        return Err(DENY_MESSAGE.to_string());
    }
    Ok(verdict.resolved)
}

pub async fn run_command_core(
    root: &Path,
    command: &str,
    timeout_secs: u64,
    artifact_paths: Vec<String>,
) -> Result<RunResult, String> {
    let timeout = timeout_secs.clamp(1, RUN_MAX_TIMEOUT_SECS);
    let canonical_root =
        std::fs::canonicalize(root).map_err(|error| format!("解析命令工作区失败: {error}"))?;
    let before = artifact_paths
        .iter()
        .map(|raw| resolve_artifact_path(root, raw))
        .collect::<Result<Vec<_>, _>>()?;
    let mut states = Vec::new();
    for path in &before {
        states.push((path.clone(), artifact_state(path).await?));
    }
    let before = states;

    let mut cmd = shell_command(command);
    cmd.current_dir(root)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);

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
    let truncated = stdout_full.chars().count() > RUN_MAX_OUTPUT_CHARS
        || stderr_full.chars().count() > RUN_MAX_OUTPUT_CHARS;

    let current_root = std::fs::canonicalize(root)
        .map_err(|error| format!("命令后重新解析工作区失败: {error}"))?;
    if current_root != canonical_root {
        return Err("命令工作区的规范化路径已变化，不能验证产物".to_string());
    }
    let mut changes = Vec::new();
    for ((path, previous), raw) in before.into_iter().zip(artifact_paths.iter()) {
        let current_path = resolve_artifact_path(root, raw)?;
        if current_path != path {
            return Err("命令产物的规范化路径已变化，不能验证产物".to_string());
        }
        let current = artifact_state(&current_path).await?;
        if previous == current {
            continue;
        }
        let kind = match (previous.exists, current.exists) {
            (false, true) => "created",
            (true, false) => "deleted",
            _ => "modified",
        };
        changes.push(CommandFileChange {
            path: current_path,
            kind: kind.to_string(),
            verified: true,
        });
    }
    Ok(RunResult {
        exit_code: status.and_then(|s| s.code()),
        stdout: truncate_chars(&stdout_full, RUN_MAX_OUTPUT_CHARS),
        stderr: truncate_chars(&stderr_full, RUN_MAX_OUTPUT_CHARS),
        timed_out,
        truncated,
        changes,
    })
}

#[tauri::command]
pub async fn agent_run_command(
    app: AppHandle,
    root: Option<String>,
    command: String,
    timeout_secs: Option<u64>,
    artifact_paths: Option<Vec<String>>,
) -> Result<RunResult, String> {
    let root = resolve_root(&app, &root)?;
    let result = run_command_core(
        &root,
        &command,
        timeout_secs.unwrap_or(RUN_DEFAULT_TIMEOUT_SECS),
        artifact_paths.unwrap_or_default(),
    )
    .await?;
    audit_command(&app, &root, &command, &result);
    Ok(result)
}

#[cfg(test)]
mod workspace_test_support {
    use std::path::{Path, PathBuf};

    pub struct TempWorkspace(PathBuf);

    impl TempWorkspace {
        pub fn new() -> Self {
            let unique = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "sageread-workspace-preview-{}-{}",
                std::process::id(),
                unique
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        pub fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempWorkspace {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

#[cfg(test)]
mod workspace_test_support_tests {
    use super::workspace_test_support::TempWorkspace;
    use std::collections::HashSet;

    #[test]
    fn temporary_workspaces_never_reuse_a_path() {
        let paths = (0..128)
            .map(|_| TempWorkspace::new().path().to_path_buf())
            .collect::<HashSet<_>>();
        assert_eq!(paths.len(), 128, "同一批测试的临时目录发生了复用");
    }
}

#[cfg(test)]
mod write_command_tests {
    use super::workspace_test_support::TempWorkspace;
    use super::write_file_core;
    use std::fs;

    #[test]
    fn write_command_distinguishes_create_from_overwrite_and_serializes_created() {
        let root = TempWorkspace::new();
        let path = root.path().join("nested").join("新建.txt");
        let path = path.to_str().unwrap();
        let first = write_file_core(root.path(), path, "第一次", false).unwrap();
        assert!(first.created);
        assert_eq!(first.bytes, 9);
        assert_eq!(fs::read_to_string(path).unwrap(), "第一次");
        assert!(first.resolved.ends_with("新建.txt"));
        assert_eq!(serde_json::to_value(&first).unwrap()["created"], true);

        let second = write_file_core(root.path(), path, "覆盖🙂", false).unwrap();
        assert!(!second.created);
        assert_eq!(second.bytes, 10);
        assert_eq!(fs::read_to_string(path).unwrap(), "覆盖🙂");
        assert_eq!(serde_json::to_value(&second).unwrap()["created"], false);
    }
}

#[cfg(all(test, windows))]
mod workspace_command_tests {
    use super::workspace_test_support::TempWorkspace;
    use super::{artifact_state, run_command_core};
    use std::fs;

    #[tokio::test]
    async fn large_artifact_hash_preserves_exact_digest() {
        let root = TempWorkspace::new();
        let path = root.path().join("large.csv");
        let bytes = vec![b'x'; 8 * 1024 * 1024];
        fs::write(&path, &bytes).unwrap();
        let state = artifact_state(path.to_str().unwrap()).await.unwrap();
        use sha2::Digest;
        let expected: [u8; 32] = sha2::Sha256::digest(&bytes).into();
        assert_eq!(state.fingerprint, Some(expected));
    }

    #[tokio::test]
    async fn declared_artifacts_are_verified_without_scanning_stdout() {
        let root = TempWorkspace::new();
        fs::write(root.path().join("old.txt"), "old").unwrap();
        fs::write(root.path().join("same.txt"), "same").unwrap();
        let result = run_command_core(
            root.path(),
            r#"python -c "from pathlib import Path; Path('new.csv').write_text('a,b\\n1,2\\n', encoding='utf-8'); Path('old.txt').unlink()""#,
            120,
            vec!["new.csv".into(), "old.txt".into(), "same.txt".into()],
        )
        .await
        .unwrap();
        assert_eq!(result.exit_code, Some(0));
        assert_eq!(result.changes.len(), 2);
        assert!(result
            .changes
            .iter()
            .any(|change| change.path.ends_with("new.csv")
                && change.kind == "created"
                && change.verified));
        assert!(result
            .changes
            .iter()
            .any(|change| change.path.ends_with("old.txt")
                && change.kind == "deleted"
                && change.verified));
        assert!(!result
            .changes
            .iter()
            .any(|change| change.path.ends_with("same.txt")));
    }

    #[tokio::test]
    async fn nonzero_exit_does_not_erase_verified_changes() {
        let root = TempWorkspace::new();
        fs::write(root.path().join("new.csv"), "before").unwrap();
        let result = run_command_core(
            root.path(),
            r#"python -c "from pathlib import Path; Path('new.csv').write_text('changed', encoding='utf-8'); 1/0""#,
            120,
            vec!["new.csv".into()],
        )
        .await
        .unwrap();
        assert_eq!(result.exit_code, Some(1));
        assert_eq!(result.changes.len(), 1);
        assert_eq!(result.changes[0].kind, "modified");
        assert!(result.changes[0].verified);
    }

    #[tokio::test]
    async fn command_rechecks_artifact_target_after_junction_rebinding() {
        let root = TempWorkspace::new();
        fs::create_dir(root.path().join("a")).unwrap();
        fs::create_dir(root.path().join("b")).unwrap();
        let link = root.path().join("linked");
        let output = std::process::Command::new("cmd")
            .args(["/D", "/C", "mklink", "/J"])
            .arg(&link)
            .arg(root.path().join("a"))
            .output()
            .unwrap();
        assert!(output.status.success(), "mklink failed: {output:?}");
        let result = run_command_core(
            root.path(),
            r#"rmdir "linked" && mklink /J "linked" "b" && python -c "from pathlib import Path; Path('linked/out.txt').write_text('new-target', encoding='utf-8')""#,
            120,
            vec!["linked/out.txt".into()],
        )
        .await;
        let error = match result {
            Ok(_) => panic!("retargeted artifact must not be verified"),
            Err(error) => error,
        };
        fs::remove_dir(link).unwrap();
        assert!(error.contains("已变化"), "unexpected error: {error}");
        assert_eq!(
            fs::read_to_string(root.path().join("b/out.txt")).unwrap(),
            "new-target"
        );
        assert!(!root.path().join("a/out.txt").exists());
    }

    #[tokio::test]
    async fn artifacts_cannot_escape_or_target_sensitive_files() {
        let root = TempWorkspace::new();
        let outside = run_command_core(
            root.path(),
            "python -c \"print(1)\"",
            120,
            vec!["../outside.txt".into()],
        )
        .await;
        assert!(outside.is_err());
        let sensitive = run_command_core(
            root.path(),
            "python -c \"print(1)\"",
            120,
            vec![".env".into()],
        )
        .await;
        assert!(sensitive.is_err());
    }
}

#[cfg(test)]
mod workspace_preview_tests {
    use super::workspace_test_support::TempWorkspace;
    use super::{workspace_list, workspace_read_binary, workspace_read_chunk, workspace_stat};
    use std::fs;

    #[test]
    fn text_chunks_are_bounded_and_keep_exact_offsets() {
        let root = TempWorkspace::new();
        fs::write(root.path().join("a.txt"), "abcdef").unwrap();
        let first = workspace_read_chunk(root.path(), "a.txt", 0, 4, false, None).unwrap();
        assert_eq!(first.content, "abcd");
        assert_eq!(first.next_offset, 4);
        assert!(first.truncated);
        let second =
            workspace_read_chunk(root.path(), "a.txt", first.next_offset, 4, false, None).unwrap();
        assert_eq!(second.content, "ef");
        assert!(!second.truncated);
        assert_eq!(second.next_offset, 6);
    }

    #[test]
    fn utf8_boundaries_do_not_turn_valid_text_into_binary() {
        let root = TempWorkspace::new();
        for (text, limit) in [
            (format!("a{}", "界".repeat(100_000)), 256 * 1024),
            ("a界🙂".to_string(), 1),
        ] {
            fs::write(root.path().join("unicode.txt"), &text).unwrap();
            let mut offset = 0;
            let mut collected = String::new();
            for _ in 0..64 {
                let chunk =
                    workspace_read_chunk(root.path(), "unicode.txt", offset, limit, false, None)
                        .unwrap();
                assert!(!chunk.binary, "valid UTF-8 was rejected at byte {offset}");
                collected.push_str(&chunk.content);
                if !chunk.truncated {
                    break;
                }
                offset = chunk.next_offset;
            }
            assert_eq!(collected, text);
        }
    }

    #[test]
    fn binary_preview_returns_bytes_and_rejects_oversize_files() {
        let root = TempWorkspace::new();
        fs::write(root.path().join("paper.pdf"), b"%PDF-1.4\n").unwrap();
        let bytes = workspace_read_binary(root.path(), "paper.pdf", false, None).unwrap();
        assert_eq!(bytes, b"%PDF-1.4\n");
        fs::File::create(root.path().join("large.pdf"))
            .unwrap()
            .set_len(64 * 1024 * 1024 + 1)
            .unwrap();
        assert!(workspace_read_binary(root.path(), "large.pdf", false, None).is_err());
    }

    #[test]
    fn binary_sensitive_and_outside_paths_follow_the_same_boundary() {
        let root = TempWorkspace::new();
        fs::write(root.path().join("blob.bin"), [0, 1, 2]).unwrap();
        fs::write(root.path().join(".env"), "secret").unwrap();
        let outside_path = root.path().parent().unwrap().join("outside.txt");
        fs::write(&outside_path, "outside").unwrap();
        let binary = workspace_read_chunk(root.path(), "blob.bin", 0, 16, false, None).unwrap();
        assert!(binary.binary);
        assert!(binary.content.is_empty());
        assert!(workspace_read_chunk(root.path(), ".env", 0, 16, true, None).is_err());
        assert!(workspace_read_chunk(root.path(), "../outside.txt", 0, 16, false, None).is_err());
        let resolved = super::display_path(&outside_path);
        let outside =
            workspace_read_chunk(root.path(), "../outside.txt", 0, 16, true, Some(&resolved))
                .unwrap();
        assert_eq!(outside.content, "outside");
        let _ = fs::remove_file(outside_path);
    }

    #[test]
    fn directory_listing_is_paginated_and_stat_reports_missing() {
        let root = TempWorkspace::new();
        fs::create_dir(root.path().join("dir")).unwrap();
        fs::write(root.path().join("a.txt"), "a").unwrap();
        fs::write(root.path().join("b.txt"), "b").unwrap();
        let page = workspace_list(root.path(), ".", 0, 2, false, None).unwrap();
        assert_eq!(page.items.len(), 2);
        assert!(page.truncated);
        assert_eq!(page.next_offset, 2);
        assert!(page.items[0].is_directory);
        let missing = workspace_stat(root.path(), "missing.txt", false, None).unwrap();
        assert!(!missing.exists);
        let file = workspace_stat(root.path(), "a.txt", false, None).unwrap();
        assert!(file.exists);
        assert!(!file.is_directory);
        assert_eq!(file.size, 1);
    }
}

#[cfg(all(test, windows))]
mod windows_command_tests {
    use super::shell_command;
    use std::path::{Path, PathBuf};
    use std::process::{Output, Stdio};

    static NEXT_WORKSPACE_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    struct TestWorkspace(PathBuf);

    impl TestWorkspace {
        fn new() -> Self {
            let unique = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock should be after Unix epoch")
                .as_nanos();
            let sequence = NEXT_WORKSPACE_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "sageread agent ws {} {} {}",
                std::process::id(),
                unique,
                sequence
            ));
            std::fs::create_dir(&path).expect("create unique test workspace");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestWorkspace {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).expect("remove test workspace");
        }
    }

    async fn run(command: &str, cwd: &Path) -> Output {
        let mut cmd = shell_command(command);
        cmd.current_dir(cwd)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null());
        cmd.creation_flags(0x08000000);
        cmd.output().await.expect("run Windows shell command")
    }

    #[tokio::test]
    async fn quoted_python_code_captures_stdout() {
        let workspace = TestWorkspace::new();
        let output = run(r#"python -c "print(123)""#, workspace.path()).await;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);

        assert_eq!(
            output.status.code(),
            Some(0),
            "stdout={stdout:?}, stderr={stderr:?}"
        );
        assert_eq!(
            stdout.trim(),
            "123",
            "quoted Python stdout must not be empty; stderr={stderr:?}"
        );
    }

    #[tokio::test]
    async fn quoted_python_error_preserves_nonzero_exit_and_stderr() {
        let workspace = TestWorkspace::new();
        let output = run(r#"python -c "1/0""#, workspace.path()).await;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);

        assert_eq!(
            output.status.code(),
            Some(1),
            "stdout={stdout:?}, stderr={stderr:?}"
        );
        assert!(
            stderr.contains("ZeroDivisionError"),
            "stdout={stdout:?}, stderr={stderr:?}"
        );
    }

    #[tokio::test]
    async fn chained_commands_capture_both_outputs() {
        let workspace = TestWorkspace::new();
        let output = run(
            r#"python -c "print('first')" && python -c "print('second')""#,
            workspace.path(),
        )
        .await;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);

        assert_eq!(
            output.status.code(),
            Some(0),
            "stdout={stdout:?}, stderr={stderr:?}"
        );
        assert_eq!(
            stdout.lines().collect::<Vec<_>>(),
            ["first", "second"],
            "stderr={stderr:?}"
        );
    }

    #[tokio::test]
    async fn quoted_argument_and_workspace_path_with_spaces_are_preserved() {
        let workspace = TestWorkspace::new();
        let output = run(
            r#"python -c "import os,sys; print(sys.argv[1]); print(os.getcwd())" "argument with spaces""#,
            workspace.path(),
        )
        .await;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let lines = stdout.lines().collect::<Vec<_>>();

        assert_eq!(
            output.status.code(),
            Some(0),
            "stdout={stdout:?}, stderr={stderr:?}"
        );
        assert_eq!(
            lines.first(),
            Some(&"argument with spaces"),
            "stdout={stdout:?}, stderr={stderr:?}"
        );
        assert_eq!(
            lines.get(1).map(Path::new),
            Some(workspace.path()),
            "stdout={stdout:?}, stderr={stderr:?}"
        );
    }
}

#[cfg(test)]
mod image_tests {
    use super::read_image_bytes;
    use std::path::{Path, PathBuf};

    const FAKE_PNG: &[u8] = b"\x89PNG\r\n\x1a\nTask 9 fake PNG";
    static NEXT_WORKSPACE_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    struct TestWorkspace(PathBuf);

    impl TestWorkspace {
        fn new() -> Self {
            let unique = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock should be after Unix epoch")
                .as_nanos();
            let sequence = NEXT_WORKSPACE_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "sageread-task9-image-{}-{}-{}",
                std::process::id(),
                unique,
                sequence
            ));
            std::fs::create_dir(&path).expect("create unique image test workspace");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestWorkspace {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn write_fake_png(path: &Path) {
        std::fs::create_dir_all(path.parent().expect("image has a parent"))
            .expect("create image parent");
        std::fs::write(path, FAKE_PNG).expect("write fake PNG");
    }

    fn resolved(path: &Path) -> String {
        super::display_path(&std::fs::canonicalize(path).expect("canonicalize test image"))
    }

    #[test]
    fn image_read_accepts_app_data_shared_and_per_agent_roots() {
        let workspace = TestWorkspace::new();
        let roots = vec![
            workspace.path().join("appdata"),
            workspace.path().join("shared"),
            workspace.path().join("reader-agent"),
        ];
        for root in &roots {
            let image = root.join("figure.png");
            write_fake_png(&image);
        }

        for root in &roots {
            let image = root.join("figure.png");
            let bytes = read_image_bytes(&roots, image.to_str().unwrap(), false, None, None)
                .expect("each configured image root should be readable");
            assert_eq!(bytes, FAKE_PNG);
        }
    }

    #[test]
    fn image_read_parent_traversal_requires_a_bound_outside_grant() {
        let workspace = TestWorkspace::new();
        let root = workspace.path().join("allowed");
        let outside = workspace.path().join("outside.png");
        std::fs::create_dir(&root).expect("create allowed root");
        write_fake_png(&outside);
        let original = root.join("..").join("outside.png");
        let original = original.to_str().unwrap();
        let resolved = resolved(&outside);

        let error = read_image_bytes(&[root.clone()], original, false, None, None)
            .expect_err("parent traversal must not bypass the outside check");
        assert!(error.contains("工作区外"), "unexpected error: {error}");
        let bytes = read_image_bytes(&[root], original, true, Some(original), Some(&resolved))
            .expect(
                "an exact original-path and canonical-target grant should allow an outside read",
            );
        assert_eq!(bytes, FAKE_PNG);
    }

    #[test]
    fn image_read_outside_grant_rejects_a_different_original_path() {
        let workspace = TestWorkspace::new();
        let root = workspace.path().join("allowed");
        let outside = workspace.path().join("outside.png");
        std::fs::create_dir(&root).expect("create allowed root");
        write_fake_png(&outside);
        let original = outside.to_str().unwrap();
        let alias = workspace
            .path()
            .join("nested")
            .join("..")
            .join("outside.png");
        let resolved = resolved(&outside);

        let error = read_image_bytes(
            &[root],
            alias.to_str().unwrap(),
            true,
            Some(original),
            Some(&resolved),
        )
        .expect_err("a grant must not be reusable with a different original path");
        assert!(error.contains("原始路径"), "unexpected error: {error}");
    }

    #[test]
    fn image_read_rejects_a_changed_expected_resolved_target() {
        let workspace = TestWorkspace::new();
        let root = workspace.path().join("allowed");
        let first = workspace.path().join("first.png");
        let second = workspace.path().join("second.png");
        write_fake_png(&first);
        write_fake_png(&second);
        let first_path = first.to_str().unwrap();

        let error = read_image_bytes(
            &[root],
            first_path,
            true,
            Some(first_path),
            Some(&resolved(&second)),
        )
        .expect_err("the canonical target must match the approved target");
        assert!(error.contains("规范化路径"), "unexpected error: {error}");
    }

    #[cfg(windows)]
    fn make_junction(link: &Path, target: &Path) {
        let output = std::process::Command::new("cmd")
            .args(["/D", "/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .expect("run mklink /J");
        assert!(
            output.status.success(),
            "mklink /J failed: stdout={:?}, stderr={:?}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[cfg(windows)]
    fn remove_junction(link: &Path) {
        let output = std::process::Command::new("cmd")
            .args(["/D", "/C", "rmdir"])
            .arg(link)
            .output()
            .expect("remove test junction");
        assert!(output.status.success(), "rmdir junction failed: {output:?}");
    }

    #[cfg(windows)]
    #[test]
    fn image_read_windows_junction_cannot_escape_or_be_retargeted_after_approval() {
        let workspace = TestWorkspace::new();
        let root = workspace.path().join("allowed");
        let outside_a = workspace.path().join("outside-a");
        let outside_b = workspace.path().join("outside-b");
        std::fs::create_dir(&root).expect("create allowed root");
        write_fake_png(&outside_a.join("figure.png"));
        write_fake_png(&outside_b.join("figure.png"));
        let junction = root.join("figure-link");
        make_junction(&junction, &outside_a);
        let original_path = junction.join("figure.png");
        let original = original_path.to_str().unwrap();
        let approved_resolved = resolved(&outside_a.join("figure.png"));

        let error = read_image_bytes(&[root.clone()], original, false, None, None)
            .expect_err("a junction into an outside directory is still outside");
        assert!(error.contains("工作区外"), "unexpected error: {error}");
        let approved = read_image_bytes(
            &[root.clone()],
            original,
            true,
            Some(original),
            Some(&approved_resolved),
        )
        .expect("the explicitly approved junction target should be readable");
        assert_eq!(approved, FAKE_PNG);

        remove_junction(&junction);
        make_junction(&junction, &outside_b);
        let error = read_image_bytes(
            &[root],
            original,
            true,
            Some(original),
            Some(&approved_resolved),
        )
        .expect_err("retargeting the junction after approval must invalidate the grant");
        assert!(error.contains("规范化路径"), "unexpected error: {error}");
        remove_junction(&junction);
    }

    #[test]
    fn image_read_sensitive_filename_is_denied_even_with_png_bytes_and_outside_grant() {
        let workspace = TestWorkspace::new();
        let root = workspace.path().join("allowed");
        let inside = root.join("model-provider.json");
        let outside = workspace.path().join("model-provider.json");
        write_fake_png(&inside);
        write_fake_png(&outside);

        let inside_error =
            read_image_bytes(&[root.clone()], inside.to_str().unwrap(), false, None, None)
                .expect_err("sensitive names are denied inside the roots");
        assert!(
            inside_error.contains("凭据"),
            "unexpected error: {inside_error}"
        );
        let outside_path = outside.to_str().unwrap();
        let outside_error = read_image_bytes(
            &[root],
            outside_path,
            true,
            Some(outside_path),
            Some(&resolved(&outside)),
        )
        .expect_err("an outside grant must not override the sensitive-path denylist");
        assert!(
            outside_error.contains("凭据"),
            "unexpected error: {outside_error}"
        );
    }

    #[test]
    fn image_read_rejects_directories() {
        let workspace = TestWorkspace::new();
        let root = workspace.path().join("allowed");
        std::fs::create_dir(&root).expect("create allowed root");

        let error = read_image_bytes(&[root.clone()], root.to_str().unwrap(), false, None, None)
            .expect_err("a directory is not an image byte stream");
        assert!(error.contains("目录"), "unexpected error: {error}");
    }

    #[test]
    fn image_read_enforces_the_twenty_mib_limit() {
        let workspace = TestWorkspace::new();
        let root = workspace.path().join("allowed");
        std::fs::create_dir(&root).expect("create allowed root");
        let image = root.join("oversize.png");
        let file = std::fs::File::create(&image).expect("create oversize image");
        file.set_len(20 * 1024 * 1024 + 1)
            .expect("size oversize image");

        let error = read_image_bytes(&[root], image.to_str().unwrap(), false, None, None)
            .expect_err("images larger than 20 MiB must be rejected before reading");
        assert!(error.contains("20MB"), "unexpected error: {error}");
    }
}
