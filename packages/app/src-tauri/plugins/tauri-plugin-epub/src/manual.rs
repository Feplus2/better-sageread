//! 内置使用手册：编译期嵌入的 Markdown 资源 + 落盘与内容哈希
//!
//! 手册作为"虚拟语料库"存放在 {app_data}/books/__app_manual__/：
//! - mdbook/*.md：手册原文（检索结果可引用真实文件路径，关键词降级检索也读这里）
//! - vectors.sqlite：向量/BM25 索引（process_manual_to_db 构建）
//! - meta.json：内容哈希，判断手册是否随版本更新需要重建索引

use anyhow::{Context, Result};
use std::fs;
use std::path::{Path, PathBuf};

/// 手册语料库在 books/ 下的保留目录名（即检索时的 book_id）
pub const MANUAL_BOOK_DIR: &str = "__app_manual__";
pub const MANUAL_TITLE: &str = "Better SageRead 使用手册";
pub const MANUAL_AUTHOR: &str = "Better SageRead";

/// 一份手册文件：文件名 + 章节标题（检索时作为 related_chapter_titles 返回）+ 编译期嵌入内容
pub struct ManualFile {
    pub filename: &'static str,
    pub title: &'static str,
    pub content: &'static str,
}

pub const MANUAL_FILES: &[ManualFile] = &[
    ManualFile {
        filename: "01-overview.md",
        title: "总览与快速上手",
        content: include_str!("../resources/manual/01-overview.md"),
    },
    ManualFile {
        filename: "02-library.md",
        title: "图书馆与书籍阅读器",
        content: include_str!("../resources/manual/02-library.md"),
    },
    ManualFile {
        filename: "03-papers.md",
        title: "文献库与论文",
        content: include_str!("../resources/manual/03-papers.md"),
    },
    ManualFile {
        filename: "04-ai.md",
        title: "AI 助手与 Agent",
        content: include_str!("../resources/manual/04-ai.md"),
    },
    ManualFile {
        filename: "05-translation.md",
        title: "书籍对照翻译",
        content: include_str!("../resources/manual/05-translation.md"),
    },
    ManualFile {
        filename: "06-sync.md",
        title: "备份与同步",
        content: include_str!("../resources/manual/06-sync.md"),
    },
    ManualFile {
        filename: "07-appearance.md",
        title: "外观、主题与个性化",
        content: include_str!("../resources/manual/07-appearance.md"),
    },
    ManualFile {
        filename: "08-converter.md",
        title: "PDF 转换与 Zotero 导入",
        content: include_str!("../resources/manual/08-converter.md"),
    },
    ManualFile {
        filename: "09-faq.md",
        title: "常见问题与故障排查",
        content: include_str!("../resources/manual/09-faq.md"),
    },
];

/// 手册语料库根目录（{app_data}/books/__app_manual__）
pub fn manual_book_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("books").join(MANUAL_BOOK_DIR)
}

/// FNV-1a 64 位哈希（无新依赖）：判断手册内容是否变化
pub fn manual_content_hash() -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for file in MANUAL_FILES {
        for byte in file.filename.as_bytes().iter().chain(file.content.as_bytes()) {
            hash ^= *byte as u64;
            hash = hash.wrapping_mul(0x100000001b3);
        }
    }
    format!("{hash:016x}")
}

/// 把手册原文落盘到 mdbook/（幂等：内容一致时跳过写入；顺带清掉已下线章节的历史残留文件，
/// 否则关键词降级检索与手册页会把旧章节也读出来）
/// 返回 mdbook 目录路径；索引构建与关键词降级检索都读这里的文件
pub fn ensure_manual_files(app_data_dir: &Path) -> Result<PathBuf> {
    let mdbook_dir = manual_book_dir(app_data_dir).join("mdbook");
    fs::create_dir_all(&mdbook_dir).context("创建手册目录失败")?;

    let current: std::collections::HashSet<&str> = MANUAL_FILES.iter().map(|f| f.filename).collect();
    if let Ok(entries) = fs::read_dir(&mdbook_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            if let Some(name) = name.to_str() {
                if name.ends_with(".md") && !current.contains(name) {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
    }

    for file in MANUAL_FILES {
        let path = mdbook_dir.join(file.filename);
        let up_to_date = fs::read_to_string(&path)
            .map(|existing| existing == file.content)
            .unwrap_or(false);
        if !up_to_date {
            fs::write(&path, file.content).with_context(|| format!("写入手册文件失败: {}", path.display()))?;
        }
    }
    Ok(mdbook_dir)
}

/// 读取 meta.json 里的内容哈希（不存在/损坏返回 None）
pub fn read_indexed_hash(app_data_dir: &Path) -> Option<String> {
    let meta_path = manual_book_dir(app_data_dir).join("meta.json");
    let content = fs::read_to_string(meta_path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&content).ok()?;
    value.get("hash")?.as_str().map(|s| s.to_string())
}

/// 写入内容哈希到 meta.json
pub fn write_indexed_hash(app_data_dir: &Path, hash: &str) -> Result<()> {
    let meta_path = manual_book_dir(app_data_dir).join("meta.json");
    let content = serde_json::json!({
        "hash": hash,
        "indexed_at": chrono::Utc::now().timestamp_millis(),
    });
    fs::write(meta_path, serde_json::to_vec_pretty(&content)?).context("写入手册索引元信息失败")
}
