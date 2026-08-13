# 01 · 总体架构

> 本章讲清五件事：前端分层、Rust 核心、向量检索插件（tauri-plugin-epub）、foliate-js 渲染内核、标签页与休眠机制。
> Agent 系统的细节（工具注册表、确认卡、摘要压缩等）单独见 `04-agent.md`。

## 总览

```
┌─────────────────────────── Tauri 窗口 ───────────────────────────┐
│ React 前端（packages/app/src）                                    │
│  pages / components / services / store / ai                     │
│    └ 阅读器视图 ← foliate-js（<foliate-view> Web Component）      │
└────────────── invoke / event ──────────────────────────────────┘
┌─────────────────────────── Rust 核心 ────────────────────────────┐
│ lib.rs: tauri::Builder + ~150 个 command                         │
│  core/: books papers threads sync mcp skills secrets local_api   │
│         agent_ws llama tags prompts zotero converter ...         │
│  plugins/tauri-plugin-epub: 解析 + 分块 + 向量化 + BM25/混合检索  │
└──────────────────────────────────────────────────────────────────┘
        │ SQLite ({appData}/database/app.db)   │ WebDAV（备份/同步）
```

前后端边界很整齐：前端一切持久化都走 `invoke` 调 Rust command（`services/` 是薄封装层），数据库、文件、网络、密钥都在 Rust 侧。跨窗口/同页组件间通信用自定义事件总线 `services/iframe-service.ts:1-6`（explain/quote 文本传递）。

## 1. 前端分层（packages/app/src/）

### 入口与路由

- 真入口是 `src/main.tsx`：`HashRouter` 包裹 `ReaderLayout`（`main.tsx:55-62`）。启动副作用集中在此：密钥初始化（:20）、拉起本地 API 通道 `invoke("start_local_api")`（:26-30）、全局拦截外链点击交给 plugin-opener（:40-53）。`src/App.tsx` 是 Vite 模板残留，未被使用。
- 路由只覆盖"主页壳"内部七个页面：`components/home-layout.tsx:91-148` 声明 `/`（书库）、`/statistics`、`/chat`、`/trash`、`/skills`、`/converter`、`/papers`。
- **书籍/论文阅读页不走路由**：`components/reader-layout.tsx:470-617` 按 tab 数组绝对定位堆叠所有打开的阅读视图，用 `visibility` 切换——这是标签页秒切与休眠机制的基础（见第 5 节）。

### pages/（八个页面目录）

- `pages/library/` — 书库：书籍网格、拖放导入、批量/AI 打标签、向量化入口（`embedding-dialog.tsx`）；`trash.tsx` 为回收站
- `pages/papers/` — 论文库：文件夹树、卡片右键菜单、Zotero 导入、论文助手面板（`paper-chat-panel.tsx`）
- `pages/paper-reader/` — 论文阅读：`paper-reader-view.tsx` 三段式（左笔记 | 中正文 | 右论文助手）；`paper-reader.tsx` 用 ReactMarkdown + remark-math/rehype-katex 渲染 `paper.md`，同目录有 paper-blocks/paper-sentences/paper-anchors 一整套锚点/对齐/划线模块
- `pages/reader/` — 书籍阅读器：`components/`（annotator、header-bar、toc-view、search-bar 等）+ `hooks/`（use-foliate-viewer、use-pagination、use-annotator 等）+ `store/create-reader-store.ts:12`（**每个 tab 一个独立 vanilla zustand store**）
- `pages/chat/` — 全局聊天页；`pages/converter/` — PDF→EPUB 转换页；`pages/skills/` — "AI Hub"（快捷指令/提示词/技能库/MCP 四 tab，`pages/skills/index.tsx:9-14`）；`pages/statistics/` — 阅读统计（年度热力图）

### components/

- 布局骨架：`reader-layout.tsx`（应用外壳 + 标签系统）、`home-layout.tsx`、`sidebar.tsx`、`vertical-tab-bar.tsx`、`window-controls.tsx`
- 功能块：`settings/`（设置对话框约 20 个分栏：providers、models、sync、proxy、web-search、tts、vector-model、agent、secret-vault 等）、`side-chat/`（阅读侧栏 AI 聊天，含确认卡 `agent-confirm-card.tsx`）、`notepad/`（笔记面板）、`preview/`（html/svg/mermaid/react/markdown 预览）、`markdown/`、`tools/`（mindmap/rag/web-search 查看器）、`ui/`、`icons/`

### services/ 与 store/

- `services/` 绝大多数是 `invoke` 薄封装（如 `sync-service.ts:61-73`、`paper-service.ts:57-70`、`book-service.ts`）；例外是纯前端服务（`iframe-service.ts` 事件总线、`transformers/` 文本变换）
- `store/` 约 20 个 zustand store 按域划分：`layout-store.ts`（tab 列表/休眠清单，persist 落盘，:60-61）、`library-store`、`chat-reader-store`、`provider-store`、`chat-settings-store`、`agent-settings-store`、`agent-confirm-store`（写操作确认卡挂起桥）、`mcp-store`、`converter-store`、`llama-store`（向量模型）、`thread-store`、`tts-store`、`theme-store` 等
- persist 经 `lib/tauri-storage.ts:61-65` 落为 `{configDir}/{name}.json`，key 清单见 `constants/tauri-storage.ts:1-11`（详见 `02-data-model.md` 第 5 节）

### ai/（AI SDK v5 集成层）

- `ai/custom-chat-transport.ts` — 自定义 `ChatTransport`，组装系统提示词、按 scope 取工具、合并 MCP 工具后调 `streamText`（接线细节见 `04-agent.md` 第 7 节）
- `ai/tools/registry.ts:325` — `getToolsForScope(agentScope, context)` 按角色动态组装工具；`tools/central/` 21 个全局工具、`tools/paper/` 论文工具、根级共享工具与 `rag-*.ts` 检索工具
- `ai/mcp/mcp-manager.ts` — MCP 连接管理；`ai/providers/factory.ts` — 按 provider 创建模型实例，统一走 Tauri fetch 绕 CORS
- `ai/hooks/use-chat.ts` — 包装 `@ai-sdk/react` 的 useChat 注入自定义 transport
- 提示词常量在 `src/constants/`：`prompt.ts:13-26` 按 `agentScope` 路由到 `central-prompt.ts`/`paper-prompt.ts`/阅读提示词，并叠加技能与预设
- `ai/utils/`：message-selector（上下文活塞）、token-estimator、tool-guard（写操作拦截）、secret-patterns（脱敏）

## 2. Rust 核心（packages/app/src-tauri/src/）

### 组装

- `main.rs:5` 仅调 `sage_read_lib::run()`，全部逻辑在 `lib.rs`
- `lib.rs:98-118` `tauri::Builder` 注册官方插件（updater、shell、os、global_shortcut、sql、http、fs、opener、dialog、log）与两个自研插件：`tauri_plugin_llamacpp::init()`（:112）、`tauri_plugin_epub::init()`（:118）；:103-106 manage 四个状态（AppState/ConverterState/PaperConverterState/McpStdioState）
- `lib.rs:119-188` setup：载入代理快照 → Windows 去窗口装饰 → release 检查更新 → 应用待恢复数据（`apply_pending_restore`）→ 明文密钥迁移 → `database::initialize` → 回收站清理 → 云端目录迁移
- `lib.rs:190-348` `invoke_handler` 注册约 150 个命令（按模块分组注释）
- `lib.rs:349-393` 拦截 CloseRequested：退出前 L2 推送（5s 超时）→ 清 llamacpp 进程 → 回收全部 MCP stdio 子进程 → destroy

### core/ 子模块一句话职责（清单见 `core/mod.rs:1-20`）

- `books/` — 书籍、标注/书签/摘录、阅读会话 CRUD，回收站，论文入库 `save_paper`/`scan_papers_dir`（`books/commands.rs:8-16`）
- `papers/` — 论文库文件夹树 CRUD（扁平返回、前端组装树）
- `threads/` — AI 对话线程 CRUD；`tags/` — 标签；`prompts/` — 提示词预设（scope 仅 reader/paper）
- `sync/` — WebDAV 同步全家桶：`engine.rs` L2 引擎、`changelog.rs` changeset 行协议、`merge.rs` LWW 合并、`webdav.rs` reqwest 客户端、`backup.rs`/`restore.rs` L1 备份恢复、`files.rs`/`assets.rs` 内容与资产通道、`tables.rs` 同步表注册表。详见 `03-sync.md`
- `mcp/` — MCP stdio 子进程桥（stdout 推事件、密钥引用注入、Windows Job Object 防孤儿）
- `skills/` — 技能 CRUD；`secrets/` — keyring 密钥保管 + `agent_http_request` 代发 + 存量明文迁移（`secrets/migrate.rs`）
- `local_api/` — localhost-only 迷你 HTTP（`/health` + `/embed`，token 写入 `mcp-local.json`，见 `04-agent.md` 第 6 节）
- `agent_ws/` — Agent 工作区路径守卫与文件/命令执行（守卫唯一实现处在 `agent_ws/mod.rs:6-9`）
- `llama/` — llamacpp 本地向量服务（版本常量 `LLAMA_CPP_VERSION` b6692，`llama/mod.rs:5-10`）
- `zotero.rs` — Zotero 7 本地库扫描、去重键、导入状态
- `converter.rs` / `paper_converter.rs` — 两个转换器 sidecar 的 spawn 与进度事件转发（见 `05-papers-pipeline.md`）
- `database.rs` — SQLite 初始化：:41 执行内嵌 `schema.sql`、:55 起 fork 专属迁移、:267/:456 播种 `default-skills.json`
- `state.rs` — AppState（sqlx 连接池 + 备份进行中标志）；`proxy.rs` — 应用级代理三档（off/custom/follow-env），作用于全部 Rust reqwest 请求；`web_search.rs` — 搜索 provider（内置 HTML 爬取 Bing/百度/DuckDuckGo + Tavily/Serper/SearXNG API）；`fonts/` — 字体上传/转换

## 3. tauri-plugin-epub（解析 + 向量化 + 混合检索）

插件装配在 `plugins/tauri-plugin-epub/src/lib.rs:30-49`：`Builder::new("epub")` 注册 15 个命令（`parse_epub`、`index_epub`、`search_db`、`read_book_section`、`index_paper`、`search_papers_db`、`index_manual`、`tokenize_zh` 等）；前端以 `plugin:epub|xxx` 形式调用（如 `ai/tools/rag-search.ts:93`、`services/book-service.ts:325-332`）。

**索引管线**（总入口 `pipeline.rs:16-21` `process_epub_to_db`）：

```
book_dir → 定位 book.epub → epub/reader.rs 解析 → epub2mdbook 转 mdbook
→ TOC 解析（nav.md 优先、toc.ncx 兜底，epub/toc_parser.rs，pipeline.rs:86-105）
→ text/chunker.rs 分块（MIN 50 / MAX 300 tokens、重叠 20%，text/constants.rs:5-11）
→ text/vectorizer.rs 调 embedding → 写入 books/{id}/vectors.sqlite
```

- 分词与计数：`text/tokenizer.rs` tiktoken o200k；`text/zh_segmenter.rs` jieba 中文分词（返回 UTF-16 偏移对齐 JS 下标，供论文词级对齐；注意 BM25 本身**未接中文分词**，见 `05-papers-pipeline.md`）
- Embedding：`text/vectorizer.rs:74-165`，OpenAI 兼容 `/embeddings` 与 Ollama `/api/embed` 双协议（:94 按 URL 结尾判定）；配置仅三项（`models/config.rs:10-14`：url/model/api_key）。本地模式由前端 `llama-store.ts:176-218` 拉起 llamacpp embedding server
- 存储：`database/connection.rs` rusqlite + **sqlite-vec** 自动扩展（不可用时降级 BLOB 表）
- 检索三模式：`database/hybrid.rs:31-46` 按 `VectorOnly / BM25Only / Hybrid` 分派；BM25 在 `database/bm25.rs`（k1/b 参数化）
- 融合排序（`hybrid.rs:83-105, 115-161, 187-210`）：两路各取 `limit*2` → 各自 min-max 归一化 → 加权 `vector_weight*v + bm25_weight*b`（单边缺失退化为单路）→ 排序截断。默认权重 0.7/0.3、k1=1.2、b=0.75（`config/search.rs:21-29`），短查询智能偏向 BM25（`config/search.rs:45+`）
- 内置使用手册走同一管线：`manual.rs:1-7` 把手册作为虚拟语料库 `__app_manual__` 落盘索引（前端 `services/manual-service.ts:34-53`）

**两条向量存储路径**：书籍每书一库（`books/{id}/vectors.sqlite`，重建时直接删库文件，`pipeline.rs:171-186`）；论文全局单库（`{appData}/papers/vectors.sqlite`，按 `paper_id` 幂等重索引，`pipeline.rs:710-779`）。详见 `02-data-model.md` 第 4 节。

## 4. foliate-js 阅读器渲染

`packages/foliate-js/` 是上游 foliate-js 的 vendored fork（`README.md:1-3`），本地仅少量补丁（git log 两笔：init + 滚动模式滚动条鼠标拖动）。仓库根部的 `reader.html` 只是上游 demo，**应用不走 iframe 加载它**。

实际嵌入方式：

- 应用以 workspace 依赖引入，`pages/reader/hooks/use-foliate-viewer/foliate-viewer-manager.ts:80-85` 动态 `import("foliate-js/view.js")` 后 `document.createElement("foliate-view")` 挂进阅读容器
- 开书在 `foliate-viewer-manager.ts:128` `view.open(bookDoc)`（BookDoc 由 `lib/document.ts` DocumentLoader 加载）
- 内核内部：`foliate-js/view.js:273-276` 按书籍类型选 `foliate-paginator`（流式）或 `foliate-fxl`（定版）；paginator 内部才用 iframe 渲染各 section（`paginator.js:215,248`，沙箱 `allow-same-origin allow-scripts`）
- 滚动/分页切换：内核侧 `paginator.js:295-300`（`flow !== "scrolled"` 走 CSS 分栏分页）；应用侧 setAttribute 切换（`pages/reader/components/settings-dropdown.tsx:248`、`style-manager.ts:48-49`），快捷键在 `use-book-shortcuts.ts:45-48`，页码/滚动事件在 `use-pagination.ts:16,71-113`

## 5. 标签页与休眠机制

### 标签系统

- UI 由 workspace 库 `app-tabs` 提供（受控组件 `Tabs`，拖拽排序基于 Draggabilly）；横向标签栏渲染在 `reader-layout.tsx:410-449`，竖排模式由 `components/vertical-tab-bar.tsx:12-18` 实现（48px 窄条悬停浮层、按书籍/论文分组）
- 状态在 `store/layout-store.ts`：Tab 类型 :9-14（`type: "book" | "paper"`，bookId 字段复用为 paperId）；zustand persist 持久化（:60-61）
- `openBook`（:80-100）：tabId = `reader-{bookId}`，已开则激活，否则 `createReaderStore(bookId)` 建**独立阅读 store**，挂在 `readerStores: Map`（:34, 90-93）——每 tab 状态外置是休眠/恢复能成立的前提

### 休眠（`reader-layout.tsx:86-152`）

- 双条件：宽限期 10 分钟（`TAB_SLEEP_GRACE_MS`，:90）+ 挂载上限 6（`TAB_MOUNT_LIMIT`，:91），30 秒巡检（:117-150），超限按 LRU 立即休眠（:132-142）
- **PDF tab 永不休眠**（原生 iframe 无位置恢复通道，:129-130）
- 休眠只卸载重型阅读视图（`{!isSlept && <ReaderViewer />}`，:605），**侧栏/聊天保活**以护流式任务（:87-88 注释）；阅读状态存于 per-tab zustand store，重挂载自动恢复
- 休眠清单 `sleptTabIds` 在 `layout-store.ts:42-44`（不持久化）；唤醒一次性标记 `markTabWoken/consumeTabWoken`（:20-28）让重挂载时的"开书快拉"（`syncPullNow`）静默
- 休眠 tab 在标签栏置灰（`dimmed`），标题支持公式 HTML

> 注意：根 `package.json:20` 声明的 `keepalive-for-react` 是**未使用的遗留依赖**（全仓源码零引用）；保活语义由上述条件渲染 + 状态外置自行实现。仓库里凡涉及"标签页保活"的讨论以此为准。

## 6. 附：进程间事件与模型层速查

**Tauri 事件**（Rust emit → 前端 listen）：

- `convert://progress` / `paper-convert://progress` — 两个转换器 sidecar 的逐行 JSON 进度（`core/converter.rs:101-147`、`core/paper_converter.rs:104-157`，后者给每条注入 `pdf_path` 防并发串台）
- `mcp-stdio://{session_id}` — MCP stdio 子进程 stdout 逐行上行（`core/mcp/mod.rs`）
- `sync-backup-done` — L1 备份完成，进通知中心（`hooks/use-sync-events.ts:14`）；L2 自动同步则完全静默
- 同页组件间另有自定义事件总线 `services/iframe-service.ts:1-6`（explain/quote 文本传递，不经 Rust）

**模型层**（`ai/providers/factory.ts`）：

- 按 provider 创建 AI SDK 实例：openai / deepseek / google / openrouter / openai-compatible，统一走 `@tauri-apps/plugin-http` 的 fetch 绕 CORS
- 思考强度由 `reasoning-map.ts` 按端点/模型分档打请求体补丁；摘要压缩、术语表抽取等轻量任务用辅助模型实例并关闭思考
- 模型配置持久化在 `provider-store` / `llama-store`，密钥永远只在 keyring（见 `02-data-model.md` 第 5 节）

**PDF tab 特例**：未转换的原始 PDF 直接用原生 iframe 渲染，没有位置恢复通道——休眠机制因此对 PDF tab 永远豁免（`reader-layout.tsx:129-130`）。
