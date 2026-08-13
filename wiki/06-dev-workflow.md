# 06 · 开发工作流

> 本章覆盖：构建命令、前端测试脚本惯例、CDP 调试、双实例同步测试、发布 workflow、提交与代码风格惯例。

## 1. 构建与测试命令

根脚本（根 `package.json:7-14`）：

```bash
pnpm install         # 安装 workspace 依赖
pnpm dev             # = cd packages/app && pnpm tauri dev（Vite 1420 + Rust 一体启动）
pnpm build           # = 前端 tsc && vite build，再 pnpm tauri build 出安装包
pnpm build:foliate   # 单独构建 foliate-js 子包
pnpm build:app-tabs  # 单独构建 app-tabs 子包
pnpm tauri           # 透传 tauri CLI
```

- `packages/app/package.json:7-10`：`dev` 是纯 `vite`（不起 Tauri，用于纯前端调试）；`build` = `tsc && vite build`（含类型检查）
- `pnpm-workspace.yaml:1-12`：`allowBuilds` 白名单（`@biomejs/biome`、`@tailwindcss/oxide`、`es5-ext`、`esbuild`）勿删，漏配报 `ERR_PNPM_IGNORED_BUILDS`
- Rust：`packages/app/src-tauri/Cargo.toml` 包名 `better-sageread`，release profile 开 LTO + `panic = "abort"`（:76-80）

**Rust 测试**：

```bash
cd packages/app/src-tauri && cargo test
```

约 **58 个用例**。重头在 `src/core/sync/`（engine.rs 18 个、merge.rs 8 个、backup.rs 3 个、changelog.rs 2 个、restore.rs 1 个）+ `core/web_search.rs` 6 个；`tauri-plugin-epub` 共 18 个（其中 `text/` 下 15 个：chunker 7、sanitizer 3、tokenizer 2、zh_segmenter 3）；另有集成测试 `src-tauri/tests/secrets-roundtrip.rs`。

**前端验证组合拳**（仓库惯例）：`pnpm --filter app exec tsc --noEmit` + `biome check <改动文件>` + 对应 `scripts/test-*.mjs` + 必要时 CDP 冒烟。

## 2. 前端测试脚本惯例（scripts/test-*.mjs）

**15 个** `test-*.mjs`（另有 21 个 `cdp-test-*.mjs` 走 CDP，见下节）。共同套路（以 `scripts/test-chat-math-delimiters.mjs:1-23` 为代表）：

1. 注释头写覆盖点 + 运行方式 `node scripts/test-xxx.mjs`
2. 从 `node_modules/.pnpm` 里**翻目录找 esbuild 包**动态 import（:10-13，没找到就提示先 `pnpm install`）——不新增 devDependency
3. `esbuild.build` 把被测 TS 源文件 bundle 成临时 ESM 到 tmpdir，再动态 import 取导出函数（:15-23）
4. 裸 node 断言（自写 `eq`/`ok` 计数器），结尾打印「N 过 / M 挂」并 `process.exit(fail ? 1 : 0)`

变体：`test-paper-math-normalize.mjs:20-27` 用同样手法引入 katex，并用根目录 devDependency 的 jsdom 造 live DOM 测 DOM 逻辑。**无测试框架**——纯 node + esbuild + 可选 jsdom。新写测试脚本请沿用这个模板。

服务级 E2E 变体：`scripts/test-l1-backup-restore-e2e.mjs`（双实例 + WebDAV 的备份恢复断言，见第 4 节）。

## 3. CDP 调试（scripts/cdp-*.mjs）

**62 个** `cdp-*.mjs`，用于对**运行中**的应用做 DOM 断言、截图、性能采样、复现探针。

- 端口：老脚本硬编码 **9222**（38 处，如 `cdp-check-state.mjs:2`），较新的一批用 **9223**（如 `cdp-test-p0-tools.mjs:12`），双实例测试时 dev2 用 **9224**（`test-l1-backup-restore-e2e.mjs:19-20`）
- 应用侧没有开启 remote debugging 的代码——启动时用环境变量开（Windows/WebView2）：

  ```bash
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 pnpm dev
  ```

  macOS 走 Tauri 的 devtools feature（`src-tauri/Cargo.toml:21` 已开）

- 共同结构（`cdp-check-state.mjs`）：
  1. `fetch http://127.0.0.1:9222/json/list` 拿目标列表，按 `type === "page"` 且 url 含 `localhost:1420` 选中页面（:2-15）
  2. Node 22+ 内置 `WebSocket` 连 `webSocketDebuggerUrl`，自写 id/pending Map 的 `call(method, params)` 收发 JSON-RPC（:22-42）
  3. `Runtime.evaluate` 注入 JS 做 DOM 断言（`returnByValue: true` 拿回 JSON）；截图用 `Page.captureScreenshot` base64 落盘（`cdp-screenshot.mjs:20-22`）
  4. 常监听 `Runtime.exceptionThrown` 抓页面异常（:37-40）

## 4. 双实例同步测试

方法（`docs/sync-testing-guide.md:27-41`）：用 **git worktree** 开第二份代码，实例 B 改三处——`tauri.conf.json` 的 identifier（→ 独立 appData 目录）、`vite.config.ts` 与 devUrl 端口（1421）；两边各自 `pnpm dev`，连同一个 WebDAV 测试同步。

> 文档成文于更名前：identifier 现为 `com.bettersageread.dev` / `com.bettersageread.dev2`（不再是 `com.xincmm.sageread.dev*`），appData 目录名同步变化。

踩坑记录（:37-41）：sidecar 二进制 `books_converter-*.exe` 被 gitignore，worktree 要手工拷贝；`pnpm dev` 失败会留孤儿 exe 抢同一个数据目录；端口被占先杀残留 node。测试清单分 A（元数据）/B（真进度）/C（书籍文件）/D（资产偏好）/E（删除传播）/F（健壮性）六组；排障日志在 appData 的 `logs/sageread.log`。

配套自动化：**`scripts/test-l1-backup-restore-e2e.mjs`**——主实例（CDP 9223）`syncBackupNow` → dev2（9224）`syncRestore` + 重启 → 双库逐表行集 + books 目录逐文件 sha256 比对（:1-12）；appData 路径可用 `MAIN_APPDATA`/`DEV2_APPDATA` 环境变量覆盖（:21-22）。L2 增量同步没有等价自动化脚本，仍是手工清单。

## 5. 发布 workflow（.github/workflows/release.yml）

- 触发：推 `v*` tag 或 `workflow_dispatch` 手动（:3-7）
- 矩阵（`fail-fast: false`，:14-22）：`macos-latest` + `aarch64-apple-darwin`、`macos-latest` + `x86_64-apple-darwin`、`windows-latest`
- 步骤：checkout → pnpm 9 → Node lts（pnpm cache）→ Rust stable（mac 装双 target）→ swatinem/rust-cache（只缓存 `packages/app/src-tauri/target`，:44-47）→ `pnpm install` → **Sync version**：node 脚本把 tag 名写进 `tauri.conf.json` 的 version，并把 identifier 从 `.dev` 改成 `com.bettersageread.app`（:52-54）→ mac 上先 `codesign --remove-signature` 摘掉 sidecar 旧签名（:56-61）→ `tauri-apps/tauri-action@v0` 构建（:63-78）
- 产物：`releaseDraft: true`（草稿，人工补 Release Notes 后发布）、`includeUpdaterJson: true`（生成 `latest.json` 供应用内自动更新）、updater 签名用 secrets 的 `TAURI_SIGNING_PRIVATE_KEY`
- 注意：`docs/release-workflow.md` 已于 2026-08-14 重写为当前事实（密钥名、仓库链接、mac 摘 sidecar、未签名指引、历史重写后的 force-push 要求），可直接当作发布日 runbook

## 6. 提交与代码风格惯例

**提交信息**：Conventional Commits 前缀 + 中文正文（`git log --oneline -30` 全部带类型前缀：`feat:`/`fix:`/`refactor:`/`docs:`/`chore:`）。风格特征：

- 单行超长，破折号后直接塞完整上下文——病灶、根因、修法、验证结果全在标题里
- 常附测试证据，如「cargo test 39+1 全绿」「cdp-test-zotero-import 26/26」
- 不用 scope 括号，不用英文

**代码风格（Biome 1.9.4，`biome.json`）**：

- formatter：空格缩进、行宽 **120**（:12-16）、双引号（:54-58）；organizeImports 开启（:17-19）
- linter：recommended 但关了一批（`noNonNullAssertion`、`noParameterAssign`、`noExplicitAny`、`noArrayIndexKey`、`noForEach`、`noDangerouslySetInnerHtml`、a11y 整组，:22-52）
- nursery 的 **`useSortedClasses` 开为 error**——Tailwind 类排序，作用于 `className` 与 `cn`/`tw` 函数（:39-48）
- `vcs.enabled: false`（:3-7）
- 命令：**没有 npm script 封装**，直接 `biome check <改动文件>`

**工作区卫生**：仓库根目录有一批 `.tmp-*` 临时探针/截图与 `.tmp-*/` 目录，是 CDP 调试的副产品，不要提交；`scripts/` 里新探针建议同样以 `cdp-`/`test-` 前缀命名以便识别。

## 7. 脚本清单速查

**test-*.mjs（15 个，node 直跑）**：`test-chat-math-delimiters`、`test-rawmath-transformer`、`test-paper-math-normalize`、`test-paper-display-math`、`test-paper-blocks`、`test-paper-blocks-consistency`、`test-paper-sentences`、`test-paper-figures`、`test-paper-hover-rects`、`test-paper-ai-highlights`、`test-paper-alignment`、`test-paper-alignment-service`、`test-paper-translation-tolerance`、`test-paper-export`、`test-l1-backup-restore-e2e`。可见重心在论文管线的渲染/对齐/翻译不变量上。

**cdp-*.mjs（62 个，连运行中的应用）**，按前缀分工：

- `cdp-check-*` / `cdp-verify-*` — 状态断言与修复验证（划线、高亮、阅读位置）
- `cdp-test-*` — 功能冒烟（Agent 工具、论文导入、Zotero、摘要滚动等 21 个）
- `cdp-debug-*` / `cdp-diag-*` / `cdp-repro-*` / `cdp-try-*` — 病灶定位与复现探针
- `cdp-screenshot` / `cdp-shot-*` — 截图
- `cdp-perf-*` — 性能审计/CSS A-B/采样
- `cdp-cleanup-*` — 测试数据清理；`cdp-scan-*` — 批量扫描；`cdp-inspect-*` / `cdp-dump-*` — 结构转储

**Rust 测试分布**（`cargo test`，约 58 个用例）：`core/sync/` 是重头（engine.rs 18、merge.rs 8、backup.rs 3、changelog.rs 2、restore.rs 1），`core/web_search.rs` 另 6 个（注意它在 core/ 直下、不在 sync/）；`tauri-plugin-epub` 共 18 个（`text/` 下 15 个：chunker 7、sanitizer 3、tokenizer 2、zh_segmenter 3）；集成测试 `src-tauri/tests/secrets-roundtrip.rs`。

## 8. 排障速查

- 应用日志：appData 下 `logs/sageread.log`（开发期即 `%APPDATA%\com.bettersageread.dev\logs\`）
- 数据目录被抢：`pnpm dev` 异常退出可能留孤儿进程（含 sidecar exe）占用同一 appData，先杀残留再起
- 端口被占：Vite 1420 / CDP 9222 被占时杀残留 node；双实例分别用 1420/9223 与 1421/9224
- 同步排障：先看日志，再看 `{config}/sync-state.json` 的水位与云端 `devices.json`；应用失败包会阻塞该设备后续包（满 3 次才跳过）
- 页面异常：CDP 脚本普遍监听 `Runtime.exceptionThrown`，复现类问题先挂探针再操作

## 9. 新功能开发套路（仓库惯例）

以新增一个 Agent 工具为例（细则见 `docs/agent-tool-recipe.md`）：

1. 在 `ai/tools/` 对应目录实现工具（central 专属放 `central/`，三 scope 通用放根级），在 `registry.ts` 注册并同步 `getToolDescriptions()` 的清单
2. 若是写操作：在 `ai/utils/tool-guard.ts` 的决策表加分支（决定三档下的确认行为），危险动作（delete/create 类）参考"恒确认"惯例
3. 若需要 Rust 能力：在 `core/` 对应模块加 command 并在 `lib.rs` 的 invoke_handler 注册；涉及文件系统边界的必须走 `agent_resolve_path` 守卫
4. 补提示词：`constants/` 下对应 scope 的 prompt 常量加工具说明；reader 系统提示词在 DB（改 `default-skills.json` + `database.rs` 的条件迁移）
5. 验证组合拳：`pnpm --filter app exec tsc --noEmit` → `biome check <改动文件>` → 新写/复用 `scripts/test-*.mjs` → 起应用跑 `cdp-test-*` 冒烟 → 必要时 `cargo test`
6. 提交信息用 `feat:`/`fix:` 前缀 + 中文正文，结尾附上测试证据（如「cargo test 39+1 全绿」）

## 10. 环境准备与发布 Checklist

**新机器环境准备**：

1. Node.js 22+（CDP 脚本依赖内置 `WebSocket`）、pnpm 9、Rust stable
2. Windows：WebView2 运行时（Win11 自带）；macOS：Xcode CLT
3. `pnpm install`（确认 `pnpm-workspace.yaml` 的 allowBuilds 未被破坏）
4. 手工放置两个 sidecar exe 到 `packages/app/src-tauri/binaries/`（转换功能才可用）
5. 首次 `pnpm dev` 验证：书库导入一本 EPUB（`fixtures/` 或自备）→ 配模型 → 向量化 → 对话冒烟

**发布 Checklist**（细则 `docs/release-workflow.md`，密钥名等以 `release.yml` 为准）：

1. 改 `packages/app/src-tauri/tauri.conf.json` 的 version（CI 也会用 tag 名覆盖）
2. 打 `v*` tag 并推送（或在 Actions 手动 workflow_dispatch）
3. 等三平台矩阵构建出**草稿** Release
4. 人工编辑 Release Notes 后 Publish
5. 验证：`latest.json` 已生成，旧版本应用内自动更新能拉到（updater 签名为 secrets `TAURI_SIGNING_PRIVATE_KEY`）
