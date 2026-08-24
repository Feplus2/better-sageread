# 任务体系施工调研（task-system-survey）

> 2026-08-24 建立。为「统一任务队列 + 版本对齐 + 卡片子任务展开」大施工做现状摸底。
> 口径：全部结论附文件:行证据；dev 实例（com.bettersageread.dev，CDP 9223）数据已实盘抽检。
> 本文只调研与出方案，不改产品代码。

## 0. 现状架构地图（30 秒版）

**三 store 两层模型**：

- `store/paper-task-registry.ts:13-29` — 叶子注册表：同篇任务互斥的单一事实源（parse/vectorize/translate 冲突矩阵，`conflictKinds` 纯函数）。
- `store/paper-task-store.ts` — 向量化/翻译双通道队列（zustand 内存队列 + 通道内串行泵 `drainVectorize:138` / `drainTranslate:223`），每通道一张进度卡（`ChannelProgress:30-43`）。
- `store/convert-progress-store.ts` — 论文解析队列（模块级 `paperQueue:359`，parse/acquire/reparse 三种工作项，`drainPaperQueue:552`）+ 图书 PDF→EPUB 转换单任务状态（`bookConvert:100-124`，无队列）。

**进度事件通道**：

- `paper-convert://progress`（论文解析；Rust 侧逐事件注入 `pdf_path` 归属标识，`src-tauri/src/core/paper_converter.rs:117-125`）
- `convert://progress`（图书转换；**无归属标识**，`src-tauri/src/core/converter.rs:114`）
- `paper://index-progress`（论文向量化；载荷含 `paper_id`，`plugins/tauri-plugin-epub/src/commands.rs:541-579`）
- 翻译无后端事件：前端按批回调 `onProgress`（`paper-translation-service.ts`）

**右下角五类卡**（全部经 `BottomRightPortal` 进共享栈，栈宿主 `reader-layout.tsx:625`，阅读器/聊天页禁区隐藏，`components/ui/bottom-right-stack.tsx:16-33`；8c2c569 落地）：

| # | 卡 | 数据源 | 出处 |
|---|---|---|---|
| 1 | 论文解析卡（含重解析/acquire） | convert-progress-store.paperImport | `components/global-convert-progress.tsx:27-106` |
| 2 | 图书转换小卡（**唯一点击可开**：还原图书馆页大窗口） | convert-progress-store.bookConvert | `components/global-convert-progress.tsx:109-192` |
| 3 | 向量化通道卡 | paper-task-store.progress.vectorize | `pages/papers/index.tsx:1943-2009` |
| 4 | 翻译通道卡 | paper-task-store.progress.translate | 同上 |
| 5 | Zotero 批量导入卡 | 对话框本地 run 状态 | `pages/papers/zotero-import-dialog.tsx:343-375` |

**任务发起入口 × 是否入队**（统一队列的差距清单）：

| 入口 | 任务 | 走队列？ |
|---|---|---|
| PapersPage 批量条/右键 | 解析/重解析 | ✅ startPaperImportBatch / startPaperReparse |
| PapersPage 批量条/右键 | 向量化/翻译 | ✅ paper-task-store.enqueue |
| 论文阅读器翻译下拉 | 翻译+对齐 | ❌ 直跑 translatePaper，只打点注册表（`paper-reader-view.tsx:245-265`） |
| 图书馆 book-item | 图书向量化 | ❌ 直跑 indexEpub（`library/components/book-item.tsx:301-356`） |
| 设置页全量重新向量化 | 书+论文向量化 | ❌ 自带串行循环（`settings/vector-model-manager.tsx:338-387`） |
| AI processPaper reparse | 重解析 | ✅ startPaperReparse（`ai/tools/central/process-paper.ts:230`） |
| AI processPaper translate/align | 翻译/对齐 | ❌ 阻塞式直跑（`process-paper.ts:132-203`） |
| AI vectorizeBook | 书/论文向量化 | ❌ 自带串行循环（`vectorize-book.ts:283-291`），单篇有 trackSoloVectorize 卡（`paper-task-store.ts:329-399`，6dd73c4 修） |
| AI importPaper | 解析导入 | ❌ importPaperPdf 独立链路自持监听（`paper-service.ts:366-433`） |
| AI convertPdf | 图书转换 | ❌ 直跑 startConvert（且有 5s 监听 bug，见 §5） |

---

## 1. 菜单回归修复（6131195 引入，已定位）

**现状**：6131195 把右键菜单的翻译/重新解析从带参（`handleBatchTranslate([paper])` / `handleBatchReparse([paper])`）改成无参走 `selectedPapers` 选择集（`git show 6131195` diff 实证：`-handleBatchTranslate([paper])` → `+handleBatchTranslate()`，reparse 同）。右键单篇但不勾选时 `selectedIds` 为空：

- **重新解析恒 disabled**：`pages/papers/index.tsx:1834` `disabled={batchLocked || selectedIds.size === 0 || taskReparseBlockers.length > 0}`。
- **翻译静默无效**：`:1829` 菜单项无 disabled，点了进 `handleBatchTranslate()` → `:1311` `if (selectedPapers.length === 0) return;` 静默返回，无任何反馈。
- 同菜单的「向量化」没坏：`:1820` 仍走单篇 `handleVectorize(paper)`（`:1140`）——这正是修复参照物。

**方案**：右键菜单对被右键的那篇生效（对齐旧行为与 Windows 资源管理器惯例：若被右键篇在勾选集内且勾选 >1，作用于勾选集；否则作用于被右键单篇）。最小实现：给 handleBatchTranslate/handleBatchReparse 恢复可选 `papers?: BookWithStatus[]` 参数（缺省回退 selectedPapers），菜单传 `[paper]`，disabled 判定同样按「目标集」推导而非裸 `selectedIds.size`。注意 1829 翻译项应补 disabled 与 blockerHint（当前连禁用态都没有）。

**改动面**：仅 `pages/papers/index.tsx` 一个文件，约 30 行；测试脚本 `scripts/test-task-conflict.mjs` 不受影响。施工清单直接收录。

---

## 2. 翻译状态与「重新翻译」

**现状**：

- **状态存储**：块级平行译本 `{appData}/books/{paperId}/translation-zh.json`，结构 `{version:1, lang, updatedAt, alignStatus?, alignWStatus?, glossary?, blocks: {"<块索引>": {hash, text, align?, alignHash?, alignW?, alignWHash?}}}`（`paper-translation-service.ts:44-55`；hash = 块源文本 sha256 前 16 hex，`:92-98`）。元数据译文 `title_zh/abstract_zh` 写在 `metadata.json`（`translateMetadata:266-313`）。对齐状态 `alignStatus/alignWStatus` 在译本顶层（`paper-alignment-service.ts:1-21`）。**book_status.metadata 里没有翻译字段**——数据库层无翻译状态。
- **卡片可见标记**：无。论文卡片右侧只有向量化圆环（`VectorizationRing, index.tsx:140-179`）、云端徽标（`:113`）、阅读状态徽标（`PaperStatusBadge:210-227`，New/已读完/进度%——是阅读状态不是翻译状态）。
- **「重新翻译」入口**：仅论文阅读器翻译下拉有（`paper-translation-dropdown.tsx:131-136`「重新翻译（全部重翻）」→ `onTranslate(true)`）；AI 工具 processPaper action=translate 有 force 参数（`process-paper.ts:51,76-79`）。**文献库列表页（右键/批量）没有重翻入口**：批量通道固定 `force: false`（`paper-task-store.ts:268`）。
- 卡片有无"已翻译"判定所需数据：需要异步读 translation-zh.json（列表 130+ 篇逐篇 IO 不现实）或在 book_status.metadata 冗余一个翻译标记位。

**方案**：

1. **已翻译徽标**：翻译完成/重翻/续翻收尾时在 `book_status.metadata` 合并写入 `translation: {status:"success", lang, blockCount, updatedAt, sourceHash?}`（复用 `updateBookVectorizationMeta` 同款 merge 模式，`book-service.ts:364-385`）；卡片下排加一个小徽标（Languages 图标，绿色=已翻译/琥珀=陈旧（见 §3）/灰=未翻译）。列表数据源 `getBooksWithStatus` 已带 status.metadata，零额外 IO。
2. **重新翻译入口**：右键菜单与批量条加「重新翻译」——本质是 enqueue 时带 force 标志：`paper-task-store` 的 `TaskItem` 加 `force?: boolean`，`drainTranslate` 透传（`:265-275`）；同篇已有译本时菜单文案切换（参照向量化 `isVectorized ? "重新向量化" : "向量化"`，`:1827`）。重翻完成后自动重建对齐（复用 processPaper `:166-172` 的 translate→align 一条龙，队列版现在只翻不对齐——`drainTranslate` 压根不调 alignPaperTranslation，这也是个落差，施工时一并补上）。

**改动面**：小。paper-task-store（force 透传 + 收尾写 metadata + 接对齐）+ paper-translation-service（收尾回写 metadata 标记）+ index.tsx（徽标 + 两个菜单项）。无 Rust 改动。

---

## 3. 版本对齐（重点）

### 3.1 现状：重解析后三类产物的一致性追踪

`replace_paper_content`（`src-tauri/src/core/books/commands.rs:1473-1527`）只替换 `paper.md / images / metadata.json`，**其余一律不动**：

- **向量化结果**：全局库旧 chunks 原样保留（删除只发生在下次向量化前，`pipeline.rs:778`）；`book_status.metadata.vectorization.status` 仍是 `"success"`——**系统认为该篇已向量化，但向量对应的是旧正文**。
- **翻译结果**：`translation-zh.json` 原样保留。译本按**块索引**作键、块源文本 hash 作幂等校验（`paper-translation-service.ts:350-352`）。「陈旧处理」的真相：没有任何代码在重解析时主动把译本标陈旧；所谓"转陈旧"是**下次翻译时 hash 失配的惰性自愈**（process-paper.ts:62/241 的描述语义）。三个具体问题：
  1. **渲染侧不校验 hash，静默错配**：阅读器把 `blocks` 直接按索引映射成译文（`paper-reader-view.tsx:133-135` 建 `Map(index→text)`；`buildPaperViewMarkdown` 只做文本替换，`paper-blocks.ts:615-628`）。重解析后块索引漂移 → **旧译文按新索引贴到错误源文块上**，用户看到译错的段落且无任何提示。只有对齐覆盖统计做了 hash 核对（`paper-reader-view.tsx:148` 注释「aligned < total 即无对齐/陈旧」），它只能间接反映。
  2. **死索引残留**：翻译"只增不改"（`paper-translation-service.ts:6`），重解析后失效块永不清理。
  3. **元数据译文丢失**：`metadata.json` 被整体重写（`commands.rs:1513-1516`），`title_zh/abstract_zh` 随之清空（reparse 只保留 zotero 回链字段，`paper-reparse-service.ts:182-186`）——列表页中文化显示回退原文，且无任何记录表明它曾被翻过。
- **版本概念**：向量化侧零版本概念。`BookVectorizationMeta`（`types/simple-book.ts:107-115`）有 `version` 但恒为 1（schema 版本，非内容版本）；无内容 hash。翻译侧有块级 hash 但**无 paper.md 整体版本锚**。注：论文 id 本身是导入时 paper.md 的 sha256 前 16（`paper-service.ts:22-23`），但重解析保 id 换内容（`replace_paper_content` 设计），id 已不能当版本用。

### 3.2 方案：paper.md 内容 hash 作版本锚

1. **记录**：翻译 `save()` 与向量化成功收尾时各记一份 `sourceHash`（paper.md 正文 sha256 前 16 hex，与 scan_papers_dir 的 id 算法同口径）。落点：译本 JSON 顶层加 `sourceHash` 字段（`paper-translation-service.ts:373-382` 的 save 处）；向量化写进 `book_status.metadata.vectorization.sourceHash`（`paper-service.ts:327-333`）。hash 计算零新依赖：前端 WebCrypto 已有 `hashBlockText` 同款；或复用 Rust `scan_papers_dir({dir: books/{id}})` 返回的 id（它就是对当前 paper.md 的内容哈希）作查询侧免实现通道。
2. **判定**：`staleness = 当前paper.md hash ≠ 记录的 sourceHash`。卡片徽标、processPaper/vectorizeBook 的 status 动作、AI 状态查询统一读这个差值。陈旧时 UI 文案「重解析后未更新」。
3. **渲染防错配（顺手必须修）**：`translationMap` 构建时带 markdown 重切块的 hash 比对——hash 不匹配当前块的条目不进 Map（宁可缺译不可错译），并在阅读器出「译本基于旧版正文」横幅（复用 `reparsedPapers` 横幅模式，`convert-progress-store.ts:144-147`）。
4. **元数据译文保留**：`replaceWithConverted` 合并 metadata 时把旧 `title_zh/abstract_zh` 并入（`paper-reparse-service.ts:171-186`，与 zotero 字段同法）；标题/摘要若变化由下次翻译的 hash 机制自然覆盖（translateMetadata 目前只在缺省时补，`:285`——可改为源 hash 变化才重翻，避免白烧）。
5. **死索引清理**：翻译 save 时把不在当前块集里的键删掉（一次 prune，随每次落盘自然执行）。

### 3.3 全局助手「未翻译的翻一遍、已翻译别动、重解析过的重翻」缺什么

| 能力 | 现状 | 缺口 |
|---|---|---|
| 批量翻译状态查询 | ❌ 无。processPaper action=status 单篇且要 paperId + 读 paper.md + 对齐核对（重）；getBooks 不返回翻译状态（数据库无此字段） | 需 §2.1 的 metadata 翻译标记位 + getBooks/status 输出该字段 |
| 按状态过滤 | ❌ getBooks 无 hasTranslation/stale 过滤（`book.ts:54-66`） | 加过滤参数或批量 status 动作 |
| 陈旧判定 | ❌ 无版本锚（§3.1） | §3.2 的 sourceHash |
| 重翻入队 | 半有：processPaper translate force=true 存在但**单篇、阻塞式、不入队**；UI 批量固定 force=false | TaskItem.force 透传（§2.2）+ AI 改入队接口（§7） |
| 向量化重跑（陈旧时） | ❌ vectorizeBook 单篇对已向量化早退 `alreadyVectorized`（`vectorize-book.ts:230-239`），无 force | 加 force 参数或陈旧自动放行 |

**改动面**：中。TS 侧为主（translation/alignment/service、vectorizeBook/processPaper、getBooks、卡片）；Rust 仅需 replace_paper_content 合并保留 title_zh/abstract_zh（或继续在前端 merge）。无 schema 迁移（metadata 是 JSON 自由字段；译本 JSON 加顶层字段向后兼容，`loadPaperTranslation:106-118` 校验只看 version/blocks）。

---

## 4. 向量化幂等性

**结论：现行代码已幂等，发行版无"同篇两套向量"的雷；dev 实测干净。但留一个维度切换的硬伤。**

- **论文（全局单库 `{appData}/papers/vectors.sqlite`）**：`process_paper_to_db` 索引前先 `delete_chunks_by_paper_id`（`pipeline.rs:777-782`），删除覆盖 vec0 向量表、fallback 表、document_chunks，并清 BM25 统计缓存（`database/operations.rs:54-93`）。该删除与全局库同生于 721765d（2026-07-30），即从论文全局库第一天起就是先删后插。
- **图书（每书一库 `books/{id}/vectors.sqlite`）**：重建时直接删整个库文件（`pipeline.rs:171-179`），天然幂等；换维度也自愈。
- **dev 实例实测**（`C:/Users/20995/AppData/Roaming/com.bettersageread.dev`）：`document_chunks` 按 `paper_id × chunk_order_in_file` 分组零重复；15 个 paper_id 全部有对应 books 目录（无孤儿）；无 `paper_id=''` 迁移遗留行。用户记忆中的"两套并存"应是全局库之前 per-paper 时代的遗留，现已不存在（books/ 下散见的 vectors.sqlite 均属 EPUB 书，正常）。
- **彻底删除连带**：purge 时清理全局库该篇分片（`core/books/commands.rs:340-357`，L2 对端删除也走 `purge_paper_vectors_pub:360`）；软删不清（回收站可恢复），口径正确。

**残余雷区（发行版也在）**：

1. **换嵌入模型/维度 → 论文全局库写不进**。vec0 表 `FLOAT[N]` 在建表时钉死，已存在则跳过（`connection.rs:207-225`「向量表已存在，跳过创建」），全局库"绝不删库文件"（`pipeline.rs:766`）。维度变化后插入直接报维度不符 → 每篇向量化都失败。设置页有告警与「全量重新向量化」（`vector-model-manager.tsx:293-348`），但该路径对论文会因维度不符全灭（图书侧删库自愈所以没事）。**修法**：`index_paper` 打开库后比对既有表维度与实测维度，不符则清空整库重建（换模型本来就使全部论文向量失效，语义正确；加日志与返回字段告知）。备选：全量重新向量化入口先删全局库文件（一行 invoke）。
2. **中途失败留部分索引**：删除在前、插入在后（`pipeline.rs:778` vs `:820-843`），向量化中途挂掉 → 该篇处于"部分索引"态（metadata 已标 failed，下次重索引会先清，可自愈，可接受）。
3. **存量清理**：无需专门清理。建议顺手存档一个审计脚本（dup 分组 / 孤儿 / 空 paper_id 三查，本文 §4 的 SQL 即是），发版前跑一遍。

**改动面**：极小（Rust index_paper 加维度比对重建分支 + 可选审计脚本）。

---

## 5. 图书侧任务现状

- **图书转换（PDF→EPUB，可带全书翻译）**：无队列。`convert-progress-store.startBookConvert:204-229` 直起 sidecar；`ConverterState` 单 child 句柄（`converter.rs:13-15,94-98`），并发启动互相覆盖取消句柄；`convert://progress` 事件**无任务归属字段**（`converter.rs:114`，对比论文侧有 pdf_path 注入）——并发两转换必串台。UI 上靠大窗口单实例（图书馆页弹层，`library/index.tsx:50-52`）弱约束。
- **图书向量化**：无队列无注册表。三入口各自直跑（book-item `:301-356`、AI vectorizeBook 串行循环、设置页全量串行循环），互不感知——同一本书可被两个入口同时索引（每书一库删库重建，结果是互相覆盖的竞态而非数据翻倍，但会白烧 embedding 费用）。
- **图书翻译**：**没有独立的图书翻译任务**。翻译只作为转换管线的一个阶段存在（`translate` 参数 → 全书翻译阶段，`convert-progress-store.ts:104,127-135`；`converter.rs:70-75` 透传 `--translate`）。已入库的 EPUB 不能再"翻译"——要翻译只能重新转换。
- **图书转换卡片可点开的先例**：`BookConvertMiniCard`（`global-convert-progress.tsx:109-192`）整卡可点 → `openBookConvertDialog() + navigate("/")` 还原图书馆页大窗口（阶段流水线、percent、结果 epubPath、导入按钮）。这是"卡片点开看详情"的现存范式。
- **五类卡共享 BottomRightStack**：见 §0 表。卡之间零关联——解析卡、向量化卡、翻译卡各自一张，同一篇论文的"解析→向量化→翻译"链路在 UI 上是三张孤立卡。
- **AI convertPdf 的实bug**（统一入队的强论据）：`convert-pdf.ts:63-80` 直起 startConvert 后，自带监听 5 秒即 `unlisten()`（`:80`）。转换以分钟计 → done 事件几乎必然错过 → **"完成后自动导入书库"的承诺实际不兑现**，且全程无任何进度卡（store 的 bookConvert 未被喂，描述里"转换进度会在界面右下角显示"也不实）。

**改动面**（若入统一队列）：图书转换需要队列化 + 事件归属标识（Rust 加 task_id/pdf_path 注入，照抄 paper_converter.rs:117-125 模式）；图书向量化收敛到统一通道后三入口改为入队调用；AI convertPdf 删自持监听改入队。

---

## 6. 并发可行性（队列内有界并发评估）

### 论文解析通道（converter 子进程 ×N）

- **资源画像**：Papers_Converter sidecar 是纯 API 客户端（引擎 MinerU 云端 VLM / PaddleOCR 云端异步 job；GLM、mineru-pipeline 均已下线，`docs/papers-converter-integration.md:60`），元数据提取走辅助模型（`DEEPSEEK_*` env = OpenAI 兼容端点，`paper_converter.rs:86-91`）。本机内存 = 单个 PyInstaller Python 进程（exe 56MB，运行期数百 MB 级），N=2 可承受；**瓶颈在云端：MinerU token 的 QPS/并发限额与辅助模型 QPS**（具体额度随用户套餐，属外部约束，建议按"可配置并发数，默认 1~2"处理而非写死）。
- **Rust 侧阻塞点**：`PaperConverterState` 单 child 句柄（`paper_converter.rs:15-17,95-99`）——并发两次解析互相覆盖取消句柄（**已知边界**，`docs/next-round-backlog.md:51` 明文记录）。需改成 `HashMap<pdf_path, child>` 或任务 id 键控。
- **事件路由**：已具备多任务归属（每事件注入 pdf_path，`paper_converter.rs:117-125`；前端各链路按 pdf_path 过滤，`convert-progress-store.ts:849`、`paper-service.ts:404`）——并发的最大前置条件已满足。
- **staging/产物隔离**：staging 在 `{appData}/papers-converter/_staging/`，目录形如 `{标题}-{短hex}`（实例 `…-6546e9`，`docs/paper-structure-boundary-plan.md:19`；后缀是否内容 digest 由 converter 侧实现决定，本仓库无源码可核——**待核点**：同一 PDF 两进程并发会共享 staging 撞车）。前端已有内容哈希预去重（`paper-dedup.ts`，`startPaperImportBatch:389-413`）挡住同内容并发；最终产物 `{slug}/` 有碰撞消歧后缀（⑪ chen2023d-ufj6tyeh 例），但消歧若是"看目录已存在"实现则存在 TOCTOU 竞态窗口——**建议并发上限 2 起步并实测**，而非一步到位放开。

### 向量化通道

- 现状：单篇内逐块**串行** HTTP embed（`pipeline.rs:790-837` 循环 `vectorize_text` 逐个 await），批量入库 batch=10；HTTP 超时 connect 10s/总 60s（`text/vectorizer.rs:57-58`），无重试无退避。
- 外部 embedding API（智谱/硅基流动等）有 QPS/批量上限；本地嵌入模型（llama-store 本地方案）则 CPU 绑定，并行无收益。
- **并发两篇的硬伤：SQLite 写锁**。每次 index_paper 各自开连接（`pipeline.rs:771`），连接未设 `busy_timeout`、未开 WAL（`connection.rs:150-156` 只有 synchronous/cache/temp_store）——两库写并发 → `database is locked` 失败面。
- **建议**：通道内不并行多篇，改为**单篇内并行 embed**（如 4 路并发取 embedding、保持写库单线程）+ 连接 `PRAGMA busy_timeout` 兜底；收益同量级且零锁风险。翻译已有同款先例（下条）。

### 翻译通道

- 单篇内已 3 路并发批次（`paper-translation-service.ts:404-405` `TRANSLATE_CONCURRENCY = 3`），块索引互不相交、快照落盘幂等。
- 跨篇再并发 = LLM QPS ×N，辅助模型限额先见底。**建议通道内保持串行**（单篇已并行，跨篇并行的边际收益低、429 风险高）。

### 对进度事件路由的影响

- `paper://index-progress` 按 paper_id 归属（`commands.rs:541-579`；`trackSoloVectorize` 按 paper_id 过滤，`paper-task-store.ts:364-372`）——并发路由 OK；但 solo 卡所有权守卫是 `total===1 && title===标题` 双重比对（`paper-task-store.ts:337-340`），两篇 solo 并发即破——统一队列后按任务 id 发卡即可消除。
- 翻译/图书转换无前端的任务级事件归属（前者纯前端回调、后者无归属字段），并发前必须补。

**结论**：论文解析有界并发 2 可行（先改 Rust 多句柄 + 实测云端 QPS）；向量化走单篇内并行 embed；翻译维持现状。全部以「通道并发数可配置、默认保守」落地。

---

## 7. 统一队列 + 卡片点开看子任务

### 现状到目标的差距

现有三套半独立机制（§0 地图）：解析队列（模块级裸数组 + 单卡）、向量化/翻译双通道队列（zustand + 双卡）、图书转换单任务态（无队列）、Zotero 导入（对话框自持）、以及一堆绕过队列的直跑入口（§0 入口表）。卡片只显示"通道级"聚合（index/total + 当前篇名），无子任务清单；五类卡里只有图书转换小卡可点开（还原本是它的大窗口）。

### 目标形态建议（分层）

**L1 统一任务模型（数据层）**：定义 `TaskItem = { taskId, channel: "paper-parse"|"paper-vectorize"|"paper-translate"|"book-convert"|"book-vectorize", targetId, title, payload, enqueuedAt, status, percent, detail, error }`，`TaskRun = { runId, channel, items: TaskItem[] }`。五通道注册进一张表（zustand store 即可，不必上 SQLite——现状全是内存态，保持简单）。冲突矩阵保留（registry 叶子不动，队列改读同一注册表）。每通道 `concurrency` 字段（默认全 1，解析可配 2）。

**L2 执行器收敛**：把六个直跑入口全部改为 `enqueue()` 薄壳：
- importPaperPdf 的监听/结算逻辑搬入解析通道执行器（AI importPaper 变入队即返或等待句柄）；
- 阅读器翻译、processPaper translate 入翻译通道（force 透传，§2.2）；
- book-item/设置页/AI vectorizeBook 入向量化通道（图书向量化共享通道或独立通道均可——独立通道更贴现状冲突模型）；
- AI convertPdf 入图书转换通道（顺手消掉 5s 监听 bug）；
- Zotero 导入的解析段本就进解析队列，只差卡片数据源自持 → 改读统一 store。

**L3 卡片点开（UI 层）**：聚合卡沿用现有视觉；点击展开抽屉/弹出层列出该 run 的每个子任务（题名 + 状态图标 + 实时 percent/detail + 单任务取消）。图书转换小卡的"点击还原大窗口"是先例；统一后点开的是通用子任务面板（大窗口形态可退役或保留为转换专属详情）。BottomRightStack/禁区逻辑不变。

**改动面评估**：大。执行器收敛涉及 6 入口 × 各自结算/取消语义（取消窗口新意图续跑、solo toast、恢复卡等边角已有大量实证注释，迁移时要逐条对齐）；建议分批：先把"模型 + 图书两类任务队列化 + AI 入口改入队"做掉（消灭 convertPdf bug 与双写打架），卡片点开面板随后，并发最后。

---

## 8. AI 工具使用不清晰（「向量化某篇论文搜不到」复盘）

### 机制事实

- 全局助手工具面 = 14 shared + 22 central = 36 个 > 30 → **恒走目录牌模式**（`lazy-toolset.ts:13-30`；`custom-chat-transport.ts:196-197`）：模型请求里只有 describeTool/useTool 两个真工具，其余全是目录牌上的一行一句话（首行 ≤60 字，`:32-38`）。
- **central scope 没有任何论文语义检索工具**：paperSearch 是 paper scope 专属（`registry.ts:384`），ragSearch 是 reader scope 专属（`:361`）。全局助手找论文只有 `getBooks`——`search` 参数落到 SQL `title LIKE '%kw%' OR author LIKE '%kw%'`（`core/books/commands.rs:124-131`）。
- 指引链对比：processPaper 的描述与参数都写了「先用 getBooks(kind=paper) 确认目标论文的 ID」（`process-paper.ts:63,75`）；**vectorizeBook 没有**——描述只讲 action/kind，bookId 参数只说"要向量化的条目 ID"（`vectorize-book.ts:128-156`）。central-prompt 里 vectorizeBook 一行（`central-prompt.ts:35`）同样无指引；行为准则第 4 条「用户提到书名时先 getBooks」（`:21`）只提书名未提论文；示例只演示了批量模式（`:77-78`）。
- getBooks 自身描述OK（`book.ts:38-52`，kind 区分书/论文讲得很清）。

### 「搜不到那一篇」的最可能链路

用户说"向量化那篇讲 XXX 的论文" → 模型需要 bookId → 调 getBooks(search="XXX 中文主题词") → SQL LIKE 对英文标题零命中 → "未找到"。**语义检索对未向量化论文本就不可达，而 central 连对已向量化论文的语义检索都没有**——发现能力只剩标题/作者子串匹配，这是硬缺口不是模型纪律问题。次要叠加：目录牌一行话 + vectorizeBook 描述无 getBooks 跳板，模型可能索性猜 id 或跳过查 id 直接调（用户观察到的"传参前没查 schema"）；describeTool 跳板纪律本身是写了的（`lazy-toolset.ts:71,89-90`），但它只能让模型查清楚参数形状，查不到"先 getBooks 查 id"这种跨工具编排。

### 改进建议（按性价比排序）

1. **工具描述补跳板**（零风险，先做）：vectorizeBook 描述与 bookId 参数照抄 processPaper 句式——「先用 getBooks(kind=paper) 按标题/作者查得条目 ID；topic 式描述查不到时，先 action=status 列全部条目让用户的描述与标题人工对齐」。central-prompt.ts:35 那行同步补；行为准则第 4 条"书名"改"书名/论文名"。
2. **getBooks 增强**：`limit` 上限 50 对"列全部论文挑一篇"偏小（库里 130 篇）；考虑 status/列表动作返回精简全量（id+title 两列）或 vectorizeBook action=status 的 items 直接可当发现清单用（它本来就返回全量 id+title，`:172-198`——在描述里点明这个用法即可，零代码）。
3. **中量（治本）**：central 加论文语义检索能力（paperSearch 下放 central，或 getBooks 接向量检索兜底）。这是"按主题找论文"的正解，但与统一队列施工独立，可单排。
4. **目录牌模式观测**：在 agent-audit 里记 describeTool/useTool 调用序列，复盘"没查 schema"是模型没读牌还是读了牌也没指引——本次分析支持后者为主。

**改动面**：1/2 为文案级（三个文件各几行）；3 是独立特性；4 加审计字段。

---

## 9. 推荐施工批次

| 批次 | 内容 | 依据 | 体量 |
|---|---|---|---|
| **P0 回归与小修** | ① 右键菜单对被右键篇生效（§1）；② AI convertPdf 入队或至少修 5s 监听 bug（§5）；③ 卡片已翻译徽标 + 右键/批量「重新翻译」+ 队列翻译收尾接对齐（§2） | 全是已定位缺陷，无架构争议 | 小（TS only） |
| **P1 版本对齐基座** | ① sourceHash 记录（翻译+向量化）与 stale 判定（§3.2-1/2）；② 阅读器渲染 hash 校验防错配 + 陈旧横幅（§3.2-3，** correctness 优先**）；③ title_zh/abstract_zh 重解析保留（§3.2-4）；④ 译本死索引 prune；⑤ processPaper/vectorizeBook status 输出 stale、getBooks 带翻译标记、vectorizeBook 加 force（§3.3） | 是 AI 批量编排与卡片陈旧徽标的公共依赖 | 中 |
| **P2 统一队列** | ① L1 任务模型 + 五通道注册（§7-L1）；② 六直跑入口收敛为入队薄壳（§7-L2）；③ 图书转换/图书向量化队列化 + convert://progress 事件归属标识（§5）；④ 卡片点开子任务面板（§7-L3） | 依赖 P1 的状态模型（子任务卡片要显示 stale）；并发不在此批 | 大 |
| **P3 有界并发** | ① PaperConverterState 多句柄化（§6）；② 解析通道并发 2（实测 MinerU/LLM QPS 后定默认）；③ 向量化单篇内并行 embed + busy_timeout；④ converter staging 并发安全核实（待核点：`_staging` 后缀是否内容 digest） | 必须在 P2 通道化之后 | 中 |
| **P4 AI 体验** | §8 的 1/2（描述跳板，可提前搭 P0 便车）→ 4（审计）→ 3（central 语义检索） | 1/2 随时可做 | 小→中 |
| **穿插** | 向量库维度切换自愈（§4 残余雷区 1）+ 存量审计脚本存档（§4-3） | 独立小项，搭 P1 便车 | 小 |

**明确不做**（本次调研结论）：不向量化/翻译的 SQLite 任务持久化（现状全内存态 + metadata 标记已够用，持久化队列等真出现"重启续跑"需求再做）；不动阅读器内翻译的交互形态（入队是 L2 的事，UI 不变）。

## 附：关键实证记录

- dev 全局向量库（`com.bettersageread.dev/papers/vectors.sqlite`）三查全绿：无 (paper_id × chunk_order) 重复、15 篇无孤儿、无 paper_id='' 遗留行；vec0 表 `FLOAT[2048]`。
- 6131195 diff 实证右键菜单回归（§1）。
- `docs/next-round-backlog.md:51` 明文记录 PaperConverterState 单句柄为已知边界（§6）。
- 图书侧 books/{id}/vectors.sqlite 散见文件均属 EPUB 书（含 book.epub），非论文遗留（§4）。
