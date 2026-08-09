# Agent 生态执行计划（MCP · 市场 · 秘钥安全 · 小点批）

> 2026-08-06 与用户调研讨论后拍板，供后续 Agent 按批执行。
> 决策来源：① MCP 传输全做、分两期；② 市场形态 = 对接官方 MCP Registry；Skill **不自建市场**（2026-08-06 用户明确无此打算），仅做 SKILL.md 兼容导入；③ 秘钥安全全套改造；④ 小点批四项全做。
> 执行要求：严格按批次顺序与文件锚点施工；每批次完成后跑该批验收清单再进下一批；不要自由扩大范围，「明确不做」一节是边界。

## 总排产顺序

| 批次 | 内容 | 体量 | 依赖 |
|---|---|---|---|
| S | 安全先行快修（备份泄密 / memory 防写入 / WebDAV 掩码） | 小 | 无 |
| A | 秘钥全套（keyring 迁移 + secret 引用机制 + 读守卫 + 审计脱敏） | 中 | S |
| B | MCP 一期：远程运行时（Streamable HTTP/SSE）+ manageMcp 工具 | 中 | A（headers/env 依赖 secret 引用） |
| C | 市场与一键安装（MCP Registry 市场 + Skill SKILL.md 导入） | 中 | B |
| D | MCP 二期：stdio（Rust 子进程桥 + 自定义 Transport） | 大 | B |
| F | Zotero brain 精简版 MCP（检索/下载/导入）+ 代理配套 | 中 | D（stdio 运行时） |
| E | 小点批（C2 打磨 / webSearch 面板 / read_epub bug / tags 冲突 / 预览面板） | 小~中 | 无，E1–E4 可插入任意批次间隙 |

执行顺序：S → A → B → C → D → F；E 穿插进行。全量剩余待办（含未排产项）见文末附录。

背景事实（已核实，执行者无需再调研）：

- MCP 现状：只有配置外壳。UI `packages/app/src/pages/skills/tabs/mcp-tab.tsx`（BETA 标记 :74-78）、store `packages/app/src/store/mcp-store.ts`（明文落盘 `appConfigDir()/mcp-servers.json`）、注入点是 `packages/app/src/ai/tools/registry.ts:335-340` 的注释占位。**前后端均无 MCP 运行时**。
- AI SDK v5（`ai@^5.0.44` 已装）支持 `experimental_createMCPClient`，transport 支持 `{ type: 'http', url, headers, authProvider }`、`{ type: 'sse', ... }`、以及自定义 `MCPTransport` 接口（`start/send/close` + `onmessage/onerror/onclose`），`client.tools()` 自动做 schema 转换。官方文档：<https://ai-sdk.dev/v5/docs/ai-sdk-core/mcp-tools>。注意新版文档从 `@ai-sdk/mcp` 导出，若当前 `ai` 包内导出缺失或不支持 `type: 'http'`，则新增依赖 `@ai-sdk/mcp`（开工第一步验证，见 B1）。
- 官方 MCP Registry API 已可用：`GET https://registry.modelcontextprotocol.io/v0/servers?limit=30&cursor=&search=&version=latest`，响应 `{ servers: [{ server: { name, title, description, version, packages?, remotes? }, _meta }], metadata: { nextCursor, count } }`；`remotes[].type = "streamable-http"`，`packages[].registry_type ∈ npm/pypi/oci` 且含 `environment_variables[]`（`name/description/is_required/is_secret`）。
- 秘钥现状：**全部明文**。`model-provider.json` / `llama-store.json` / `converter-store.json` / `mcp-servers.json` / `webdav-config.json` 均在 `%APPDATA%/com.xincmm.sageread.dev/`；web-search、TTS key 在 localStorage。Rust 侧无任何 keyring/stronghold。
- Skill 现状：DB 表 `skills`（`src-tauri/src/core/skills/`），Agent 已有 `manageSkill` 工具（central 专属，`src/ai/tools/central/manage-skill.ts`）；无 MCP 注册工具、无 SKILL.md 兼容、无导入导出 UI。

---

## 批次 S：安全先行快修（小，先做）

三颗已确认的雷，改动小、独立，任何后续批次前必须先修。

### S1 llama-store 备份泄密修复

- 问题：`src-tauri/src/core/sync/backup.rs:15` 的 L1 备份白名单含 `llama-store.json`，而 `packages/app/src/store/llama-store.ts:231-238` 的 partialize 未剔除 `apiKey` → 向量模型 key 明文上传 WebDAV。
- 修法（双保险，都做）：
  1. `llama-store.ts` 的 `partialize` 中剔除所有 `apiKey` 字段（持久化层即不存——与批次 A 的 keyring 迁移衔接：迁移后 key 本就由 keyring 保管，此处先行只是确保备份不带 key）。
  2. `backup.rs` 白名单保留 `llama-store.json`（配置本身可同步），但加注释说明"apiKey 由 partialize 保证不落盘，若未来恢复持久化 key 必须同步移出白名单"。
- 验收：触发一次 L1 备份，解包确认备份内 llama-store.json 无 apiKey 字段。

### S2 memory.md 防 secret 写入

- 问题：Agent 被 prompt 鼓励记录用户信息（`src/ai/utils/workspace-context.ts:29,53`），无任何防 secret 机制；memory.md 每轮注入 system prompt，key 一旦写入即常驻上下文。
- 修法（两层）：
  1. prompt 层：`workspace-context.ts` 的记忆指引中追加硬规则——"绝不把 API Key、Token、密码、私钥写入 memory.md 或工作区任何文件；用户主动提供密钥时，引导其通过 设置 → 密钥保管箱 保存，并在 SOP/配置中以 `{{secret:名称}}` 引用"。
  2. 工具层：在 writeFile/editFile 的执行路径（写之前）加 secret 模式检测：目标文件为 `memory.md`（工作区根下）且内容命中常见 key 模式时**全模式拒绝写入**，工具返回错误信息说明原因与替代方案。模式清单（正则，放 `src/ai/utils/secret-patterns.ts` 新建）：
     - `sk-[A-Za-z0-9_-]{20,}`（OpenAI 系）、`AIza[0-9A-Za-z_-]{35}`（Google）、`ghp_[A-Za-z0-9]{36}`、`github_pat_[A-Za-z0-9_]{22,}`、`xox[baprs]-[A-Za-z0-9-]{10,}`（Slack）、`eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`（JWT）、`-----BEGIN [A-Z ]*PRIVATE KEY-----`、`(?i)(api[_-]?key|token|secret|password)\s*[:=]\s*["']?[A-Za-z0-9_\-]{16,}`。
  3. 检测函数 `containsSecret(text: string): string | null`（返回命中的模式名）同时供批次 A 的审计脱敏复用。
- 验收：让 Agent 把一段含 `sk-test...` 的文本写入 memory.md，应被拒绝并收到引导信息；正常记忆写入不受影响。

### S3 WebDAV 密码返回掩码

- 问题：`src-tauri/src/core/sync/commands.rs:138-145`（`sync_get_config`）把完整密码返回前端。
- 修法：返回结构中密码字段替换为掩码（如 `"********"`）+ `has_password: bool`；前端设置页据此显示占位而非真值；新增独立命令 `sync_test_connection`（Rust 侧用真密码直连测试，不经过前端）。保存逻辑改为：前端提交掩码值时保留原密码不变。
- 验收：设置页不再出现明文密码；保存/测试连接正常。

---

## 批次 A：秘钥全套改造（中）

目标：所有 key 迁入 OS 凭据管理器；建立 `{{secret:NAME}}` 引用机制，使 key 永远不进入模型上下文。

### A1 Rust secrets 模块（keyring）

- 新模块 `packages/app/src-tauri/src/core/secrets/mod.rs`。依赖：`keyring = "3"`（Windows 凭据管理器 / macOS Keychain / Linux Secret Service，无需额外系统依赖）。
- 约定：`Entry::new("com.xincmm.sageread", account)`，account 命名 `{category}:{key}`：
  - `model-provider:{providerId}`、`vector-model:remote`、`converter:{service}`（mineru/paddleocr/glm/deepseek）、`webdav:password`、`web-search:{engine}`、`tts:{service}`、`mcp:{serverId}:{envKey}`、`user:{NAME}`（用户密钥保管箱，供 skill/集成引用）。
- Tauri 命令（在 `lib.rs` 注册）：
  - `secret_set(category: String, key: String, value: String)`
  - `secret_delete(category: String, key: String)`
  - `secret_has(category: String, key: String) -> bool`
  - **不向前端提供读取真值的通用命令**；唯一例外是执行边界内部函数 `resolve_secret_refs(text: &str) -> String`（见 A3），以及设置页"测试"类命令在 Rust 侧自取。
- 注意 keyring 在 headless Linux 无可行后端的降级：捕获错误并回退到旧明文路径 + 日志警告（本项目主发 Windows/macOS，降级仅为不崩溃）。

### A2 存量明文迁移器

- 启动时一次性执行（挂 `lib.rs` setup 或 database 迁移链末尾，幂等）：
  1. 依次读 `model-provider.json`、`llama-store.json`、`converter-store.json`、`webdav-config.json`、`mcp-servers.json`（含 env）、localStorage 的两类 key（web-search/TTS 在前端启动时迁移：读 localStorage → 调 `secret_set` → localStorage 置空标记）。
  2. 每个 key `secret_set` 后，将 JSON 中对应字段改写为空串，并在 JSON 顶层写 `"secretsMigratedTo": "keyring"` 标记；迁移器见到标记即跳过。
  3. 迁移完成写应用日志一行汇总（不含 key 本体）。
- 前端各 store/settings UI 配合改造：保存 key 时改调 `secret_set`，持久化 JSON 不再含 key 字段；输入框不回显真值，已保存时显示 `已保存 ·•••` 占位 + 「清除」按钮（调 `secret_delete`）。涉及文件：`provider-store.ts`、`llama-store.ts`、`converter-store.ts`、`web-search-store.ts`、`tts-store.ts`、`mcp-store.ts` 及对应设置组件（`api-config-section.tsx`、`vector-model-manager.tsx`、`converter.tsx`、`sync.tsx`、`web-search-settings.tsx`、`tts-settings.tsx`）。
- 使用方读取路径改为 Rust 侧自取：`web_search.rs` 等命令由"前端传 api_key 参数"改为"Rust 侧按 category/key 自 keyring 取"（`web_search.rs:672-680` 签名精简）；LLM 对话请求在前端发 fetch 必须带 key 的场景（`provider-service.ts:23-37`），允许启动时经一次 `secret_get_for_runtime(category, key)` 取入内存（仅内存、不写盘、不进日志）——此命令注册但**不暴露给 Agent 工具**，仅前端代码 invoke。威胁模型说明写进模块注释：key 可存在 app 进程内存，但绝不进模型消息、磁盘明文、日志、备份。

### A3 secret 引用机制 `{{secret:NAME}}`

- 规则：任意面向 Agent 的文本配置（skill content、MCP env/headers、httpRequest 的 url/headers/body）可写 `{{secret:NAME}}`；模型永远只见占位符，执行边界替换为 `user:{NAME}` 的真值。
- Rust 实现：`core/secrets/mod.rs` 内 `resolve_secret_refs(text)`——正则 `\{\{secret:([A-Za-z0-9_-]{1,64})\}\}` 逐个替换；未知名称替换失败时返回结构化错误（不静默置空）。
- 执行边界改造：
  1. **httpRequest 走 Rust 发射**：新增命令 `agent_http_request(method, url, headers, body)`，Rust 侧先 `resolve_secret_refs`（URL/headers/body 三处）再用 reqwest 发射，返回状态码 + 响应体（截断上限沿用现网搜的惯例）。前端 `src/ai/tools/central/http-request.ts:27-33` 改为 invoke 该命令；tool-guard 的"非 GET 恒确认"规则不变（`src/ai/utils/tool-guard.ts:142-146`）。
  2. MCP 的 stdio env：批次 D 中在 spawn 前于 Rust 侧替换（key 不进 JS）。
  3. MCP 的 http/sse headers：transport 在前端创建，替换只能在前端完成——调一次 `secret_resolve_batch(texts: string[]) -> string[]`（新建命令，仅前端 invoke），取回真值后注入 transport headers。**key 短暂经过 JS 内存但不进模型上下文**，此取舍写进代码注释。
- 设置页新增「密钥保管箱」区块（放在模型提供商设置旁）：用户级 secret 的增/删/改名，永不明文回显；列表显示名称 + 已保存状态。

### A4 Agent 读守卫加固

- 问题：`agent_read_file`（`src-tauri/src/core/agent_ws/commands.rs:58-101`）Rust 侧不判界，界外读仅靠 TS 层 `tool-guard.ts:119-134`，relaxed/full 模式下静默放行。
- 修法：
  1. Rust 侧补界外拦截：`agent_read_file` 增加与写命令同款的 `allow_outside: Option<bool>` 注入参数（不进模型 schema，由 tool-guard 按模式注入），默认拒绝界外读。
  2. 敏感路径 denylist（Rust 侧、全模式生效、不可被 allow_outside 覆盖）：`model-provider.json`、`llama-store.json`、`converter-store.json`、`mcp-servers.json`、`webdav-config.json`、`*.pem`、`*.key`、`id_rsa*`、`.env`、`.env.*`。命中即返回固定错误"该文件可能包含凭据，已由安全策略拦截"。迁移完成后这些 JSON 已无 key，denylist 仍保留作纵深防御。
- 验收：strict/relaxed/full 三模式下让 Agent 读 `model-provider.json` 均被拦截；读工作区内普通文件正常。

### A5 审计日志脱敏

- 问题：`{appData}/agent-audit/commands.jsonl` 记录完整命令 + stdout/stderr 前 200 字符（`agent_ws/commands.rs:342-372`），可能沉淀 key。
- 修法：写入前对 command/stdout/stderr 三字段跑 S2 的 `containsSecret` 同款正则（Rust 侧复制一份模式清单，或用等价 regex crate 实现），命中片段替换为 `«REDACTED:{模式名}»`。
- 验收：执行 `echo sk-test12345678901234567890` 后查 jsonl 无明文 key。

### 批次 A 验收总表

- [ ] 所有设置页保存后，对应 JSON/localStorage 不再出现 key 明文
- [ ] 老用户升级后首次启动迁移器跑通，各功能（对话/向量化/转换/同步/网搜/TTS）不回归
- [ ] L1 备份包内无任何 key
- [ ] Agent 读 key 文件被拦；写 memory.md 带 key 被拒；审计日志无 key
- [ ] `{{secret:NAME}}` 在 httpRequest 全链路替换成功，模型消息记录中只有占位符

---

## 批次 B：MCP 一期 · 远程运行时（中）

目标：Streamable HTTP / SSE 两类远程 MCP server 可配置、可连接、工具进入三个 Agent 的 ReAct 循环、全部走确认卡。stdio 本批不做（批次 D）。

### B1 开工验证（半天，必须先做）

- 在当前 `ai@^5.0.44` 下验证：`experimental_createMCPClient` 的导出来源（`ai` 还是需新增 `@ai-sdk/mcp`）、`transport: { type: 'http' }` 是否可用、`client.tools()` 返回的 ToolSet 形态。
- 验证 CORS：在 webview 中直连一个无 CORS 头的远程 MCP server。若被拦，决策树：
  1. 优先：`StreamableHTTPClientTransport`（`@modelcontextprotocol/sdk`，新增依赖）注入自定义 `fetch`（`@tauri-apps/plugin-http` 的 fetch，已装，绕 CORS）；
  2. 次选：自研轻量 Streamable HTTP transport 实现 `MCPTransport` 接口（接口仅 `start/send/close` + 三个回调，协议 = POST JSON-RPC + 可选 SSE 响应流）；
  3. 兜底：Rust 代理命令转发。
- 把验证结论以注释形式落在 `src/ai/mcp/` 模块头。

### B2 配置模型 v2（store + UI + 迁移）

- `mcp-store.ts` 升级（persist version 1→2 迁移）：

```ts
interface McpServerConfigV2 {
  id: string;
  name: string;
  transport: "stdio" | "http" | "sse"; // sse 保留兼容，UI 标注「已弃用，建议 http」
  command?: string;                    // stdio（批次 D 才可用）
  args?: string[];                     // UI 改逐行编辑器，弃用逗号分隔
  env?: Record<string, string>;        // 值支持 {{secret:NAME}}；UI 新增 env 编辑器
  url?: string;                        // http/sse
  headers?: Record<string, string>;    // 值支持 {{secret:NAME}}；UI 新增
  scope: Array<"central" | "reader" | "paper">;
  enabled: boolean;
  source?: "manual" | "registry";      // 批次 C 市场安装写入
  registryName?: string;               // 官方 registry 的 name，供将来检查更新
}
```

- `mcp-tab.tsx` 改造：传输方式三选（stdio 项标注"即将支持"，选中时提示批次 D 后可用并禁用保存？——不，允许预先配置，运行时跳过并 toast）、args 逐行编辑、env/headers 键值对编辑器（secret 值引导用保管箱引用，UI 上给 `{{secret:...}}` 插入辅助）、去掉 BETA 横幅改为"远程传输已可用，stdio 即将支持"。

### B3 运行时连接管理器（新建 `src/ai/mcp/`）

- `mcp-manager.ts` 核心 API：

```ts
async function getMcpToolsForScope(
  scope: "central" | "reader" | "paper",
): Promise<{ tools: ToolSet; failures: Array<{ server: string; error: string }> }>
```

- 逻辑：过滤 `enabled && scope.includes(scope)` → 每个 server 并行 `createMCPClient`（headers 先经 A3 的 `secret_resolve_batch` 替换）→ 10s 超时 → `client.tools()` → 工具键加前缀 `mcp_{sanitize(server.name)}_{toolName}`（sanitize：非字母数字转 `_`），description 前加 `[server名] ` → 合并返回；失败收集进 failures（不阻塞其他 server）。
- 生命周期（v1 简单方案）：跟随单次聊天请求创建，`streamText` 的 `onFinish` 中 `client.close()`；常驻缓存优化留待后续（代码里留 TODO 注释即可，不实现）。
- `registry.ts:335-340` 注释占位替换为真实注入：`getToolsForScope` 中合并 `getMcpToolsForScope(scope)` 的结果；failures 通过回调抛给 UI toast（"MCP 服务器 X 连接失败：原因，已跳过"）。
- 工具元数据：MCP 工具在 `ToolScope` 体系按各 server 配置的 scope 注入；`TOOL_NAME_MAP` 不做静态登记，确认卡与消息渲染直接显示前缀名（渲染管线 `chat-messages.tsx:354` 已能 fallback 原始名）。

### B4 安全门控

- `tool-guard.ts` 决策表新增：`mcp_` 前缀工具 = strict/relaxed 弹确认卡（卡片显示 **server 名 + 工具名 + 参数摘要**），full 模式静默放行（与 runCommand 同档）；确认卡支持"本次会话不再询问该 server"（按 server 维度记忆，不落盘）。
- central/reader/paper 三处确认卡挂载点复用 P1 已有三聊天面，不新增 UI 体系。

### B5 manageMcp 工具（Agent 自助注册）

- 新建 `src/ai/tools/central/manage-mcp.ts`，动作 `list / create / update / toggle / delete`，写 mcp-store；注册 `scope: "central"`（与 manageSkill 同策略）；**全部动作 Tier 2 确认卡**（create/delete 恒确认，不受"不再询问"影响）。
- central 系统提示词（`src/constants/central-prompt.ts`）补一段：用户说"装/配某个 MCP"时用 manageMcp，含密钥的 env 一律引导 `{{secret:NAME}}`。
- 配套回答用户历史疑问的文档事实：Agent 创建技能 = `manageSkill`（已有，central）；注册 MCP = `manageMcp`（本项新增）。

### 批次 B 验收总表

- [ ] 配置一个真实远程 MCP server（如官方 registry 里任一 streamable-http server）后，三个 Agent 按 scope 拿到 `mcp_*` 工具
- [ ] 工具调用弹确认卡且显示 server 名；full 模式放行
- [ ] server 离线/超时时不阻塞聊天，toast 降级提示
- [ ] 含 `{{secret:NAME}}` 的 header 正确替换，模型上下文与 UI 消息中无真值
- [ ] manageMcp 对话流："帮我加一个 XX MCP" 全流程走通
- [ ] `tsc && vite build` 通过；旧版 mcp-servers.json 迁移无损

---

## 批次 C：市场与一键安装（中）

### C1 MCP 市场（对接官方 Registry）

- UI：技能页 MCP tab 加「浏览市场」按钮 → 市场对话框：搜索框 + 列表（title/描述/版本/官方 active 标记）+ 分页（`metadata.nextCursor`）+ 详情视图。
- 数据源：`GET https://registry.modelcontextprotocol.io/v0/servers?limit=30&search={q}&version=latest&cursor=`，请求走 `@tauri-apps/plugin-http`（绕 CORS）；列表按 `_meta.official.isLatest` 去重同名 server。
- 一键安装映射（详情页「安装」→ 打开预填的 server 编辑表单，用户确认/补 env 后落 mcp-store）：
  - `remotes[].type == "streamable-http"` → `transport: "http"` + `url`；`headers` 中含占位语法的生成 headers 编辑行。
  - `packages[].registry_type == "npm"` → `transport: "stdio"`、`command: "npx"`、`args: ["-y", "{identifier}@{version}", ...package_arguments]`；`pypi` → `command: "uvx"`；`oci`/docker → 一期标"需 stdio 支持（批次 D）"，按钮置灰。
  - `environment_variables[]` → 生成 env 编辑行（`name` + `description` 作提示；`is_required` 标红星；`is_secret` 的行默认建议 `{{secret:NAME}}` 并链接到保管箱）。
  - 安装时写 `source: "registry"` + `registryName`。
- stdio 类 server 在批次 D 完成前允许"预配置"（保存但运行时跳过），UI 明示。

### C2 Skill 的 SKILL.md 兼容导入

> 定位（2026-08-06 用户拍板）：**不自建 skill 市场/索引仓**。用户自行在社区找 skill（Claude Code skills 生态，如 anthropics/skills 及各类 awesome-skills 仓），我们保证"找得到就能装"——格式兼容 + 三种导入通道。

- 解析器 `src/services/skill-import-service.ts`（新建）：拉取文本（tauri-plugin-http）→ 解析 YAML frontmatter（`js-yaml` 已装）——字段 `name`（必填）、`description`、`scope`（可选，映射到三 scope 复选，缺省全选）→ body 作 content → 走 `skill-service.ts` 现有 create。
- UI：技能库 tab 加「导入」：支持 ① SKILL.md 直链 URL；② GitHub 仓库目录 URL（自动转 `raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}/SKILL.md`，分支默认 main 失败后试 master）；③ 粘贴文本。对话框内放引导文案：去哪找 skill（Claude Code skills 官方/社区仓）+ 兼容范围说明。
- 密钥引导：解析时顺手扫正文中的 `{{secret:NAME}}` 占位（A3 机制），命中则导入完成后 toast 引导去密钥保管箱补齐——替代原 C3 的 `requiresSecrets` 字段，零成本。
- 与 Claude Code skills 生态兼容即"能导入其 SKILL.md 的 name/description/正文"；附带脚本/资源文件不处理（文档注明限制：SOP 中引用的脚本需 Agent 自行下载执行）。
- Agent 散装安装流保留，`central-prompt.ts` 的 skill 包安装示例更新为"优先识别 SKILL.md frontmatter"。

### 批次 C 验收总表

- [ ] 市场内搜索 "github" 等关键词出结果、分页正常、详情字段完整
- [ ] 远程 server 一键安装后立即可用；npm 类正确预填 npx 命令行
- [ ] is_secret 的 env 引导进保管箱，配置文件中无明文
- [ ] 从官方 skills 仓任选 Claude Code SKILL.md 可导入为 SageRead 技能并启用；含 `{{secret:}}` 占位的导入后有保管箱补齐引导

---

## 批次 D：MCP 二期 · stdio（大）

目标：本地 npm/uvx 类 MCP server（生态大头）可用。这是前后端联动改造，独立排产。

### D1 Rust 子进程桥（`src-tauri/src/core/mcp/`）

- 命令：
  - `mcp_stdio_start(server_id, command, args, env) -> session_id`：spawn 子进程，stdin/stdout/stderr 管道；**Windows 解析**：`npx`/`uvx` 等实为 `.cmd`，需 `cmd /C` 包裹或先 `which` 解析全路径；`CREATE_NO_WINDOW`（0x08000000）防弹黑窗；env 先 `resolve_secret_refs` 再注入（A3，key 不进 JS）。
  - `mcp_stdio_write(session_id, message)`：向 stdin 写一行 JSON-RPC（换行结尾）。
  - `mcp_stdio_close(session_id)`：kill + 回收。
- stdout 逐行读取 → `app.emit("mcp-stdio://{session_id}", line)` 推到前端；stderr 进审计日志（脱敏复用 A5）；进程异常退出 emit 错误事件。
- 生命周期：全局 `HashMap<session_id, Child>` 管理；app 退出时全部 kill（`lib.rs` 的 `on_exit`/Drop）；孤儿进程防护（job object 或 kill-on-drop）。
- 安全：同一 server 的首次启动触发前端确认卡（"将启动本地进程：`npx -y xxx`"，strict/relaxed/full 语义同 B4 的 server 维度）。

### D2 前端 TauriStdioTransport

- 新建 `src/ai/mcp/tauri-stdio-transport.ts`，实现 `MCPTransport` 接口：`start()`（invoke start + listen 事件）、`send()`（invoke write）、`close()`（invoke close + unlisten）；`onmessage/onerror/onclose` 回调接线；JSON 行解析与错误兜底。
- 接入 B3 连接管理器：`transport == "stdio"` 时 `createMCPClient({ transport: new TauriStdioTransport(config) })`，其余命名空间/确认卡/降级逻辑完全复用。

### 批次 D 验收总表

- [ ] `@modelcontextprotocol/server-filesystem`（npx）配置后工具可用，确认卡显示 server 名
- [ ] Windows 下 `npx` 正确解析，无黑窗
- [ ] 聊天结束 close 后无残留进程（任务管理器验证）；app 退出后无孤儿 node 进程
- [ ] env 中 `{{secret:NAME}}` 在 Rust 侧替换注入，JS 侧与模型侧均不见真值
- [ ] server 进程崩溃 → 聊天内工具报错降级 + toast，不拖垮对话

---

## 批次 F：Zotero brain 精简版 MCP（默认夹带）+ 代理配套（中）

> 2026-08-06 用户拍板纳入（撤销此前"暂缓"口径）。原版在 `F:/MyProjects/zotero-brain`（6252 行 Python，官方 MCP SDK 低层 Server，stdio 传输，14 个工具；已实地调研）。精简目标三件事做扎实：**数据库（Zotero 检索）、下载源（PDF 瀑布）、代理（网络环境）**；剪除解析与向量化（MinerU/智谱/ChromaDB 全删）。以下下载源/代理结论已经开源社区调研核实（Unpaywall/arXiv/S2/CORE/OpenAlex 官方文档、zotero-scihub 插件源码、54yyyu 与 kujenga 的 zotero-mcp、reqwest/undici/uv 代理行为文档）。

### F1 精简版本体（独立仓，目标 ~1500 行）

- 从原版保留：`config.py`（删 MinerU/智谱/ChromaDB 配置项）、`zotero_sync.py`（Zotero 读写，pyzotero Web API）、`paper_discovery.py`（四源学术搜索）、`paper_importer.py`（下载瀑布 + Zotero 导入，剪 `fetch_and_ingest`）、`mcp_server.py`（只留工具框架）。
- 剪除：`pdf_parser.py` / `chunker.py` / `embedder.py` / `vector_store.py` / `run_ingest.py` / `ingest_resume.py` / `network_helper.py`（MinerU 的 TUN 绕行 monkey-patch，精简后全是境外 API，不再需要）、`parsed/`、`data/chroma_db/`。依赖 6 → 4：pyzotero、httpx、mcp、PyMuPDF（仅 PDF 校验用）。
- 工具面（6 个）：
  1. `search_zotero_library`（**新写**：原版的 `search_papers` 搜的是向量库，"搜 Zotero 库"工具并不存在；基于 pyzotero `q=` 检索 + 按 DOI/标题查元数据）
  2. `discover_papers`（保留四源学术搜索；`is_in_library` 查重从 ChromaDB 改走 Zotero DOI 比对）
  3. `download_paper`（保留 + 增强，见 F2）
  4. `import_to_zotero`（保留：建条目 + linked_file 附件 + 入 Collection）
  5. `list_collections` / `create_collection`（保留 Zotero 半边，删 ChromaDB 状态半边）
- **数据库双模式（回应"Web API 不稳定"顾虑）**：默认 Zotero Web API（需 `ZOTERO_USER_ID`/`ZOTERO_API_KEY`，有限流）；`ZOTERO_LOCAL=true` 切 Zotero 桌面端本地 API（`127.0.0.1:23119`，免 key、不限流，需 Zotero 运行中）——kujenga/zotero-mcp 同款惯例，pyzotero 仅构造参数差异，成本很低。
- 配置（MCP env 传入，密钥经 `{{secret:NAME}}` 引用）：`ZOTERO_USER_ID`、`ZOTERO_API_KEY`、`ZOTERO_LIBRARY_TYPE`、`ZOTERO_LOCAL`；可选 `CORE_API_KEY`、`UNPAYWALL_EMAIL`、`OPENALEX_API_KEY`、`PROXY_URL`（F3）、`SCIHUB_ENABLED`（默认 false，F2）。

### F2 下载源瀑布（增强）

- 级联顺序（串行，每源独立开关，速率遵守标注）：
  1. 本地缓存（原版已有，按 DOI/title-hash）
  2. Unpaywall（`?email=` 即认证，100k 次/天，合法 OA 聚合，量最大）
  3. arXiv 规则直链（`arxiv.org/pdf/{id}`，≥3s 间隔）
  4. Semantic Scholar `openAccessPdf`（**新增**，54yyyu 级联同款；无 key 100 次/5min 共享池，≥1s 间隔，429 退避）
  5. CORE（5 次/10s，需 `CORE_API_KEY`）
  6. OpenAlex OA 直链（**注意：已从 mailto 礼貌池改为免费 API key 制**，$1/天免费额度，配 `OPENALEX_API_KEY`）
  7. Sci-Hub 镜像轮换（**默认关闭**，`SCIHUB_ENABLED=true` 才启用）：保留原版的 whereisscihub 动态镜像列表（缓存 1h）+ 硬编码 .se/.st/.ru 兜底——调研确认该动态发现机制优于开源社区的静态列表做法（zotero-scihub 插件均为硬编码多域名轮询）；补每镜像 HEAD 测活、验证码出现即中断并返回"人工下载指引"
- 质量校验保留原版：magic bytes `%PDF`、>1000B、content-type、PyMuPDF 读 PDF 标题三级模糊比对（不匹配即丢弃）。
- 容错增强：单源 2 次指数退避（原版一次定胜负）；级间 sleep 按各源速率；全失败返回 `(None, "none")` + 手动下载提示（原版已有此交互，保留）。

### F3 代理与网络环境（应用级代理为主路径，**无需 TUN**）

背景结论（已核实）：**TUN 不是必需的**。TUN 是路由层全局接管（需管理员权限、装虚拟网卡、接管全系统流量），对本场景是过重的武器——zotero-brain 的全部流量都是 HTTPS API 请求，应用级 HTTP 代理完全够用，且更安全：不碰路由表、不影响其他应用、不要管理员权限。

工作原理（执行者需理解）：

- 应用级代理 = 应用把请求发给本机代理软件的 HTTP 入站端口（Clash 混合端口默认 `127.0.0.1:7890`；只要代理软件在运行该端口就在监听，**不需要开 TUN，甚至不需要开"系统代理"模式**）。
- 走 HTTP 代理时 DNS 在代理端解析——Sci-Hub 等被 DNS 污染的域名自动解决，应用无感知。
- 国内外分流由代理软件自身规则（`GEOIP,CN,DIRECT`）在出口侧完成，应用把全部流量交给本地端口即可，**应用内不做域名分流**（做一份只会和用户的 Clash 规则打架，Cherry Studio reranker 冲突是前车之鉴）。

落地三项：

1. **SageRead 应用级代理设置（设置页新增，本方案主路径）**：三档 off / custom（输入框占位 `http://127.0.0.1:7890`）/ follow-env；作用于 ① Rust reqwest 层（`Proxy::custom`，覆盖 webdav 同步、web_search 等 Rust 侧请求）② F3-2 的 spawn env 注入。`NO_PROXY` 恒含 `localhost,127.0.0.1`。配「测试代理」按钮：经当前配置请求 `https://api.zotero.org` 和 `https://api.unpaywall.org`，失败时提示"请确认代理软件正在运行且端口正确"。
2. **D 批 D1 增补（stdio env 注入模板）**：`mcp_stdio_start` spawn 子进程时，在继承父进程 env 基础上显式注入——`HTTP_PROXY`/`HTTPS_PROXY`（值取自 F3-1 设置，带 `http://` scheme，reqwest 系对无 scheme 兼容差）+ `NO_PROXY=localhost,127.0.0.1` + `NODE_USE_ENV_PROXY=1`（Node ≥22.21 才生效，npx 系 server 必需）。npx/uvx 拉包同样受惠。把这段写进 D1 的实现 checklist。
3. **精简版 MCP 本体**：httpx 客户端读 `PROXY_URL` 配置（缺省读 env，即 F3-2 注入进来的值；留空 = 直连）。README **不再要求 TUN**，改写"在 SageRead 设置里配代理，或设 `PROXY_URL`"。

边界与降级（如实记录，不过度承诺）：

- Node 系 MCP server 在 Node <22.21 下无视 env 代理——设置页注明建议 Node ≥ 22.21；zotero-brain 精简版是 Python（httpx 原生尊重代理），不受此限。
- SOCKS5 支持参差（httpx 需 extras、Node undici 不支持）——统一建议 HTTP 混合端口，不推 SOCKS。
- WebView2 前端 JS fetch（LLM 对话/embedding 走 `provider-service.ts:23-37`）跟随 **Windows 系统代理**（注册表），不吃应用级设置；若要让 LLM 流量也走应用级代理需改经 Rust 转发——记为可选后续项，本计划不实现（国内提供商直连可达；用 OpenAI 的用户一般已开系统代理）。
- 完全无代理软件的环境：境外源不可达属预期，下载瀑布失败返回的"人工指引"中说明需代理。

### F4 SageRead 侧配套

- 新增 `importPaper` Agent 工具（central，Tier 2）：包装 `packages/app/src/services/paper-service.ts:213` 的单篇 PDF→paper.md 解析（启动 → 等转换进度事件 → 返回 paper id/title/folder）；注意与 `importBook`（`src/ai/tools/central/import-book.ts`，进书库）是两条链路，文案里区分清楚。
- `central-prompt.ts` 编排示例："找论文 → `discover_papers` → `download_paper` → `import_to_zotero` → `importPaper` 进 SageRead 文献库"；Zotero collection → SageRead 文件夹的映射沿用 Zotero 批量导入的既有逻辑（`zotero_collections` 表）。
- 安装通道：走 C 批市场一键安装（stdio 类，D 批后可用）。**分发形态待用户拍板**——首选：独立 GitHub 仓 + uvx 一键（kujenga/zotero-mcp 的 `uvx zotero-mcp@latest` 模式，物理不进 SageRead 安装包，配合"对外不绑定"口径）；备选：PyInstaller sidecar exe 夹带（与 Books/Papers_Converter 同模式，但绑定更实）。
- 灰色口径：精简版仓独立品牌、不带 SageRead 名；README 附免责声明（参照 ethanwillis/zotero-scihub 的 "Keep the laws of your locality in mind"）；Sci-Hub 级默认关闭；SageRead 官方文档与宣传不出现该仓链接，市场条目来源标注"社区"。

### F 批验收总表

- [ ] 6 个工具经 SageRead MCP 客户端（D 批 stdio 运行时）全部可调
- [ ] 不开 TUN、不开系统代理，仅在 SageRead 设置里配 `http://127.0.0.1:7890`：Zotero 检索 + 下载瀑布全链路通（含 Sci-Hub 域名的 DNS 污染场景）；无代理软件运行时失败指引清晰
- [ ] Zotero Web 模式与 `ZOTERO_LOCAL=true` 本地模式（Zotero 桌面端运行中）均可检索/导入
- [ ] 下载瀑布：OA 源命中即返回；OA 全失败且 `SCIHUB_ENABLED=false` 时返回人工指引；开启后镜像轮换可下载（含测活与验证码降级）
- [ ] 对话流"找 XX 论文并导入"端到端走通（Zotero + SageRead 文献库双侧落库，collection 映射正确）
- [ ] stdio 子进程 env 中代理变量正确注入（审计日志脱敏后可见），Node 系 MCP（`NODE_USE_ENV_PROXY=1`）与 Python 系均生效

---

## 批次 E：小点批（E1–E4 小，E5 中）

### E1 C2 打磨组（AI 标亮稳定性，已拍板）

- 锚点：`packages/app/src/services/paper-highlight-service.ts`（类型判定→模板抽取管线）、`packages/app/src/pages/paper-reader/paper-highlight-locator.ts`（quote→锚点匹配）、`packages/app/src/pages/paper-reader/paper-notepad-panel.tsx`（生成入口/toast）。
- 三项：
  1. 模板抽取的 LLM 调用加 `temperature: 0`（或 0.2），抑制 3~8 条的抽奖波动；
  2. 生成 toast 附丢弃原因分布（复述/公式句/未匹配分类 各几条）；
  3. quote 匹配器加一层宽松归一：大小写折叠 + 标点/空白归一化后再匹配（保留现有严格层，宽松层作兜底），归一函数放 locator 同文件并补 fixture 测试（沿用该文件 11 组 fixture 的测试方式）。

### E2 webSearch 结构化结果面板

- 锚点：`packages/app/src/pages/chat/index.tsx:136-197`（toolDetail 右侧面板，目前仅 mindmap/rag 有结构化渲染）。
- 做法：为 webSearch 工具结果新增结构化视图（标题/链接/摘要卡片列表，点击走 plugin-opener 开外链）；先读 webSearch 工具的输出结构（Rust `web_search.rs` 返回与前端工具定义）再定渲染字段；面板复用现有滑出容器，不加新依赖。

### E3 read_epub 元组顺序 bug

- 锚点：`packages/app/src-tauri/plugins/tauri-plugin-epub/src/epub/reader.rs:22`（`read_epub` 返回元组顺序颠倒，无下游使用，启用前须修）。
- 做法：对照 `EpubContent` 定义修正顺序；验证 `pipeline.rs:42`、`commands.rs:52` 两处调用；跑 epub 插件 cargo test。

### E4 tags 跨设备 UNIQUE 冲突

- 锚点：skills 已修的同款方案在 `src-tauri/src/core/sync/engine.rs:468-493`（`apply_skill_upsert` 按名合并）。
- 做法：为 tags 实现 `apply_tag_upsert`（同名不同 UUID → 归并到既有 id，保留 LWW 字段语义）；sync 测试套件保持全绿并补一组 tags 同名冲突用例。

### E5 预览面板（AI 产物侧边预览，"高频功能"）

- 范围：Agent 用 writeFile 产出的 `.md` / `.html` 在右侧边栏预览；书籍与论文场景通用。
- 做法：MD 复用现有 react-markdown 渲染管线；HTML 用 sandboxed iframe。**2026-08-09 复审修订（用户拍板：改文档不改代码）**：实际实现为 `sandbox="allow-scripts allow-modals"`（`src/components/preview/html-preview.tsx:14`）——放行脚本是为支持 AI 产出的交互式 HTML（图表/动画类产物）；**不含 `allow-same-origin`**，iframe 处于 opaque origin，读不到父页面 DOM/Cookie/localStorage，残余风险限于弹窗（allow-modals）与脚本算力消耗，评估可接受。入口 = writeFile 工具确认卡/结果卡片上的「预览」按钮 + 工作区文件列表（若有）。**体量中等，允许单独排产**，不与 E1–E4 捆绑。

---

## 明确不做（边界，勿越界施工）

- OAuth（`authProvider`）：一期不做；HTTP header 方案已覆盖主流托管 server 的 PAT 鉴权，OAuth 待真实需求出现后单独立项。
- MCP resources / prompts / elicitation：只接 tools，其余能力不暴露给模型。
- Zotero brain 的"解析/向量化"部分：维持剪除（精简版只做检索/下载/导入，见批次 F）；其 ChromaDB/MinerU/智谱链路不进入 SageRead 生态。
- 内嵌 rmcp（路线 B）、mem0 类长记忆、移动端：维持原判，不做。
- Skill 系统不重写为文件格式：保持 DB SOP 模型，仅加 SKILL.md 导入兼容（重写成本与同步体系冲突）。
- 自建 Skill 市场/索引仓（2026-08-06 用户明确无此打算）：skill 获取 = 用户自找 + URL/GitHub/粘贴导入，不做目录货架、投稿仓与技能市场 UI。

## 风险与注意

1. **keyring 迁移是最易翻车点**：迁移器必须幂等 + 失败可重入；任何一类 key 迁移失败不得阻塞 app 启动（记日志 + 该功能提示重配）。
2. **stdio 的 Windows 兼容**：`.cmd` 解析与 `CREATE_NO_WINDOW` 是历史坑位，D 批务必在真机验证 node/npm 全局与 npx 缓存两种形态。
3. **CORS**：B1 验证结论决定 B3 传输实现路径，执行者不得在跳过 B1 的情况下直接写传输层。
4. **确认卡疲劳**：MCP 工具默认全确认是有意设计（roadmap 已定），"按 server 记忆放行"是缓解阀，不要做成"全局不再询问 MCP"。
5. **文档收尾**：全部批次完成后，回更 `agent-capability-roadmap.md`（P2 标记完成、指向本文档）、`paper-polish-backlog.md`（E 批条目划线消化）、`README.md`（特性表补 MCP/市场/密钥保管箱）。

---

## 附录：全量剩余待办盘点（2026-08-06 对齐 docs/ 全部文档）

S–F 批之外，各文档里记录的其余待办如下。分类口径：**下一批** = 已拍板或低成本，建议紧随本计划排产；**条件触发** = 等特定时机；**远期** = 维持原判不动。

### 建议下一批（未排进 S–F）

> 2026-08-08 更新：剩余项已重新分批排产，见 `docs/agent-next-phase-plan.md`（G–J 批）。以下条目状态同步更新。

1. **词对齐残留打磨**（paper-polish-backlog D 批，2026-08-05 已拍板排产）：句首虚词错配（worth↔远离）、非连续对应（"not…at all"↔"根本"，jieba 粘连）、历史标注 -tgt 镜像疑似重复区间注册。
2. **多模态图片输入**（agent-capability-roadmap P3 残留）：消息 schema 扩展 + 附件 UI + 多模态能力检测 + 图片预览"发送到对话"按钮接线。
3. **确认卡视觉与真实对话链路手测**（roadmap P3 残留；B/D/F 批落地后必须补，因为 MCP 工具全走确认卡）。
4. **轻量 AI 任务提速**（local-roadmap 待观察）：辅助模型默认设为非推理模型；可选做 provider 级"禁用思考"开关。
5. **RAG 命中块去重限流**（paper-polish-backlog：top-k 被相邻重复块占满时的便宜机制，出现召回质量问题再做）。
6. ~~**支线三小件**~~（✅ 用户确认已做 2026-08-08）：刷新按钮对齐云端进度、对话右键菜单主题化、回收站文案。
7. ~~**性能模式开关**~~（❌ 2026-08-08 用户拍板不做）：P2 休眠 + 施工 B 已覆盖大部分收益。
8. ~~**标签页休眠**~~（✅ 2026-08-08 完成）：P2 落地——宽限期 10 分钟 + LRU 上限 6，只卸重型阅读视图（论文 PaperReader / 书籍 ReaderViewer），侧栏与聊天保活（护流式任务），阅读状态经 zustand store 重挂载恢复，论文滚动位置模块级记忆；实测 DOM -28%、开设置 6.1s→1.8s（叠加施工 B content-visibility）。遗留：休眠状态可见标识（见第 15 条）。
9. ~~**Agent 论文一条龙处理工具**~~（✅ 主体完成 2026-08-08）：processPaper 已落地（action：status/translate/align，translate 自动带对齐）；向量化入口由 vectorizeBook 的 kind 参数路由覆盖（论文走 vectorizePaper）。遗留：重新解析（reparse）入口缺失（见第 14 条）。
10. **对话断点续传**（2026-08-07 用户提出）：现状整条回复完成后才落库，app 异常中断时当次对话（用户消息 + 已产出的 AI 回复）全部丢失，无法看到中断在哪一步。方案：用户消息发送即落库；assistant 消息在 abort/异常时把已产出的 parts 增量写入 thread；重进时可看到中断现场。
11. **聊天布局宽版自适应 + 输入区拖拽高度**（2026-08-07 用户提出）：① 设置项"宽版聊天布局"：放宽聊天区与消息列的 max-w 约束（全局助手/书籍/论文三 scope 同改）；② 输入区顶边加拖拽手柄，鼠标悬停框线可向上拖放大输入区（方便大段文字输入，复用现有 Resizable 模式）。
12. **切页续接对话**（2026-08-07 用户提出，小修）：切换页面/tab 时助手对话默认新开聊天的行为改为**续接上一次对话**（全局助手与各阅读区同理），新对话改为显式动作。
13. **全局助手新对话页思考强度按钮缺失**（2026-08-08 用户发现，已核实）：`pages/chat/index.tsx` 的 EmptyState 自定义输入区只有上传+搜索引擎选择器，未挂 `ReasoningLevelSelector`；非空对话走的 ChatInputArea 有该按钮。修法：EmptyState 输入区补挂同款组件（一行级）。
14. **processPaper 补 reparse（重新解析）**（2026-08-08 用户提出，调研后确认地基已有）：手动重解析已落地（`paper-reparse-service.ts` + 文献库页批量入口，源 PDF 解析链：`metadata.zotero_pdf_path` → `{appData}/books/{id}/source.pdf` → 计失败，保留论文 id/归属/对话/标注）。缺的仅是 Agent 入口：processPaper 加 action=reparse 薄包装（可选 filePath 覆盖）+ 返回里提示译文转陈旧（续翻自然更新）与对齐需重建。
15. ~~**标签页休眠可见标识**~~（✅ 2026-08-08 完成）：横排 chrome-tabs `dimmed` → opacity 0.45，竖排 vertical-tab-bar opacity-40。

### 条件触发 / 暂缓

- **发行版 rebranding 清单**（封装发行版时执行）：identifier（影响 appDataDir，需首发前定或配迁移）、productName/title、updater endpoints + 自有 minisign pubkey、macOS signingIdentity、icons/署名。
- paper 设置下拉扩展更多书籍阅读器设置项（按需）。
- 论文导出 frontmatter 中文化（title_zh/abstract_zh 回写 YAML；js-yaml 重排会动用户字段顺序，暂缓）。
- foliate paginator 隐藏 tab 过早渲染 `el is null`（无害，持续观察，不修）。
- Zotero 实质重复识别后两层（PDF 首页 simhash / 向量近邻）+ 重复关系标记不物理删除、未分组虚拟集合（批量导入稳定后排产）。
- 动态术语表跨论文/文件夹沉淀复用（愿景项，单篇抽取已落地）。
- 存量 123 篇论文按修复后管线批量重转（等 converter 侧修复完成后的收尾动作）。
- 同步测试缺口：坚果云 503 限流观察、幽灵设备 devices.json 手动清理流程（下次同步专项时处理）。

### Converter 侧遗留（不在本仓，记档备查）

- staging LLM 元数据缓存（slug 防漂移，converter 侧实现）。
- stage1 VLM 退化循环：exe 未随源码重建，需重打包。
- `--zotero-key` 透传锚定 slug。
- Books_Converter 同款 `_MEIPASS` 隐患未修本体。

### 远期 / 不承诺（维持原判）

- **sageread-mcp（把 SageRead 能力对外暴露为 MCP server）——✅ 2026-08-08 用户拍板必做**，从远期升级为排产项（见 next-phase 计划 I2）：stdio 形态已敲定；除读取静态数据库外，还要能让外部 Agent 直接调用我们的工具（如向量化检索）；**API Key 绝不出 app 进程**——MCP 进程不碰密钥，执行类调用经本地 IPC 转发给运行中的 SageRead，app 用自己的 key 执行后只回结果。要点：① Skill 只是内部 SOP，跨客户端必须走 MCP 协议；② 只读操作可直读 SQLite，执行类动作需 app↔MCP 本地通道（localhost + 随机 token）；③ app 未运行时执行类工具需明确报错。
- P4：全局 Agent 批处理、定时/触发式 Agent、子 Agent 分工、对 docs/代码库建 RAG 的"最了解自己"助手。
- L2 同步 BETA 加固（503/429 指数退避、存量回填引导、高频压测）——待移动端立项时一并。
- format-strategy 远景：§3.5 PDF 原文对照面板（page 锚点已预留）、§3.4 标注回写 Zotero、译文 chunks 入向量库、多模型嵌入并存。
- living-library 开放问题：向量库/标注/译本的 L2 同步语义、MCP 权限模型（供 SageWrite/SageResearch 连接时再定）。
- 内嵌 rmcp（路线 B）、L3 端到端加密（已确认放弃）、移动端。
