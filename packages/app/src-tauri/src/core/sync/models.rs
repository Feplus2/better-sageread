use serde::{Deserialize, Serialize};

fn default_remote_dir() -> String {
    "bettersageread/backups".to_string()
}

fn default_auto_backup() -> String {
    "off".to_string()
}

fn default_backup_keep() -> usize {
    10
}

pub fn default_sync_frequency() -> String {
    "30s".to_string()
}

/// WebDAV 连接配置（只存本地 webdav-config.json，不进备份包）
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct WebdavConfig {
    pub endpoint: String,
    pub username: String,
    pub password: String,
    #[serde(default = "default_remote_dir")]
    pub remote_dir: String,
    /// 自动备份频率：off / hourly / daily（前端 setInterval 实现）
    #[serde(default = "default_auto_backup")]
    pub auto_backup: String,
    /// 备份保留份数（轮转时只保留最新 N 份，默认 10）
    #[serde(default = "default_backup_keep")]
    pub backup_keep: usize,
    /// L2 增量同步开关
    #[serde(default)]
    pub l2_enabled: bool,
    /// L2 同步频率：off / 30s / 5min / 30min
    #[serde(default = "default_sync_frequency")]
    pub sync_frequency: String,
    /// L2 云端根目录覆盖：None=默认 bettersageread/sync；
    /// 服务器拒绝 MOVE（如坚果云 403）时落为旧目录 bettersageread-sync，保证同步不断
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub l2_root: Option<String>,
}

/// L2 云端根目录解析：覆盖值优先，缺省用统一新布局
pub fn l2_root(config: &WebdavConfig) -> &str {
    config.l2_root.as_deref().unwrap_or("bettersageread/sync")
}

/// 备份包内的清单文件（manifest.json）
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct BackupManifest {
    pub format: String, // 固定 "bettersageread-backup"
    pub version: u32,
    pub created_at: i64,
    pub device: String,
    pub app_version: String,
    pub contents: Vec<String>,
    pub db_sha256: String,
    /// v2 大包资产清单（sha256 内容寻址，存于 bettersageread/backups/assets/）；v1 备份无此字段
    #[serde(default)]
    pub assets: Vec<AssetRef>,
}

/// 大包资产包（manifest v3）：按捆上传——每本书一包、字体/背景/工作区/聊天附件各一捆、向量库单文件。
/// 请求数从"文件数"压到"书数+5"（WebDAV 频率限流的治本）；内容清单哈希不变则永不重传。
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AssetRef {
    /// 包类型：book / fonts / backgrounds / workspace / vectors / attachments
    pub kind: String,
    /// 包名：book id 或固定名（fonts/backgrounds/workspace/vectors/attachments）
    pub name: String,
    /// 包内容清单哈希（目录内全部文件 path+sha256 的组合哈希；向量库为文件哈希）
    pub sha256: String,
    /// 包 zip 体积（字节）
    pub size: u64,
}

impl AssetRef {
    /// 云端包文件名（内容寻址：哈希变了就是新文件，旧文件由 GC 回收）
    pub fn bundle_remote_name(&self) -> String {
        format!("{}-{}-{}.zip", self.kind, self.name, &self.sha256[..16.min(self.sha256.len())])
    }
}

/// 云端资产池索引（asset-bundles-index.json）：
/// 记录每个备份引用了哪些资产捆，供轮转 GC 计算孤儿（不读各备份 manifest，省下载）
#[derive(Serialize, Deserialize, Debug, Default, Clone)]
pub struct AssetsIndex {
    /// backup_name -> 引用的资产内容哈希列表
    pub by_backup: std::collections::HashMap<String, Vec<String>>,
    /// 内容哈希 -> 捆 zip 体积（判存/统计用）
    pub sizes: std::collections::HashMap<String, u64>,
    /// 内容哈希 -> 云端捆文件名（GC 删除孤儿时按名删——文件名含捆名，无法从哈希反推）
    #[serde(default)]
    pub bundle_files: std::collections::HashMap<String, String>,
}

/// 小包 JSON 收集策略：配置目录顶层 *.json 全收，减去此排除清单
/// - sync-state.json：L2 设备身份，进包会致两端撞 device_id
/// - secrets-fallback.json：keyring 降级时的明文密钥，永不上云
/// - pending-restore.json / backup-assets-cache.json：本机运行态
pub const CONFIG_JSON_EXCLUDES: [&str; 4] = [
    "sync-state.json",
    "secrets-fallback.json",
    "pending-restore.json",
    "backup-assets-cache.json",
];

/// 远端 index.json 里的列表项（用清单文件代替 PROPFIND 解析，简单可靠）
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct BackupInfo {
    pub name: String,
    pub size: u64,
    pub created_at: i64,
    pub device: String,
    pub app_version: String,
    pub db_sha256: String,
}

/// 本地 sync-state.json：上次备份状态与包哈希（无变化检测用）
#[derive(Serialize, Deserialize, Debug, Default, Clone)]
pub struct SyncState {
    pub last_backup_at: Option<i64>,
    pub last_backup_name: Option<String>,
    pub last_db_sha256: Option<String>,
    /// 整包内容哈希（db+全部 JSON+themes+资产清单）：v2 无变化检测口径（v1 只比 db）
    #[serde(default)]
    pub last_pack_sha256: Option<String>,
    pub last_result: Option<String>,

    /* ---- L2 增量同步状态（协议 §3） ---- */
    /// 设备身份：首次同步生成 UUID 持久化
    #[serde(default)]
    pub device_id: Option<String>,
    /// 本地变更日志已推送到的序号
    #[serde(default)]
    pub last_pushed_seq: Option<i64>,
    /// 每台远端设备已应用到本地的 changeset 序号
    #[serde(default)]
    pub last_pulled: Option<std::collections::HashMap<String, i64>>,
    #[serde(default)]
    pub last_l2_sync_at: Option<i64>,
    #[serde(default)]
    pub last_l2_result: Option<String>,
    /// 首次全量引导完成时间（存量回填进 _sync_log，协议 §11 2c）
    #[serde(default)]
    pub bootstrapped_at: Option<i64>,
    /// 已为其做过存量回填引导的他端设备 id（防重复 dump）
    #[serde(default)]
    pub bootstrap_peers: Vec<String>,
    /// 每包应用失败次数（key = device_id/seq_end）：失败不推水位下轮重试，满 3 次跳过
    #[serde(default)]
    pub failed_packs: std::collections::HashMap<String, u8>,
    /// 每包传输性失败次数（解压失败等半截包，key 同上）：不计入内容性 3 次上限，
    /// 独立计次满更高天花板（40 轮）才按永久坏包跳过（P3 修复，audit P3）
    #[serde(default)]
    pub failed_packs_transient: std::collections::HashMap<String, u8>,
    /// 云端目录布局（sageread/{sync,backups}）已完成迁移的 endpoint（防重复 PROPFIND）
    #[serde(default)]
    pub cloud_layout_migrated_for: Option<String>,
}

/// 备份执行结果（uploaded=已上传，skipped=无变化跳过）
#[derive(Serialize, Debug)]
pub struct BackupOutcome {
    pub status: String,
    pub message: String,
    pub backup_name: Option<String>,
}
