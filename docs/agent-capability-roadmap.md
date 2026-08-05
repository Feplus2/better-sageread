# Agent 能力边界拓展：落地路线

> 2026-08-04。基于全库现状调研（证据见各文件行号），衔接 paper-polish-backlog F 批。

## 一、现状判断（比想象中好）

编排层已经是**真 Agent**：AI SDK v5 `streamText` + `toolChoice:auto` + `stopWhen:20` 的 ReAct 循环（`ai/custom-chat-transport.ts:82`），三 scope 动态工具集（`ai/tools/registry.ts:318`），central 已有 26 个动作工具。**框架不缺，缺的是写类工具与 MCP 客户端运行时。**

## 二、既定设计约束（docs/local-roadmap.md §Agent 架构设想）

~~动作工具只挂全局助手（central）；阅读助手保持只读 + 本书 RAG，防工具过多误触发。~~ **2026-08-05 用户拍板修订**："读着论文让 AI 整理笔记落盘"是直觉场景，论证成立——文件五件套（writeFile/editFile/readLocalFile/searchFiles/runCommand）+ exportNotes + askAppHelp 下放 shared（三 scope 可用），安全分档由 tool-guard 统一包装（确认卡已挂载三处聊天面）。**仍锁 central 的**：网络外发类（httpRequest/downloadFile/extractZip，书/论文正文是不可信输入，注入面不收口子）与应用管理类（删书/回收站/备份/同步/设置/技能，管家职责）。

## 三、分阶段落地

### P0 · 纯前端封装的写工具（零风险，1-2 天）—— ✅ 2026-08-04 已落地

底层 Rust 命令全部现成，走"一个文件 + 四处登记"套路（已沉淀为 docs/agent-tool-recipe.md）：

1. ~~createPaperAnnotation~~ **已否决并移除**（2026-08-04 当日复盘）：给论文创建 AI 标注的工具上线后被判定概念回退——"无划线纯文字笔记"功能此前已被用户清除，AI 版同类物是重蹈覆辙；手动划线是一划的事无须代劳，AI 长篇总结也不适合塞侧边栏。正确去向是 P1 写文件工具（工作区可指向 Obsidian 等外部库）与 P2 MCP 写入外部知识库。**保留的副产品**：C2"重新生成 AI 重点"清空语义已收窄为 `delete_ai_book_notes` 仅删 source='ai' 且 category IS NOT NULL 的重点标注（对话/其他无 category 的 AI 标注与人工标注均保留）；正文 `findQuoteRange` 兜底高亮机制（阅读器既有，未动）。
2. **managePaperFolders**（central）：list/papers/create/rename/delete/move/assign 七动作，与 Zotero 导入的文件夹体系衔接；assign 为整体替换语义（description 已写防空清空）。
3. **ragRange 注册**（reader，死代码盘活）：含存量库提示词迁移（database.rs v2.1 手术插入，已查库验证生效）。
4. **getCitations/getFigures**（paper 基础层，无向量门控）。getFigures 图注三来源（2026-08-04 加强）：alt 文本 → 图片下方正文图注段（Figure/Fig./图/表 编号开头，跳过空行/分版标号/纯图片行，多图版组共享一条）→ 无则 null 并标注 captionFrom；message 附游离图注计数（有编号文本但附近无图，图丢失残注）。

验证：tsc exit 0；biome 改动文件 clean（全库 14 报错均 HEAD 既有）；CDP 冒烟 11/11 PASS（scripts/cdp-test-p0-tools.mjs）。

### P1 · 写文件 + 执行命令（F 批核心）—— ✅ 2026-08-05 已落地

**2026-08-05 讨论拍板（决策记录）：**

- **安全边界落在执行层，不靠提示词自觉**：所有写/执行类工具在 `execute` 内统一过 `guard(path/命令) → allow | confirm | deny`（路径 resolve 后判根目录前缀），模式切换只改判定表。策略层（description 写"别越界"）只是辅助，防不住提示注入与模型犯傻。
- **用户可选三档安全模式**（设置项）：严格（默认）：工作区内读写静默，区外读/写/删除/自由 shell 均确认卡；宽松：区外读也静默，其余同上；完全访问：全部静默。**网络外发（POST 类）任何模式都保留确认**——数据离机的唯一通道。
- **runCommand（自由 shell）本轮一并做，恒确认卡**（完全访问模式放行）：ffmpeg/pandoc/magick 这类只有它能覆盖。**runPython 取消**——其"比自由 shell 可控"的价值已被证伪（子进程钉不死），两个执行工具只会增加误选率与分档复杂度；python 只是 runCommand 的一条命令。
- **P1 工具清单**：`writeFile`（整文件写）、`editFile`（精确匹配替换，借 Kimi Edit 语义：old_string 唯一性校验、失败带上下文）、`runCommand`（cwd 钉根/超时杀/输出截断/全模式审计日志）、`searchFiles`（glob 按名 + grep 按内容，单工具双 mode）；`readLocalFile` 加固（分页/行号/工作区守卫，向后兼容）；联网 `webSearch`/`httpRequest` 现成，纳入分档表（httpRequest 非 GET 恒确认）。**scope 归属（2026-08-05 下午拍板）**：文件五件套 + exportNotes + askAppHelp 挂 shared（三 scope）；网络外发类 + 应用管理类锁 central。
- **硬校验收在 Rust 侧**：文件操作与命令执行走新 Rust 命令，入口 canonicalize + 根前缀判定，webview 仅薄包装，符号链接也绕不过。
- **工作区模型（2026-08-05 拍板，当日晚修订）：共享根 + 按助手覆盖**。默认 `{appData}/agent-workspace` 三助手共用（含共享 memory.md）；设置页可为 reader/paper/central 各自指定覆盖根（留空跟随共享根），**记忆随根走**——覆盖了根的助手有独立 memory.md，否则共享。解析链：`resolveWorkspaceRootForScope`（store）→ transport 注入提示词 + tool-guard 注入 `rootOverride`（与 allowOutside 同通道，不进模型 schema）→ 工具/Rust。"每对话独立工作区"与"三独立默认工作区"均已否决（前者产物散落+切碎记忆；后者割裂跨助手汇总任务与通用偏好，例证见当日讨论）。参考模型：cwd（Claude Code/Cursor）、vault（Obsidian 系插件）；反例：ChatGPT 沙盒+下载。
- **通用工具语义借鉴 Kimi Code CLI**（[MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code)，MIT、TypeScript）：Edit 精确匹配+唯一性校验、Read 分页/行号/截断、输出截断策略可直接参照；但其工具假设 Node 运行时（fs/child_process），SageRead 聊天工具跑在 webview，执行层必须经 Tauri（fs plugin / Rust 命令），故"借语义重写执行层"，不做代码搬运。

**原设计（安全分档思想并入上述三档表）：**

- **Tier 0 只读**（检索/查询/读取）：静默执行，现状如此。
- **Tier 1 工作区内写入**：界内静默放行（工具清单见拍板区）。"文件即记忆"由此成立（memory.md 落工作区，提示词注入路径）。
- **Tier 2 破坏/越界/外发**：删除、覆盖工作区外路径、网络 POST 类，走**逐次确认**——聊天流内嵌确认卡（工具名 + 目标路径/命令全文 + 允许/拒绝）。会话内可对单条命令选"本次会话不再询问"。

**落地要点（2026-08-05）：** Rust 新模块 `core/agent_ws`（6 命令：resolve_path/read_file/write_file/edit_file/search_files/run_command；canonicalize+根前缀硬校验，audit 日志 `{appData}/agent-audit/commands.jsonl` 全模式无条件写）；前端 `ai/utils/tool-guard.ts` 决策表集中、transport 层包装（`allowOutside` 不进模型 schema，确认通过后注入；确认桥走 `store/agent-confirm-store.ts` 队列，卡 UI `components/side-chat/agent-confirm-card.tsx` 挂 central 页输入区上方）；设置新增 Agent 面板（三档模式 + 工作区根，`store/agent-settings-store.ts`）；工作区 chip 挂 `chat-input-area.tsx` isChatPage 行；central-prompt 注入当前工作区段 + 确认机制文案改写。确认机制未用 AI SDK approval 流程（工具 execute 本就在前端，Promise 挂起语义相同更简单）。验证：cargo check / tsc / biome clean；CDP 冒烟 `scripts/cdp-test-p1-tools.mjs` 25/25 PASS（裸工具链路 + Rust 界外硬拒 + 守卫挂起/拒绝/允许/免打扰/full 直通 + 审计日志）。确认卡视觉与真实对话链路手测待补。

**2026-08-05 下午追加（写工具下放 + 文件即记忆）：** 7 个工具 central→shared（见上）；确认卡加挂 reader 侧边栏（`side-chat/index.tsx`）与论文面板（`paper-chat-panel.tsx`）；**memory.md 落地**：transport 统一注入「当前工作区」段（`ai/utils/workspace-context.ts` 的 `loadWorkspaceSection`，含根路径+记忆指引，恒在）与「长期记忆」段（`loadMemorySection`，读工作区根 memory.md、剥行号、截 4000 字符、无文件静默空串）——三 scope 一处生效，记忆随根走（vault 模型）；不加专用 memory 工具，Agent 用 writeFile/editFile 自维护。提示词同步：central/paper 直接改常量，reader 走 default-skills.json + database.rs v2.2 追加式迁移（存量库已验证生效）。验证：CDP `scripts/cdp-test-shared-tools-memory.mjs` 37/37 PASS（scope 归属/网络锁 central/工作区段恒在/记忆写入-注入-清理全链）。

**2026-08-05 晚追加（共享根 + 按助手覆盖）：** `agent-settings-store` 增 `perAgentRoots`（三助手可选覆盖根，留空跟随共享根）+ `resolveWorkspaceRootForScope`；tool-guard 签名改 `(tools, agentScope)`，判界与 `rootOverride` 注入均按 scope 生效根；设置面板加"按助手覆盖"三行（含浏览/清除）与三助手生效文案；输入区 chip 改为切换 central 覆盖根。Rust `resolve_root` 对不存在的自定义根改为自动创建。验证：tsc/biome/cargo clean；CDP `scripts/cdp-test-per-agent-root.mjs` 7/7 PASS（覆盖根写入/共享根不受影响/记忆随根走/工作区段按 scope 解析）。**CDP 测试坑位**：vite HMR 后模块带 `?t=` 查询串，与裸 URL 是不同模块实例——测试脚本注入 import 全局单例 store 时，必须从已 serve 的转换产物里提取带 `?t=` 的 URL。

### P1.5 · 场景工具精简（2026-08-05 用户拍板）—— ✅ 当日落地

central 26 → 17：五组"单实体多动作"合并——`manageBook`（delete/open/resetProgress）、`manageSync`（backupNow/listBackups/restore/syncNow/updatePrefs）、`manageThreads` 扩（+search/export）、`managePreferences`（setTheme/reader/ui）、`manageSkill` 扩（+toggle）。13 个旧文件删除，注册链五处同步（含 central-prompt 清单与操作示例改写）。**旧对话兼容（转换层容错）**：`stripUnknownToolParts`（`ai/utils/message-processor.ts`）在 convertToModelMessages 前剔除已下线工具名的 part（该函数遇未知工具名会抛 TypeValidationError，已在 ai 包 dist 核实）；空 part 消息整条丢弃。验证：tsc/biome clean；CDP `scripts/cdp-test-tool-consolidation.mjs` 24/24 PASS。

### P2 · MCP 客户端运行时（盘活生态 + F 批 Zotero brain 夹带）

- mcp-store 配置模型已在（stdio/sse），registry 注入点是注释占位（registry.ts:359）。
- 落地：AI SDK `experimental_createMCPClient`（或 @modelcontextprotocol/sdk 直连 stdio）→ 聊天启动时按启用配置拉 `listTools` → 转 AI SDK tool 定义，命名空间 `mcp_{server}_{tool}` → 挂进 central（可选 scope 复选）。
- MCP 工具默认全部 Tier 2（外部进程行为不可预知），确认卡显示 server 名。
- 默认夹带：Zotero brain 精简版 MCP（搜库/下载/导入），与刚完成的 Zotero 批量导入形成"批量走原生、零散走 MCP"互补。

### P3 · 上下文与对话工程（长任务硬伤）

- 现状：最后 8 条消息硬截断（`ai/utils/message-selector.ts:3`），无 token 感知。
- **拓宽窗口（2026-08-05 用户拍板）—— ✅ 2026-08-05 已落地**：8 条硬截断 → token 预算制（`HISTORY_TOKEN_BUDGET=256k` + `RECENT_MESSAGE_FLOOR=40`，`ai/utils/message-selector.ts` 的 `selectMessagesWithinBudget`；估算器 `ai/utils/token-estimator.ts`，CJK≈1 token/字）。超额前缀由辅助模型滚动压缩为摘要（`services/conversation-summary-service.ts`，≤2000 字，存 `thread.metadata.conversationSummary`，含 coveredCount/lastCoveredMessageId 对齐校验、失败降级纯截断），注入 system prompt 的【前情摘要】块；`ChatContext.threadId` 由 useChatState 一处注入覆盖三 scope。验证：tsc/biome clean；CDP 冒烟 `scripts/cdp-test-context-window.mjs` 14/14 PASS、压缩链路 `scripts/cdp-test-summary-roll.mjs` 7/7 PASS（真实辅助模型出摘要、metadata 写回、增量滚动）。
- **对话思考强度档位**—— ✅ 2026-08-05 已落地：映射表 `ai/providers/reasoning-map.ts`（用户四档 off/low/medium/high → 各端参数面；当日调研刷新：Anthropic 4.6+ 废 budget_tokens 改 effort、Gemini 3.x 废 thinkingBudget 整数改 thinkingLevel、OpenAI 按模型子集 minimal~high、DeepSeek high/max、Kimi K3 low/high/max；不认的端不下发防 400）。双通道：AI SDK 原生 providerOptions（transport streamText 直传）+ 自定义端点动态请求体补丁（factory `wrapChatReasoningFetch`，按请求时刻读档位、400 重放兜底）。聊天模型经 useModelSelector 挂 `reasoningLevelRef`；档位偏好存 `chat-settings-store`；UI 选择器挂 chat-input-area（Gauge 图标，三 scope 输入区都有）。验证：tsc/biome clean；CDP `scripts/cdp-test-reasoning-map.mjs` 28/28 PASS（全组合映射断言）。
- **多模态图片输入**：论文/书籍图片经"引用到对话"发给 Agent 识图解析。要点：消息 schema 扩展（AI SDK v5 的 parts/attachments，图片走 data URL 或 base64）、输入区附件 UI、模型多模态能力检测与提示（deepseek-v4-flash 非视觉模型时给引导）。图片点开预览（复制/保存）已在论文阅读器先行落地（2026-08-05），"发送到对话"按钮待本项落地时接到预览层。
- ~~reader 未向量化时无正文通道~~（✅ 2026-08-05 已落地）：`read_book_section`（epub 插件命令，按目录标题直读小节原文，不依赖向量索引/mdbook）+ `readBookSection` 工具对 reader **常驻注册**（首版挂在全局无向量分支，实测发现"全局有向量能力 ≠ 本书已建索引"，未建索引的书 ragSearch 空回且无兜底——当日晚改为常驻 + 提示词指引"RAG 命中为空立即改用直读"，存量库走 database.rs v2.4 迁移修正旧指引文案）+ prompt.ts 两分支注入（无向量：主通道说明；有向量：补充工具说明）。踩坑：① epub crate 2.1.4 的 `fill_toc` 对 OPF 在子目录/NCX 带默认命名空间的书静默失败（`doc.toc` 空）——自解析 OPF→NCX（插件 toc_parser）/EPUB3 nav.xhtml 双兜底；② `get_current_str()` 返回 **(内容, MIME)**，插件既有 `read_epub` 误取第二元素（潜在外观 bug，无下游使用未动）；③ 转换器产 NCX 有同名占位页与正文章节并存（且顺序错乱/重复）——标题匹配收集全部候选、逐个算范围取内容最多者；④ hasVectorCapability 是 store 异步态，CDP 断言前要等其稳定。验证：cargo/tsc/biome clean；CDP `scripts/cdp-test-reader-fallback.mjs` 7/7 PASS（真实章节 26188 字符截断续读提示正确）+ `cdp-verify-reader-fallback-branch.mjs` 分支断言全过。

### P4 · 远期（已有 backlog，不展开）

全局批处理（全部向量化/翻译/归类）、定时/触发式 Agent、子 Agent 分工、对 docs/代码库建 RAG 的"最了解自己"助手。

## 四、工程纪律（来自工具生态的实践经验）

- **工具在精不在多**：description 写清"什么时候用、什么时候别用"，比堆工具数量更能提成功率；每加一个工具，先在真实对话里试 5 个场景再留。
- **工具输出即模型的眼睛**：返回结构化摘要（成功/影响对象/可继续的线索），不要只回 "ok"。
- **确认卡只挡真正不可逆的**：处处确认 = 用户点麻 = 等于没有安全。
- 建议沉淀一份 `docs/agent-tool-recipe.md`：把"一个文件 + 四处登记"写成 checklist，以后加工具照着抄。

## 五、建议排产

P0（本周）→ P1 安全模型 + 写文件/runPython（下周）→ P2 MCP（随后）。P3 可插入任何间隙。
