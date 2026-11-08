# Agent 工具开发套路（Recipe）

> 2026-08-04 建立。每给内置助手加一个聊天工具，照此清单走一遍。P0 批工具（managePaperFolders / ragRange / getCitations / getFigures）即按此落地；createPaperAnnotation 同日被否决移除（概念回退，见 roadmap P0-1），加工具前先问"这能力是否与应用概念体系自洽"。

## 五步清单

1. **新建工具文件** `packages/app/src/ai/tools/[central|paper/]<name>.ts`
   - 样板：`central/export-notes.ts`。`tool({ description, inputSchema: z.object({ reasoning: z.string().min(1), ... }), execute })`，返回 `{ results: {...}, meta: {...} }`
   - description 中文富文本：核心功能 / 前提条件 / 返回内容 / **什么时候别用**（决定模型的选择准确率，比堆工具数量重要）
   - 工具输出是模型的"眼睛"：给结构化结果 + 可继续的线索，不要只回 "ok"
2. **注册** `ai/tools/registry.ts`
   - 静态工具：`registerTools([...])`（scope central/shared）进模块级 `registry`，由 `getToolsForScope` 组装。注意 `getToolDescriptions()` 当前**无调用方**，不要为它维护清单。
   - 需要 bookId/paperId 闭包的：在 `getToolsForScope` 对应分支工厂创建（ragSearch/readDocument 先例）。
3. **提示词策略同步**（按 scope 三选一）：2026-09 分层重构后，工具策略不再走 DB 种子/清单生成，而是代码里的系统策略段——改工具面必须同步 `constants/central-prompt.ts`、`constants/paper-prompt.ts`、`constants/prompt.ts`（buildReaderPolicy），并检查 `ai/prompts/library-guide.ts` 的共享约定。`src-tauri/src/core/default-skills.json` 的系统基词种子已退役（只剩"生成思维导图"一条技能）。
4. **UI 显示名** `components/side-chat/chat-messages.tsx` 的 TOOL_NAME_MAP；要结构化结果面板再改 `pages/chat/index.tsx` 的 renderToolContent
5. **barrel 导出** `ai/tools/index.ts`（+ `central/index.ts` 或 `paper/index.ts`）

## 已知坑位

- **标注锚点**：书籍（EPUB）的 cfi 必须是真的（`CFI.compare` 遇空串会抛，渲染炸）；论文（MARKDOWN）空 cfi 优雅降级（`parseAnchor` 返回 null，面板可见、无文内高亮）。写标注类工具先想清楚锚点来源
- **新 Rust 命令**：`core/` 加模块 → `core/mod.rs` 导出 → `lib.rs` generate_handler! 注册；走 epub 插件则还要三处同步（插件 lib.rs、build.rs COMMANDS、permissions/default.toml，见 format-strategy-and-paper-module.md §108）
- **验证**：`pnpm --filter app exec tsc --noEmit` + `biome check` 改动文件 + CDP 冒烟（仿 `scripts/cdp-test-p0-tools.mjs`：注册断言 + execute 直调 + 写操作立即清理）

## 写/执行/图片工具的安全守卫

给 Agent 加"会动手"的工具（写文件/执行命令/网络外发）或本地图片读取时，除上面五步外还要过守卫：

1. **界内/界外判定只在 Rust**：`core/agent_ws` 复用 canonicalize、最近存在祖先解析与根前缀判界；TS 侧只通过 `agent_resolve_path` 取 verdict，不做词法根前缀放行。junction/symlink 与 `..` 不能绕过。
2. **内部授权不进 inputSchema**：`allowOutside/rootOverride` 以及图片的 `imageRoots/imageGrant/imageGrants/expectedResolved` 只由 transport 的 `tool-guard.ts` 注入；guard 覆盖模型传入的同名字段。图片授权绑定原始 path 与 canonical target，批量图片逐路径授权，没有整批界外放行布尔值。
3. **决策表集中在 tool-guard.ts 的 GUARDED_TOOLS**：新危险工具在此登记（fileWrite/fileRead/imageRead/command/network + pathArg + 确认卡标题），不要在工具文件里各写各的分档逻辑。
4. **确认按安全模式与例外矩阵**：strict 的界外读、strict/relaxed 的界外写与命令先确认，full 对常规路径/命令静默；relaxed/full 的界外读免确认。`attachment://` 不走本地路径判界。网络非 GET、含密钥引用的外发以及破坏性/密钥操作等恒确认例外不因 full 取消。确认桥使用 `store/agent-confirm-store.ts` 队列，拒绝返回取消结果。
5. **图片检查与读取不可分离**：`agent_read_image` 在同一 Rust 调用内完成 canonical 判界、授权复核、敏感路径拒绝、目录/20MiB 检查与字节读取，返回 `ArrayBuffer`；前端保留魔数嗅探、解码和降采样。确认后 canonical target 变化必须失败，不能复用旧授权。
6. **runCommand 全模式写审计日志**（Rust 侧 `{appData}/agent-audit/commands.jsonl`）；不要为通过测试而扩大全局 assetProtocol scope。
7. **交付文件必须显式调用 `present`**：仅用于本轮真正要交付的成果，不把测试脚本或中间产物自动列为交付物。`present` 经 `agent_workspace_stat` 核对真实存在且非目录，返回 `results.deliverable={path,description?}`；界外读取仍走 `fileRead` 守卫，严格模式确认后保留原 canonical target，不能把模型自报路径当成交付证据。
8. **命令产物用 `artifactPaths` 声明并核验**：`runCommand` 只核对声明的工作区内文件，Rust 对执行前后的真实变化返回 `changes[{path,kind,verified}]`。只有 verified 变化进入「已编辑文件」；新建/覆盖/删除不得冒充。`writeFile` 另返回真实 `created` 标记。交付列表由 `presented-files.ts` 收集，编辑列表由 `changed-files.ts` 收集，两者不得混用。

相关回归：`test-presented-files.mjs`、`test-changed-files.mjs`、`test-preview-grants.mjs`、`cdp-test-file-workspace.mjs`、`cdp-test-file-workspace-formats.mjs`、`cdp-verify-real-game-delivery.mjs`。

## 请求历史兼容

- transport 在请求副本上先执行 `sanitizeLegacyMcpHistoryImages`，再用 `adaptToolHistoryForRequest` 做 direct↔directory 适配，最后 `await convertToModelMessages`。
- 不因当前 New/Legacy 工具面或目录牌模式删除未知、已下线工具的 history part；保留 toolCallId、output、approval/metadata。`dynamic:false` 缺失工具的 conversion-only stub 只进转换副本，不进入 live 工具面。
- 旧 raw MCP 历史不回灌图片字节：有路径留路径，无路径留“重新调用”占位；当前轮 live MCP 图片仍可进入模型。UI/DB 原消息保持不变。
- 回归：`scripts/test-tool-history.mjs`、`test-mcp-image-pipeline.mjs`、`test-tool-image-bridge.mjs`、`cdp-test-tool-consolidation.mjs` 与 `cdp-scan-thread-conversion.mjs`。

## 当前验证基线

`pnpm --filter app build`、相关 Node/CDP 行为测试与 `git diff --check` 必须通过。图片安全还需跑 `scripts/cdp-verify-p0-read-image.mjs`、`scripts/cdp-test-p1-tools.mjs` 和 Rust `agent_ws` 测试；不能用源码字符串断言替代真实工具、真实 junction 或请求历史转换测试。

## 工具合并与模式回退

deleteBook/openBook/resetProgress → manageBook；backupNow/backupRestore/syncNow/syncPreferences → manageSync；setTheme/readerPreferences/uiPreferences → managePreferences；getThreads/exportThreads 并入 manageThreads（search/export 动作）；toggleSkill 并入 manageSkill（toggle 动作）。文档工具只保留 `new` 与 `legacy` 两个互斥模式：默认 New，Legacy 保留旧工具回退；旧 Both/非法持久化值归一为 New。共享文件五件套、`exportNotes/askAppHelp/readImage/viewImages` 不随文档模式裁剪；central 的论文 `getFigures/getCitations` 在两种模式均注册且必须显式传 `doc=paper:<id>`。
