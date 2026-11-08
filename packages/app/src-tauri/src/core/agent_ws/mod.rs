pub mod commands;

use serde::Serialize;
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Manager};

/// Agent 工作区（P1）：默认根 {appData}/agent-workspace，用户可在设置改到 Obsidian 库等外部目录。
/// 路径守卫的唯一实现处：所有文件/搜索命令先过 guard 判界内/界外；
/// 界外写入必须带 allow_outside=true（前端确认卡通过后才注入，模型无法自行构造）。

pub(crate) fn default_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用目录失败: {}", e))?
        .join("agent-workspace");
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| format!("创建工作区目录失败: {}", e))?;
    }
    Ok(dir)
}

pub(crate) fn resolve_root(app: &AppHandle, custom: &Option<String>) -> Result<PathBuf, String> {
    match custom {
        Some(c) if !c.trim().is_empty() => {
            let p = PathBuf::from(c);
            if !p.exists() {
                // 用户显式配置的工作区根：不存在则创建（与默认根同语义）
                std::fs::create_dir_all(&p).map_err(|e| format!("创建工作区根目录失败: {}", e))?;
            }
            if !p.is_dir() {
                return Err(format!("工作区根路径不是目录: {}", c));
            }
            Ok(p)
        }
        _ => default_root(app),
    }
}

pub(crate) fn resolve_preview_root(
    app: &AppHandle,
    custom: &Option<String>,
) -> Result<PathBuf, String> {
    resolve_preview_root_with_default(custom, || default_root(app))
}

fn resolve_preview_root_with_default<F>(
    custom: &Option<String>,
    default: F,
) -> Result<PathBuf, String>
where
    F: FnOnce() -> Result<PathBuf, String>,
{
    match custom {
        Some(c) if !c.trim().is_empty() => {
            let p = PathBuf::from(c);
            if !p.exists() {
                return Err(format!("预览目录不存在: {}", c));
            }
            if !p.is_dir() {
                return Err(format!("预览根路径不是目录: {}", c));
            }
            Ok(p)
        }
        _ => default(),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuardVerdict {
    /// "in" = 工作区内；"out" = 工作区外
    pub verdict: &'static str,
    /// 规范化后的绝对路径（展示用，已去 Windows \\?\ 前缀）
    pub resolved: String,
    pub exists: bool,
    pub is_dir: bool,
}

/// 语法层归一：剔除 `.`、弹掉 `..`（不触盘，防 ../../ 逃逸绕过文本前缀判定）
fn syntactic_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            _ => out.push(comp.as_os_str()),
        }
    }
    out
}

/// 绝对化（相对路径相对 root）+ 语法归一 + 尽力 canonicalize：
/// 路径存在则整体解符号链接；不存在则找最近存在的祖先 canonicalize 后拼接尾部。
fn resolve_absolute(root: &Path, path: &str) -> PathBuf {
    let p = PathBuf::from(path);
    let abs = if p.is_absolute() { p } else { root.join(p) };
    let norm = syntactic_normalize(&abs);
    if let Ok(c) = std::fs::canonicalize(&norm) {
        return c;
    }
    // 逐层剥尾部，直到存在可 canonicalize 的祖先
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut cursor: Option<&Path> = Some(norm.as_path());
    while let Some(cur) = cursor {
        if let Ok(c) = std::fs::canonicalize(cur) {
            let mut out = c;
            for part in tail.iter().rev() {
                out.push(part);
            }
            return out;
        }
        match cur.file_name() {
            Some(name) => {
                tail.push(name.to_os_string());
                cursor = cur.parent();
            }
            None => break,
        }
    }
    norm
}

/// 去 Windows canonicalize 产生的 \\?\ 前缀（仅展示层）
pub(crate) fn display_path(p: &Path) -> String {
    let s = p.to_string_lossy().to_string();
    s.strip_prefix(r"\\?\").map(|r| r.to_string()).unwrap_or(s)
}

/// 界内/界外判定。root 调用方保证已存在（resolve_root 负责）。
pub(crate) fn guard(root: &Path, path: &str) -> GuardVerdict {
    guard_with_roots(&[root], path)
}

/// 同一 canonical 目标可属于任一允许根；相对路径仍以第一个根解析。
pub(crate) fn guard_with_roots<P: AsRef<Path>>(roots: &[P], path: &str) -> GuardVerdict {
    let target = resolve_absolute(
        roots
            .first()
            .map(|root| root.as_ref())
            .unwrap_or_else(|| Path::new(".")),
        path,
    );
    let inside = roots.iter().any(|root| {
        let root = root.as_ref();
        let canon_root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
        target.starts_with(canon_root)
    });
    let meta = std::fs::metadata(&target).ok();
    GuardVerdict {
        verdict: if inside { "in" } else { "out" },
        resolved: display_path(&target),
        exists: meta.as_ref().is_some(),
        is_dir: meta.as_ref().is_some_and(|m| m.is_dir()),
    }
}

#[cfg(test)]
mod preview_root_tests {
    use super::resolve_preview_root_with_default;
    use std::fs;

    fn unique_path(label: &str) -> std::path::PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "sageread-preview-{label}-{}-{nonce}",
            std::process::id()
        ))
    }

    #[test]
    fn custom_preview_root_must_exist_and_be_directory() {
        let missing = unique_path("missing");
        let result = resolve_preview_root_with_default(
            &Some(missing.to_string_lossy().into_owned()),
            || unreachable!("自定义根不应走默认目录"),
        );
        assert!(result.is_err());
        assert!(!missing.exists());

        let directory = unique_path("directory");
        fs::create_dir_all(&directory).unwrap();
        let file = directory.join("not-a-directory.txt");
        fs::write(&file, "text").unwrap();
        assert!(resolve_preview_root_with_default(
            &Some(file.to_string_lossy().into_owned()),
            || { unreachable!() }
        )
        .is_err());
        assert_eq!(
            resolve_preview_root_with_default(
                &Some(directory.to_string_lossy().into_owned()),
                || { unreachable!() }
            )
            .unwrap(),
            directory
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn app_managed_default_may_be_materialized() {
        let root = unique_path("default");
        let result = resolve_preview_root_with_default(&None, || {
            fs::create_dir_all(&root).unwrap();
            Ok(root.clone())
        })
        .unwrap();
        assert_eq!(result, root);
        assert!(result.is_dir());
        fs::remove_dir_all(result).unwrap();
    }
}
