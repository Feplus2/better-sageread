//! 开发者 wiki 语料库：编译期嵌入仓库根目录 wiki/*.md + 落盘与内容哈希
//!
//! 与内置使用手册（manual.rs）同款机制，差异仅在于受众与语料：
//! - 手册面向用户（__app_manual__，askAppHelp 检索）；wiki 面向开发者（__repo_wiki__，全局助手 searchDevDocs 检索）
//! - wiki 源文件在仓库根目录 wiki/（开发者在 GitHub 上直接读），include_str! 深相对路径编译期嵌入

use anyhow::{Context, Result};
use std::fs;
use std::path::{Path, PathBuf};

/// wiki 语料库在 books/ 下的保留目录名（即检索时的 book_id）
pub const WIKI_BOOK_DIR: &str = "__repo_wiki__";
pub const WIKI_TITLE: &str = "Better SageRead 开发者 Wiki";
pub const WIKI_AUTHOR: &str = "Better SageRead";

/// wiki 语料文件清单（结构复用手册的 ManualFile：文件名 + 章节标题 + 编译期嵌入内容）
/// 注意路径：src/wiki.rs → 仓库根 wiki/ 需上溯 6 级（src→tauri-plugin-epub→plugins→src-tauri→app→packages→root）
use crate::manual::ManualFile;

pub const WIKI_FILES: &[ManualFile] = &[
    ManualFile {
        filename: "00-index.md",
        title: "项目地图",
        content: include_str!("../../../../../../wiki/00-index.md"),
    },
    ManualFile {
        filename: "01-architecture.md",
        title: "总体架构",
        content: include_str!("../../../../../../wiki/01-architecture.md"),
    },
    ManualFile {
        filename: "02-data-model.md",
        title: "数据模型与存储布局",
        content: include_str!("../../../../../../wiki/02-data-model.md"),
    },
    ManualFile {
        filename: "03-sync.md",
        title: "备份与同步协议",
        content: include_str!("../../../../../../wiki/03-sync.md"),
    },
    ManualFile {
        filename: "04-agent.md",
        title: "Agent 系统",
        content: include_str!("../../../../../../wiki/04-agent.md"),
    },
    ManualFile {
        filename: "05-papers-pipeline.md",
        title: "转换与解析管线",
        content: include_str!("../../../../../../wiki/05-papers-pipeline.md"),
    },
    ManualFile {
        filename: "06-dev-workflow.md",
        title: "开发工作流",
        content: include_str!("../../../../../../wiki/06-dev-workflow.md"),
    },
];

/// wiki 语料库根目录（{app_data}/books/__repo_wiki__）
pub fn wiki_book_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("books").join(WIKI_BOOK_DIR)
}

/// FNV-1a 64 位哈希（无新依赖）：判断 wiki 内容是否变化
pub fn wiki_content_hash() -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for file in WIKI_FILES {
        for byte in file.filename.as_bytes().iter().chain(file.content.as_bytes()) {
            hash ^= *byte as u64;
            hash = hash.wrapping_mul(0x100000001b3);
        }
    }
    format!("{hash:016x}")
}

/// 把 wiki 原文落盘到 mdbook/（幂等：内容一致时跳过写入；顺带清掉已下线文件的历史残留）
pub fn ensure_wiki_files(app_data_dir: &Path) -> Result<PathBuf> {
    let mdbook_dir = wiki_book_dir(app_data_dir).join("mdbook");
    fs::create_dir_all(&mdbook_dir).context("创建 wiki 目录失败")?;

    let current: std::collections::HashSet<&str> = WIKI_FILES.iter().map(|f| f.filename).collect();
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

    for file in WIKI_FILES {
        let path = mdbook_dir.join(file.filename);
        let up_to_date = fs::read_to_string(&path)
            .map(|existing| existing == file.content)
            .unwrap_or(false);
        if !up_to_date {
            fs::write(&path, file.content).with_context(|| format!("写入 wiki 文件失败: {}", path.display()))?;
        }
    }
    Ok(mdbook_dir)
}

/// 读取 meta.json 里的内容哈希（不存在/损坏返回 None）
pub fn read_indexed_hash(app_data_dir: &Path) -> Option<String> {
    let meta_path = wiki_book_dir(app_data_dir).join("meta.json");
    let content = fs::read_to_string(meta_path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&content).ok()?;
    value.get("hash")?.as_str().map(|s| s.to_string())
}

/// 写入内容哈希到 meta.json
pub fn write_indexed_hash(app_data_dir: &Path, hash: &str) -> Result<()> {
    let meta_path = wiki_book_dir(app_data_dir).join("meta.json");
    let content = serde_json::json!({
        "hash": hash,
        "indexed_at": chrono::Utc::now().timestamp_millis(),
    });
    fs::write(meta_path, serde_json::to_vec_pretty(&content)?).context("写入 wiki 索引元信息失败")
}
