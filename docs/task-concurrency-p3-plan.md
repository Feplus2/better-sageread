# P3 有界并发施工计划（task-concurrency-p3-plan）

> 2026-08-25 建立。前置调研：`docs/task-system-survey.md` §6（并发可行性，含资源画像与锁分析）。
> **强依赖 P2**（`docs/task-queue-p2-plan.md`）：通道化完成后并发才有意义；本文档各阶段按 P2 落地后的代码位置描述。

---

## 0. 总原则

- **通道并发数可配置、默认保守**：解析默认 1（实测云端 QPS 后可调 2），向量化/翻译通道内不并行多篇。
- 瓶颈在外部（MinerU/embedding/LLM 的 QPS 限额），不在本机——并发上限是外部约束的映射，不是性能指标。
- 用户拍板理念：**队列是给人看的（可感知进度），执行可以并发**。

## 1. 论文解析通道：有界并发 2

**现状阻塞点**（P2 后仍存在）：`PaperConverterState` 单 child 句柄
（`src-tauri/src/core/paper_converter.rs`）——并发两次解析互相覆盖取消句柄；
`pending_done` 单槽同理。事件归属已具备（每事件注入 pdf_path）。

**改动**：
1. Rust：`PaperConverterState` 改 `HashMap<pdf_path, Child>` + `pending_done` 改
   `Vec<PaperConvertDone>`（或 HashMap<pdf_path, Done>）；取消/状态查询/清除命令按 pdf_path 寻址
   （`cancel_paper_convert`、`paper_convert_status`、`clear_paper_convert_pending_done` 加参数）。
2. staging 撞车待核点（**动手前先核**）：converter 侧 `_staging/{标题}-{短hex}` 的后缀是否内容
   digest——若是随机/时间戳后缀，同 PDF 两进程并发安全；若是内容 digest，同内容并发撞车
   （但前端内容哈希预去重 paper-dedup 已挡住同内容并发入队，残余风险是"同内容不同任务"边角）。
   结论写进本文档再实施。
3. 前端：task-center 的 paper-parse 通道 `concurrency: 2`（P2-0 的通道注册表字段）。
   取消按钮按 taskId→pdf_path 映射定向取消。

**验证**：两篇论文同时解析实盘（进度双行不串台、取消其一另一个继续、产物均落库）；
MinerU token 429 观察（若频繁则默认回 1）。

## 2. 向量化通道：单篇内并行 embed（不并行多篇）

**现状**：单篇内逐块串行 HTTP embed（插件 `pipeline.rs:790-837` 循环逐个 await），
批量入库 batch=10；连接无 `busy_timeout`、未开 WAL（`database/connection.rs:150-156`）。

**改动**：
1. 插件 pipeline：embed 循环改有界并行（默认 4 路，`buffer_unordered` 或手动信号量），
   写库保持单线程（批量 INSERT 不变）。
2. `connection.rs`：连接加 `PRAGMA busy_timeout = 5000`（多写撞锁兜底；不依赖它做正确性，
   正确性由"单篇写库单线程 + 通道内不并行多篇"保证）。
3. 429/超时退避：embed HTTP 失败现无重试（`text/vectorizer.rs:57-58` 只有超时设置）——
   加有限次指数退避（3 次，500ms 起）。

**验证**：单篇向量化墙钟时间对比（串行基线 vs 4 路并行，预期 ~3 倍提速）；
维度切换自愈（既有）不回归；cargo 绿。

## 3. 翻译通道：维持现状

单篇内已 3 路并发批次（`TRANSLATE_CONCURRENCY = 3`），跨篇不并行（LLM QPS 边际收益低、
429 风险高）。本阶段零改动，仅回归确认。

## 4. 事件路由收尾

- P2-1 已给 `convert://progress` 注入归属；本阶段复核五通道全部进度事件在并发下不串台
  （论文解析 pdf_path、图书转换 pdf_path、向量化 paper_id/book_id、翻译前端回调天然隔离）。
- solo 卡所有权守卫（`total===1 && title` 双重比对）在 P2-3 已退役——本阶段确认无残留引用。

## 5. 回归矩阵

- P2 全部验证项（队列语义不因并发参数变化而破）；
- `cdp-e2e-refresh-recovery.mjs`（解析恢复在多句柄化后仍成立——pending_done 改多槽是重点回归点）；
- 取消幂等：对同一 pdf_path 连发两次 cancel 不报错（job object + kill_tree 既有语义）。

## 6. 明确不做

- 跨通道并发编排（如"解析完自动向量化"流水线）——属另一特性，另行立项。
- 解析并发 >2、向量化跨篇并行——外部 QPS 约束不支持，等真需求再调。
