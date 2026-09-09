//! M2 真机 spike 自检（临时模块，仅 debug 安卓构建编译；结论回填 android-port-plan.md 后可移除）
//!
//! 每次启动自动跑一轮，结果经 println! 进 logcat（tag: RustStdoutStderr，过滤 `[M2SPIKE]`）：
//! - sqlite-vec：vec0 虚表创建 / 向量写入 / KNN 查询全链路（M2-1 运行期验证；编译期已由构建绿证明）
//! - keyring：写入→读取→删除回环 + 跨重启持久化探针（M2-2；android-native-keyring-store）

use std::time::{SystemTime, UNIX_EPOCH};

fn report(item: &str, result: &str) {
    // println! 在 Tauri 安卓胶水层被重定向到 logcat（RustStdoutStderr）
    println!("[M2SPIKE] {item}: {result}");
    log::info!("[M2SPIKE] {item}: {result}");
}

fn spike_sqlite_vec() -> String {
    unsafe {
        rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute(
            sqlite_vec::sqlite3_vec_init as *const (),
        )));
    }
    let run = || -> rusqlite::Result<String> {
        let conn = rusqlite::Connection::open_in_memory()?;
        conn.execute_batch(
            "CREATE VIRTUAL TABLE spike_vec USING vec0(embedding float[4]);",
        )?;
        conn.execute("INSERT INTO spike_vec(rowid, embedding) VALUES (1, '[0.1, 0.2, 0.3, 0.4]')", [])?;
        conn.execute("INSERT INTO spike_vec(rowid, embedding) VALUES (2, '[0.9, 0.8, 0.7, 0.6]')", [])?;
        conn.execute("INSERT INTO spike_vec(rowid, embedding) VALUES (3, '[0.11, 0.19, 0.31, 0.39]')", [])?;
        let mut stmt = conn.prepare(
            "SELECT rowid, distance FROM spike_vec WHERE embedding MATCH '[0.1, 0.2, 0.3, 0.4]' AND k = 2 ORDER BY distance",
        )?;
        let rows: Vec<(i64, f64)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(format!("knn={rows:?}"))
    };
    match run() {
        Ok(detail) => format!("OK vec0 建表/写入/KNN 全通 {detail}"),
        Err(e) => format!("FAIL {e}"),
    }
}

fn spike_keyring(app: &tauri::AppHandle) -> String {
    let mut parts: Vec<String> = Vec::new();

    // 1) 回环：写 → 读 → 删（走生产路径 secrets::{set,get,delete}，内部完成安卓存储装配）
    let probe = format!("rt-{}", SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0));
    let set = super::secrets::set_secret(app, "spike", "roundtrip", &probe);
    let got = super::secrets::get_secret(app, "spike", "roundtrip");
    let del = super::secrets::delete_secret(app, "spike", "roundtrip");
    let gone = super::secrets::get_secret(app, "spike", "roundtrip");
    match (set, got, del, gone) {
        (Ok(()), Ok(Some(v)), Ok(()), Ok(None)) if v == probe => {
            parts.push("roundtrip OK（写读一致、删除后不可读）".into())
        }
        (s, g, d, ga) => parts.push(format!("roundtrip FAIL set={s:?} get={g:?} del={d:?} gone={ga:?}")),
    }

    // 2) 跨重启持久化探针：先读上次启动写的值，再写本次时间戳供下次启动验证
    match super::secrets::get_secret(app, "spike", "restart-probe") {
        Ok(Some(prev)) => parts.push(format!("restart-probe 读到上次写入值={prev} → 跨重启持久化成立")),
        Ok(None) => parts.push("restart-probe 首次运行（无历史值，本次写入待下次启动验证）".into()),
        Err(e) => parts.push(format!("restart-probe 读取失败: {e}")),
    }
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    match super::secrets::set_secret(app, "spike", "restart-probe", &format!("boot-{now}")) {
        Ok(()) => parts.push(format!("restart-probe 本次写入 boot-{now}")),
        Err(e) => parts.push(format!("restart-probe 写入失败: {e}")),
    }

    parts.join(" | ")
}

/// 由 lib.rs setup 在 debug 安卓构建中每次启动调用
pub fn run_spike(app: &tauri::AppHandle) {
    report("sqlite-vec", &spike_sqlite_vec());
    report("keyring", &spike_keyring(app));
    seed_mock_ai_provider(app);
}

// ---- M2-5 AI 流式对话 spike：预置 mock 提供商（OpenAI 兼容，走 Tauri fetch）----

/// mock 服务：PC 侧 `node .tmp-e2e/mock-llm.mjs`，经 `adb reverse tcp:4920 tcp:4920` 访问
const MOCK_PROVIDER_JSON: &str = r#"{
  "state": {
    "modelProviders": [
      {
        "name": "M2 Mock",
        "active": true,
        "provider": "m2mock",
        "apiKey": "",
        "baseUrl": "http://127.0.0.1:4920/v1",
        "models": [{ "id": "m2-spike-model", "name": "M2 Spike Model", "active": true }]
      }
    ],
    "selectedModel": { "modelId": "m2-spike-model", "providerId": "m2mock", "providerName": "M2 Mock", "modelName": "M2 Spike Model" },
    "utilityModel": null
  },
  "version": 2
}"#;

/// 预置 mock 提供商配置 + keyring 密钥（幂等：配置文件已存在则不动，防覆盖真机上用户的后续改动）
fn seed_mock_ai_provider(app: &tauri::AppHandle) {
    use tauri::Manager;
    let mut parts: Vec<String> = Vec::new();

    match super::secrets::set_secret(app, "model-provider", "m2mock", "sk-mock") {
        Ok(()) => parts.push("keyring model-provider:m2mock 已写入".into()),
        Err(e) => parts.push(format!("keyring 写入 FAIL {e}")),
    }

    match app.path().app_config_dir() {
        Ok(dir) => {
            let path = dir.join("model-provider.json");
            if let Err(e) = std::fs::create_dir_all(&dir) {
                parts.push(format!("建配置目录 FAIL {e}"));
            }
            // 恒覆写：spike 在 setup 阶段跑（早于 webview hydrate），覆写值即本轮生效值；
            // 测试机专用构建，不考虑保留用户改动
            match std::fs::write(&path, MOCK_PROVIDER_JSON) {
                Ok(()) => parts.push("model-provider.json 已预置 mock 提供商".into()),
                Err(e) => parts.push(format!("写配置 FAIL {e}")),
            }
        }
        Err(e) => parts.push(format!("取配置目录 FAIL {e}")),
    }

    report("ai-provider-seed", &parts.join(" | "));
}

// ---- M2-3 WebDAV 同步 spike ----

/// 测试端点：PC 侧 dufs（`.tools/dufs.exe -A --bind 127.0.0.1 --port 4918 .tmp-webdav-root`），
/// 经 `adb reverse tcp:4918 tcp:4918` 让手机访问 PC 回环口
const SPIKE_WEBDAV_ENDPOINT: &str = "http://127.0.0.1:4918";

/// M2-3：真机走通 L1 备份 + L2 pull/push（数据库就绪后由 setup 的异步任务调用）
pub async fn run_sync_spike(app: &tauri::AppHandle) {
    use super::sync::{backup, commands, engine, models::WebdavConfig, webdav};

    let config = WebdavConfig {
        endpoint: SPIKE_WEBDAV_ENDPOINT.to_string(),
        username: String::new(),
        password: String::new(),
        remote_dir: "bettersageread/backups".to_string(),
        auto_backup: "off".to_string(),
        backup_keep: 3,
        l2_enabled: true,
        sync_frequency: "off".to_string(),
        l2_root: None,
    };

    // 1) 连接性（MKCOL/PROPFIND 通路）
    match webdav::test_connection(&config).await {
        Ok(msg) => report("webdav-conn", &format!("OK {msg}")),
        Err(e) => {
            report("webdav-conn", &format!("FAIL {e}（后续 L1/L2 跳过）"));
            return;
        }
    }

    // 2) 落盘配置（复用正式保存路径：密码进 keyring、JSON 置空——顺带再压一遍安卓 keyring）
    if let Err(e) = commands::sync_save_config(app.clone(), config.clone()).await {
        report("webdav-config", &format!("FAIL {e}（后续 L1/L2 跳过）"));
        return;
    }
    report("webdav-config", "OK 配置已保存");

    let pool = {
        use tauri::Manager;
        let state = app.state::<crate::core::state::AppState>();
        let guard = state.db_pool.lock().await;
        guard.as_ref().cloned()
    };
    let Some(pool) = pool else {
        report("webdav-db", "FAIL 数据库未初始化（后续 L1/L2 跳过）");
        return;
    };

    // 3) L1 全量备份（zip 打包 + 上传 + index 更新）
    match backup::run_backup(app, &pool, &config).await {
        Ok(outcome) => report("webdav-L1-backup", &format!("OK {}", outcome.message)),
        Err(e) => report("webdav-L1-backup", &format!("FAIL {e}")),
    }

    // 4) L2 增量同步一轮（含 ensure 目录树 / push / pull / 修剪）
    match engine::run_sync(app, &pool, &config).await {
        Ok(r) => report(
            "webdav-L2-sync",
            &format!("OK status={} pushed={} pulled={} msg={}", r.status, r.pushed_rows, r.pulled_rows, r.message),
        ),
        Err(e) => report("webdav-L2-sync", &format!("FAIL {e}")),
    }
}
