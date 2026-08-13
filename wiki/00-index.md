# 00 · 项目地图

> 面向新加入开发者的导读：这是什么项目、技术栈、仓库怎么分布、如何跑起来。
> 本 wiki 只描述**当前已落地**的状态；设计文档（`docs/`）记录演进过程，与代码冲突时以代码为准。

## 这是什么

**Better SageRead** 是一款本地优先的 EPUB 书籍 + 学术论文阅读器，核心特色是阅读时随时与 AI 对话。它是 [xincmm/sageread](https://github.com/xincmm/sageread) 的独立演进分支（渊源见根目录 `NOTICE`），许可证 AGPL-3.0。

- 平台：macOS（arm64 + x86_64）与 Windows（发布矩阵见 `.github/workflows/release.yml`）
- 数据全部本地存储，AI 服务自行配置（OpenAI/Anthropic 风格端点、OpenRouter、DeepSeek 等），向量模型支持在线 API 与本地 llamacpp（本地仅 macOS）
- 首次使用引导：设置 → 模型提供商配 LLM → 向量模型配置配 embedding → 书库点"开始向量化"，之后即可用 RAG 对话（README 使用引导节）

核心能力（对应 README 特性表，均已在代码中落地）：

- EPUB 阅读（滚动 / 分页双模式）、论文 PDF 经转换管线解析为 `paper.md` 后阅读
- AI 助手三件套：全局助手（central）、阅读助手（reader）、论文助手（paper），见 `wiki/04-agent.md`
- 高亮 / 书签 / 摘录、笔记面板、阅读统计
- 向量化语义检索（书籍每书一库、论文全局一库），见 `wiki/01-architecture.md` 与 `wiki/05-papers-pipeline.md`
- WebDAV 备份（L1 整包）与增量同步（L2 多设备），见 `wiki/03-sync.md`
- 技能系统（兼容 Claude Code SKILL.md）、MCP 扩展（stdio + HTTP/SSE）、密钥保管箱（keyring + `{{secret:}}` 引用）
- TTS 朗读、主题定制；数据全部本地存储

## 技术栈

| 层 | 技术 | 版本依据 |
| --- | --- | --- |
| 前端框架 | React 19 + TypeScript 5.8 + Vite 7 | `packages/app/package.json`（`react ^19.1.0`、`typescript ~5.8.3`、`vite ^7.0.4`） |
| 桌面壳 | Tauri 2.8（Rust） | `packages/app/src-tauri/Cargo.toml`（`tauri = "2.8"`） |
| 路由 | react-router v7（HashRouter） | `packages/app/src/main.tsx:55-62` |
| 状态管理 | zustand 5（含 persist 落盘） | `packages/app/src/store/` |
| AI | Vercel AI SDK v5（`ai ^5.0.44`、`@ai-sdk/react ^2.0.44`） | `packages/app/src/ai/` |
| UI | Tailwind CSS 4 + 自研组件（`components/ui/`，shadcn 风格） | `packages/app/package.json` |
| Rust 关键依赖 | tokio 1、sqlx 0.8（SQLite）、reqwest 0.12、rusqlite 0.32 | `packages/app/src-tauri/Cargo.toml` |
| 阅读器内核 | foliate-js（vendored fork，见下） | `packages/foliate-js/` |
| 向量检索 | sqlite-vec（自动扩展）+ 自研 BM25 + 加权融合 | `packages/app/src-tauri/plugins/tauri-plugin-epub/` |
| 构建/包管理 | pnpm workspace、cargo、Biome 1.9.4（格式化/lint） | 根 `package.json`、`biome.json` |

包名与标识：Rust 包名 `better-sageread`（lib 名 `sage_read_lib`，`packages/app/src-tauri/Cargo.toml:2,14`）；开发期 identifier 为 `com.bettersageread.dev`（`packages/app/src-tauri/tauri.conf.json:5`），发布 workflow 会改写为 `com.bettersageread.app`。

## 仓库结构

pnpm monorepo（`pnpm-workspace.yaml:1-12`，workspace 含 `packages/*`；`overrides` 把 katex 统一锁 0.18 修类名错位；`allowBuilds` 白名单 `@biomejs/biome`、`@tailwindcss/oxide`、`es5-ext`、`esbuild`，漏配会报 `ERR_PNPM_IGNORED_BUILDS`）。

```
SageRead/
├── packages/
│   ├── app/            # 主应用：前端 src/ + Rust 后端 src-tauri/
│   ├── app-tabs/       # Chrome 风格标签 UI 库（拖拽排序，基于 draggabilly）
│   └── foliate-js/     # EPUB 渲染内核（johnfactotum/foliate-js 的 vendored fork）
├── scripts/            # 开发辅助脚本：15 个 test-*.mjs、62 个 cdp-*.mjs 等
├── docs/               # 23 篇设计/演进文档（见下"文档地图"）
├── fixtures/papers/    # 测试用样例论文（akter2026atscale，CC-BY 开放获取论文的真实管线产物）
├── assets/             # README 截图
├── package.json        # 根脚本入口（dev/build/...）
└── biome.json          # 统一代码风格（行宽 120、双引号、Tailwind 类排序）
```

### packages/app（主应用）

- `src/` 前端：`pages/`（页面）、`components/`（组件）、`services/`（Tauri command 封装）、`store/`（zustand）、`ai/`（AI SDK 集成层）等，详见 `wiki/01-architecture.md`
- `src-tauri/` Rust 后端：`src/core/` 为全部业务核心（books/papers/sync/mcp/skills/secrets/...），`src-tauri/plugins/tauri-plugin-epub/` 为自研向量检索插件，另有 `tauri-plugin-llamacpp`（本地向量模型）。`src-tauri/binaries/` 存放两个转换器 sidecar exe（gitignored，需手工准备，见 `wiki/05-papers-pipeline.md`）
- 约 140 个 Tauri command 在 `packages/app/src-tauri/src/lib.rs:190-347` 注册

### packages/app-tabs

Chrome 风格标签 UI 库，导出受控组件 `Tabs`（`packages/app-tabs/src/index.tsx:3-6`），`src/chrome-tabs.ts` 用 Draggabilly 实现拖拽与重叠布局。注意其 `README.md` 写的 `useTabs`/`TabContainer` API 已过时，以源码为准。

### packages/foliate-js

EPUB 渲染内核，是上游 [johnfactotum/foliate-js](https://github.com/johnfactotum/foliate-js) 的 vendored fork（`packages/foliate-js/README.md:1-3`），本地补丁很少（如滚动模式滚动条支持鼠标拖动）。应用以 workspace 依赖 `"foliate-js": "workspace:*"` 引入（`packages/app/package.json`），由 `src/pages/reader/hooks/use-foliate-viewer/foliate-viewer-manager.ts:80-85` 动态 `import("foliate-js/view.js")` 使用。根脚本 `pnpm build:foliate` 单独构建它。

### scripts/

约 90 个 `.mjs` 开发脚本，三类：`test-*.mjs`（esbuild 打包 TS → node 断言的轻量单测）、`cdp-*.mjs`（Chrome DevTools Protocol 连运行中应用做 DOM 断言/截图/性能采样）、双实例 E2E（`test-l1-backup-restore-e2e.mjs`）。用法详见 `wiki/06-dev-workflow.md`。

### docs/

23 篇设计文档，按主题对应 wiki 章节：

- Agent：`agent-ecosystem-plan.md`、`agent-next-phase-plan.md`、`agent-capability-roadmap.md`、`agent-tool-recipe.md`
- 同步：`sync-protocol.md`、`sync-testing-guide.md`
- 论文管线：`format-strategy-and-paper-module.md`、`papers-converter-integration.md`、`books-converter-integration.md`、`paper-format-contract.md`、`paper-textlayer-pipeline.md`、`paper-structure-boundary-plan.md`、`paper-polish-backlog.md`、`paper-reading-feasibility.md`、`sidebar-figures-notes-plan.md`
- 其他：`release-workflow.md`、`zotero-batch-import.md`、`performance-optimization-plan.md`、`refactoring-lessons.md`、`living-library-vision.md`、`local-roadmap.md`、`next-round-backlog.md`、`THEMING.md`

**重要提醒**：这些文档记录的是决策演进史，早期结论可能被后续推翻（典型例子：云端目录已从 `sageread/` 更名为 `bettersageread/`，同步文档未跟进）。读文档时以日期较新者为准，引用行为时务必回代码核实——本 wiki 各章末尾列出了已知的文档/代码不一致点。

## 构建与运行

前置：Node.js（建议 22+，CDP 脚本用到内置 `WebSocket`）、pnpm 11（CI 同版本；pnpm 9 与 v11 写的 lockfile 不兼容，会报 `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`）、Rust stable、Tauri 2 系统依赖（Windows 需 WebView2；macOS 需 Xcode CLT）。

```bash
pnpm install     # 安装 workspace 依赖（allowBuilds 白名单勿删）
pnpm dev         # = cd packages/app && pnpm tauri dev：Vite(1420) + Rust 一体启动
pnpm build       # = 前端 tsc && vite build，再 pnpm tauri build 出安装包
```

其他根脚本（根 `package.json:7-12`）：`pnpm preview`（预览前端产物）、`pnpm build:foliate` / `pnpm build:app-tabs`（构建两个子包）、`pnpm tauri`（透传 tauri CLI）。

常用开发命令：

```bash
cd packages/app/src-tauri && cargo test   # Rust 测试（约 58 个用例，sync 与 epub 插件为主）
pnpm --filter app exec tsc --noEmit       # 前端类型检查
biome check <改动文件>                     # 格式化/lint（无 npm script 封装，直接调用）
node scripts/test-xxx.mjs                 # 前端轻量测试（见 06 章）
```

运行中的调试：Windows 下用 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 pnpm dev` 启动即可被 `scripts/cdp-*.mjs` 连接；macOS 用 Tauri devtools feature（`Cargo.toml` 中已开）。详见 `wiki/06-dev-workflow.md`。

## 关键入口速查

| 关心的事 | 入口文件 |
| --- | --- |
| 应用组装 / 命令注册 / 退出钩子 | `packages/app/src-tauri/src/lib.rs` |
| 前端入口与启动副作用 | `packages/app/src/main.tsx` |
| 应用外壳 + 标签页 + 休眠 + 同步调度 | `packages/app/src/components/reader-layout.tsx` |
| 书籍阅读器 | `packages/app/src/pages/reader/`（foliate 接线在 `hooks/use-foliate-viewer/`） |
| 论文阅读器 | `packages/app/src/pages/paper-reader/` |
| AI 请求管线（transport） | `packages/app/src/ai/custom-chat-transport.ts` |
| 工具注册表 | `packages/app/src/ai/tools/registry.ts` |
| 写操作守卫 / 确认卡 | `packages/app/src/ai/utils/tool-guard.ts`、`components/side-chat/agent-confirm-card.tsx` |
| 数据库 schema 与迁移 | `packages/app/src-tauri/src/core/schema.sql` + `core/database.rs` |
| 同步引擎（L2） | `packages/app/src-tauri/src/core/sync/engine.rs` |
| 备份 / 恢复（L1） | `core/sync/backup.rs`、`core/sync/restore.rs` |
| 向量化 / 混合检索 | `plugins/tauri-plugin-epub/src/pipeline.rs`、`database/hybrid.rs` |
| 转换器 sidecar 接线 | `core/converter.rs`、`core/paper_converter.rs` |
| 密钥保管箱 | `core/secrets/mod.rs` |
| MCP（远程 + stdio） | `src/ai/mcp/`、`core/mcp/` |
| 技能 / 提示词预设 | `core/skills/`、`core/prompts/`、`constants/` 下 prompt 常量 |
| 设置对话框 | `packages/app/src/components/settings/`（约 20 个分栏） |
| 本地 API 通道（I2） | `core/local_api/mod.rs` |

**数据与配置放哪里**：数据库、书籍文件、向量库在 `app_data_dir()`；各类 JSON 配置在 `app_config_dir()`；开发期 identifier 为 `com.bettersageread.dev`（Windows 下即 `%APPDATA%\com.bettersageread.dev\`）。完整清单见 `02-data-model.md`。

**两个 sidecar exe 不在 git 里**：`packages/app/src-tauri/binaries/` 下的 `books_converter-*` / `papers_converter-*` 被 gitignore，clone/worktree 后需手工准备，否则转换功能不可用（同步测试指南的踩坑记录见 `docs/sync-testing-guide.md:37-41`）。

**关联的外部仓库**（不在本 monorepo，随 sidecar/外部进程分发）：

- `Books_Converter` / `Papers_Converter` — 两个 Python 转换器的实现主体（PyInstaller 单文件 exe），管线细节见 `05-papers-pipeline.md`
- `sageread-mcp` — 供 Claude Desktop 等外部 Agent 调用的 MCP 进程，经本地 API 通道与本应用通信（见 `04-agent.md` 第 6 节）

## Wiki 章节导航

- `01-architecture.md` — 前端分层、Rust 核心、向量检索插件、阅读器渲染、标签页休眠
- `02-data-model.md` — app.db 表结构、磁盘目录布局、配置 JSON、密钥保管箱、回收站
- `03-sync.md` — L1 备份 / L2 增量同步协议、WebDAV 目录布局、限流退避
- `04-agent.md` — 三 scope 与工具注册表、写操作三档确认、滚动摘要、技能、MCP、本地 API
- `05-papers-pipeline.md` — Books/Papers 转换器、解析格式契约、向量化与翻译管线
- `06-dev-workflow.md` — 构建命令、测试脚本惯例、CDP 调试、双实例同步测试、发布流程、提交惯例
