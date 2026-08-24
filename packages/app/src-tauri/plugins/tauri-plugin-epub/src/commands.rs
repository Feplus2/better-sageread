use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::database::VectorDatabase;
use crate::epub::EpubReader;
use crate::pipeline::{process_epub_to_db, process_manual_to_db, process_paper_to_db};
use crate::models::ProgressUpdate;
use crate::state::EpubState;
use crate::epub::{parse_toc_file, find_toc_ncx_in_mdbook, flatten_toc};
use crate::models::{
    DocumentChunk, ProcessOptions, VectorizerConfig, FlatTocNode,
    ParsedBook, IndexResult, MdbookResult
};
use epub2mdbook::convert_epub_to_mdbook;

/// 按章节标题直读 EPUB 小节原文（P3 兜底：未向量化的书也给阅读助手真实正文通道）。
/// 不依赖向量索引与 mdbook 产物，随读随解析。
#[tauri::command]
pub async fn read_book_section<R: Runtime>(
    app: AppHandle<R>,
    _state: State<'_, EpubState>,
    book_id: String,
    chapter_title: String,
    max_chars: Option<usize>,
) -> Result<crate::epub::SectionReadResult, String> {
    if book_id.trim().is_empty() || chapter_title.trim().is_empty() {
        return Err("book_id / chapter_title is empty".into());
    }
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let epub_path = app_data_dir.join("books").join(&book_id).join("book.epub");
    if !epub_path.exists() {
        return Err(format!("未找到书籍文件: {}", book_id));
    }
    let reader = EpubReader::new().map_err(|e| e.to_string())?;
    reader.read_section(&epub_path, chapter_title.trim(), max_chars.unwrap_or(8000).clamp(500, 30000))
}

/// Parse an EPUB under $AppData/books/{book_id} and return basic metadata.
#[tauri::command]
pub async fn parse_epub<R: Runtime>(
    app: AppHandle<R>,
    _state: State<'_, EpubState>,
    book_id: String,
) -> Result<ParsedBook, String> {
    if book_id.trim().is_empty() {
        return Err("book_id is empty".into());
    }
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let book_dir = app_data_dir.join("books").join(&book_id);
    let epub_path = book_dir.join("book.epub");
    let reader = EpubReader::new().map_err(|e| e.to_string())?;
    let content = reader.read_epub(&epub_path).map_err(|e| e.to_string())?;
    Ok(ParsedBook {
        title: content.title,
        author: content.author,
        chapters: content.chapters.len(),
    })
}

/// Index an EPUB: resolve book_dir from $AppData/books/{book_id},
/// parse, write chapters txt, vectorize and persist locally.
#[tauri::command]
pub async fn index_epub<R: Runtime>(
    app: AppHandle<R>,
    _state: State<'_, EpubState>,
    book_id: String,
    _dimension: Option<usize>,
    embeddings_url: String,
    model: String,
    api_key: Option<String>,
) -> Result<IndexResult, String> {
    if book_id.trim().is_empty() {
        return Err("book_id is empty".into());
    }
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let book_dir = app_data_dir.join("books").join(&book_id);

    #[derive(Serialize, Clone)]
    struct IndexProgressEvent {
        book_id: String,
        current: usize,
        total: usize,
        percent: f32,
        md_file_path: String,
        chunk_index: usize,
        related_chapter_titles: String,
    }

    let app_for_emit = app.clone();
    let book_id_for_emit = book_id.clone();

    let report = process_epub_to_db(
        &book_dir,
        ProcessOptions {
            batch_size: None,
            vectorizer: VectorizerConfig {
                embeddings_url,
                model_name: model,
                api_key,
            },
        },
        Some(move |u: ProgressUpdate| {
            let payload = IndexProgressEvent {
                book_id: book_id_for_emit.clone(),
                current: u.current,
                total: u.total,
                percent: u.percent,
                md_file_path: u.md_file_path,
                chunk_index: u.chunk_index,
                related_chapter_titles: u.related_chapter_titles,
            };
            let _ = app_for_emit.emit("epub://index-progress", payload);
        }),
    )
    .await
    .map_err(|e| e.to_string())?;

    Ok(IndexResult {
        success: true,
        message: "indexed".into(),
        report: Some(report.into()),
    })
}

/// Convert an EPUB under $AppData/books/{book_id} to mdBook structure at {book_dir}/mdbook
#[tauri::command]
pub async fn convert_to_mdbook<R: Runtime>(
    app: AppHandle<R>,
    _state: State<'_, EpubState>,
    book_id: String,
    overwrite: Option<bool>,
) -> Result<MdbookResult, String> {
    if book_id.trim().is_empty() {
        return Err("book_id is empty".into());
    }

    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let book_dir = app_data_dir.join("books").join(&book_id);
    let epub_path = book_dir.join("book.epub");
    let mdbook_dir = book_dir.join("mdbook");

    if !epub_path.exists() {
        return Err(format!("EPUB not found: {}", epub_path.to_string_lossy()));
    }
    if !mdbook_dir.exists() {
        std::fs::create_dir_all(&mdbook_dir).map_err(|e| e.to_string())?;
    }

    let ow = overwrite.unwrap_or(true);
    log::info!(
        "convert_to_mdbook: book_id={}, epub_path={:?}, output_dir={:?}, overwrite={}",
        book_id,
        epub_path,
        mdbook_dir,
        ow
    );
    match convert_epub_to_mdbook(&epub_path, &mdbook_dir, ow) {
        Ok(_) => {
            log::info!("convert_to_mdbook: success at {:?}", mdbook_dir);
            Ok(MdbookResult {
                success: true,
                message: "converted".into(),
                output_dir: Some(mdbook_dir.to_string_lossy().to_string()),
            })
        }
        Err(e) => {
            log::error!("convert_to_mdbook: failed: {}", e);
            Err(format!("convert epub->mdbook failed: {}", e))
        }
    }
}

/// Parse the TOC structure of an EPUB book, returning a flattened array
#[tauri::command]
pub async fn parse_toc<R: Runtime>(
    app: AppHandle<R>,
    _state: State<'_, EpubState>,
    book_id: String,
) -> Result<Vec<FlatTocNode>, String> {
    if book_id.trim().is_empty() {
        return Err("book_id is empty".into());
    }

    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let book_dir = app_data_dir.join("books").join(&book_id);
    let mdbook_dir = book_dir.join("mdbook");

    // 在 mdbook 目录下递归搜索 toc.ncx
    let toc_path = find_toc_ncx_in_mdbook(&mdbook_dir)
        .ok_or_else(|| "TOC file (toc.ncx) not found in MDBook directory".to_string())?;

    let toc_nodes = parse_toc_file(&toc_path)?;
    let flat_toc = flatten_toc(&toc_nodes);
    Ok(flat_toc)
}

#[derive(Serialize)]
pub struct SearchItemDto {
    pub book_title: String,
    pub book_author: String,
    pub content: String,
    pub similarity: f32,

    // 文件级别信息
    pub md_file_path: String,
    pub file_order_in_book: u32,

    // 章节关联信息
    pub related_chapter_titles: String,

    // 分片位置信息
    pub chunk_id: i64,
    pub chunk_order_in_file: usize,
    pub total_chunks_in_file: usize,
    pub global_chunk_index: usize,
}

/// Search the vector database for similar chunks with hybrid search support.
#[tauri::command]
pub async fn search_db<R: Runtime>(
    app: AppHandle<R>,
    _state: State<'_, EpubState>,
    book_id: String,
    query: String,
    limit: Option<usize>,
    dimension: Option<usize>,
    embeddings_url: String,
    model: String,
    api_key: Option<String>,
    // 新增混合搜索参数
    search_mode: Option<String>,      // "vector", "bm25", "hybrid"
    vector_weight: Option<f32>,       // 向量权重 (0.0-1.0)
    bm25_weight: Option<f32>,         // BM25权重 (0.0-1.0)
    // 是否包含参考文献区段分片（缺省 false：检索默认排除）
    include_references: Option<bool>,
) -> Result<Vec<SearchItemDto>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let book_dir = app_data_dir.join("books").join(book_id);

    // 解析搜索模式
    let mode = search_mode.as_deref().unwrap_or("hybrid");

    let results = crate::pipeline::search_db_with_mode(
        &book_dir,
        &query,
        limit.unwrap_or(5),
        dimension.unwrap_or(1024),
        VectorizerConfig {
            embeddings_url,
            model_name: model,
            api_key,
        },
        mode,
        vector_weight,
        bm25_weight,
        include_references.unwrap_or(false),
    )
    .await
    .map_err(|e| e.to_string())?;

    Ok(results
        .into_iter()
        .map(|r| SearchItemDto {
            book_title: r.book_title,
            book_author: r.book_author,
            content: r.chunk_text,
            similarity: r.similarity_score,
            md_file_path: r.md_file_path,
            file_order_in_book: r.file_order_in_book,
            related_chapter_titles: r.related_chapter_titles,
            chunk_id: r.chunk_id,
            chunk_order_in_file: r.chunk_order_in_file,
            total_chunks_in_file: r.total_chunks_in_file,
            global_chunk_index: r.global_chunk_index,
        })
        .collect())
}

/// Get chunk with context by chunk ID
#[tauri::command]
pub fn get_chunk_with_context<R: Runtime>(
    app: AppHandle<R>,
    _state: State<'_, EpubState>,
    book_id: String,
    chunk_id: i64,
    prev_count: usize,
    next_count: usize,
) -> Result<Vec<DocumentChunkDto>, String> {
    if book_id.trim().is_empty() {
        return Err("book_id is empty".into());
    }
    
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let book_dir = app_data_dir.join("books").join(&book_id);
    let db_path = book_dir.join("vectors.sqlite");
    
    let db = VectorDatabase::new(&db_path, 1024).map_err(|e| e.to_string())?;
    let chunks = db.get_chunk_with_context(chunk_id, prev_count, next_count)
        .map_err(|e| e.to_string())?;
    
    Ok(chunks.into_iter().map(DocumentChunkDto::from).collect())
}

/// Get all chunks for a chapter by title
#[tauri::command]
pub fn get_toc_chunks<R: Runtime>(
    app: AppHandle<R>,
    _state: State<'_, EpubState>,
    book_id: String,
    chapter_title: String,
) -> Result<Vec<DocumentChunkDto>, String> {
    if book_id.trim().is_empty() {
        return Err("book_id is empty".into());
    }

    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let book_dir = app_data_dir.join("books").join(&book_id);
    let db_path = book_dir.join("vectors.sqlite");

    let db = VectorDatabase::new(&db_path, 1024).map_err(|e| e.to_string())?;
    let chunks = db.get_chunks_by_chapter_title(&chapter_title).map_err(|e| e.to_string())?;

    Ok(chunks.into_iter().map(DocumentChunkDto::from).collect())
}

/// Get chunks by global index range
#[tauri::command]
pub fn get_chunks_by_range<R: Runtime>(
    app: AppHandle<R>,
    _state: State<'_, EpubState>,
    book_id: String,
    start_index: usize,
    end_index: usize,
) -> Result<Vec<DocumentChunkDto>, String> {
    if book_id.trim().is_empty() {
        return Err("book_id is empty".into());
    }
    
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let book_dir = app_data_dir.join("books").join(&book_id);
    let db_path = book_dir.join("vectors.sqlite");
    
    let db = VectorDatabase::new(&db_path, 1024).map_err(|e| e.to_string())?;
    let chunks = db.get_chunks_by_global_index_range(start_index, end_index)
        .map_err(|e| e.to_string())?;
    
    Ok(chunks.into_iter().map(DocumentChunkDto::from).collect())
}

#[derive(Serialize)]
pub struct DocumentChunkDto {
    pub id: Option<i64>,
    pub book_title: String,
    pub book_author: String,
    pub md_file_path: String,
    pub file_order_in_book: u32,
    pub related_chapter_titles: String,
    pub chunk_text: String,
    pub chunk_order_in_file: usize,
    pub total_chunks_in_file: usize,
    pub global_chunk_index: usize,
}

impl From<DocumentChunk> for DocumentChunkDto {
    fn from(chunk: DocumentChunk) -> Self {
        Self {
            id: chunk.id,
            book_title: chunk.book_title,
            book_author: chunk.book_author,
            md_file_path: chunk.md_file_path,
            file_order_in_book: chunk.file_order_in_book,
            related_chapter_titles: chunk.related_chapter_titles,
            chunk_text: chunk.chunk_text,
            chunk_order_in_file: chunk.chunk_order_in_file,
            total_chunks_in_file: chunk.total_chunks_in_file,
            global_chunk_index: chunk.global_chunk_index,
        }
    }
}

/* ---------------- 开发者 wiki 语料库（全局助手 searchDevDocs 用） ---------------- */

/// 把 wiki 原文落盘到 {app_data}/books/__repo_wiki__/mdbook/（幂等），返回目录路径。
#[tauri::command]
pub async fn prepare_wiki_files<R: Runtime>(
    app: AppHandle<R>,
    _state: State<'_, EpubState>,
) -> Result<String, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let dir = crate::wiki::ensure_wiki_files(&app_data_dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

/// 构建/更新 wiki 向量索引（内容哈希不变且非 force 时跳过，返回 up-to-date）
#[tauri::command]
pub async fn index_wiki<R: Runtime>(
    app: AppHandle<R>,
    _state: State<'_, EpubState>,
    embeddings_url: String,
    model: String,
    api_key: Option<String>,
    force: Option<bool>,
) -> Result<IndexResult, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;

    crate::wiki::ensure_wiki_files(&app_data_dir).map_err(|e| e.to_string())?;

    let current_hash = crate::wiki::wiki_content_hash();
    let db_exists = crate::wiki::wiki_book_dir(&app_data_dir)
        .join("vectors.sqlite")
        .exists();
    let up_to_date = db_exists && crate::wiki::read_indexed_hash(&app_data_dir).as_deref() == Some(&current_hash);

    if up_to_date && !force.unwrap_or(false) {
        return Ok(IndexResult {
            success: true,
            message: "up-to-date".into(),
            report: None,
        });
    }

    let report = process_manual_to_db(
        crate::wiki::wiki_book_dir(&app_data_dir),
        crate::wiki::WIKI_TITLE,
        crate::wiki::WIKI_AUTHOR,
        crate::wiki::WIKI_FILES,
        ProcessOptions {
            batch_size: None,
            vectorizer: VectorizerConfig {
                embeddings_url,
                model_name: model,
                api_key,
            },
        },
    )
    .await
    .map_err(|e| e.to_string())?;

    crate::wiki::write_indexed_hash(&app_data_dir, &current_hash).map_err(|e| e.to_string())?;

    Ok(IndexResult {
        success: true,
        message: "indexed".into(),
        report: Some(report.into()),
    })
}

/* ---------------- 内置使用手册语料库 ---------------- */

/// 把手册原文落盘到 {app_data}/books/__app_manual__/mdbook/（幂等），返回目录路径。
/// 关键词降级检索（无向量能力时）只需文件落盘，不需要 Embedding 配置。
#[tauri::command]
pub async fn prepare_manual_files<R: Runtime>(
    app: AppHandle<R>,
    _state: State<'_, EpubState>,
) -> Result<String, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let dir = crate::manual::ensure_manual_files(&app_data_dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

/// 构建/更新手册向量索引（手册内容哈希不变且非 force 时跳过，返回 up-to-date）
#[tauri::command]
pub async fn index_manual<R: Runtime>(
    app: AppHandle<R>,
    _state: State<'_, EpubState>,
    embeddings_url: String,
    model: String,
    api_key: Option<String>,
    force: Option<bool>,
) -> Result<IndexResult, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;

    // 原文始终先落盘（索引与降级检索共用），再按内容哈希判断是否需要重建索引
    crate::manual::ensure_manual_files(&app_data_dir).map_err(|e| e.to_string())?;

    let current_hash = crate::manual::manual_content_hash();
    let db_exists = crate::manual::manual_book_dir(&app_data_dir)
        .join("vectors.sqlite")
        .exists();
    let up_to_date = db_exists && crate::manual::read_indexed_hash(&app_data_dir).as_deref() == Some(&current_hash);

    if up_to_date && !force.unwrap_or(false) {
        return Ok(IndexResult {
            success: true,
            message: "up-to-date".into(),
            report: None,
        });
    }

    let report = process_manual_to_db(
        crate::manual::manual_book_dir(&app_data_dir),
        crate::manual::MANUAL_TITLE,
        crate::manual::MANUAL_AUTHOR,
        crate::manual::MANUAL_FILES,
        ProcessOptions {
            batch_size: None,
            vectorizer: VectorizerConfig {
                embeddings_url,
                model_name: model,
                api_key,
            },
        },
    )
    .await
    .map_err(|e| e.to_string())?;

    crate::manual::write_indexed_hash(&app_data_dir, &current_hash).map_err(|e| e.to_string())?;

    Ok(IndexResult {
        success: true,
        message: "indexed".into(),
        report: Some(report.into()),
    })
}


/* ---------------- 全局论文向量库 ---------------- */

/// 向量化一篇论文：读 {app_data}/books/{paper_id}/paper.md，写入全局库
/// {app_data}/papers/vectors.sqlite（先按 paper_id 删后插，重索引幂等）
#[tauri::command]
pub async fn index_paper<R: Runtime>(
    app: AppHandle<R>,
    _state: State<'_, EpubState>,
    paper_id: String,
    title: String,
    author: String,
    _dimension: Option<u32>,
    embeddings_url: String,
    model: String,
    api_key: Option<String>,
) -> Result<IndexResult, String> {
    if paper_id.trim().is_empty() {
        return Err("paper_id is empty".into());
    }
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let paper_dir = app_data_dir.join("books").join(&paper_id);
    let db_path = app_data_dir.join("papers").join("vectors.sqlite");

    #[derive(Serialize, Clone)]
    struct PaperIndexProgressEvent {
        paper_id: String,
        current: usize,
        total: usize,
        percent: f32,
        md_file_path: String,
        chunk_index: usize,
        related_chapter_titles: String,
    }

    let app_for_emit = app.clone();
    let paper_id_for_emit = paper_id.clone();

    let report = process_paper_to_db(
        &paper_id,
        &paper_dir,
        &db_path,
        &title,
        &author,
        ProcessOptions {
            batch_size: None,
            vectorizer: VectorizerConfig {
                embeddings_url,
                model_name: model,
                api_key,
            },
        },
        Some(move |u: ProgressUpdate| {
            let payload = PaperIndexProgressEvent {
                paper_id: paper_id_for_emit.clone(),
                current: u.current,
                total: u.total,
                percent: u.percent,
                md_file_path: u.md_file_path,
                chunk_index: u.chunk_index,
                related_chapter_titles: u.related_chapter_titles,
            };
            let _ = app_for_emit.emit("paper://index-progress", payload);
        }),
    )
    .await
    .map_err(|e| e.to_string())?;

    // 版本锚：metadata.json.vectorizedSourceHash = 当前 paper.md 的 sourceHash（sha256 截 16 hex，
    // 与 app 侧 scan_papers_dir 的 id 算法同口径）。重解析会换新 metadata.json 并清空向量分片，
    // 锚随之失效 → get_paper_source_status 判 stale；写锚失败仅告警（方向安全：保持 stale）
    if let Err(e) = record_vectorized_source_hash(&app_data_dir, &paper_id) {
        log::warn!("记录论文向量版本锚失败 (paper_id={}): {}", paper_id, e);
    }

    Ok(IndexResult {
        success: true,
        message: "indexed".into(),
        report: Some(report.into()),
    })
}

/// 向量化完成后把版本锚写进 {app_data}/books/{paper_id}/metadata.json
/// （读改写走全局锁串行化——与翻译戳记/Zotero 回链并发互不覆盖；sourceHash = paper.md 内容 sha256 截 16 hex）
fn record_vectorized_source_hash(app_data_dir: &std::path::Path, paper_id: &str) -> anyhow::Result<()> {
    use sha2::Digest;
    let book_dir = app_data_dir.join("books").join(paper_id);
    let content = std::fs::read(book_dir.join("paper.md"))?;
    let source_hash = format!("{:x}", sha2::Sha256::digest(&content))[..16].to_string();

    let mut patch = serde_json::Map::new();
    patch.insert(
        "vectorizedSourceHash".to_string(),
        serde_json::Value::String(source_hash),
    );
    crate::metadata_json::patch_metadata_json(&book_dir.join("metadata.json"), &patch)
}

#[derive(Serialize)]
pub struct PaperSearchItemDto {
    pub paper_id: String,
    // 论文标题（存于 document_chunks.book_title）
    pub book_title: String,
    pub book_author: String,
    pub content: String,
    pub similarity: f32,

    // 文件级别信息
    pub md_file_path: String,
    pub file_order_in_book: u32,

    // 分片位置信息
    pub chunk_id: i64,
    pub chunk_order_in_file: usize,
    pub total_chunks_in_file: usize,
    pub global_chunk_index: usize,
}

/// 检索全局论文向量库：hybrid 融合（提供嵌入配置时）或 BM25 降级，
/// paper_ids 为 Some 时按论文集合过滤（Some(空集) 返回空，None 不过滤）
#[tauri::command]
pub async fn search_papers_db<R: Runtime>(
    app: AppHandle<R>,
    _state: State<'_, EpubState>,
    query: String,
    paper_ids: Option<Vec<String>>,
    top_k: Option<usize>,
    vector_weight: Option<f32>,
    bm25_weight: Option<f32>,
    // 嵌入配置：缺省时降级为 BM25 检索
    embeddings_url: Option<String>,
    model: Option<String>,
    api_key: Option<String>,
    // 是否包含参考文献区段分片（缺省 false：检索默认排除）
    include_references: Option<bool>,
) -> Result<Vec<PaperSearchItemDto>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let db_path = app_data_dir.join("papers").join("vectors.sqlite");

    let vectorizer = embeddings_url
        .filter(|url| !url.trim().is_empty())
        .map(|url| VectorizerConfig {
            embeddings_url: url,
            model_name: model.unwrap_or_default(),
            api_key,
        });

    let results = crate::pipeline::search_papers_global(
        &db_path,
        &query,
        paper_ids,
        top_k.unwrap_or(5),
        vectorizer,
        vector_weight,
        bm25_weight,
        include_references.unwrap_or(false),
    )
    .await
    .map_err(|e| e.to_string())?;

    Ok(results
        .into_iter()
        .map(|r| PaperSearchItemDto {
            paper_id: r.paper_id,
            book_title: r.book_title,
            book_author: r.book_author,
            content: r.chunk_text,
            similarity: r.similarity_score,
            md_file_path: r.md_file_path,
            file_order_in_book: r.file_order_in_book,
            chunk_id: r.chunk_id,
            chunk_order_in_file: r.chunk_order_in_file,
            total_chunks_in_file: r.total_chunks_in_file,
            global_chunk_index: r.global_chunk_index,
        })
        .collect())
}

/// 按 chunk_id 取全局论文库中该分块的前后邻居（同一 paper_id 内按 global_chunk_index 扩展），
/// 供 paperSearch 命中片段不足时扩展上下文；库不存在时返回空数组
#[tauri::command]
pub async fn get_paper_chunk_context<R: Runtime>(
    app: AppHandle<R>,
    _state: State<'_, EpubState>,
    chunk_id: i64,
    before: Option<usize>,
    after: Option<usize>,
) -> Result<Vec<DocumentChunkDto>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let db_path = app_data_dir.join("papers").join("vectors.sqlite");

    if !db_path.exists() {
        return Ok(Vec::new());
    }

    let db = VectorDatabase::open_for_search(&db_path, 1024).map_err(|e| e.to_string())?;
    let chunks = db
        .get_paper_chunk_context(chunk_id, before.unwrap_or(2), after.unwrap_or(2))
        .map_err(|e| e.to_string())?;

    Ok(chunks.into_iter().map(DocumentChunkDto::from).collect())
}

/// 批量中文分词（jieba，text/zh_segmenter.rs）：论文词级对齐的中文侧分词。
/// 每条文本独立输出 token 序列（UTF-16 偏移，与 JS string 下标一致；空白/标点/符号已过滤）。
/// 纯 CPU 短任务（句级文本、百条量级毫秒级），同步命令即可。
#[tauri::command]
pub fn tokenize_zh(texts: Vec<String>) -> Vec<Vec<crate::text::zh_segmenter::ZhToken>> {
    crate::text::zh_segmenter::tokenize_zh(&texts)
}

#[cfg(test)]
mod tests {
    use super::record_vectorized_source_hash;

    #[test]
    fn test_record_vectorized_source_hash() {
        let dir = tempfile::tempdir().unwrap();
        let book_dir = dir.path().join("books").join("paper-x");
        std::fs::create_dir_all(&book_dir).unwrap();
        std::fs::write(book_dir.join("paper.md"), "# Hello").unwrap();
        std::fs::write(book_dir.join("metadata.json"), r#"{"title":"Hello","title_zh":"你好"}"#).unwrap();

        record_vectorized_source_hash(dir.path(), "paper-x").unwrap();

        let metadata: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(book_dir.join("metadata.json")).unwrap()).unwrap();
        // 版本锚写入，且与 scan_papers_dir 的 id 算法同口径（sha256("# Hello") 截 16 hex）
        use sha2::Digest;
        let expected = format!("{:x}", sha2::Sha256::digest(b"# Hello"));
        assert_eq!(
            metadata["vectorizedSourceHash"].as_str().unwrap(),
            &expected[..16]
        );
        // 读改写：其他字段原样保留
        assert_eq!(metadata["title"].as_str().unwrap(), "Hello");
        assert_eq!(metadata["title_zh"].as_str().unwrap(), "你好");
    }

    #[test]
    fn test_record_vectorized_source_hash_missing_paper() {
        let dir = tempfile::tempdir().unwrap();
        // paper.md 缺失 → 报错（调用方降级为告警，不阻断向量化结果）
        assert!(record_vectorized_source_hash(dir.path(), "paper-none").is_err());
    }
}
