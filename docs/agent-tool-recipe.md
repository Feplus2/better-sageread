# Agent 工具开发套路（Recipe）

> 2026-08-04 建立。每给内置助手加一个聊天工具，照此清单走一遍。P0 批工具（managePaperFolders / ragRange / getCitations / getFigures）即按此落地；createPaperAnnotation 同日被否决移除（概念回退，见 roadmap P0-1），加工具前先问"这能力是否与应用概念体系自洽"。

## 五步清单

1. **新建工具文件** `packages/app/src/ai/tools/[central|paper/]<name>.ts`
   - 样板：`central/export-notes.ts`。`tool({ description, inputSchema: z.object({ reasoning: z.string().min(1), ... }), execute })`，返回 `{ results: {...}, meta: {...} }`
   - description 中文富文本：核心功能 / 前提条件 / 返回内容 / **什么时候别用**（决定模型的选择准确率，比堆工具数量重要）
   - 工具输出是模型的"眼睛"：给结构化结果 + 可继续的线索，不要只回 "ok"
2. **注册** `ai/tools/registry.ts`
   - 静态工具：`registerTools([...])`（scope central/shared），自动进 `getToolDescriptions`
   - 需要 bookId/paperId 闭包的：在 `getToolsForScope` 对应分支工厂创建（ragSearch 先例），**并手动同步 `getToolDescriptions`**
3. **提示词清单同步**（按 scope 三选一）
   - central → `constants/central-prompt.ts` 工具清单
   - paper → `constants/paper-prompt.ts`
   - reader → `src-tauri/src/core/default-skills.json` 系统技能种子。**坑：存量数据库不会自动更新**——必须在 `core/database.rs` 加条件迁移块（指纹匹配官方文案才动，用户自定义过的不动；先例：v2 整文替换、v2.1 ragRange 手术插入）
4. **UI 显示名** `components/side-chat/chat-messages.tsx` 的 TOOL_NAME_MAP；要结构化结果面板再改 `pages/chat/index.tsx` 的 renderToolContent
5. **barrel 导出** `ai/tools/index.ts`（+ `central/index.ts` 或 `paper/index.ts`）

## 已知坑位

- **标注锚点**：书籍（EPUB）的 cfi 必须是真的（`CFI.compare` 遇空串会抛，渲染炸）；论文（MARKDOWN）空 cfi 优雅降级（`parseAnchor` 返回 null，面板可见、无文内高亮）。写标注类工具先想清楚锚点来源
- **新 Rust 命令**：`core/` 加模块 → `core/mod.rs` 导出 → `lib.rs` generate_handler! 注册；走 epub 插件则还要三处同步（插件 lib.rs、build.rs COMMANDS、permissions/default.toml，见 format-strategy-and-paper-module.md §108）
- **验证**：`pnpm --filter app exec tsc --noEmit` + `biome check` 改动文件 + CDP 冒烟（仿 `scripts/cdp-test-p0-tools.mjs`：注册断言 + execute 直调 + 写操作立即清理）

## 写/执行类工具的安全守卫（P1 起）

给 Agent 加"会动手"的工具（写文件/执行命令/网络外发）时，除上面五步外还要过守卫：

1. **界内/界外判定只在 Rust**：`core/agent_ws` 的 `guard()`（canonicalize + 根前缀，符号链接绕不过）；TS 侧 `agent_resolve_path` 拿 verdict。不要在 TS 里自己拼路径判前缀
2. **放行参数不进 inputSchema**：`allowOutside` 由 transport 的 `ai/utils/tool-guard.ts` 在确认通过/模式放行后注入，模型构造不出来
3. **决策表集中在 tool-guard.ts 的 GUARDED_TOOLS**：新危险工具在此登记（action: fileWrite/fileRead/command/network + pathArg + 确认卡标题），不要在工具文件里各写各的分档逻辑
4. **确认桥走 `store/agent-confirm-store.ts` 队列**：execute 挂起等用户（先例：export-threads await 原生对话框）；拒绝返回 `{results:{success:false,message:"用户已拒绝本次操作"}}` 即可，AI SDK 当普通工具结果处理
5. **runCommand 全模式写审计日志**（Rust 侧 `{appData}/agent-audit/commands.jsonl`），网络外发（httpRequest 非 GET）任何模式都确认

## 验证基线（P0 落地时）

tsc exit 0；biome 改动文件 clean（全库 14 个报错均为 HEAD 既有，勿顺手修）；CDP 11/11 PASS。

## 工具合并（2026-08-05，13→5）

deleteBook/openBook/resetProgress → manageBook；backupNow/backupRestore/syncNow/syncPreferences → manageSync；setTheme/readerPreferences/uiPreferences → managePreferences；getThreads/exportThreads 并入 manageThreads（search/export 动作）；toggleSkill 并入 manageSkill（toggle 动作）。执行逻辑原样搬入未改行为。兼容层：`ai/utils/message-processor.ts` 的 `stripUnknownToolParts(messages, tools)` 在 transport 的 `convertToModelMessages` 前剔除引用已下线工具的 part（否则旧对话历史直接抛 TypeValidationError 炸聊天）。冒烟：`scripts/cdp-test-tool-consolidation.mjs`（24/24 PASS；vite 缓存模块用 `?smoke=<ts>` 强制重新转换拿最新产物）。
