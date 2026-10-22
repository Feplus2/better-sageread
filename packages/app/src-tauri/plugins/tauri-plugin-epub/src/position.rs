//! 阅读位置桥（2026-10-20）：foliate 阅读位置 ↔ mdbook 文本坐标。
//!
//! 前端（services/reading-position/position-service.ts）把渲染层采集的原始位置交给这里的
//! 三个命令，换算成「md 文件字符偏移 + 估算分块区间」，供提示词注入 / 工具按位置读原文：
//!   - resolve_reading_position：书籍（EPUB/spine href）→ mdbook md 坐标；
//!   - resolve_paper_position：论文（正文去 frontmatter 字符偏移）→ paper.md 坐标；
//!   - read_position_window：按字符窗口读 md 原文（UTF-8 安全）。
//!
//! mdbook 产物缺失时幂等触发一次 EPUB→mdbook 转换：进程内用 OnceLock<Mutex<HashSet>>
//! 单飞登记，避免并发重复转换。

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, Runtime};

use crate::database::{ChunkStats, VectorDatabase};
use epub2mdbook::convert_epub_to_mdbook;

/// 阅读位置坐标（camelCase 序列化给前端，见 types/reading-position.ts ResolvedPositionCoordinates）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedCoordinates {
    /// mdbook 内相对路径：书籍如 "OEBPS/Text/part012.md"；论文固定 "paper.md"
    pub md_rel_path: String,
    /// md 文件字符数（UTF-8 字符，非字节）
    pub md_length: usize,
    /// 估算的字符偏移（书籍 = 本章 fraction × md 长度；论文 = frontmatter 长度 + 正文比例偏移）
    pub char_offset: usize,
    /// 文件内位置百分比 0..100
    pub percent_in_doc: f64,
    /// 是否已建向量索引（无索引时只有字符坐标，没有分块区间）
    pub indexed: bool,
    /// 估算命中分块区间起点（0-based global_chunk_index；无索引为 null）
    pub chunk_range_start: Option<i64>,
    /// 估算命中分块区间终点（0-based global_chunk_index；无索引为 null）
    pub chunk_range_end: Option<i64>,
    /// 该书/论文分块总数（无索引为 null）
    pub chunk_total: Option<usize>,
    /// 书籍 spine 总数（前端自带，本桥恒为 null）
    pub spine_total: Option<usize>,
}

/// 按位置读原文窗口的返回（camelCase 序列化，见 types/reading-position.ts PositionWindow）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PositionWindow {
    pub text: String,
    /// 本次返回的起始字符偏移
    pub start: usize,
    /// 本次返回的结束字符偏移（exclusive）
    pub end: usize,
    /// md 文件总字符数
    pub total_length: usize,
    pub md_rel_path: String,
    /// 后续续读建议 offset（= end；到末尾为 null）
    pub next_offset: Option<usize>,
}

/* ---------------- 命令 ---------------- */

/// 书籍阅读位置 → mdbook md 坐标。mdbook 产物缺失时幂等触发转换。
#[tauri::command]
pub async fn resolve_reading_position<R: Runtime>(
    app: AppHandle<R>,
    book_id: String,
    section_href: String,
    section_fraction: f64,
    loc_current: usize,
    loc_total: usize,
) -> Result<ResolvedCoordinates, String> {
    if book_id.trim().is_empty() {
        return Err("book_id is empty".into());
    }
    // 契约保留参数：spineTotal 由前端自带，不使用 loc 进度
    let _ = (loc_current, loc_total);

    let app_data = app_data_dir(&app)?;
    let book_dir = app_data.join("books").join(&book_id);
    let src_root = ensure_mdbook_src_root(&book_dir)?;

    let rel = html_href_to_md_rel(&section_href)?;
    let (md_rel_path, md_abs) = resolve_md_file(&src_root, &rel)?;
    let content = std::fs::read_to_string(&md_abs)
        .map_err(|e| format!("读取 md 文件失败: {} ({})", md_abs.display(), e))?;

    let md_length = content.chars().count();
    let fraction = fraction01(section_fraction);
    let char_offset = ((fraction * md_length as f64).round() as usize).min(md_length);
    let percent_in_doc = fraction * 100.0;

    let stats = book_chunk_stats(&book_dir, &md_abs);
    let (indexed, chunk_range_start, chunk_range_end, chunk_total) = chunk_fields(stats, fraction);

    Ok(ResolvedCoordinates {
        md_rel_path,
        md_length,
        char_offset,
        percent_in_doc,
        indexed,
        chunk_range_start,
        chunk_range_end,
        chunk_total,
        spine_total: None,
    })
}

/// 论文阅读位置 → paper.md 坐标（正文偏移按去掉 YAML frontmatter 的原文比例换算回全文偏移）。
#[tauri::command]
pub async fn resolve_paper_position<R: Runtime>(
    app: AppHandle<R>,
    paper_id: String,
    char_offset: usize,
    doc_length: usize,
) -> Result<ResolvedCoordinates, String> {
    if paper_id.trim().is_empty() {
        return Err("paper_id is empty".into());
    }

    let app_data = app_data_dir(&app)?;
    let paper_dir = app_data.join("books").join(&paper_id);
    let md_path = paper_dir.join("paper.md");
    let raw = std::fs::read_to_string(&md_path)
        .map_err(|e| format!("读取论文 paper.md 失败: {} ({})", md_path.display(), e))?;

    let md_length = raw.chars().count();
    let fm_len = frontmatter_prefix_chars(&raw);
    let body_raw_len = md_length.saturating_sub(fm_len);
    // 正文比例：char_offset / doc_length（前端 doc_length = parsePaperSections 的 body 字符数）
    let ratio = if doc_length > 0 {
        fraction01(char_offset as f64 / doc_length as f64)
    } else {
        0.0
    };
    let raw_body_offset = (ratio * body_raw_len as f64).round() as usize;
    let abs_char_offset = (fm_len + raw_body_offset).min(md_length);
    let percent_in_doc = ratio * 100.0;

    // 分块按全文（含 frontmatter）位置比例估算：分片是对整个 paper.md 顺序切的
    let chunk_ratio = if md_length > 0 {
        abs_char_offset as f64 / md_length as f64
    } else {
        0.0
    };
    let stats = paper_chunk_stats(&app_data, &paper_id);
    let (indexed, chunk_range_start, chunk_range_end, chunk_total) =
        chunk_fields(stats, chunk_ratio);

    Ok(ResolvedCoordinates {
        md_rel_path: "paper.md".to_string(),
        md_length,
        char_offset: abs_char_offset,
        percent_in_doc,
        indexed,
        chunk_range_start,
        chunk_range_end,
        chunk_total,
        spine_total: None,
    })
}

/// 按位置读 md 原文窗口（按字符而非字节切分，UTF-8 安全）。
#[tauri::command]
pub async fn read_position_window<R: Runtime>(
    app: AppHandle<R>,
    kind: String,
    id: String,
    rel_path: String,
    offset: usize,
    max_chars: usize,
) -> Result<PositionWindow, String> {
    if id.trim().is_empty() {
        return Err("id is empty".into());
    }
    let max_chars = max_chars.clamp(1, 100_000);
    let app_data = app_data_dir(&app)?;

    let (md_path, md_rel_path) = match kind.as_str() {
        "book" => {
            let book_dir = app_data.join("books").join(&id);
            let src_root = ensure_mdbook_src_root(&book_dir)?;
            let rel = normalize_rel_path(&rel_path)?;
            let candidate = src_root.join(&rel);
            // 安全边界：canonicalize 后必须落在 mdbook src 根内（防 ../ 越界）
            let canonical_root = std::fs::canonicalize(&src_root)
                .map_err(|e| format!("mdbook src 根不可用: {} ({})", src_root.display(), e))?;
            let canonical_md = std::fs::canonicalize(&candidate)
                .map_err(|e| format!("md 文件不存在: {} ({})", candidate.display(), e))?;
            if !canonical_md.starts_with(&canonical_root) {
                return Err(format!("rel_path 越界：{} 不在 mdbook src 根内", rel_path));
            }
            (canonical_md, rel)
        }
        "paper" => (
            app_data.join("books").join(&id).join("paper.md"),
            "paper.md".to_string(),
        ),
        other => return Err(format!("未知 kind: {}（应为 book / paper）", other)),
    };

    let content = std::fs::read_to_string(&md_path)
        .map_err(|e| format!("读取 md 文件失败: {} ({})", md_path.display(), e))?;
    let (text, start, end, total_length) = char_window(&content, offset, max_chars);

    Ok(PositionWindow {
        text,
        start,
        end,
        total_length,
        md_rel_path,
        next_offset: if end < total_length { Some(end) } else { None },
    })
}

/* ---------------- mdbook 产物发现 / 幂等转换 ---------------- */

/// 进程内转换登记表：同一本书并发请求只触发一次 EPUB→mdbook 转换
fn mdbook_conversions() -> &'static Mutex<std::collections::HashSet<String>> {
    static CONVERTING: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();
    CONVERTING.get_or_init(|| Mutex::new(std::collections::HashSet::new()))
}

/// 确保 mdbook 产物存在并返回 src 根目录；缺失时幂等触发一次转换。
fn ensure_mdbook_src_root(book_dir: &Path) -> Result<PathBuf, String> {
    let mdbook_dir = book_dir.join("mdbook");
    if let Some(src) = find_mdbook_src_root(&mdbook_dir) {
        return Ok(src);
    }

    let epub_path = find_epub_file(book_dir)
        .ok_or_else(|| format!("mdbook 产物缺失且未找到 EPUB: {}", book_dir.display()))?;
    let key = book_dir.to_string_lossy().to_string();

    // 失败/并发结束时允许重试一次
    for _attempt in 0..2 {
        if let Some(src) = find_mdbook_src_root(&mdbook_dir) {
            return Ok(src);
        }

        let ours = {
            let mut converting = mdbook_conversions()
                .lock()
                .map_err(|_| "mdbook 转换登记表已被 poison".to_string())?;
            if converting.contains(&key) {
                false
            } else {
                converting.insert(key.clone());
                true
            }
        };

        if ours {
            log::info!(
                "阅读位置桥：mdbook 产物缺失，幂等触发 EPUB→mdbook 转换（book_dir={:?}）",
                book_dir
            );
            let convert_result = convert_epub_to_mdbook(&epub_path, &mdbook_dir, true);
            if let Ok(mut converting) = mdbook_conversions().lock() {
                converting.remove(&key);
            }
            convert_result.map_err(|e| format!("EPUB→mdbook 转换失败: {}", e))?;
            return find_mdbook_src_root(&mdbook_dir).ok_or_else(|| {
                format!("转换完成但未找到 mdbook src 根: {}", mdbook_dir.display())
            });
        }

        // 其他调用正在转换：轮询等待其完成（成功即返回；失败则跳出循环重试一次）
        let deadline = Instant::now() + Duration::from_secs(180);
        loop {
            if let Some(src) = find_mdbook_src_root(&mdbook_dir) {
                return Ok(src);
            }
            let still_converting = mdbook_conversions()
                .lock()
                .map(|converting| converting.contains(&key))
                .unwrap_or(false);
            if !still_converting {
                break;
            }
            if Instant::now() >= deadline {
                return Err(format!("等待 mdbook 转换超时: {}", mdbook_dir.display()));
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }

    Err(format!(
        "mdbook 产物不可用（并发转换重试后仍失败）: {}",
        mdbook_dir.display()
    ))
}

/// 在 mdbook 目录下定位 src 根（含任意 .md 的目录）。
/// epub2mdbook(with_file_name=true) 的约定布局是 mdbook/<book_name>/src，其余布局递归兜底。
pub(crate) fn find_mdbook_src_root(mdbook_dir: &Path) -> Option<PathBuf> {
    if !mdbook_dir.is_dir() {
        return None;
    }
    // 约定布局：mdbook/<book_name>/src（SUMMARY.md 必在 src 根）
    if let Ok(entries) = std::fs::read_dir(mdbook_dir) {
        let mut children: Vec<PathBuf> = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.is_dir())
            .collect();
        children.sort();
        for child in &children {
            let src = child.join("src");
            if dir_has_md(&src) {
                return Some(src);
            }
        }
    }
    let direct = mdbook_dir.join("src");
    if dir_has_md(&direct) {
        return Some(direct);
    }
    find_src_dir_recursive(mdbook_dir, 0, 4)
}

fn dir_has_md(dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    entries.flatten().any(|entry| {
        let path = entry.path();
        path.is_file()
            && path
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.eq_ignore_ascii_case("md"))
                .unwrap_or(false)
    })
}

fn find_src_dir_recursive(dir: &Path, depth: usize, max_depth: usize) -> Option<PathBuf> {
    if depth > max_depth {
        return None;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return None;
    };
    let mut children: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    children.sort();
    for child in &children {
        if child.file_name().and_then(|name| name.to_str()) == Some("src") && dir_has_md(child) {
            return Some(child.clone());
        }
    }
    for child in &children {
        if let Some(found) = find_src_dir_recursive(child, depth + 1, max_depth) {
            return Some(found);
        }
    }
    None
}

fn find_epub_file(book_dir: &Path) -> Option<PathBuf> {
    let default = book_dir.join("book.epub");
    if default.is_file() {
        return Some(default);
    }
    let entries = std::fs::read_dir(book_dir).ok()?;
    let mut candidates: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .map(|ext| ext.eq_ignore_ascii_case("epub"))
                    .unwrap_or(false)
        })
        .collect();
    candidates.sort();
    candidates.into_iter().next()
}

/* ---------------- 路径换算 ---------------- */

/// section_href → mdbook 内 md 相对路径。
/// 去 #fragment、反斜杠转斜杠、去前导 ./、.xhtml/.html（大小写不敏感）换 .md；拒绝含 .. 的段。
pub(crate) fn html_href_to_md_rel(href: &str) -> Result<String, String> {
    let bare = href.split('#').next().unwrap_or("").trim();
    let normalized = normalize_rel_path(bare)?;
    Ok(replace_html_ext_with_md(&normalized))
}

/// 相对路径归一化：反斜杠转斜杠、去前导 ./ 与空段、拒绝 .. 段。
pub(crate) fn normalize_rel_path(path: &str) -> Result<String, String> {
    let unified = path.trim().replace('\\', "/");
    let mut segments: Vec<&str> = Vec::new();
    for segment in unified.trim_start_matches('/').split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            return Err(format!("非法路径（含 .. 段）: {}", path));
        }
        segments.push(segment);
    }
    if segments.is_empty() {
        return Err("空路径".to_string());
    }
    Ok(segments.join("/"))
}

/// .xhtml / .html（大小写不敏感）扩展名替换为 .md
pub(crate) fn replace_html_ext_with_md(path: &str) -> String {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".xhtml") {
        return format!("{}.md", &path[..path.len() - ".xhtml".len()]);
    }
    if lower.ends_with(".html") {
        return format!("{}.md", &path[..path.len() - ".html".len()]);
    }
    path.to_string()
}

/// 在 src 根下定位 md 文件：先按相对路径直取；失败则按 rel 后缀递归匹配唯一文件。
fn resolve_md_file(src_root: &Path, rel: &str) -> Result<(String, PathBuf), String> {
    let direct = src_root.join(rel);
    if direct.is_file() {
        return Ok((rel.to_string(), direct));
    }

    let mut md_files: Vec<PathBuf> = Vec::new();
    collect_md_files(src_root, &mut md_files, 0);
    let suffix = format!("/{}", rel);
    let mut matched: Option<(String, PathBuf)> = None;
    for file in md_files {
        let Some(actual_rel) = relative_slash_path(src_root, &file) else {
            continue;
        };
        if actual_rel == rel || actual_rel.ends_with(&suffix) {
            if let Some((previous, _)) = &matched {
                return Err(format!(
                    "md 文件后缀匹配到多个候选（{} / {}），无法唯一定位: {}",
                    previous, actual_rel, rel
                ));
            }
            matched = Some((actual_rel, file));
        }
    }
    matched.ok_or_else(|| {
        format!(
            "mdbook 中未找到与 {} 对应的 md 文件（src 根: {}）",
            rel,
            src_root.display()
        )
    })
}

fn relative_slash_path(base: &Path, file: &Path) -> Option<String> {
    file.strip_prefix(base)
        .ok()
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
}

fn collect_md_files(dir: &Path, out: &mut Vec<PathBuf>, depth: usize) {
    if depth > 8 || out.len() > 20_000 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut children: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).collect();
    children.sort();
    for path in children {
        if path.is_dir() {
            let hidden = path
                .file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.starts_with('.'))
                .unwrap_or(false);
            if !hidden {
                collect_md_files(&path, out, depth + 1);
            }
        } else if path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("md"))
            .unwrap_or(false)
        {
            out.push(path);
        }
    }
}

/* ---------------- 分块统计 ---------------- */

fn book_chunk_stats(book_dir: &Path, md_abs: &Path) -> Option<ChunkStats> {
    let db_path = book_dir.join("vectors.sqlite");
    if !db_path.is_file() {
        return None;
    }
    let db = match VectorDatabase::open_for_search(&db_path, 1024) {
        Ok(db) => db,
        Err(e) => {
            log::warn!("阅读位置桥：打开书籍向量库失败（降级为无分块区间）: {}", e);
            return None;
        }
    };
    match db.chunk_stats_by_md_path(&md_abs.to_string_lossy()) {
        Ok(stats) => stats,
        Err(e) => {
            log::warn!(
                "阅读位置桥：读取书籍分块统计失败（降级为无分块区间）: {}",
                e
            );
            None
        }
    }
}

/// 论文单篇索引状态（Agent getDocumentInfo 用；不依赖 RAG 查询即可判断能否语义检索）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperIndexStatus {
    pub indexed: bool,
    pub chunk_count: usize,
}

#[tauri::command]
pub async fn paper_index_status<R: Runtime>(
    app: AppHandle<R>,
    paper_id: String,
) -> Result<PaperIndexStatus, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(match paper_chunk_stats(&app_data, &paper_id) {
        Some(stats) => PaperIndexStatus { indexed: stats.count > 0, chunk_count: stats.count },
        None => PaperIndexStatus { indexed: false, chunk_count: 0 },
    })
}

pub(crate) fn paper_chunk_stats(app_data: &Path, paper_id: &str) -> Option<ChunkStats> {
    let db_path = app_data.join("papers").join("vectors.sqlite");
    if !db_path.is_file() {
        return None;
    }
    let db = match VectorDatabase::open_for_search(&db_path, 1024) {
        Ok(db) => db,
        Err(e) => {
            log::warn!("阅读位置桥：打开论文向量库失败（降级为无分块区间）: {}", e);
            return None;
        }
    };
    match db.chunk_stats_by_paper_id(paper_id) {
        Ok(stats) => stats,
        Err(e) => {
            log::warn!(
                "阅读位置桥：读取论文分块统计失败（降级为无分块区间）: {}",
                e
            );
            None
        }
    }
}

/// 分块估算：idx = round(ratio*(count-1))；区间 = [clamp(min+idx-1), clamp(min+idx)]。
fn estimate_chunk_span(stats: &ChunkStats, ratio: f64) -> (i64, i64) {
    let count = stats.count as i64;
    if count <= 0 {
        return (stats.min_global_index, stats.max_global_index);
    }
    let ratio = if ratio.is_finite() {
        ratio.clamp(0.0, 1.0)
    } else {
        0.0
    };
    let idx = (ratio * (count - 1) as f64).round() as i64;
    let start =
        (stats.min_global_index + idx - 1).clamp(stats.min_global_index, stats.max_global_index);
    let end = (stats.min_global_index + idx).clamp(start, stats.max_global_index);
    (start, end)
}

fn chunk_fields(
    stats: Option<ChunkStats>,
    ratio: f64,
) -> (bool, Option<i64>, Option<i64>, Option<usize>) {
    match stats {
        Some(stats) => {
            let (start, end) = estimate_chunk_span(&stats, ratio);
            // range 是全局 chunk 索引，分母用 scope 总数（书籍=全书、论文=本篇），
            // 不能用单文件分块数（会出现 145–146/91 这类自相矛盾的展示）
            (true, Some(start), Some(end), Some(stats.total))
        }
        None => (false, None, None, None),
    }
}

/* ---------------- 纯函数小工具 ---------------- */

fn app_data_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {}", e))
}

/// NaN / 非有限值收敛到 0，其余 clamp 到 [0,1]
fn fraction01(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

/// 按字符（非字节）切 [offset, offset+max_chars)，返回 (text, start, end, total)
fn char_window(content: &str, offset: usize, max_chars: usize) -> (String, usize, usize, usize) {
    let total = content.chars().count();
    let start = offset.min(total);
    let end = start.saturating_add(max_chars).min(total);
    let text: String = content
        .chars()
        .skip(start)
        .take(end.saturating_sub(start))
        .collect();
    (text, start, end, total)
}

/// 开头 YAML frontmatter 的字符长度（含起止 --- 行与结尾换行；无 frontmatter 返回 0）。
/// 对齐前端 paper-metadata.ts 的 FRONTMATTER_RE：首行 ---（可带行尾空白），
/// 后接 LF（可带 CR），再找下一个独立 --- 行；未闭合则不剥离。
pub(crate) fn frontmatter_prefix_chars(text: &str) -> usize {
    let bytes = text.as_bytes();
    if !bytes.starts_with(b"---") {
        return 0;
    }
    let mut cursor = 3usize;
    while cursor < bytes.len() && (bytes[cursor] == b' ' || bytes[cursor] == b'\t') {
        cursor += 1;
    }
    if cursor < bytes.len() && bytes[cursor] == b'\r' {
        cursor += 1;
    }
    if cursor >= bytes.len() || bytes[cursor] != b'\n' {
        return 0;
    }
    cursor += 1;

    let mut line_start = cursor;
    while line_start < bytes.len() {
        if bytes[line_start..].starts_with(b"---") {
            let mut after = line_start + 3;
            while after < bytes.len() && (bytes[after] == b' ' || bytes[after] == b'\t') {
                after += 1;
            }
            let closed = after == bytes.len() || bytes[after] == b'\n' || bytes[after] == b'\r';
            if closed {
                let prefix_end = if after >= bytes.len() {
                    after
                } else if bytes[after] == b'\r' {
                    if after + 1 < bytes.len() && bytes[after + 1] == b'\n' {
                        after + 2
                    } else {
                        after + 1
                    }
                } else {
                    after + 1
                };
                return text[..prefix_end].chars().count();
            }
        }
        match bytes[line_start..].iter().position(|&byte| byte == b'\n') {
            Some(relative) => line_start += relative + 1,
            None => return 0,
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- section_href → md 相对路径 ----

    #[test]
    fn test_html_href_to_md_rel() {
        assert_eq!(
            html_href_to_md_rel("OEBPS/Text/part012.xhtml#sec1").unwrap(),
            "OEBPS/Text/part012.md"
        );
        // 反斜杠、大小写扩展名
        assert_eq!(
            html_href_to_md_rel("OEBPS\\Text\\Part001.HTML").unwrap(),
            "OEBPS/Text/Part001.md"
        );
        // 前导 ./
        assert_eq!(
            html_href_to_md_rel("./OEBPS/Text/a.xhtml").unwrap(),
            "OEBPS/Text/a.md"
        );
        // 已是 .md：原样保留
        assert_eq!(
            html_href_to_md_rel("OEBPS/Text/a.md").unwrap(),
            "OEBPS/Text/a.md"
        );
        // 非 html 扩展名：不替换
        assert_eq!(
            html_href_to_md_rel("OEBPS/Images/cover.png").unwrap(),
            "OEBPS/Images/cover.png"
        );
        // 前导斜杠被去掉（避免 join 时变成根路径）
        assert_eq!(html_href_to_md_rel("/OEBPS/a.xhtml").unwrap(), "OEBPS/a.md");
        // 拒绝 .. 段
        assert!(html_href_to_md_rel("../etc/passwd.xhtml").is_err());
        assert!(html_href_to_md_rel("OEBPS/../../a.xhtml").is_err());
        // 空 / 只有 fragment
        assert!(html_href_to_md_rel("").is_err());
        assert!(html_href_to_md_rel("#anchor").is_err());
    }

    // ---- UTF-8 字符窗口切分 ----

    #[test]
    fn test_char_window_utf8() {
        let content = "a中😀bc";
        // 按字符切：1..3 = 中😀
        let (text, start, end, total) = char_window(content, 1, 2);
        assert_eq!(text, "中😀");
        assert_eq!((start, end, total), (1, 3, 5));
        // 偏移越界：clamp 到末尾，返回空串
        let (text, start, end, total) = char_window(content, 100, 10);
        assert_eq!(text, "");
        assert_eq!((start, end, total), (5, 5, 5));
        // 到末尾：nextOffset 由 end < total 判定为 None
        let (text, start, end, total) = char_window(content, 4, 10);
        assert_eq!((text, start, end, total), ("c".to_string(), 4, 5, 5));
        // 空文件
        let (text, start, end, total) = char_window("", 0, 10);
        assert_eq!((text, start, end, total), (String::new(), 0, 0, 0));
    }

    // ---- frontmatter 剥离 ----

    #[test]
    fn test_frontmatter_prefix_chars() {
        let md = "---\ntitle: 测试\n---\n\n# 正文\n";
        let fm_len = frontmatter_prefix_chars(md);
        assert_eq!(fm_len, 18);
        assert_eq!(md.chars().skip(fm_len).collect::<String>(), "\n# 正文\n");

        // 无 frontmatter
        assert_eq!(frontmatter_prefix_chars("# 标题\n正文"), 0);
        // 未闭合：不剥离
        assert_eq!(frontmatter_prefix_chars("---\ntitle: x\n正文"), 0);
        // 开首行必须独立 ---（"----" 不算）
        assert_eq!(frontmatter_prefix_chars("----\nx\n---\n"), 0);
        // 只有开首行（无换行）不算
        assert_eq!(frontmatter_prefix_chars("---"), 0);
        // 闭合行在文件末尾（无结尾换行）
        assert_eq!(frontmatter_prefix_chars("---\n---"), 7);
        // CRLF 行尾
        assert_eq!(
            frontmatter_prefix_chars("---\r\ntitle: x\r\n---\r\nbody"),
            20
        );
        // 闭合行带行尾空白（"---\n" + "key: v\n" + "---   \n" = 18 字符）
        assert_eq!(frontmatter_prefix_chars("---\nkey: v\n---   \nbody"), 18);
    }

    // ---- 分块估算边界 ----

    #[test]
    fn test_estimate_chunk_span_boundaries() {
        let single = ChunkStats {
            count: 1,
            min_global_index: 5,
            max_global_index: 5,
            total: 1,
        };
        assert_eq!(estimate_chunk_span(&single, 0.0), (5, 5));
        assert_eq!(estimate_chunk_span(&single, 0.7), (5, 5));
        assert_eq!(estimate_chunk_span(&single, 1.0), (5, 5));

        let ten = ChunkStats {
            count: 10,
            min_global_index: 0,
            max_global_index: 9,
            total: 120,
        };
        // 文件开头：区间落在第一个分块
        assert_eq!(estimate_chunk_span(&ten, 0.0), (0, 0));
        // 文件末尾：区间落在最后一个分块
        assert_eq!(estimate_chunk_span(&ten, 1.0), (8, 9));
        // 中间：idx = round(0.5*9) = 5
        assert_eq!(estimate_chunk_span(&ten, 0.5), (4, 5));
        // 非法比例按 0 处理
        assert_eq!(estimate_chunk_span(&ten, f64::NAN), (0, 0));
        assert_eq!(estimate_chunk_span(&ten, -3.0), (0, 0));
        assert_eq!(estimate_chunk_span(&ten, 3.0), (8, 9));

        // 非零起始 global chunk index（论文内连续递增）
        let paper = ChunkStats {
            count: 3,
            min_global_index: 10,
            max_global_index: 12,
            total: 45,
        };
        assert_eq!(estimate_chunk_span(&paper, 0.0), (10, 10));
        // idx = round(0.5*2) = 1 → [clamp(10+0), clamp(10+1)] = (10, 11)
        assert_eq!(estimate_chunk_span(&paper, 0.5), (10, 11));
        // idx = 2 → start = clamp(10+1, 10, 12) = 11；end = clamp(10+2, 11, 12) = 12
        assert_eq!(estimate_chunk_span(&paper, 1.0), (11, 12));
    }

    #[test]
    fn test_fraction01() {
        assert_eq!(fraction01(f64::NAN), 0.0);
        assert_eq!(fraction01(f64::INFINITY), 0.0);
        assert_eq!(fraction01(-0.2), 0.0);
        assert_eq!(fraction01(0.25), 0.25);
        assert_eq!(fraction01(1.2), 1.0);
    }

    #[test]
    fn test_replace_html_ext_with_md() {
        assert_eq!(replace_html_ext_with_md("a/b.XHTML"), "a/b.md");
        assert_eq!(replace_html_ext_with_md("a/b.html"), "a/b.md");
        assert_eq!(replace_html_ext_with_md("a/b.md"), "a/b.md");
        assert_eq!(replace_html_ext_with_md("a/b.png"), "a/b.png");
    }
}
