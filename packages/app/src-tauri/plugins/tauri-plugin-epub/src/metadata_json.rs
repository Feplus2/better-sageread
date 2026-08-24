//! metadata.json 读改写的进程内串行化。
//!
//! 背景：论文的 metadata.json 有多个并发写者——翻译服务（title_zh/abstract_zh、
//! translationRunState 戳记，TS 侧）、向量化版本锚（vectorizedSourceHash，本插件）、
//! Zotero 回链（zotero_key/zotero_pdf_path，app 侧）。翻译 × 向量化按冲突矩阵允许并行，
//! 各自「读-改-写」整文件存在互覆窗口（后写者用陈旧快照覆盖先写者的字段）。
//! 本模块把读改写收进一把全局锁：所有写者走 patch_metadata_json 即互斥。

use std::path::Path;
use std::sync::Mutex;

static METADATA_JSON_LOCK: Mutex<()> = Mutex::new(());

/// 读改写 metadata.json：合并 patch 字段（不动其他字段），全程持全局锁串行化。
/// 锁中毒时取回守卫继续（写文件失败本就按各自语义降级，不因一次 panic 永久死锁）。
/// 文件不存在/损坏返回 Err，由调用方决定降级口径。
pub fn patch_metadata_json(
    meta_path: &Path,
    patch: &serde_json::Map<String, serde_json::Value>,
) -> anyhow::Result<()> {
    let _guard = METADATA_JSON_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let raw = std::fs::read_to_string(meta_path)?;
    let mut metadata: serde_json::Value = serde_json::from_str(&raw)?;
    let obj = metadata
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("metadata.json 顶层不是 JSON 对象"))?;
    for (k, v) in patch {
        obj.insert(k.clone(), v.clone());
    }
    std::fs::write(meta_path, serde_json::to_string_pretty(&metadata)?)?;
    Ok(())
}
