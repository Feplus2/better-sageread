# 02 · 数据模型与存储布局

> 两个根目录先锚定：`app_data_dir()`（简称 `{appData}`，存数据库/书籍文件/向量库）与 `app_config_dir()`（简称 `{configDir}`，存各类配置 JSON）。开发期 identifier 为 `com.bettersageread.dev`，数据目录名随平台惯例（Windows 为 `%APPDATA%\\com.bettersageread.dev\\`）。

## 1. 数据库与 schema 的两层结构

数据库文件：`{appData}/database/app.db`（`core/database.rs:21-24`），sqlx `SqlitePool` 打开；库不存在则 `Sqlite::create_database` 创建，每次启动都执行内嵌 `schema.sql`（全 IF NOT EXISTS 幂等）+ `run_migrations()`（`database.rs:30-46`）。

**关键认知：schema 分两层，直接读 `schema.sql` 会漏掉一半表。**

- 基础层：`core/schema.sql`（ threads/books/book_status/reading_sessions/tags/book_notes/notes/skills ）
- 迁移层：`database.rs:55` 起的 `run_migrations()`——fork 专属的新列与新表全在这里（文件头注释明确要求**新增列勿写进 schema.sql**，见 `schema.sql:1` 与 `database.rs:55-56`）。迁移风格：无版本表，纯幂等增量——`ALTER TABLE ADD COLUMN` 捕获 "duplicate column name" 跳过、`CREATE TABLE IF NOT EXISTS`、外加数据回填与系统提示词手术式升级

WAL：代码未显式设置 `PRAGMA journal_mode`，依赖 sqlx 默认（WAL）；`sync/restore.rs:152-154` 明确处理 `app.db-wal`/`app.db-shm` 伴生文件，`sync/backup.rs:243` 注释说明活库直接拷贝会带未合并的 WAL 页。

### 主要表

**schema.sql 层**

- `threads`（`schema.sql:2`）— AI 对话线程。`book_id`（可空，外键级联删）、`metadata`（JSON，滚动摘要存这里，见 `04-agent.md` 第 3 节）、`title`、`messages`（JSON）、`created_at/updated_at`；`starred` 与 `scope`（'global'/'book'）由迁移后补（`database.rs:59,109`）
- `books`（`schema.sql:13`）— **书籍与论文共用主表**。`title/author/format/file_path/cover_path/file_size/language/tags(JSON)`。论文即 `format='MARKDOWN'` 的行，`paper_folders.paper_id` 直接引用 `books(id)`（`database.rs:190`）；`trashed_at`（回收站）由迁移后补（`database.rs:70`）
- `book_status`（`schema.sql:30`）— 阅读状态 1:1。`status`（unread/reading/completed）、`progress_current/total`、`location`（CFI）、`rating`（0-3）、`last_read_at/started_at/completed_at`、`metadata`；迁移后补 `position_changed_at`（同步 LWW 用，`database.rs:81`）、`dwell_seconds`（:92）
- `reading_sessions`（`schema.sql:47`）— 阅读会话流水（`duration_seconds` 等），统计页数据源
- `ai_usage`（`schema.sql:150`）— AI 用量流水（2026-08 增）：每条 AI 回复 finish 落一行（`thread_id`（首轮可空）/`scope`/`provider_id`/`model_id`/`input_tokens`/`output_tokens`/`created_at`），统计页 AI 用量数据源；**不参与 L2 同步**（与 reading_sessions 同级的地方性统计数据）
- `tags`（`schema.sql:78`）— 标签字典（`name` UNIQUE、`color`）
- `book_notes`（`schema.sql:90`）— 标注/书签/摘录。`type`（bookmark|annotation|excerpt）、`cfi`、`text`、`style`、`color`、`note`、`context_before/after`；迁移后补 `category`（AI 重点标注类别，`database.rs:364`）、`source`（user/ai，:375）、`starred`（:386）
- `notes`（`schema.sql:116`）— 笔记面板的**长文 Markdown 笔记**，与 book_notes 是两套概念。三列定位：`location_cfi`（论文=heading slug，书籍=CFI）、`location_tag`（文本兜底）、`location_block`（排序键）。注意此表在 schema.sql:116 与 `database.rs:154` **各建了一遍**（刻意幂等）；`database.rs:150-152` 注释警告**不可再加 `DROP TABLE IF EXISTS notes` 迁移**（首轮"notes 概念废弃"迁移曾 DROP 旧表导致数据丢失）
- `skills`（`schema.sql:134`）— AI 技能库（Markdown SOP），`is_active`、`is_system`（系统技能不可删）；`scope`（reader/central/both）由迁移后补（`database.rs:120`）

**仅由迁移创建的表**

- `_sync_log`（`database.rs:138`）— L2 增量同步变更日志：`seq` 自增、`table_name`、`row_id`、`op`、`at`
- `folders`（`database.rs:177`）— 论文库文件夹树，`parent_id` 自引用级联删；`trashed_at` 后补（:204）
- `paper_folders`（`database.rs:189`）— 论文↔文件夹多对多，复合主键 `(paper_id, folder_id)`
- `zotero_collections`（`database.rs:216`）— Zotero collection key → 本地 folder 映射缓存
- `zotero_paper_state`（`database.rs:228`）— 论文 Zotero 链接去重状态，`zotero_key` UNIQUE；**无外键**，彻底删书时需手动清（`books/commands.rs:334`）
- `prompt_presets`（`database.rs:246`）— 命名提示词预设，`scope` + 同 scope 内 `is_active` 互斥，无激活行时用内置默认

**同步触发器**：schema.sql 中**没有** CREATE TRIGGER。33 个触发器（11 张同步表 × AFTER INSERT/UPDATE/DELETE）由 `database.rs:413-449` 在每次启动时 DROP+CREATE 自愈式重建；`paper_folders` 的 row_id 用 `NEW.paper_id || ':' || NEW.folder_id` 拼接（:422）。同步表清单见 `core/sync/tables.rs`（细节见 `03-sync.md`）。

两个通用约定：

- 多张表带 `metadata` TEXT 列（JSON），是该实体的扩展包——例如 `threads.metadata` 放滚动摘要与星标外的杂项，`book_status.metadata` 放视图杂项
- `folders`/`paper_folders` 的 CRUD 由 `core/papers/commands.rs` **扁平返回**、前端组装树（`commands.rs:6-15`）；可见性沿父链在内存判定（:23-38）

## 2. 每本书的磁盘目录 `{appData}/books/{id}/`

创建入口 `save_book`（`core/books/commands.rs:17-45`）。目录内容：

- `book.{format}`（如 `book.epub`）— 原始书文件（:26-29）；插件侧按此约定读取（`plugins/tauri-plugin-epub/src/commands.rs:50`）
- `cover.jpg` — 封面（:32-35）
- `metadata.json` — 元数据（:40-43；论文导入/重解析/Zotero 也写它）
- 论文（MARKDOWN）专有：`paper.md`（正文）、`images/`（插图）、`source.pdf`（原始 PDF）（`:1334-1461`）
- EPUB 管线产物（tauri-plugin-epub）：`mdbook/`、`chapters/`（`pipeline.rs:110`）、`metadata.md`（`pipeline.rs:561`）、`vectors.sqlite`（每书向量库，`pipeline.rs:26`）
- `view-settings.json` — 前端按书写的视图设置（`src/lib/tauri-storage.ts:166-168`）

各文件的生产者一览：

| 文件/目录 | 生产者 | 出处 |
| --- | --- | --- |
| `book.{format}` | `save_book` 从临时路径 rename | `core/books/commands.rs:26-29` |
| `cover.jpg` | `save_book` | `commands.rs:32-35` |
| `metadata.json` | `save_book` / 论文导入 / 重解析 / Zotero | `commands.rs:40-43,1392,1515`、`core/zotero.rs:441` |
| `paper.md`、`images/`、`source.pdf` | `save_paper`（仅 MARKDOWN 论文） | `commands.rs:1334-1461` |
| `mdbook/`、`chapters/`、`metadata.md` | EPUB 索引管线 | `pipeline.rs:110,561`、插件 `commands.rs:140` |
| `vectors.sqlite` | 索引管线（每书一库） | `pipeline.rs:26` |
| `view-settings.json` | 前端按书写的视图设置 | `src/lib/tauri-storage.ts:166-168` |
| `translation-zh.json` | 论文翻译产物（仅 MARKDOWN，块级平行译本；`fn:<id>` 键 = 脚注译文，不占块序号） | `services/paper-translation-service.ts:24-25,123` |

版本锚与状态戳记（2026-08-24，重解析/翻译/向量化的版本对齐基座）：

- `translation-zh.json` 顶层 `sourceHash` = 所译 paper.md 内容的 sha256-16（`core/books/commands.rs` 的 `paper_source_hash`，与 scan 入库 id 同算法）；`metadata.json` 顶层 `vectorizedSourceHash`（`index_paper` 成功后写入）与 `translationRunState`（翻译收尾写入 `complete`/`partial`，中断/批次失败为 partial——列表三色徽标的「不完整」来源）
- `get_paper_source_status(paperId)` 据锚比对 + 向量分片计数给出 `translationStale`/`vectorizedStale`；`replace_paper_content` 重解析时按「原文没变才保」并入旧 `title_zh/abstract_zh`，并调 `purge_paper_vectors` 清死向量
- 陈旧译本阅读器不显示（防错配），续翻（force=false）补齐变化块后锚复原；换嵌入维度模型时 `initialize_schema` 比对 vec0 维度，不一致自动 drop 重建（全库向量随之判 stale）

删除时整个目录 `remove_dir_all`（`books/commands.rs:321-324`）。

`books/` 之外的 `{appData}` 目录：

- `papers-converter/` — 论文转换器工作目录（`core/paper_converter.rs:49`）
- `agent-workspace/` — Agent 工作区默认根（`core/agent_ws/mod.rs:7-16`）；其中的 memory.md 记忆约定由前端提示词注入维护（`src/ai/utils/workspace-context.ts:29,37-53`）
- `papers/vectors.sqlite` — 论文全局向量库（见第 3 节）
- `agent-audit/*.jsonl` — Agent 审计日志（mcp-stdio、local-api，写盘前脱敏）
- `mcp-local.json` — 本地 API 通道的 `{port, token}`（`core/local_api/mod.rs:300-310`）

`reading_sessions` 表是统计页（`pages/statistics/`，年度热力图）的数据源：每次阅读会话记一行流水（`duration_seconds` 等），配合 `book_status.dwell_seconds`（迁移后补，`database.rs:92`）做停留时长统计。2026-08 起统计页并入 `ai_usage` 流水（AI 用量四卡 + 模型占比图表），且改为**一次性取全量行级数据、前端按时间单位切片聚合**（日/周/月/年/全部 + 热力图年份过滤零请求）。

## 3. 论文统一向量库 `{appData}/papers/vectors.sqlite`

- 路径出处：`plugins/tauri-plugin-epub/src/commands.rs:520-590`（`index_paper`）、`:612-670`（`search_papers_db`）；清理侧 `core/books/commands.rs:350`；备份侧 `core/sync/backup.rs:244`
- 表结构与 per-book 库同 schema（建在 `plugins/tauri-plugin-epub/src/database/connection.rs`）：
  - `document_chunks`（:161）— 分片主表：`book_title/book_author`（论文借用了书的列名）、`paper_id`（:165）、`md_file_path`、`chunk_text`、`chunk_order_in_file`、`global_chunk_index`、`is_references`（:173，检索默认排除参考文献区段）等
  - `chunk_embeddings`（:242）— sqlite-vec `vec0` 虚拟表；扩展不可用时降级 `chunk_embeddings_fallback` BLOB 表（:260）
  - `bm25_stats`（:321）— BM25 统计缓存（内容变了即清空重建）
  - 性能 pragma：`synchronous=NORMAL`、`cache_size=10000`、`temp_store=memory`（:153-155）
- 语义分离：**论文内容存 `books/{id}/`，向量存全局库**。`index_paper` 读 `books/{paper_id}/paper.md`，按 `paper_id` 先删后插（幂等重索引，`pipeline.rs:709-779` 的 `process_paper_to_db`，插件命令入口 `commands.rs:520-590`），前端入口 `services/paper-service.ts:271`
- 级联清理：彻底删除 MARKDOWN 论文时连带清全局库分片（`books/commands.rs:340-416`，软删不清、回收站可恢复）；对端彻底删除经同步到达时同样清理（`core/sync/engine.rs:1038-1049`）

## 4. 配置 JSON 清单（`{configDir}` 下）

前端 zustand persist 经 `tauriStorage` 落盘为 `{configDir}/{name}.json`（`src/lib/tauri-storage.ts:61-65`），key 清单在 `src/constants/tauri-storage.ts:1-11`：

- `model-provider.json` — LLM 提供商配置（apiKey 字段已置空，密钥在 keyring，`secrets/migrate.rs:96`）
- `app-settings.json` — 应用设置
- `llama-store.json` — 向量/本地模型配置（apiKey 同样迁出，`migrate.rs:111`）
- `layout-store.json` / `quick-commands.json` / `agent-settings.json` / `chat-settings.json` — UI 布局、快捷指令、Agent 与聊天设置
- `converter-store.json` — 论文转换器服务配置（mineru/paddleocr/glm token 已迁出，`migrate.rs:126`）
- `mcp-servers.json` — MCP 服务器配置，env 敏感值改写为 `{{secret:...}}` 引用（`migrate.rs:165`）
- `webdav-config.json` — WebDAV 同步配置（密码迁出 keyring，读取时回填内存，`sync/commands.rs:15,36-56`）

Rust 侧直接读写的：

- `sync-state.json` — 同步状态：设备 ID、备份哈希、`last_pushed_seq`、`last_pulled`（每远端设备应用水位）（`sync/backup.rs:57-65`，结构 `sync/models.rs:123-141`）
- `proxy.json` — 代理配置，MCP 子进程 env 注入也读它（`core/proxy.rs:37`、`core/mcp/mod.rs:135`）
- `secret-names.json` — 用户密钥保管箱的名称登记（keyring 无列举 API 的补偿，`secrets/mod.rs:175-211`）
- `secrets-fallback.json` — keyring 不可用时的降级明文存储（见下节）
- `pending-restore.json` — 待恢复备份的暂存标记（`sync/restore.rs:144,263`）
- `sync-staging/l2-safety/*.db` — 同步应用前的安全快照（`sync/engine.rs:220-246`）
- `{appData}/mcp-local.json` — 本地 API 通道的 `{port, token}`（`local_api/mod.rs:300-310`）
- `{appData}/agent-audit/*.jsonl` — Agent 审计日志（写盘前脱敏）

另：`web-search-engine`、`tts-config-storage`、`thread-store` 等仍用 **localStorage**（如 `store/web-search-store.ts:63-64`），不是文件。

## 5. 密钥保管箱（`core/secrets/`）

- keyring 服务名 `com.bettersageread.app`，account 命名 `{category}:{key}`：`model-provider:{id}`、`vector-model:{id}`、`converter:{service}`、`webdav:password`、`web-search:{provider}`、`tts:{service}`、`mcp:{serverId}:{envKey}`（旧版遗留）、`user:{NAME}` 用户保管箱（`secrets/mod.rs:1-9,18`）
- **降级路径**：keyring 后端不可用（如 headless Linux）时明文写 `{configDir}/secrets-fallback.json` 并 `log::warn!`（`mod.rs:19-20,49-65`）——"永不明文落盘"是主路径承诺，代码明确保留了可用性兜底（模块头注释 :3-4 承认此取舍）
- `{{secret:NAME}}` 解析：正则 `\{\{secret:([A-Za-z0-9_-]{1,64})\}\}`（`mod.rs:106`），`resolve_secret_refs` 把引用换成 `user:{NAME}` 真值，未知名称**报错不静默置空**（:110-132）
- 注入点全在 Rust 侧 / 出网前最后一刻：MCP stdio 启动 env（`mcp/mod.rs:173-175`）、`agent_http_request` 的 URL/headers/body（`secrets/mod.rs:291-317`）、MCP http/sse headers 经 `secret_resolve_batch` 在前端建 transport 前批量替换（:157-162）。模型只见占位符，真值不进模型上下文
- 明文清除的体现：存量 JSON 的 key 字段迁移后**置空**（`migrate.rs:67-71`）；zustand `partialize` 保证内存 key 不再落盘（`src/services/secret-init.ts:16`）；前端仅经 `secret_get_for_runtime` 把 key 载入内存发请求（`secrets/mod.rs:151-155`）；审计日志写盘前 `redact_secrets` 按模式脱敏（:244-279，与前端 `ai/utils/secret-patterns.ts` 同款清单）

## 6. 回收站语义

**书籍是软删除**。`books.trashed_at`（可空毫秒时间戳）由迁移添加（`database.rs:70`）：

- 删除：`UPDATE books SET trashed_at = ?, updated_at = ?`（`books/commands.rs:253-272`）——磁盘文件与 book_status/threads 等关联数据全部保留；`updated_at` 必须同步推进，否则 L2 同步按 LWW 比较时删除赢不了对端（:256-257 注释）
- 列表/恢复：`get_trashed_books` 按删除时间倒序（:294-305），`restore_book` 清 `trashed_at`（:275-291）
- 彻底删除：`purge_book`（:419-423）/`purge_book_by_id`（:307-345）——删磁盘目录 + `DELETE FROM books`（外键级联清关联表）+ 手动清 `zotero_paper_state` + MARKDOWN 论文连带清全局向量库
- 自动清理：保留 30 天（`TRASH_RETENTION_DAYS`，:426），启动时 `purge_expired_trash`（:429 起）

**文件夹同样软删**：`folders.trashed_at`（`database.rs:204`），删父即子树整体隐藏（沿父链判定可见性，`core/papers/commands.rs:23-38,318-335`），恢复后结构与论文归属原样回来；`purge_folder` 级联删子文件夹与 paper_folders 行，但**论文本身不删**（:163-180）。

## 7. 改 schema 的正确姿势（给新开发者）

1. **新列/新表写进 `database.rs` 的 `run_migrations()`，不要动 `schema.sql`**（文件头注释 `schema.sql:1` 明确要求，避免与 ALTER 重复）
2. 写法必须幂等：`ALTER TABLE ADD COLUMN` 捕获 "duplicate column name" 跳过；`CREATE TABLE IF NOT EXISTS`；数据回填可重入
3. 新表若要进 L2 同步：在 `core/sync/tables.rs` 注册表登记（列清单即 changeset data 的白名单），触发器由 `database.rs:413-449` 的自愈重建自动覆盖
4. **绝不要**写 `DROP TABLE IF EXISTS notes` 这类破坏性迁移（`database.rs:150-152` 注释记录过事故）
5. 改完跑 `cd packages/app/src-tauri && cargo test`（sync 引擎测试会建独立夹具副本，能抓住注册表/触发器不一致）

## 8. 写作备忘（易踩的坑）

- schema.sql 不是全部 schema；`folders`/`paper_folders`/`prompt_presets`/`zotero_*`/`_sync_log`/全部触发器都在 `database.rs` 迁移里
- 论文没有独立主表，复用 `books`（`format='MARKDOWN'`）
- `notes`（长文笔记）与 `book_notes`（划线/书签）是两套概念，别混用
- 论文"内容在 books/、向量在 papers/"的分离容易误读，引用时讲清楚
- `sync/engine.rs` 里的集成测试带独立建表/建触发器副本（`engine.rs:1318-1420`），属测试夹具，不是运行路径
