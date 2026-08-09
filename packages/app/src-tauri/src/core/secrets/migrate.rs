//! 存量明文密钥迁移器（批次 A2）：启动时一次性把各 JSON 里的 key 搬进 OS 凭据管理器。
//!
//! 幂等：JSON 顶层写入 `"secretsMigratedTo": "keyring"` 标记，见到即跳过。
//! 失败可重入：单字段写 keyring 失败时**保留原值**且不盖迁移标记，下次启动重试；
//! 单个文件迁移失败仅记日志，绝不阻塞 app 启动。

use super::{delete_secret, get_secret, register_secret_name, set_secret};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const MIGRATED_MARK: &str = "secretsMigratedTo";

fn is_migrated(json: &Value) -> bool {
    json.get(MIGRATED_MARK).and_then(|v| v.as_str()) == Some("keyring")
}

fn mark_migrated(json: &mut Value) {
    if let Some(obj) = json.as_object_mut() {
        obj.insert(MIGRATED_MARK.to_string(), Value::String("keyring".to_string()));
    }
}

/// 单字段迁移结果
enum FieldOutcome {
    /// 字段不存在或为空：无事可做
    NoValue,
    /// 已写入 keyring 并置空字段
    Moved,
    /// 写 keyring 失败：字段保留原值，文件不盖迁移标记，下次启动重试
    Failed,
}

#[derive(Default)]
struct MigrateCount {
    moved: usize,
    failed: usize,
}

impl MigrateCount {
    fn tally(&mut self, outcome: FieldOutcome) {
        match outcome {
            FieldOutcome::Moved => self.moved += 1,
            FieldOutcome::Failed => self.failed += 1,
            FieldOutcome::NoValue => {}
        }
    }
}

/// 把 JSON 字符串字段的值搬进 keyring；**仅 set 成功后置空**
/// （旧版先置空再 set，set 失败 + 文件已盖迁移标记 = key 永久丢失）
fn migrate_str_field(
    app: &AppHandle,
    obj: &mut serde_json::Map<String, Value>,
    field: &str,
    category: &str,
    key: &str,
) -> FieldOutcome {
    let Some(value) = obj.get(field).and_then(|v| v.as_str()) else {
        return FieldOutcome::NoValue;
    };
    if value.trim().is_empty() {
        return FieldOutcome::NoValue;
    }
    let value = value.to_string();
    match set_secret(app, category, key, &value) {
        Ok(()) => {
            obj.insert(field.to_string(), Value::String(String::new()));
            FieldOutcome::Moved
        }
        Err(e) => {
            log::warn!("密钥迁移：{category}:{key} 写入凭据管理器失败（{e}），已保留原值，下次启动重试");
            FieldOutcome::Failed
        }
    }
}

fn write_back(path: &PathBuf, json: &Value) -> Result<(), String> {
    let content = serde_json::to_string_pretty(json).map_err(|e| e.to_string())?;
    fs::write(path, content).map_err(|e| e.to_string())
}

fn load_json(path: &PathBuf) -> Option<Value> {
    fs::read_to_string(path).ok().and_then(|c| serde_json::from_str(&c).ok())
}

/// 启动时调用：迁移各 JSON 的明文密钥（localStorage 的 web-search/TTS key 由前端启动时迁移）
pub fn migrate_plaintext_secrets(app: &AppHandle) {
    let Ok(dir) = app.path().app_config_dir() else {
        return;
    };
    let mut moved = 0usize;

    // 1. model-provider.json：modelProviders[].apiKey → model-provider:{providerId}
    moved += migrate_zustand_file(&dir.join("model-provider.json"), |state| {
        let mut count = MigrateCount::default();
        if let Some(providers) = state.get_mut("modelProviders").and_then(|v| v.as_array_mut()) {
            for p in providers {
                let Some(obj) = p.as_object_mut() else { continue };
                let Some(id) = obj.get("provider").and_then(|v| v.as_str()).map(|s| s.to_string()) else {
                    continue;
                };
                count.tally(migrate_str_field(app, obj, "apiKey", "model-provider", &id));
            }
        }
        count
    });

    // 2. llama-store.json：vectorModels[].apiKey → vector-model:{modelId}
    moved += migrate_zustand_file(&dir.join("llama-store.json"), |state| {
        let mut count = MigrateCount::default();
        if let Some(models) = state.get_mut("vectorModels").and_then(|v| v.as_array_mut()) {
            for m in models {
                let Some(obj) = m.as_object_mut() else { continue };
                let Some(id) = obj.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()) else {
                    continue;
                };
                count.tally(migrate_str_field(app, obj, "apiKey", "vector-model", &id));
            }
        }
        count
    });

    // 3. converter-store.json：三个 token → converter:{service}
    moved += migrate_zustand_file(&dir.join("converter-store.json"), |state| {
        let mut count = MigrateCount::default();
        let pairs = [("mineruToken", "mineru"), ("paddleocrToken", "paddleocr"), ("glmApiKey", "glm")];
        if let Some(obj) = state.as_object_mut() {
            for (field, service) in pairs {
                count.tally(migrate_str_field(app, obj, field, "converter", service));
            }
        }
        count
    });

    // 4. webdav-config.json：password → webdav:password（非 zustand 格式，直接顶层）
    {
        let path = dir.join("webdav-config.json");
        if let Some(mut json) = load_json(&path) {
            if !is_migrated(&json) {
                let mut count = MigrateCount::default();
                if let Some(obj) = json.as_object_mut() {
                    count.tally(migrate_str_field(app, obj, "password", "webdav", "password"));
                }
                if count.failed == 0 {
                    mark_migrated(&mut json);
                } else {
                    log::warn!("密钥迁移：webdav-config.json 有写入失败项，不盖迁移标记，下次启动重试");
                }
                if let Err(e) = write_back(&path, &json) {
                    log::warn!("密钥迁移：webdav-config.json 回写失败: {e}");
                }
                moved += count.moved;
            }
        }
    }

    // 5. mcp-servers.json：env 中疑似密钥的值 → 用户保管箱 user:MCP_{serverId}_{envKey}，
    //    JSON 改写为 {{secret:...}} 引用（stdio 启动时 resolve_secret_refs 注入，真值不进 JS）；
    //    非敏感值（如 ZOTERO_LOCAL=true）原样保留。
    //    旧版（批次 A2 初版）曾把全部 env 搬进 mcp: 类别并置空，运行时无读回路径——
    //    此处顺带回收：env 已空而 keyring 仍有 mcp:{serverId}:{envKey} 的，搬入保管箱并补写引用。
    //    本段天然幂等（引用跳过/非敏感保留/无孤儿即无事），故不走迁移标记，每次启动都跑。
    moved += migrate_mcp_env(app, &dir.join("mcp-servers.json"));

    if moved > 0 {
        log::info!("密钥迁移完成：共 {moved} 个密钥已迁入凭据管理器（明文已从配置文件中清除）");
    }
}

/// 通用 zustand persist 文件迁移：{ state: {...}, version } 包装；
/// 幂等 + 失败仅告警；有失败项时不盖迁移标记（下次启动重试失败字段）
fn migrate_zustand_file<F>(path: &PathBuf, extract: F) -> usize
where
    F: FnOnce(&mut Value) -> MigrateCount,
{
    let Some(mut json) = load_json(path) else { return 0 };
    if is_migrated(&json) {
        return 0;
    }
    let count = match json.get_mut("state") {
        Some(state) => extract(state),
        None => extract(&mut json),
    };
    if count.failed == 0 {
        mark_migrated(&mut json);
    } else {
        log::warn!(
            "密钥迁移：{} 有 {} 项写入失败，不盖迁移标记，下次启动重试",
            path.display(),
            count.failed
        );
    }
    if let Err(e) = write_back(path, &json) {
        log::warn!("密钥迁移：{} 回写失败: {e}", path.display());
    }
    count.moved
}

/// env 键名疑似密钥的启发式：含 KEY/TOKEN/SECRET/PASSWORD/AUTH/CREDENTIAL/PRIVATE（大小写不敏感）
fn looks_secret_key(key: &str) -> bool {
    let up = key.to_ascii_uppercase();
    ["KEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD", "AUTH", "CREDENTIAL", "PRIVATE"]
        .iter()
        .any(|pat| up.contains(pat))
}

/// 保管箱名称：MCP_{serverId}_{envKey}，净化到 [A-Za-z0-9_-] 并截断 64（与 validate_secret_name 口径一致）
fn mcp_secret_name(server_id: &str, env_key: &str) -> String {
    format!("MCP_{server_id}_{env_key}")
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .take(64)
        .collect()
}

/// mcp-servers.json env 迁移（见上方第 5 段注释）：搬疑似密钥 + 回收旧版 mcp: 孤儿
fn migrate_mcp_env(app: &AppHandle, path: &PathBuf) -> usize {
    let Some(mut json) = load_json(path) else { return 0 };
    let mut count = MigrateCount::default();
    let mut dirty = false;
    let Some(servers) = json
        .get_mut("state")
        .and_then(|s| s.get_mut("servers"))
        .and_then(|v| v.as_array_mut())
    else {
        return 0;
    };
    for server in servers {
        let Some(obj) = server.as_object_mut() else { continue };
        let Some(id) = obj.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()) else {
            continue;
        };
        let Some(env) = obj.get_mut("env").and_then(|v| v.as_object_mut()) else {
            continue;
        };
        let keys: Vec<String> = env.keys().cloned().collect();
        for k in keys {
            let value = env.get(&k).and_then(|v| v.as_str()).unwrap_or_default().to_string();
            // 已是 {{secret:...}} 引用：跳过
            if value.starts_with("{{secret:") {
                continue;
            }
            let name = mcp_secret_name(&id, &k);
            if value.trim().is_empty() {
                // 旧版孤儿回收：值已空，查 keyring 里是否躺着 mcp:{id}:{key}
                if let Ok(Some(v)) = get_secret(app, "mcp", &format!("{id}:{k}")) {
                    if !v.trim().is_empty() && set_secret(app, "user", &name, &v).is_ok() {
                        let _ = delete_secret(app, "mcp", &format!("{id}:{k}"));
                        register_secret_name(app, &name);
                        env.insert(k.clone(), Value::String(format!("{{{{secret:{name}}}}}")));
                        count.moved += 1;
                        dirty = true;
                    }
                }
                continue;
            }
            // 非敏感值原样保留（如 ZOTERO_LOCAL=true）
            if !looks_secret_key(&k) {
                continue;
            }
            match set_secret(app, "user", &name, &value) {
                Ok(()) => {
                    register_secret_name(app, &name);
                    env.insert(k.clone(), Value::String(format!("{{{{secret:{name}}}}}")));
                    count.moved += 1;
                    dirty = true;
                }
                Err(e) => {
                    log::warn!(
                        "密钥迁移：MCP env {id}:{k} 写入凭据管理器失败（{e}），已保留原值，下次启动重试"
                    );
                }
            }
        }
    }
    if dirty {
        if let Err(e) = write_back(path, &json) {
            log::warn!("密钥迁移：{} 回写失败: {e}", path.display());
        }
    }
    count.moved
}
