# 04 · Agent 系统

> AI 助手三件套：**全局助手（central）/ 阅读助手（reader）/ 论文助手（paper）**。前端实现在 `packages/app/src/ai/`，Rust 侧支撑在 `src-tauri/src/core/{agent_ws,skills,mcp,local_api,secrets,prompts}/`。设计文档（`docs/agent-*.md`）记录演进史，本章以代码为准；不一致点汇总在第 8 节。

## 1. 三个 scope 与工具注册表

- 角色类型 `AgentScope = "central" | "reader" | "paper"` 定义在 `ai/tools/registry.ts:75`；工具归属维度 `ToolScope = "central" | "reader" | "shared" | "mcp"` 在 :66（注意：`"reader"` 是合法 ToolScope 但**没有任何工具静态注册到它**——reader 的专属工具全是工厂函数动态创建）
- 静态注册表是模块级数组 `registry`（:87），组装入口 `getToolsForScope(agentScope, context)`（:325）；提示词里的工具清单由 `getToolDescriptions()` 生成（:385）

**各 scope 实际挂载**

- **shared（三 scope 通用，13 个，`registry.ts:106-187`）**：notes、getBooks、getReadingStats、getSkills、mindmap、webSearch、文件五件套（readLocalFile/writeFile/editFile/searchFiles/runCommand）、exportNotes、askAppHelp
- **central 专属（22 个，`registry.ts:191-330`）**：manageBook、convertPdf、importBook、importPaper、manageSync、searchDevDocs、vectorizeBook、manageTags、trashManager、managePreferences、switchModel、manageThreads、importFont、httpRequest、downloadFile、extractZip、manageSkill、manageSecrets、manageMcp、managePaperFolders、processPaper、manageNotes
- **reader（:344-355，需 bookId 闭包）**：ragSearch/ragToc/ragContext/ragRange（向量能力门控 `useLlamaStore.hasVectorCapability()`）、readBookSection（常驻，未建索引时的正文兜底）、manageNotes（绑定当前书）
- **paper（:358-373，需 paperId）**：基础层 6 个常驻——getPaperToc/readPaperSection/readPaperFull/getPaperInfo/getCitations/getFigures + manageNotes；增强层 paperSearch/paperContext 向量门控
- **MCP 工具不在静态组装里**，由 transport 在发请求时合并（:375-377 注释，见第 5 节）

命名约定：MCP 工具键为 `mcp_{sanitize(server名)}_{toolName}`（`ai/mcp/mcp-manager.ts:44-46,183-189`），description 前加 `[server名]`；工具文件按目录分组 `ai/tools/central/`、`ai/tools/paper/`、根级共享文件，各目录有 barrel（`index.ts`）。新工具的开发套路见 `docs/agent-tool-recipe.md`（步骤清单也浓缩在 `06-dev-workflow.md` 第 9 节）。

两个维护要点：

- `getToolDescriptions()` 里 paper 的工厂工具描述是**手动同步**的（`registry.ts:396-408`）——增删 paper 工具时两边都要改，漏改则模型看不到/叫不到新工具
- reader/paper 的专属工具是**工厂函数**（闭包捕获 bookId/paperId），不是静态注册——所以 `ToolScope` 里的 `"reader"` 分支恒为空，排查"工具没挂"先看组装时的 context 是否传了 id

## 2. 写操作安全三档与确认卡

- 实际命名：`AgentSafetyMode = "strict" | "relaxed" | "full"`（`store/agent-settings-store.ts:13`），默认 `"strict"`（:35）。语义（:7-11 注释）：
  - `strict` — 界外读/写/命令均弹确认
  - `relaxed` — 界外读静默，界外写/命令确认
  - `full` — 全静默（审计日志照写）
  - 例外：**httpRequest 非 GET 任何模式恒确认**
- **危险级别不在工具元数据里**（`ToolRegistration` 只有 name/scope/tool/description，`registry.ts:68-73`）。分档集中在 `ai/utils/tool-guard.ts` 的 `GUARDED_TOOLS` 决策表（:41-48：writeFile/editFile→fileWrite、readLocalFile/searchFiles→fileRead、runCommand→command、httpRequest→network）加一组特殊分支：
  - `mcp_` 前缀（:120-146，strict/relaxed 确认、full 放行、可按 server 免打扰）
  - manageMcp 全动作确认且 create/delete 恒确认（:149-176）
  - manageSecrets set/delete 恒确认（:180-210）
  - manageNotes create/update 恒确认（:214-243）
  - manageSkill/manageThreads 的 delete 恒确认（:247-274）
  - importPaper（:278-304）、processPaper reparse（:308-335）
- 机制：`allowOutside`/`rootOverride` **不进模型 schema**，由守卫在确认通过后注入（`tool-guard.ts:349-375`）；界内/界外判定走 Rust `agent_resolve_path`（canonicalize + 根前缀，`core/agent_ws/commands.rs:69-77`，守卫实现在 `agent_ws/mod.rs:104-115`，:6-9 模块注释标明它是唯一实现处）
- **确认卡 UI**：`components/side-chat/agent-confirm-card.tsx:11`（队列式逐张处理，"本次会话不再询问此项"复选框 :39-42）；确认桥为 `store/agent-confirm-store.ts` 队列，挂起等待在 `tool-guard.ts:79-102`。三处挂载点：全局助手 `pages/chat/index.tsx:388`、阅读侧边栏 `components/side-chat/index.tsx:261`、论文面板 `pages/papers/paper-chat-panel.tsx:395`

## 3. 滚动摘要压缩（上下文活塞）

- **存储**：`threads` 表 `metadata` 列（JSON），键 `conversationSummary = {text, coveredCount, lastCoveredMessageId, updatedAt}`（`services/conversation-summary-service.ts:12-24`）
- **双水位活塞**（常量 `ai/utils/message-selector.ts:5-12`）：点火线 `COMPRESS_HIGH_WATER = 256k tokens`、泄压线 `COMPRESS_LOW_WATER = 128k`、保底 `RECENT_MESSAGE_FLOOR = 10` 条。≤256k 零压缩；超过则从最新向前裁到 ≤128k，最近 10 条永不压缩（`selectMessagesWithinBudget`，:112-163）。token 估算：CJK≈1 token/字、其余≈1/4 字符（`ai/utils/token-estimator.ts:16-21`）
- **不动原始 messages**：压缩只把 dropped 前缀**增量**滚成摘要写回 `thread.metadata`（`conversation-summary-service.ts:172-184`），`messages` 列全程不改；摘要在 transport 注入 system prompt 的【前情摘要】块（`custom-chat-transport.ts:117-130,164-169`）
- 压缩用辅助模型 `generateText`（:148-158）；对齐校验（coveredCount/lastCoveredMessageId 对不上则从头重滚）在 :129-136；失败降级沿用旧摘要、不阻断聊天
- 旧机制残留：`selectValidMessages`（8 条硬截断）仍在 `message-selector.ts:14-49`，但已是死代码

## 4. 技能系统

- **存储**：`skills` 表（`schema.sql:134-142`）：name UNIQUE、content（Markdown SOP）、is_active、is_system（系统技能不可删）；`scope` 列由迁移添加（`database.rs:119-131`，默认 `'both'`）
- **`default-skills.json` 是种子而非数据源**：`database.rs:455-486` 在库初始化时把内嵌 JSON 的两条（"系统提示词"即 reader 系统提示词 is_system=true、"生成思维导图"）插入 skills 表；存量库不自动更新，官方文案变更靠 `database.rs` 的条件迁移手术（指纹匹配才动）。因此 **reader 的系统提示词活在 DB 里**，central/paper 的则在 TS 常量（`constants/central-prompt.ts`、`paper-prompt.ts`）
- **SKILL.md 兼容导入（Claude Code skills 生态）**：解析器 `services/skill-import-service.ts`——YAML frontmatter 取 `name`（必填）/`description`/`scope`（缺省全选三 scope，:21-28），body 作 content 落库（:113-121，恒 `isSystem:false`）。三通道：SKILL.md 直链 URL、GitHub 仓库/目录 URL（转 raw.githubusercontent.com，main 失败试 master，:77-147）、粘贴文本。UI 入口 `pages/skills/components/skill-import-dialog.tsx`，导入后扫 `{{secret:NAME}}` 占位并引导去密钥保管箱补齐（:38-49）。**不自建技能市场**（拍板不做）
- Agent 侧工具：`getSkills`（shared）、`manageSkill`（central）
- **勿混淆**：`core/prompts/`（`prompt_presets` 表）是 reader/paper 的**命名提示词预设**（同 scope 内 `is_active` 互斥，无激活行=用内置默认，`database.rs:243-259`、`prompts/models.rs:7-19`），与技能是两套东西

## 5. MCP 接入

**双传输**

- 远程：自研 `StreamableHttpMcpTransport` 与 `SseLegacyMcpTransport`（`ai/mcp/mcp-transport.ts`）；连接管理器 `ai/mcp/mcp-manager.ts`（`getMcpToolsForScope` :154-210；10s 超时、失败降级进 failures 不阻塞本条消息；生命周期跟随单次请求）。B1 结论写在模块头（:5-13）：`experimental_createMCPClient` 直接从 `ai` 包导出，**无需 `@ai-sdk/mcp`**；统一走 @tauri-apps/plugin-http 绕 CORS
- stdio：Rust 子进程桥 `core/mcp/mod.rs`（命令 `mcp_stdio_start/write/close`，stdout 逐行 emit `mcp-stdio://{session_id}`，stderr 进审计日志且脱敏；Windows `cmd /C` 包裹 + CREATE_NO_WINDOW + Job Object 防孤儿 + taskkill 树杀，:1-11,89-97）；前端 `ai/mcp/tauri-stdio-transport.ts`；首次启动有确认卡 `confirmStdioLaunch`（`mcp-manager.ts:100-113`，strict/relaxed 确认、full 静默）

**配置模型**：`store/mcp-store.ts:7-25`（`McpServer`：transport stdio/http/sse、command/args/env、url/headers、scope 数组、enabled、source/registryName），persist version 2 迁移在 :69-90（v1 scope 单值→集合）。

**市场一键安装**：数据源官方 Registry `https://registry.modelcontextprotocol.io/v0/servers`（`services/mcp-registry-service.ts:14,87-123`，tauriFetch 绕 CORS，按 official+isLatest 去重）；映射 `buildInstallPrefill`（:172-234）：streamable-http→http+url、npm→stdio+npx、pypi→uvx、oci 标不支持；`isSecret` 的 env 预填 `{{secret:NAME}}`。UI `pages/skills/tabs/mcp-market-dialog.tsx`（安装=预填回表单，用户确认后落 mcp-store）。注意 Registry 字段实测为 camelCase（`registryType`/`environmentVariables`/`isSecret`），仅顶层 `environment_variables` 保留 snake（`mcp-registry-service.ts:7-10,62`）——与 ecosystem-plan 文档口径不同。

**密钥迁移**：存量明文迁移器 `core/secrets/migrate.rs`（启动时跑，`lib.rs:164-165`；幂等标记 `"secretsMigratedTo":"keyring"`，set 成功才置空字段，失败可重入不阻塞启动）。运行时替换：stdio env 在 Rust spawn 前 `resolve_secret_refs`；http/sse headers 在前端经 `secret_resolve_batch` 批量替换（`mcp-manager.ts:86-96`）。

**Agent 自管理**：`manageMcp` 工具（`ai/tools/central/manage-mcp.ts`，list/create/update/toggle/delete 写 mcp-store，central 专属；门控见第 2 节）。

## 6. 本地 API 通道（I2）

模块 `core/local_api/mod.rs`，命令 `start_local_api`（:298-325），由前端启动时调用（`src/main.tsx:26`）。"I2" 是它在路线图里的批次代号，代码里没有这个名字。

- 形态：手搓 HTTP（无框架），绑定 `127.0.0.1:0` **随机端口**，启动生成 UUID token，`{port, token}` 写入 `{appData}/mcp-local.json`（Unix 0600，:277-310）
- 端点仅两个：`GET /health` 免 token 存活探测（:182-185）；`POST /embed` 凭 `Authorization: Bearer {token}`（:188-206），用当前选中向量模型 + keyring 密钥做嵌入，只回向量/model/dimension（:208-244）
- 密钥由 `secrets::get_secret(app, "vector-model", {modelId})` 取（:125），**MCP 进程全程不见 key**
- 用途：供外部 MCP 进程（sageread-mcp，被 Claude Desktop 等拉起）把执行类调用转发给运行中的 app——语义检索的嵌入在 app 侧执行，sqlite-vec 近邻仍在 MCP 进程（只读库）
- 审计：`{appData}/agent-audit/local-api.jsonl`（auth-fail 与 embed 记录，写盘前 `redact_secrets` 脱敏，:195-274）

## 7. chat transport 接线

`ai/custom-chat-transport.ts` 实现 AI SDK v5 的 `ChatTransport<UIMessage>`（:34），核心 `sendMessages`（:52-212）：

1. `prepareSendMessagesRequest` 把 `chatContext`（agentScope/activeBookId/paperScopeIds/threadId）塞进 body（:64-82；注入端 `ai/hooks/use-chat.ts:21-33`）
2. 多模态闸：非视觉模型 `stripFileParts`（:86-89）+ mediaType 嗅探修复（:93-113）
3. 上下文活塞 + 滚动摘要（第 3 节，:115-130）
4. 工具组装：`getToolsForScope(scope, ctx)` 合并 `await getMcpToolsForScope(scope)`（:134-148，MCP 失败逐个 toast），再过 `wrapToolsWithGuard`（:140-150）
5. `convertToModelMessages(stripUnknownToolParts(sanitizeMessageParts(...)), { tools, ignoreIncompleteToolCalls: true })`（:156-162）——stripUnknownToolParts 剔除已下线工具的旧 part 防 TypeValidationError
6. system prompt = buildPrompt + 工作区段 + memory.md 段 + 前情摘要（:164-169）
7. `streamText({ toolChoice:"auto", stopWhen: stepCountIs(20), tools, ... })` 的 ReAct 循环（:176-188），`onFinish` 关闭 MCP 连接；`toUIMessageStream` 回流给 useChat（:190-211）

思考强度经 `chatReasoningProviderOptions` 下发（:171-174,187）；`reconnectToStream` 返回 null（:214-220，不支持断流重连）。

## 8. 系统提示词组装与 Agent 工作区

**提示词组装**（每条消息发送时重新组装）：

- `constants/prompt.ts:13-26` 按 `agentScope` 路由：central → `central-prompt.ts`，paper → `paper-prompt.ts`，reader → DB 里的系统技能（见第 4 节"种子而非数据源"）；再叠加当前激活的技能与提示词预设
- transport 内的最终拼装顺序：buildPrompt + 工作区段 + memory.md 段 + 前情摘要（`custom-chat-transport.ts:164-169`）
- **提示词预设**（`prompt_presets` 表）：reader/paper 的命名系统提示词，同 scope 内 `is_active` 互斥，无激活行时用内置默认（`database.rs:243-259`、`core/prompts/models.rs:7-19`）；与技能是两套东西，别混淆

**Agent 工作区**：默认根 `{appData}/agent-workspace/`（`core/agent_ws/mod.rs:7-16`），其中的 `memory.md` 由 Agent 通过文件五件套（readLocalFile/writeFile/editFile/searchFiles/runCommand）自管理，作为跨会话记忆注入 system prompt（注入点在 `custom-chat-transport.ts:164-169` 的拼装段）。界内/界外判定统一走 Rust `agent_resolve_path`（canonicalize + 根前缀，`agent_ws/commands.rs:69-77`）——**路径守卫只有这一处实现**，前端守卫只是它的调用方；同文件 :9-14 还定义了读取限额常量（防 Agent 一次读爆上下文）。

**提示词预设的 UI**：AI Hub 第二个 tab（`pages/skills/index.tsx:9-14`）；预设与技能的区别——预设是"整套系统提示词的命名替换"（同 scope 互斥激活），技能是"可叠加的 SOP 片段"（多条同时激活）。

## 9. 模型层、快捷指令与审计

**模型层**（`ai/providers/factory.ts`）：

- 支持的 provider：openai / deepseek / google / anthropic / grok / openrouter / openai-compatible（预置清单 11 家，`constants/predefined-providers.ts`，zhipu/kimi 等落 openai-compatible 分支）。**fetch 走向分两路**：anthropic 与 openai-compatible（default 分支）传 `fetch: fetchTauri`，走 Rust 网络栈绕 CORS、跟随应用级代理；openai/deepseek/google/grok/openrouter 走 AI SDK 默认的 WebView fetch（跟随系统代理，不过应用代理）
- 思考强度：`reasoning-map.ts` 按端点/模型分档生成请求体补丁（`chatReasoningBodyPatch`），聊天模型按用户档位动态下发；摘要压缩、术语表抽取等轻量任务走辅助模型实例（`createUtilityModelInstance`）并尽量关闭思考
- 密钥运行时加载：前端仅经 `secret_get_for_runtime` 把 key 载入内存发请求，zustand `partialize` 保证不落盘（`services/secret-init.ts:16`）

**快捷指令**（quick-command-store）：AI Hub 第一个 tab（`pages/skills/index.tsx:9-14`），用户自定义的常用提示词片段，聊天输入处一键插入。

**模型选择 UI**：`components/side-chat/model-selector.tsx`（三个助手入口共用）；central 的 `switchModel` 工具让 Agent 自己换模型（`registry.ts` central 专属区）。技能的 `is_active` 控制是否叠加进提示词（`constants/prompt.ts:13-26` 只取激活项），未激活的技能对模型不可见。

**单条消息的工具往返上限**：`stopWhen: stepCountIs(20)`（`custom-chat-transport.ts:176-188`）——一次发送最多 20 步 ReAct 循环；`reconnectToStream` 恒 null（:214-220），刷新页面后流式即终止、不支持断流重连。

**审计日志**：`{appData}/agent-audit/*.jsonl`（如 `mcp-stdio.jsonl`、`local-api.jsonl`）。所有写盘日志先过 `redact_secrets` 脱敏（`core/secrets/mod.rs:244-279`），脱敏模式清单与前端 `ai/utils/secret-patterns.ts` 保持一致。`full` 档静默放行写操作时也照写审计。

**联网搜索**：`core/web_search.rs` 双通道——内置 HTML 爬取（Bing/百度/DuckDuckGo）+ API provider（Tavily/Serper/SearXNG），key 从 keyring 取；前端工具为 shared 的 `webSearch`。

## 10. 附：消息清洗与 UI 展示细节

**sendMessages 内的消息清洗管线**（`custom-chat-transport.ts`）：

1. `processQuoteMessages` 处理引用消息（:115 之前）
2. `sanitizeMessageParts` 清理 part 结构
3. `stripUnknownToolParts` 剔除已下线工具的旧 part——防止历史线程里的残留工具名触发 TypeValidationError（:156-162）
4. `convertToModelMessages(..., { tools, ignoreIncompleteToolCalls: true })`——容忍中断的工具调用

**工具的 UI 展示**：工具名即 UI 名的映射表 `TOOL_NAME_MAP` 在 `components/side-chat/chat-messages.tsx:38`，未收录的工具 fallback 显示原始名（:516）；MCP 工具显示名带 `[server名]` 前缀。

**MCP 配置版本迁移**：`store/mcp-store.ts:69-90`——persist v1→v2 把 scope 单值升成数组、补 headers/source 字段；UI 入口在 AI Hub 第四个 tab（`pages/skills/`），市场安装弹窗为 `tabs/mcp-market-dialog.tsx`。

## 11. 文档与代码不一致清单

1. keyring service 名：ecosystem-plan A1 写 `com.xincmm.sageread`，实际 `com.bettersageread.app`（`secrets/mod.rs:18`）；向量密钥账户为 `vector-model:{modelId}`
2. MCP Registry 字段大小写：文档写 snake_case，实测 camelCase（见第 5 节）
3. `@ai-sdk/mcp` 依赖：文档预判要新增，实际无需（`mcp-manager.ts:5-8`）
4. 上下文窗口参数过时：roadmap P3 写 `RECENT_MESSAGE_FLOOR=40`、无泄压线；现为双水位 256k/128k + floor=10（`message-selector.ts:5-12`）
5. `skills.scope` 两处缺省口径不一：DB 迁移默认 `'both'`（`database.rs:120`），而模型 `from_db_row` 的 fallback 是 `"reader,central"`（`skills/models.rs:65`）——旧值体系残留
6. roadmap P1.5 "central 26→17" 是当时快照；现静态注册表 central 为 22 个
7. 一致项抽验（无出入）：三档命名、`{{secret:NAME}}` 正则（Rust `secrets/mod.rs:106` 与前端 `skill-import-service.ts:155` 一致）、迁移标记 `secretsMigratedTo:keyring`、审计脱敏模式清单、确认卡三挂载点、I2 双端点与 token 模型
