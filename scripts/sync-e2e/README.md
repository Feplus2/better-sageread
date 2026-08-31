# sync-e2e —— L2 增量同步双实例端到端验证脚本

针对 `docs/audits/sync-direction-audit.md` 缺陷清单（P0/P1/P4 于 2026-08-25 修、P2/P3/P5 于 commit 1fa785d 修）的 E2E 实证套件。
2026-08-25/26 本机双实例 + 本地 dufs WebDAV 实测：**全部 PASS**。证据存于 `F:/MyProjects/SageRead/.tmp-e2e/evidence/`。

## 环境（一次性，不动主库）

| 角色 | worktree | identifier | vite 端口 | CDP | 数据目录 |
|---|---|---|---|---|---|
| A-test | `F:/MyProjects/SageRead-dev2`（detached 1fa785d） | com.bettersageread.dev2 | 1421 | 9224 | `%APPDATA%/com.bettersageread.dev2` |
| B-test | `F:/MyProjects/SageRead-dev3`（detached 1fa785d） | com.bettersageread.dev3 | 1422 | 9225 | `%APPDATA%/com.bettersageread.dev3` |

- WebDAV：`.tools/dufs.exe -A --bind 127.0.0.1 --port 4918 F:/MyProjects/SageRead/.tmp-webdav-root`（全新空目录；云端 L2 根 = `<root>/bettersageread/sync`，直接 fs 读写即可构造/观测云端）
- 两端 `webdav-config.json`：endpoint `http://127.0.0.1:4918`、l2_enabled true、sync_frequency 30s、remote_dir `bettersageread/backups`
- 启动（各自 `packages/app` 下）：
  - A：`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9224" pnpm tauri dev`
  - B：`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9225" pnpm tauri dev`
- 构建加速：dev3 复制 dev2 的 `src-tauri/target` 后各自编译（exe 同名，不能共享运行中的 target）
- 停实例必须双杀：`TaskStop` 杀 pnpm/vite + 按路径杀 `better-sageread.exe` 孤儿（注意别碰主仓 `F:\MyProjects\SageRead\...` 的那个——用户的真实实例）

## 脚本清单（在主仓根目录运行）

| 脚本 | 场景 | 前置 | 断言 |
|---|---|---|---|
| `p1-state-watch.mjs [秒]` | P1 sync-state 原子写+水位单调 | 双实例跑 | 全程 2s 采样：每次必为合法 JSON、last_pushed/last_pulled 单调不回退 → `evidence/p1-samples.jsonl` + `p1-verdict.json` |
| `p4-mutex.mjs [9224\|9225]` | P4 L2 互斥锁 | 实例在跑 | CDP 并发 8 发 syncRunNow：1 发真跑、≥1 发被拒「L2 同步已在进行中，本轮跳过」 |
| `p0-prune.mjs` | P0 指针读失败放弃修剪 | 双实例跑 | 等追平 → 写坏 `devices/<B>.json` → A 推送 → A 云端包一个不少（含反事实必删包）+ 日志「本轮放弃修剪」→ 恢复 |
| `p2-inflate.mjs` | P2 尾部水位不跳 latest_seq | **A 停**、B 跑且已追平 | `devices.json[A].latest_seq` 改大 +50 → B 跑轮 → `last_pulled[A]` 仍为指针清单末尾真值 → 恢复 |
| `p3-halfpack.mjs` | P3 半截包传输性失败 | **A 停**、B 跑、有未消费包 | 截断 A 末尾包 → B 日志「疑似半截包」+ `failed_packs_transient` 计 1+、`failed_packs` 不含、水位冻结 → 恢复 → 应用成功、计数清除、水位推进 |
| `soak-star.mjs` | 功能 soak | 双实例跑 | A CDP 星标对话 → ≤120s B 库同行 starred 一致 |
| `db.py` | SQL 助手 | 写操作先停实例 | `threads/books/star-check/p5-setup/p5-check/sync-log-count` |

## P5（无独立脚本，按序执行）

1. 双实例跑。选同一 book_id（两边库都有）。
2. 停 A → `python scripts/sync-e2e/db.py p5-setup A <book>`（写入 `cfi-real`/position_changed_at=2000 并清该行的 _sync_log，A 不推）→ 启 A。
3. **B 运行中** `python scripts/sync-e2e/db.py p5-setup B <book>`（写入 `cfi-open-only`/position_changed_at=NULL/last_read_at=now，保留 _sync_log 触发推送）。
   ⚠️ 必须 B 运行中注入：`database.rs` 的幂等回填迁移**每次启动**把 NULL→last_read_at，停实例注入会在 B 下次启动时被吃掉（首轮实测即踩此坑，P5 路径根本没被触及）。
4. 等 B 推（last_pushed_seq 涨）、A 拉（last_pulled[B] 涨）→ `p5-check A <book>` 断言 `location='cfi-real'`、`position_changed_at=2000` 不变。
5. 硬证据：gzip 解码 B 新推的 `changesets/<B>/<seq>.jsonl`，确认线上行 `position_changed_at: null`。

## 复跑注意

- 各脚本幂等可读证据到 `.tmp-e2e/evidence/`；p0/p2/p3 会自动恢复被改坏的云端文件。
- 全新云端（重测全流程）：停双实例 → 清空 `.tmp-webdav-root` → 删两端 `sync-state.json` → 启 A 等引导推送 → 启 B。
- 稳态下 A 云端只留 5 个包（修剪特性），P0 的"反事实必删"窗口 = A 推送第 6 包的瞬间，脚本已处理该时序。
