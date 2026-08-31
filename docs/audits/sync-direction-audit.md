# 同步方向审计（2026-08-25，挂账项 7 复核结论）

> 背景：坚果云 502 风暴期间观察到「同步拉取覆盖本地较新状态」。本审计回答"方向逻辑是否有缺陷"。
> 全部为静态代码审计结论，证据到文件:行号。**P0/P1/P4 已修复（2026-08-25，用户拍板范围）；
> P2/P3/P5 已修复（2026-08-26，修法见各条「已修」注记）**——至此本审计缺陷清单全部清零，
> 仅剩 P6 备查的已知取舍。

## 方向机制现状（无全局方向决策）

逐行 LWW + 水位过滤：推送 = `_sync_log` 中 `seq > last_pushed_seq` 打包上传（engine.rs:1135）；
拉取 = 对端 `latest_seq > last_pulled` 才拉（engine.rs:993-996）；冲突逐行按 `updated_at` 裁决
（merge.rs:19-24 严格大于，重放幂等）。**设备时钟是唯一仲裁者。**

## 缺陷清单（按严重度）

### P0 修剪水位在指针读失败时可删未消费包（502 期间真实可触发）—— ✅ 已修（2026-08-25）

`engine.rs` `prune_remote_changesets`：任一设备指针读失败 → 本轮放弃修剪（fail-closed Err 上抛，
修剪失败本就只记 warn 不影响主流程）。

### P1 sync-state.json 非原子写 + 多写方无互斥（用户观察到的现象最可能元凶）—— ✅ 已修（2026-08-25）

`backup.rs`：`write_sync_state` 改 tmp+rename 原子写 + 全局写锁；新增 `update_sync_state`
（锁内读-改-写），`record_l2_failure` 迁入（不再拿陈旧快照整写回）。引擎写点经
`write_sync_state` 自动纳入互斥。

### P4 无 L2 同步互斥锁，多入口可并发跑 —— ✅ 已修（2026-08-25）

`AppState.l2_running` AtomicBool + 引擎入口 RAII 守卫（`L2RunGuard`，run_sync/run_pull_only
共用，Drop 释放）。冲突时返回「L2 同步已在进行中，本轮跳过」——调度器本就静默
（console.warn），手动按钮弹出该提示语义正确。

### P2 拉取循环尾部无条件跳到 `info.latest_seq` —— ✅ 已修（2026-08-26）

`engine.rs` 拉取循环：原尾部不看指针里实际应用到哪。坚果云读视图不一致
（devices.json 新、设备指针旧）→ 水位越过未应用的包 → 水位单调短路致永久空洞。
修法已落地：循环内跟踪本轮实际处理到的最大 seq_end（`reached`，应用成功/缺失跳过/
坏包跳过均计入），尾部水位只推到 `reached`，不再跳到 `info.latest_seq`。

### P3 失败 3 次即永久跳包 —— ✅ 已修（2026-08-26）

`engine.rs`：原半截 gzip（PUT 非原子，自承）导致的解压失败也计入内容性失败计数
→ 暂时性坏包 3 轮后永久丢弃。修法已落地：解压失败归为传输性失败，计入独立计数器
`failed_packs_transient`（sync-state.json 新字段，serde default 向后兼容），不推水位、
下轮重试、不碰内容性 3 次上限；独立天花板 40 轮（≈20 分钟）不愈合才按永久坏包跳过。
应用成功时两类计数一并清除。单测 `test_transient_pack_failure_counter_independent` 守护。

### ~~P4 无 L2 同步互斥锁，多入口可并发跑~~（已修，见前「P4」节）

`commands.rs:345-371` 无防重入；开书快拉（1.5s 超时后 Rust 仍跑）、25s tick、手动按钮、
Agent 工具互不共享标志（state.rs:5-8 只有 backup_running）。两份 SyncState 读-改-写互覆。
修法：Rust 侧加 `l2_running` AtomicBool（与备份同款）。

### P5 book_status 回落比较键可被"只打开不翻页"的对端顶翻 —— ✅ 已修（2026-08-26）

`engine.rs` `apply_book_status_upsert`：原远端 `position_changed_at` 为 NULL 时回落
`last_read_at` 参与比较；而 `position_changed_at` 仅在真翻页且停留 ≥30s 时推进
（books/commands.rs:495-505）。A 端读到 50%（t1）；B 端只打开不合
（NULL + last_read_at=t2>t1）→ B 旧位置胜出覆盖。
修法已落地：远端 `position_changed_at` 为 NULL 且本地有真进度时，远端不得竞争
（直接跳过）；仅当双端都无真进度（旧库场景）才回落 last_read_at 对 last_read_at。
单测 `test_book_status_remote_null_position_cannot_overwrite_real_progress` 守护；
原 `test_book_status_merge_null_fallback_last_read_at`（双端 NULL 回落）行为不变。

### P6 备查（已知取舍）

20MB 大行静默跳过且游标照推（changelog.rs:183-205）；>50 包兜底删除对长期离线设备致永久空洞
（engine.rs:871-897）；防回环 DELETE 并发窗口（engine.rs:780）；ui-config 前端 LWW
覆盖本地未推送改动（ui-config-sync.ts:126-130）。

## 排除嫌疑的路径（审计覆盖完整性）

- webdav.rs：429/503 退避正确，502 直接 Err fail-closed，无"错误当空数据"路径。
- merge.rs：LWW 严格大于/threads 并集，重放幂等，有测试。
- 推送主流程（engine.rs:1133-1167）：先成功后推游标，文件名 seq_to 幂等。
- assets.rs：下载仅在本地不存在时写 + sha256 校验，无覆盖。
- files.rs 下载通道无条件覆盖本地，但仅用户显式触发，不在自动同步路径。
- L1 恢复：用户显式操作 + pending-restore.json 启动应用，不被自动同步间接触发。

## 结论

单次 502 本身全链路 fail-closed；用户观察到的"旧覆盖新"最可能是 **P1（sync-state 损坏 →
水位清零 → 全量重拉 + 删除复活）** 与 **P5（进度回落键）**；P0/P2/P3 解释伴随的"变更丢失"。
502 是放大器（并发失败写↑、指针读失败↑、半截文件↑）而非根因。
