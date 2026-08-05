//! Zotero 批量导入数据层：
//! 扫描本地 Zotero 7 数据库（collections + 常规条目 + PDF 路径）、库内论文去重键汇总、
//! paper.md 注入 zotero_key、导入状态（collection→文件夹映射 / 论文 zotero_key 状态）读写。

use serde::Serialize;
use sqlx::{Row, SqlitePool};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

// ==================== 返回结构体（camelCase 对齐 JS 消费形状） ====================

/// Zotero collection（分类文件夹）
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ZoteroCollection {
    pub key: String,
    pub name: String,
    pub parent_key: Option<String>,
    pub item_count: i64,
}

/// Zotero 常规条目（论文/书籍等，排除附件与笔记）
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ZoteroItem {
    pub key: String,
    pub title: String,
    pub doi: Option<String>,
    pub year: Option<String>,
    pub first_author: Option<String>,
    pub collection_keys: Vec<String>,
    pub pdf_path: Option<String>,
    pub has_pdf: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ZoteroScanResult {
    pub collections: Vec<ZoteroCollection>,
    pub items: Vec<ZoteroItem>,
}

/// 库内已有论文的去重键（含回收站中的论文，与 save_paper 的"已存在"口径一致）
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PaperDedupKeys {
    pub id: String,
    pub zotero_key: Option<String>,
    pub doi: Option<String>,
    pub title: String,
    pub first_author: Option<String>,
    pub year: Option<String>,
}

/// zotero_collections 行：Zotero collection key → SageRead 文件夹 id 映射
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ZoteroCollectionState {
    pub collection_key: String,
    pub folder_id: String,
    pub name: String,
    pub parent_key: Option<String>,
}

/// zotero_paper_state 行：已导入论文的 zotero_key 与其 collection 归属
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ZoteroPaperState {
    pub paper_id: String,
    pub zotero_key: String,
    pub collection_keys: Vec<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ZoteroStateResult {
    pub collections: Vec<ZoteroCollectionState>,
    pub papers: Vec<ZoteroPaperState>,
}

// ==================== 1. 扫描 Zotero 库 ====================

/// 扫描本地 Zotero 7 数据库。防锁：先整库拷贝到临时目录再以只读模式打开，用完即删。
#[tauri::command]
pub async fn zotero_scan_library(data_dir: String) -> Result<ZoteroScanResult, String> {
    let data_path = PathBuf::from(&data_dir);
    let src_db = data_path.join("zotero.sqlite");
    if !src_db.is_file() {
        return Err(format!(
            "未找到 Zotero 数据库：{}，请检查数据目录",
            src_db.display()
        ));
    }

    let tmp_dir = std::env::temp_dir().join(format!(
        "sageread-zotero-scan-{}",
        chrono::Utc::now().timestamp_millis()
    ));
    fs::create_dir_all(&tmp_dir).map_err(|e| format!("创建临时目录失败: {}", e))?;

    // 主库 + 同目录 journal/wal/shm（存在才拷），拷贝失败清场后报错
    let tmp_db = match copy_zotero_db(&data_path, &tmp_dir) {
        Ok(path) => path,
        Err(e) => {
            let _ = fs::remove_dir_all(&tmp_dir);
            return Err(e);
        }
    };

    let db_url = format!("sqlite:{}?mode=ro", tmp_db.display());
    let scan_result = match SqlitePool::connect(&db_url).await {
        Ok(pool) => {
            let result = scan_zotero_db(&pool, &data_path).await;
            pool.close().await;
            result
        }
        Err(e) => Err(format!("打开 Zotero 数据库失败: {}", e)),
    };

    let _ = fs::remove_dir_all(&tmp_dir);
    scan_result
}

/// 拷贝 zotero.sqlite 及同目录 journal/wal/shm 到临时目录，返回拷贝后的库路径
fn copy_zotero_db(data_path: &Path, tmp_dir: &Path) -> Result<PathBuf, String> {
    let tmp_db = tmp_dir.join("zotero.sqlite");
    fs::copy(data_path.join("zotero.sqlite"), &tmp_db)
        .map_err(|e| format!("拷贝 Zotero 数据库失败: {}", e))?;
    for name in [
        "zotero.sqlite-journal",
        "zotero.sqlite-wal",
        "zotero.sqlite-shm",
    ] {
        let src = data_path.join(name);
        if src.is_file() {
            fs::copy(&src, tmp_dir.join(name))
                .map_err(|e| format!("拷贝 {} 失败: {}", name, e))?;
        }
    }
    Ok(tmp_db)
}

async fn scan_zotero_db(pool: &SqlitePool, data_path: &Path) -> Result<ZoteroScanResult, String> {
    // user 库过滤（防御式）：查询失败或为空则不加 libraryID 过滤
    let library_ids: Vec<i64> =
        match sqlx::query_scalar("SELECT libraryID FROM libraries WHERE type = 'user'")
            .fetch_all(pool)
            .await
        {
            Ok(ids) if !ids.is_empty() => ids,
            _ => Vec::new(),
        };
    let lib_filter = |alias: &str| -> String {
        if library_ids.is_empty() {
            String::new()
        } else {
            let list = library_ids
                .iter()
                .map(|id| id.to_string())
                .collect::<Vec<_>>()
                .join(",");
            format!(" AND {}.libraryID IN ({})", alias, list)
        }
    };

    // collections：父 key 经 LEFT JOIN；itemCount 只计常规条目（排除回收站与 attachment/note）
    let collections_sql = format!(
        "SELECT c.key AS collection_key, c.collectionName AS name, p.key AS parent_key, \
         (SELECT COUNT(*) FROM collectionItems ci \
          JOIN items i ON ci.itemID = i.itemID \
          JOIN itemTypes it ON i.itemTypeID = it.itemTypeID \
          WHERE ci.collectionID = c.collectionID \
            AND i.itemID NOT IN (SELECT itemID FROM deletedItems) \
            AND it.typeName NOT IN ('attachment', 'note')) AS item_count \
         FROM collections c \
         LEFT JOIN collections p ON c.parentCollectionID = p.collectionID \
         WHERE 1 = 1{} \
         ORDER BY c.collectionID",
        lib_filter("c")
    );
    let collection_rows = sqlx::query(&collections_sql)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("查询 Zotero 分类失败: {}", e))?;
    let collections: Result<Vec<ZoteroCollection>, sqlx::Error> = collection_rows
        .iter()
        .map(|row| {
            Ok(ZoteroCollection {
                key: row.try_get("collection_key")?,
                name: row.try_get("name")?,
                parent_key: row.try_get("parent_key")?,
                item_count: row.try_get("item_count")?,
            })
        })
        .collect();
    let collections = collections.map_err(|e| format!("解析 Zotero 分类失败: {}", e))?;

    // 常规条目（排除 attachment/note 与回收站）
    let items_sql = format!(
        "SELECT i.itemID AS item_id, i.key AS item_key \
         FROM items i \
         JOIN itemTypes it ON i.itemTypeID = it.itemTypeID \
         WHERE it.typeName NOT IN ('attachment', 'note') \
           AND i.itemID NOT IN (SELECT itemID FROM deletedItems){} \
         ORDER BY i.itemID",
        lib_filter("i")
    );
    let item_rows = sqlx::query(&items_sql)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("查询 Zotero 条目失败: {}", e))?;
    let base_items: Result<Vec<(i64, String)>, sqlx::Error> = item_rows
        .iter()
        .map(|row| Ok((row.try_get("item_id")?, row.try_get("item_key")?)))
        .collect();
    let base_items = base_items.map_err(|e| format!("解析 Zotero 条目失败: {}", e))?;

    // 字段（title/DOI/date）：一次 JOIN 全取，内存按 itemID 归并
    let field_rows = sqlx::query(
        "SELECT idata.itemID AS item_id, f.fieldName AS field_name, v.value AS value \
         FROM itemData idata \
         JOIN fields f ON idata.fieldID = f.fieldID \
         JOIN itemDataValues v ON idata.valueID = v.valueID \
         WHERE f.fieldName IN ('title', 'DOI', 'date')",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("查询 Zotero 条目字段失败: {}", e))?;

    #[derive(Default)]
    struct ItemFields {
        title: Option<String>,
        doi: Option<String>,
        date: Option<String>,
    }
    let mut field_map: HashMap<i64, ItemFields> = HashMap::new();
    for row in &field_rows {
        let item_id: i64 = row
            .try_get("item_id")
            .map_err(|e| format!("解析 Zotero 条目字段失败: {}", e))?;
        let field_name: String = row
            .try_get("field_name")
            .map_err(|e| format!("解析 Zotero 条目字段失败: {}", e))?;
        let value: Option<String> = row
            .try_get("value")
            .map_err(|e| format!("解析 Zotero 条目字段失败: {}", e))?;
        let entry = field_map.entry(item_id).or_default();
        match field_name.as_str() {
            "title" => entry.title = value,
            "DOI" => entry.doi = value,
            "date" => entry.date = value,
            _ => {}
        }
    }

    // 首作者：itemCreators 按 orderIndex 第一行（查询已按 itemID+orderIndex 排序，每篇首行即首作者）；
    // lastName 非空取 lastName（fieldMode=1 时 lastName 即整名），否则 firstName
    let creator_rows = sqlx::query(
        "SELECT ic.itemID AS item_id, c.firstName AS first_name, c.lastName AS last_name \
         FROM itemCreators ic \
         JOIN creators c ON ic.creatorID = c.creatorID \
         ORDER BY ic.itemID, ic.orderIndex",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("查询 Zotero 作者失败: {}", e))?;
    let mut creator_map: HashMap<i64, String> = HashMap::new();
    for row in &creator_rows {
        let item_id: i64 = row
            .try_get("item_id")
            .map_err(|e| format!("解析 Zotero 作者失败: {}", e))?;
        let first_name: Option<String> = row
            .try_get("first_name")
            .map_err(|e| format!("解析 Zotero 作者失败: {}", e))?;
        let last_name: Option<String> = row
            .try_get("last_name")
            .map_err(|e| format!("解析 Zotero 作者失败: {}", e))?;
        let name = [last_name, first_name]
            .into_iter()
            .flatten()
            .find(|n| !n.trim().is_empty());
        if let Some(name) = name {
            creator_map.entry(item_id).or_insert(name);
        }
    }

    // membership：条目 → collection key 数组
    let member_rows = sqlx::query(
        "SELECT ci.itemID AS item_id, c.key AS collection_key \
         FROM collectionItems ci \
         JOIN collections c ON ci.collectionID = c.collectionID \
         ORDER BY ci.itemID, ci.orderIndex",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("查询 Zotero 分类归属失败: {}", e))?;
    let mut member_map: HashMap<i64, Vec<String>> = HashMap::new();
    for row in &member_rows {
        let item_id: i64 = row
            .try_get("item_id")
            .map_err(|e| format!("解析 Zotero 分类归属失败: {}", e))?;
        let collection_key: Option<String> = row
            .try_get("collection_key")
            .map_err(|e| format!("解析 Zotero 分类归属失败: {}", e))?;
        if let Some(key) = collection_key {
            member_map.entry(item_id).or_default().push(key);
        }
    }

    // PDF 附件：linkMode 0/1 的 path 形如 "storage:文件名.pdf"，实际路径 =
    // {data_dir}/storage/{附件 key}/{去掉 "storage:" 的文件名}；linkMode 2 的 path 原样用
    let attach_rows = sqlx::query(
        "SELECT a.parentItemID AS parent_id, a.linkMode AS link_mode, a.path AS path, \
         ai.key AS storage_key \
         FROM itemAttachments a \
         JOIN items ai ON a.itemID = ai.itemID \
         WHERE a.contentType = 'application/pdf' \
           AND a.parentItemID IS NOT NULL \
           AND ai.itemID NOT IN (SELECT itemID FROM deletedItems) \
         ORDER BY a.parentItemID, a.itemID",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("查询 Zotero 附件失败: {}", e))?;
    let mut pdf_map: HashMap<i64, Vec<PathBuf>> = HashMap::new();
    for row in &attach_rows {
        let parent_id: i64 = row
            .try_get("parent_id")
            .map_err(|e| format!("解析 Zotero 附件失败: {}", e))?;
        let link_mode: i64 = row
            .try_get("link_mode")
            .map_err(|e| format!("解析 Zotero 附件失败: {}", e))?;
        let path: Option<String> = row
            .try_get("path")
            .map_err(|e| format!("解析 Zotero 附件失败: {}", e))?;
        let storage_key: Option<String> = row
            .try_get("storage_key")
            .map_err(|e| format!("解析 Zotero 附件失败: {}", e))?;
        let candidate = match (link_mode, path) {
            (0 | 1, Some(p)) => storage_key.map(|key| {
                let file_name = p.strip_prefix("storage:").unwrap_or(p.as_str());
                data_path.join("storage").join(key).join(file_name)
            }),
            (2, Some(p)) => Some(PathBuf::from(p)),
            _ => None,
        };
        if let Some(candidate) = candidate {
            pdf_map.entry(parent_id).or_default().push(candidate);
        }
    }

    let mut items = Vec::with_capacity(base_items.len());
    for (item_id, key) in base_items {
        let fields = field_map.remove(&item_id).unwrap_or_default();
        let title = fields
            .title
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_else(|| "(无标题)".to_string());
        let doi = fields.doi.filter(|d| !d.trim().is_empty());
        let year = fields.date.as_deref().and_then(extract_year);
        let collection_keys = member_map.remove(&item_id).unwrap_or_default();
        // 多个附件取第一个实际存在的；都不存在则取第一个候选路径但 hasPdf=false
        let (pdf_path, has_pdf) = match pdf_map.get(&item_id) {
            Some(candidates) => match candidates.iter().find(|p| p.exists()) {
                Some(p) => (Some(p.to_string_lossy().to_string()), true),
                None => (
                    candidates.first().map(|p| p.to_string_lossy().to_string()),
                    false,
                ),
            },
            None => (None, false),
        };
        items.push(ZoteroItem {
            key,
            title,
            doi,
            year,
            first_author: creator_map.get(&item_id).cloned(),
            collection_keys,
            pdf_path,
            has_pdf,
        });
    }

    Ok(ZoteroScanResult { collections, items })
}

/// 从 date 字符串扫第一个以 "19"/"20" 开头的 4 位数字子串（手写字符扫描，不用 regex）
fn extract_year(date: &str) -> Option<String> {
    let bytes = date.as_bytes();
    let mut i = 0;
    while i + 4 <= bytes.len() {
        if (bytes[i] == b'1' && bytes[i + 1] == b'9' || bytes[i] == b'2' && bytes[i + 1] == b'0')
            && bytes[i + 2].is_ascii_digit()
            && bytes[i + 3].is_ascii_digit()
        {
            return Some(date[i..i + 4].to_string());
        }
        i += 1;
    }
    None
}

// ==================== 2. 库内论文去重键 ====================

/// 库内论文（format='MARKDOWN'，含回收站，与 save_paper 的查重口径一致）的去重键汇总。
/// metadata.json 存在时以其中的 zotero_key/doi/title/author/date 覆盖 books 表字段。
#[tauri::command]
pub async fn list_paper_dedup_keys(app_handle: AppHandle) -> Result<Vec<PaperDedupKeys>, String> {
    let db_pool = get_db_pool(&app_handle).await?;

    let rows = sqlx::query("SELECT id, title, author FROM books WHERE format = 'MARKDOWN'")
        .fetch_all(&db_pool)
        .await
        .map_err(|e| format!("查询论文列表失败: {}", e))?;

    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用目录失败: {}", e))?;

    let mut result = Vec::with_capacity(rows.len());
    for row in &rows {
        let id: String = row
            .try_get("id")
            .map_err(|e| format!("解析论文记录失败: {}", e))?;
        let mut title: String = row
            .try_get("title")
            .map_err(|e| format!("解析论文记录失败: {}", e))?;
        let book_author: Option<String> = row
            .try_get("author")
            .map_err(|e| format!("解析论文记录失败: {}", e))?;

        let mut zotero_key = None;
        let mut doi = None;
        let mut first_author = None;
        let mut year = None;

        let metadata_path = app_data_dir.join("books").join(&id).join("metadata.json");
        if let Ok(content) = fs::read_to_string(&metadata_path) {
            match serde_json::from_str::<serde_json::Value>(&content) {
                Ok(meta) => {
                    if let Some(obj) = meta.as_object() {
                        zotero_key = obj
                            .get("zotero_key")
                            .and_then(|v| v.as_str())
                            .map(str::to_string);
                        doi = obj.get("doi").and_then(|v| v.as_str()).map(str::to_string);
                        if let Some(t) = obj.get("title").and_then(|v| v.as_str()) {
                            title = t.to_string();
                        }
                        // author 数组首元素：对象取 .name，字符串直取
                        first_author = obj
                            .get("author")
                            .and_then(|v| v.as_array())
                            .and_then(|arr| arr.first())
                            .and_then(|a| {
                                a.as_object()
                                    .and_then(|o| o.get("name"))
                                    .and_then(|n| n.as_str())
                                    .or_else(|| a.as_str())
                                    .map(str::to_string)
                            });
                        year = obj
                            .get("date")
                            .and_then(|v| v.as_str())
                            .and_then(extract_year);
                    }
                }
                Err(e) => log::warn!(
                    "解析 metadata.json 失败（{}）: {}",
                    metadata_path.display(),
                    e
                ),
            }
        }

        // metadata 未提供作者时回退到 books.author
        if first_author.is_none() {
            first_author = book_author.filter(|a| !a.trim().is_empty());
        }

        result.push(PaperDedupKeys {
            id,
            zotero_key,
            doi,
            title,
            first_author,
            year,
        });
    }

    Ok(result)
}

// ==================== 3. 注入 zotero_key ====================

/// 把 zotero_key（+ 可选 zotero_pdf_path 源 PDF 回链）注入论文目录：paper.md frontmatter
/// 块内已有对应行则整行替换，否则插到首行 `---` 之后（其余字节不动，LF 写回）；
/// 无 frontmatter 块则不动 paper.md。同目录 metadata.json 存在则写入对应字段（2 空格 pretty），解析失败仅告警。
#[tauri::command]
pub async fn inject_zotero_key(
    paper_dir: String,
    zotero_key: String,
    zotero_pdf_path: Option<String>,
) -> Result<(), String> {
    let dir = PathBuf::from(&paper_dir);
    let paper_path = dir.join("paper.md");
    if !paper_path.is_file() {
        return Err(format!("paper.md 不存在: {}", paper_dir));
    }

    let content =
        fs::read_to_string(&paper_path).map_err(|e| format!("读取 paper.md 失败: {}", e))?;
    let lines: Vec<&str> = content.lines().collect();

    // frontmatter = 首行恰为 --- 到下一行恰为 --- 之间
    let closing = if lines.first() == Some(&"---") {
        lines[1..].iter().position(|l| *l == "---").map(|p| p + 1)
    } else {
        None
    };

    // 待注入键值对（顺序即插入顺序）。zotero_pdf_path 是 Windows 路径含反斜杠，
    // YAML 双引号会把 \ 当转义符，故路径用单引号（仅 '' 需双写转义）
    let yaml_value = |k: &str, v: &str| {
        if k == "zotero_pdf_path" {
            format!("'{}'", v.replace('\'', "''"))
        } else {
            format!("\"{}\"", v.replace('"', "\\\""))
        }
    };
    let mut entries: Vec<(&str, String)> = vec![("zotero_key", zotero_key)];
    if let Some(p) = zotero_pdf_path {
        entries.push(("zotero_pdf_path", p));
    }

    match closing {
        Some(close_idx) => {
            let mut written: Vec<&str> = Vec::new();
            let mut out: Vec<String> = Vec::with_capacity(lines.len() + entries.len());
            for (idx, line) in lines.iter().enumerate() {
                let in_block = idx > 0 && idx < close_idx;
                let matched = in_block
                    .then(|| entries.iter().find(|(k, _)| line.trim_start().starts_with(&format!("{}:", k))))
                    .flatten();
                match matched {
                    Some((k, v)) if !written.contains(k) => {
                        out.push(format!("{}: {}", k, yaml_value(k, v)));
                        written.push(k);
                    }
                    _ => out.push(line.to_string()),
                }
            }
            for (k, v) in &entries {
                if !written.contains(k) {
                    out.insert(1, format!("{}: {}", k, yaml_value(k, v)));
                }
            }
            let mut new_content = out.join("\n");
            if content.ends_with('\n') {
                new_content.push('\n');
            }
            fs::write(&paper_path, new_content)
                .map_err(|e| format!("写入 paper.md 失败: {}", e))?;
        }
        None => log::warn!(
            "paper.md 无 frontmatter 块，跳过 zotero_key 注入: {}",
            paper_dir
        ),
    }

    let metadata_path = dir.join("metadata.json");
    if metadata_path.is_file() {
        let parsed = fs::read_to_string(&metadata_path)
            .ok()
            .and_then(|c| serde_json::from_str::<serde_json::Value>(&c).ok())
            .and_then(|v| v.as_object().cloned());
        match parsed {
            Some(mut obj) => {
                for (k, v) in &entries {
                    obj.insert(k.to_string(), serde_json::Value::String(v.clone()));
                }
                match serde_json::to_string_pretty(&obj) {
                    Ok(json) => {
                        if let Err(e) = fs::write(&metadata_path, json) {
                            log::warn!(
                                "写入 metadata.json 失败（{}）: {}",
                                metadata_path.display(),
                                e
                            );
                        }
                    }
                    Err(e) => log::warn!(
                        "序列化 metadata.json 失败（{}）: {}",
                        metadata_path.display(),
                        e
                    ),
                }
            }
            None => log::warn!("解析 metadata.json 失败（{}）", metadata_path.display()),
        }
    }

    Ok(())
}

// ==================== 4. 导入状态读取 ====================

/// 全量导入状态：collection→文件夹映射 + 论文 zotero_key 状态
#[tauri::command]
pub async fn zotero_get_state(app_handle: AppHandle) -> Result<ZoteroStateResult, String> {
    let db_pool = get_db_pool(&app_handle).await?;

    let collection_rows =
        sqlx::query("SELECT collection_key, folder_id, name, parent_key FROM zotero_collections")
            .fetch_all(&db_pool)
            .await
            .map_err(|e| format!("查询 Zotero 文件夹映射失败: {}", e))?;
    let collections: Result<Vec<ZoteroCollectionState>, sqlx::Error> = collection_rows
        .iter()
        .map(|row| {
            Ok(ZoteroCollectionState {
                collection_key: row.try_get("collection_key")?,
                folder_id: row.try_get("folder_id")?,
                name: row.try_get("name")?,
                parent_key: row.try_get("parent_key")?,
            })
        })
        .collect();
    let collections = collections.map_err(|e| format!("解析 Zotero 文件夹映射失败: {}", e))?;

    let paper_rows =
        sqlx::query("SELECT paper_id, zotero_key, collection_keys FROM zotero_paper_state")
            .fetch_all(&db_pool)
            .await
            .map_err(|e| format!("查询 Zotero 论文状态失败: {}", e))?;
    let papers: Result<Vec<ZoteroPaperState>, sqlx::Error> = paper_rows
        .iter()
        .map(|row| {
            let raw: String = row.try_get("collection_keys")?;
            Ok(ZoteroPaperState {
                paper_id: row.try_get("paper_id")?,
                zotero_key: row.try_get("zotero_key")?,
                collection_keys: serde_json::from_str(&raw).unwrap_or_default(),
            })
        })
        .collect();
    let papers = papers.map_err(|e| format!("解析 Zotero 论文状态失败: {}", e))?;

    Ok(ZoteroStateResult {
        collections,
        papers,
    })
}

// ==================== 5/6. 导入状态写入 ====================

/// 记录/更新 Zotero collection → SageRead 文件夹的映射（INSERT OR REPLACE）
#[tauri::command]
pub async fn zotero_upsert_collection(
    app_handle: AppHandle,
    collection_key: String,
    folder_id: String,
    name: String,
    parent_key: Option<String>,
) -> Result<(), String> {
    let db_pool = get_db_pool(&app_handle).await?;

    sqlx::query(
        "INSERT OR REPLACE INTO zotero_collections \
         (collection_key, folder_id, name, parent_key, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&collection_key)
    .bind(&folder_id)
    .bind(&name)
    .bind(&parent_key)
    .bind(chrono::Utc::now().timestamp_millis())
    .execute(&db_pool)
    .await
    .map_err(|e| format!("保存 Zotero 文件夹映射失败: {}", e))?;

    Ok(())
}

/// 记录/更新已导入论文的 zotero_key 与 collection 归属（INSERT OR REPLACE，collection_keys 存 JSON）
#[tauri::command]
pub async fn zotero_upsert_paper_state(
    app_handle: AppHandle,
    paper_id: String,
    zotero_key: String,
    collection_keys: Vec<String>,
) -> Result<(), String> {
    let db_pool = get_db_pool(&app_handle).await?;

    let keys_json = serde_json::to_string(&collection_keys)
        .map_err(|e| format!("序列化 collection_keys 失败: {}", e))?;

    sqlx::query(
        "INSERT OR REPLACE INTO zotero_paper_state \
         (paper_id, zotero_key, collection_keys, updated_at) VALUES (?, ?, ?, ?)",
    )
    .bind(&paper_id)
    .bind(&zotero_key)
    .bind(&keys_json)
    .bind(chrono::Utc::now().timestamp_millis())
    .execute(&db_pool)
    .await
    .map_err(|e| format!("保存 Zotero 论文状态失败: {}", e))?;

    Ok(())
}

async fn get_db_pool(app_handle: &AppHandle) -> Result<SqlitePool, String> {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用目录失败: {}", e))?;

    let db_path = app_data_dir.join("database").join("app.db");
    let db_url = format!("sqlite:{}", db_path.display());

    SqlitePool::connect(&db_url)
        .await
        .map_err(|e| format!("数据库连接失败: {}", e))
}
