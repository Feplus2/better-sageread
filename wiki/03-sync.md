# 03 · 备份与同步协议

> 代码基线：`packages/app/src-tauri/src/core/sync/`（12 个文件，engine.rs 约 2400 行）。设计文档 `docs/sync-protocol.md` 与 `docs/sync-testing-guide.md` 成文于 2026-07，此后云端根目录已从 `sageread/` 更名为 `bettersageread/`（文档未跟进），凡文档写 `sageread/...` 处代码均为 `bettersageread/...`。本章以代码为准。
>
> 两层体系：**L1 = 完整备份**（整包搬家，容灾/换机），**L2 = 增量同步**（多设备日常同步）。

## 1. L1 完整备份（"完整搬家"）

### Manifest（当前是 v3）

`BackupManifest`（`sync/models.rs:51-63`）：`format`（固定 `"bettersageread-backup"`）、`version`、`created_at`、`device`（机器名，`backup.rs:50-54`）、`app_version`、`contents`、`db_sha256`、`assets: Vec<AssetRef>`。写入处固定 `version: 3`（`backup.rs:480-489`）。`AssetRef = {kind, name, sha256, size}`，kind ∈ `book / fonts / backgrounds / workspace / vectors`（`models.rs:67-77`）。

> 注意：`models.rs:60` 的注释仍写"v2 大包资产清单"——注释过时；v2 时代的逐文件 `assets/` 目录会被自动清理（`backup.rs:551-556`）。

### 资产捆（sha256 内容寻址）

每本书目录（`books/{id}`）一捆、向量库一捆（先 VACUUM INTO 出一致快照再打包，`backup.rs:244-271`）、字体/背景/Agent 工作区各一捆（`backup.rs:272-288`）：

- 捆的 sha256 是**目录内容清单哈希**（全部文件 `rel:sha256` 行排序后再哈希，`backup.rs:160-173`），不是 zip 字节哈希
- 云端捆文件名 = `{kind}-{name}-{sha256前16位}.zip`（`models.rs:81-83`）；内容不变即不重传（靠 `asset-bundles-index.json` 的 sizes 判存，零 PROPFIND，`backup.rs:455-475`）
- 本地哈希带 mtime+size 缓存（`backup-assets-cache.json`，`backup.rs:17,146-157`）

### 上传流程（`run_backup`，`backup.rs:374-575`）

1. VACUUM INTO 快照 app.db
2. 打小包：app.db + 配置目录顶层 `*.json`（减去 4 项排除清单，`models.rs:103-108`）+ `themes/*.css`
3. 整包哈希 `last_pack_sha256` 无变化则 skipped（`backup.rs:427-444`）
4. 上传缺失捆（每捆间 50ms 突发平滑，`backup.rs:473-474`）
5. 小包命名 `backup-yyyyMMdd-HHmmss.zip`（`backup.rs:493`），更新远端 `index.json` 并按 `backup_keep`（默认 10，`models.rs:11-13`）轮转
6. 资产索引按"存活备份引用并集"GC 孤儿捆（`backup.rs:517-549`）
7. 写 sync-state（保留 L2 字段，`backup.rs:88-98`，有回归测试）

### stage_restore 校验

`restore.rs:44-150`：下载 zip → 校验 `manifest.format == "bettersageread-backup"`（:60）→ 解压到 `{config}/sync-staging/restore` → v3 资产捆逐个处理：本地内容哈希一致则跳过（同机恢复零下载）；否则下载、解到 `_verify` 临时目录**按内容哈希比对**（不是 zip 字节哈希，:102-126）后暂存 → 写 `pending-restore.json`。

实际替换发生在**下次启动、DB 初始化之前**（`apply_pending_restore`，`restore.rs:261-309`，由 `lib.rs:160` 调用）：先把当前数据备份到 `restore-backup-{ts}/`（回滚保险），再替换 app.db（旧 WAL/SHM 必须删除，`restore.rs:157-167`，真机事故教训）、JSON 时点恢复（目标目录中不在备份集内的配置 JSON 会被删除）、themes 整目录替换、资产捆解包防 zip-slip（:240-242）。回滚：`rollback()`（`restore.rs:312-345`，需重启；资产不回滚）。

### 触发入口

设置页"备份"区"立即备份"（`components/settings/sync.tsx:537-540`）；自动备份 off/hourly/daily 由前端 60 秒 tick 实现（`reader-layout.tsx:164-201`）；Agent 工具 `manageSync`（`ai/tools/central/manage-sync.ts:84,136`）。Rust 侧防重入（`sync/commands.rs:219-231`），完成发 `sync-backup-done` 事件进通知中心（`hooks/use-sync-events.ts:14`）。

## 2. L2 增量同步

### Changeset 格式：gzip(JSONL)

- 线上文件是 **gzip 压缩的 JSONL**（魔数嗅探解码，兼容压缩前的存量裸 JSONL 包；`changelog.rs:209-238`）。扩展名仍是 `.jsonl`，看云端文件需先解压
- 文件名：`changesets/{device_id}/{seq_end 补齐10位}.jsonl`（`engine.rs:1136`）
- 首行 header：`{protocol:1, device_id, seq_from, seq_to, created_at, app_version}`（`changelog.rs:18-26,169-176`）
- 数据行：`{table, id, op, updated_at, data?}`（`changelog.rs:8-16`），data 只含注册表已知列（宽容读者）
- 打包规则：同一 (table,row_id) 只保留最后操作、已删行转墓碑、单行超 20MB 跳过告警（`changelog.rs:108-163,182-199`）

### 变更捕获：触发器 + 水位

`_sync_log(seq, table_name, row_id, op, at)`（`database.rs:137-148`）+ 11 张表各 3 个 AFTER INSERT/UPDATE/DELETE 触发器，每次启动 DROP+CREATE 自愈（`database.rs:407-450`）。同步表注册表在 `sync/tables.rs`（11 张，含 `folders`、`paper_folders`、`prompt_presets`——比 `docs/sync-protocol.md` §4 的 8 张多，文档过时）。

### Push（`run_sync`，`engine.rs:1103-1260`）

确保云端目录 → **每轮必登记 devices.json**（含纯拉取轮，:1120-1122）→ 首次 `bootstrapped_at` 全量回填 11 张表现存行（含回收站行，:829-845,1124-1131）→ `pack_changes` → gzip PUT → 写 `devices/{self}.json` 指针 → 本地日志修剪（保留 `last_pushed_seq - 100`，:860-869）→ 云端修剪（所有设备已消费 ∧ 非最近 5 个，或超最近 50 个兜底，:871-942）→ **立即持久化水位**（防 pull 失败回退，:1165-1166）→ 书籍文件/资产自动上传（静默 warn）。

### Pull（`pull_from_devices`，`engine.rs:947-1101`）

读 devices.json（**读失败禁止当空表**，:955-962）→ 发现未引导新 peer 且本地有书 → 全量回填一次（`bootstrap_peers` 防重复，:966-984）→ 按设备指针逐包拉取：包缺失则跳过并推进水位；首个应用前做 VACUUM INTO 安全快照（保留 3 份，`engine.rs:17,219-249`）；应用失败**不推水位、阻塞该设备后续包、下轮重试，满 3 次才跳过告警**（`MAX_PACK_FAILURES=3`，:141-147,1063-1074）→ 把自己的应用水位发布到指针供他端修剪（:1083-1094）。

### 应用层分派（`apply_change_row`，`engine.rs:710-735`）

- DELETE → 墓碑 LWW（:392-411）
- `threads` → **消息级并集合并**（锚点位置归并排序，同 id 按 `metadata.updatedAt` 取新，其余字段整行 LWW；`merge.rs:42-192`）
- `book_status` → 按 `position_changed_at`（NULL 回落 last_read_at）大者整体采用（:413-454）
- `reading_sessions`/`paper_folders` → INSERT OR IGNORE 只增不改（:456-486）
- `skills`/`tags` → 同 id LWW，异 id 同名按 name 归并保本地 id（:488-586）
- `prompt_presets` → LWW + `is_active` 同 scope 互斥（:670-708）
- 其余 → 通用行 LWW（严格 `>` 保证重放幂等，`merge.rs:19-24`）

每包一个事务 + `PRAGMA defer_foreign_keys = ON`（:769-774）。防回环：事务内删本次应用写出的日志行（:760-790）。

### 对端删除的连带清理

`ApplyOutcome.deleted_book_ids`（books DELETE 行，:810-815）→ 调用方删本地 `books/{id}` 目录 + `purge_paper_vectors_pub` 清向量分片（:1038-1052；实现在 `books/commands.rs:349-362`）。软删（`trashed_at`）只是普通字段走 LWW（`tables.rs:46`）。

**已知限制**：云端 `files/` blob 与 `files-index.json` 条目在彻底删除时**不清理**（全模块无 files-index 删除代码）——`docs/sync-protocol.md` §12.3 承诺的"云端文件按引用计数清除"未实现。

## 3. WebDAV 云端目录布局

根目录：`bettersageread/sync`（L2，`models.rs:46-48`，可被 `webdav-config.json` 的 `l2_root` 覆盖回退旧目录 `bettersageread-sync`）与 `bettersageread/backups`（L1，默认 `remote_dir`，`models.rs:3-5`）。旧目录搬家/回退逻辑（MOVE、坚果云 403 回退、哨兵）在 `sync/commands.rs:29-158`。

```
bettersageread/
├── sync/
│   ├── devices.json                  # 全局索引 {id: {latest_seq, last_online}}（engine.rs:75-82,176-201）
│   ├── devices/<device_id>.json      # 指针 {latest_seq, changesets[], pulled{对端: seq}}（engine.rs:54-67,151-153）
│   ├── changesets/<device_id>/<seq10位>.jsonl   # gzip 内容（engine.rs:1136-1143）
│   ├── files/<sha256前2位>/<sha256>  + files-index.json   # 书籍文件（files.rs:20-27,74-77；MARKDOWN 论文是整目录 zip 捆，files.rs:163-207）
│   ├── assets/<sha256前2位>/<sha256> + assets-index.json  # 字体/背景（assets.rs:22-31,56-59）
│   └── ui-config.json                # 背景/辅助模型/全局主题，整文件 LWW（ui-config-sync.ts:1-9,112-144）
└── backups/
    ├── backup-<时间戳>.zip + index.json          # 小包（webdav.rs:159-170）
    ├── asset-bundles/{kind}-{name}-{sha16}.zip   # 资产捆
    └── asset-bundles-index.json                  # 捆索引（backup.rs:21-29）
```

设备标识：`device_id` = 每安装实例 UUID，首次同步生成、持久化于 `sync-state.json`（不进备份，`engine.rs:99-107`，`models.rs:133-135`）；设置页显示前 8 位（`settings/sync.tsx:672`）。

## 4. 限流与退避

集中在 `webdav.rs:send()`（:30-73）：

- HTTP **429/503** 自适应退避：2s 起步倍增、60s 封顶 + ≤500ms 抖动，**总预算 35 分钟**，超预算才报错
- HTTP client：connect 10s / 总 120s 超时（:21-28，走应用级代理）
- 备份捆上传另有 50ms 间隔突发平滑（`backup.rs:473-474`）
- 注意：`path_exists`/`move_path`（PROPFIND/MOVE）**不走** `send()`，无退避（`webdav.rs:206-246`）
- PUT 直写，不用原子改名（坚果云 MOVE 409 弃用，`engine.rs:165-169`）

## 5. 同步触发方式（前端调度，`reader-layout.tsx:203-316`）

- **25 秒 tick**，每轮重读配置；dirty（`syncHasUnpushed`，纯本地查询）→ 立即完整 `run_sync`；clean → 按 `sync_frequency`（30s/5min/30min/off，默认 30s，`models.rs:15-17`）兜底 `syncPullNow`
- **空闲调度**：用户交互后 10 秒无操作才跑（:215-223）
- **启动一轮**（:276-286）、**online 事件**（:292-306）、**退出前推送**（CloseRequested 拦截，5s 超时，`lib.rs:349-392`）
- 手动：设置页"立即同步"（`settings/sync.tsx:675`）、顶栏全局同步按钮（`sync-refresh-button.tsx:10-16`，完成后整页 reload）、Agent 工具 `manageSync`
- **开书快拉**：`syncPullNow` 带 1.5s 前端超时，静默放行本地（`use-foliate-viewer/index.ts:53-88`）
- UI 配置同步随每轮 Rust 同步附带执行（:228）
- L2 自动同步**完全静默**（不弹 toast、不写通知中心，:229）；只有 L1 的 `sync-backup-done` 进通知中心

## 6. 文档与代码不一致清单（排雷）

1. **云端根目录改名**：两份同步文档通篇 `sageread/...`，代码为 `bettersageread/...`；旧目录为 `bettersageread-sync`/`-backups`（不再是文档说的 `sageread-sync`）
2. **`sync.json` 全局信息文件不存在**：`docs/sync-protocol.md:23` 设计了它，代码从未读写；全局信息实际只有 `devices.json`
3. **Changeset 是 gzip 不是裸 JSONL**：文档 §5 未提压缩；实现见 `changelog.rs:216-223`
4. **覆盖表 8 → 11 张**：文档 §4 无 `folders`/`paper_folders`/`prompt_presets`；`engine.rs:825` 注释仍写"7 张"——注释与文档都过时，以 `tables.rs` 注册表为准
5. **L2 快照回滚已有入口**：文档 §115 行写"尚无回滚入口"；已实现 `rollback_to_l2_snapshot`（`restore.rs:391-417`）+ 命令 `sync_rollback_l2` + 设置页"同步前快照"区回滚按钮（`settings/sync.tsx:722-760`）
6. **设置类 JSON 已同步**：`ui-config.json` 整文件 LWW（含全局主题）+ 字体/背景资产通道均已上线（`ui-config-sync.ts`、`assets.rs`），文档开放问题 #4/#5 已落地
7. **云端书文件 GC 未实现**：彻底删除只清对端本地目录和向量，云端 `files/` 永久残留
8. **Manifest 版本**：口头/注释里的"v2"在代码里已是 v3（`backup.rs:482`）
9. 测试指南的机器身份表过时：identifier 现为 `com.bettersageread.dev*`（`tauri.conf.json:5`），详见 `06-dev-workflow.md` 第 4 节

## 7. 已被测试锁定的行为（可放心依赖）

以下行为有 `core/sync/` 内的 Rust 测试或回归测试守护，引用时不必再核：

- 墓碑 LWW 与"输于更新的重建"（`engine.rs:392-411` + 测试 :1507-1543）
- threads 消息级并集合并（`merge.rs:42-192`）
- `position_changed_at` 决定真进度归属（`engine.rs:413-454`）
- 失败包满 3 次跳过（`MAX_PACK_FAILURES=3`）；本地日志留 100 条；云端 changesets 留 5~50 个；应用前安全快照留 3 份
- 25s 推送轮询 / 30s 拉取兜底 / 退出前推送 5s 超时
- 备份默认保留 10 份（`models.rs:11-13`）
- L1 写 sync-state 时保留已有 L2 水位字段（`backup.rs:88-98`，有回归测试）
- `paper_folders` 复合主键行 `paper_id:folder_id` 曾有"全列加前缀"的 bug，现有回归测试（`database.rs:422` 注释记录了修复）

## 8. L1 与 L2 的互操作

- 两者共享 `webdav-config.json` 与 `webdav.rs` 客户端，但目录、格式、调度完全独立，可分别开关
- `sync-state.json` **不进备份**（设备 ID 每安装实例唯一，`engine.rs:99-107`）；L1 备份写完 sync-state 时会保留已有 L2 水位字段
- L2 应用 changeset 前的安全快照在 `{config}/sync-staging/l2-safety/`（留 3 份，`engine.rs:220-246`），回滚入口为命令 `sync_rollback_l2` + 设置页按钮；L1 恢复前的整机备份在 `restore-backup-{ts}/`（`restore.rs:261-309`）
- 书籍文件传输走 L2 的 `files/` 通道（sha256 前 2 位分片寻址，`files.rs:20-27,74-77`）；MARKDOWN 论文是**整目录 zip 捆**（`files.rs:163-207`），图片随捆走
- 修剪水位靠互认：每轮把自己对各设备的应用水位发布到 `devices/{self}.json` 的 `pulled` 字段，供他端修剪云端 changesets（`engine.rs:1083-1094`）
