# Agent 大更新 · 生产风险审计与修复（2026-10-22 晚）

> 背景：本轮 Agent 大更新改动面很大（工具面、检索范围、图片链路、provider 协议、MCP）。主人要求发版前做一次"查漏"，避免带病上生产。
> 方式：3 个 fresh-context 只读审计员（工具面/图片文件/安全；provider/迁移/发布；陈旧引用/文档一致性）+ 本轮真机/实网验证 + 逐项代码复核修复。
> 结论：**发现并修复了 2 个安全级 P0 和 1 个生产阻断 P0**；其余为 P1/P2，已修关键项，剩余项列在 §4，发版前需拍板。
> 历史口径：§1–§5 保留当次审计与修复记录，不重写当时数值；其中已被后续实现取代的描述以 §6 为准。

## 1. 已修复（本轮）

### 1.1 安全 P0
| 问题 | 修复 |
|---|---|
| **readImage/viewImages 路径穿越**：只做斜杠归一，`<appData>/../../x.png` 可绕过根前缀判断，任意本地图片无确认读取（配合 assetProtocol scope 全开） | `image-shared.ts` 改为词法归一化（消 ./..、盘符不可被 .. 吃掉、残留 .. 直接拒绝）；界外仍拒绝 |
| **extractZip zip-slip**：`destDir + entry.filename` 直接拼接，`../` 可写出目标目录（可覆盖 DB/配置），且无守卫 | 新增 `safeEntryPath`（拒绝绝对路径/盘符/任何 .. 段）+ 单文件 100MB/总量 200MB 上限；extractZip/downloadFile 纳入 tool-guard 界外写入确认 |

### 1.2 生产阻断 P0
| 问题 | 修复 |
|---|---|
| **PDF 转换/翻译对新老用户全坏**：converter 把 provider.baseUrl 直接传给只认 OpenAI 协议的 sidecar；DeepSeek 默认地址已改 `/anthropic/v1` → sidecar 请求 `/anthropic/v1/chat/completions` 404 | `converter-service.resolveLlmParams` 优先取 `provider.endpoints["openai-chat"]`（预置表/预设回退），无兼容端点时明确报错；App 内实测 DeepSeek 解析为 `https://api.deepseek.com/v1` |
| **智谱默认端点选错**：普通 API key 的 Anthropic 兼容端点 429（Coding Plan 限制）；App 之前默认走它 | 智谱预置默认改 OpenAI 兼容（`/api/paas/v4`）+ provider-store v9 迁移；Anthropic 端点保留备选。App 内文本探针 7.0s PASS |

### 1.3 工具面 / 提示词 / 稳定性 P1（已修）
- **central 提示词仍教模型用 new 模式已隐藏的 paperSearch** → 改为按文档工具模式注入策略段。
- **reader 提示词教模型用 getFigures（reader 无此工具）且宣称文件工具可用** → 改为书籍无图片清单工具/图片路径来自检索与原文；文件工具段按模式区分。
- **shared library-guide 对所有 scope 都要求 getFigures** → 论文/书籍/全局分别表述。
- **legacy paper 提示词混入新原语** → 移出。
- **tool-result-slimming L1 白名单漏掉新原语**（readDocument/getDocumentInfo/searchLibrary/getCitationGraph/getFigures/getCitations）→ 补上；新增 5 条单测。
- **默认 new 模式附件读不到**：readLocalFile 被隐藏但共享策略要求用它读附件 → new 模式仅保留 readLocalFile（只读），写/命令类仍隐藏，提示词同步。
- **视觉能力门控**：原生工具图与 chat 图片桥此前只看协议，不看模型视觉能力 → 纯文本模型不再挂桥/不再原生重发；切模型时清空工具图片缓存。
- **useTool 对裸 JSON Schema（部分 MCP 工具）调 asSchema 会抛错** → 跳过本地校验直接转发，目录牌模式下 MCP 工具可执行。
- **tool-guard 缺口**：extractZip/downloadFile 未守卫；httpRequest GET + `{{secret:...}}` 可静默外发密钥；trashManager purge/empty/restore、manageSync restore、manageBook delete 无确认卡 → 全部补上（密钥引用无论方法都确认；破坏性动作恒确认）。
- **Gemini 的 /v1beta/openai 被 normalizeOpenAIBaseUrl 再拼 /v1** → 已带版本段不再追加。
- **DeepSeek 原生思考档位**：Anthropic 兼容端点忽略 `thinking.budget_tokens`，只认 `output_config.effort` → 改下发 effort；并给 budget 型 provider 自动抬高 max_tokens 防严格端点 400。
- **删除提供商时 utilityModel 悬挂** → 同步清空。
- 回归脚本陈旧：断言旧工具面的 4 个 CDP 脚本显式切 legacy；`scope:"collection"` 改回 `library`。

### 1.4 文档/一致性
- handoff §3.1 端点补 /v1、智谱默认协议纠正；端点矩阵补 CherryIN/智谱实测。
- protocol-modernization §10 记录纠偏与实测；wiki/04-agent.md 工具面/模式/提供商清单更新；agent-tool-recipe、anchor-protocol 数字、evals runner 日志口径修正。
- Release Notes 草稿：MCP 0.3.0 工具数改为 18（legacy 25）、迁移说明从"不需要迁移"改为"自动配置迁移"。

## 2. 验证证据（本轮）
- 单测：test-provider-protocol **39** 断言、tool-image-bridge **34**、tool-slimming **50**、lazy-toolset **16** 全过；`tsc -b` 通过。
- App 内真机（真实 key）：
  - DeepSeek deepseek-flash 视觉探针 PASS（7.8s，bridgeLog=[]）；4 图 viewImages 双 profile PASS。
  - Kimi kimi-k2.6 视觉探针 PASS（12.2s，bridgeLog=[]）。
  - MiniMax M3.1-Flash 视觉探针 PASS（14.0s，bridgeLog=[]）。
  - CherryIN 网关：anthropic/claude-sonnet-4.6（Messages 原生）PASS 13.6s；google/gemini-3.5-flash（Gemini 原生）PASS 13.6s；均 bridgeLog=[]。
  - 智谱 glm-5.3-flash：OpenAI 兼容端点文本探针 PASS 7.0s；Anthropic 兼容端点 429（Coding Plan 限制）。
  - 转换器端点解析：DeepSeek → `https://api.deepseek.com/v1`（修复后）。
- 提示词组装审计：reader 无 getFigures 残留、新图片/文件工具文案正确；central 无 paperSearch 残留；paper new 模式正常。

## 3. 发版前仍需拍板/处理
1. **官方 OpenAI/Anthropic/Gemini 无 key**：原生端点无 App 级证据；发版文案需保守，或补 key 验证。
2. **版本/发布元数据**：tauri.conf 仍是 0.4.2（已对应已发布 tag），RELEASE_NOTES 首节 0.4.2；发版需写 v0.5.0 notes 并走 tag 流程（否则更新弹窗仍显示 0.4.2）。
3. **MCP 0.3.0**：npm 仍是 0.2.0（21 工具）；发布前 site 的"21 个工具"、README/安装文档要同步，并说明 7 个 legacy 工具需 `SAGEREAD_MCP_LEGACY_TOOLS=1`。
4. **智谱 Coding Plan 用户**：如要用 Anthropic 端点做工具图片，需在设置里手动切端点（默认已改 OpenAI 兼容）。
5. **UI 文案**（接口端点选择器/请求路径预览）仍需主人过目。

## 4. 剩余项清除情况（2026-10-23 更新）

已修（全部）：
- **MCP 工具图片**：按用户 2026-10-23 拍板的新口径——图片落盘到 `{appData}/image-cache/mcp/<uuid>.<ext>`，**当前轮模型可见**（原生 toModelOutput / chat 桥），**跨轮与重启只留带路径占位**（`readImage(path=...)` 可重看），历史不再把 MCP 图灌回模型；内置 readImage/viewImages 的跨轮预算回灌行为不变。48 断言单测。已知限制：image-cache 暂无清理/LRU；落盘失败时当前轮也只看占位（按口径降级）。
- **书籍/论文插图读取**：readDocument 输出把可解析的 markdown/HTML 图片相对路径重写为绝对路径（幂等、不改 schema）；26 断言单测。
- **上下文水位**：按所选模型真实窗口自动 compact（DSH/Cherry 公式；含 P0 回归修复与 20 断言单测）；模型元数据 context_window/max_output_tokens 优先。**2026-10-23 用户拍板：未知模型默认从 128k 提高到 1M**（现代 Agent 模型基本 1M 标配；更小的说明不是为 Agent 设计），家族表/接口元数据仍优先。
- **摘要挪位（前缀缓存优化）**：摘要从 systemPrompt 挪到"保留段第一条 user 消息"前缀（切点），system 与最近对话保持逐字节稳定；纯函数 + 9 断言单测。
- **阅读/论文助手文件能力（用户拍板 B 方案）**：new 模式恢复 readLocalFile/writeFile/editFile/searchFiles/runCommand 五件套，不再要求绕全局助手；写/命令仍走 tool-guard 确认卡。实测 reader 工具 17→21（schema 10.4k→12.4k chars）、paper 20→24（12.2k→14.2k）；因 transport 对 reader/paper new 模式本就强制目录牌，schema 上涨不进入真实请求体。23 断言源码契约测试 + CDP 45 checks PASS。
- **provider P2**：协议下拉按预置端点过滤；auto 端点显示修正；删 provider 清 keyring；模型刷新 15s 超时；设置改端点后实例重建；版本号对齐 0.4.2。
- **评估卫生**：baseline-10 golden_trace 工具名规范化（注明人工参考、非自动回放）。

仍未做（不阻塞发版，建议 0.5.x）：
- **上下文**（详见 docs/plans/context-compaction-research.md §6）：固定开销 F 计入预算；prepareStep 在环压缩；溢出错误强制压缩重试；pruneMessages + 工具结果 head/tail 廉价裁剪（**作用域已确认：只对跨轮历史；同轮新工具结果必须完整保留，不允许刚读完下一步就忘；仅濒临溢出时处理更早步骤并保留最近 N 步 + 重读提示**）；独立压缩模型；foldCache。
- **MCP 图片缓存清理**：image-cache/mcp 目录暂无容量/时间清理。
- **文件工具副作用面**：阅读/论文助手可写文件/执行命令后，文献库内容提示注入的触达面变大；tool-guard 确认卡与审计日志仍是兜底，发版前建议再跑一轮"诱导写入"红队测试。
- 手册/wiki 更新时间点：**发版前必做**（用户固定动作）。

## 5. 代码/文档落点
- 安全：`ai/tools/image-shared.ts`、`ai/tools/central/extract-zip.ts`、`ai/utils/tool-guard.ts`
- 转换器：`services/converter-service.ts`
- 提示词：`constants/{prompt,paper-prompt,central-prompt}.ts`、`ai/prompts/library-guide.ts`
- 协议/思考：`ai/providers/{protocol,factory,reasoning-map}.ts`
- 图片/工具面：`ai/providers/native-tool-output.ts`、`ai/tools/{registry,lazy-toolset}.ts`、`ai/utils/tool-result-slimming.ts`
- 预置/迁移：`constants/predefined-providers.ts`、`store/provider-store.ts`（v9 智谱）
- 验证：`scripts/test-provider-protocol.mjs`、`scripts/test-tool-slimming.mjs`、`scripts/cdp-*.mjs`

## 6. 后续已变更（2026-10-23 当前契约）

以下是对上述历史审计的后续说明，不改变当时发现、修复或实测数值：

- §1.1 的 readImage 词法归一化已被更强的 Rust canonical 方案取代：`agent_read_image` 在同一调用内判界、拒绝敏感路径、检查目录/20MiB、复核逐路径授权并读字节。strict 界外读先确认，relaxed/full 免确认但仍需 canonical 授权；junction retarget 和原始 path 替换会失效。未扩大 assetProtocol scope。
- §1.3 所述“New 仅保留 readLocalFile、写/命令隐藏”已被后续用户拍板取代：New/Legacy 都保留共享文件五件套、`exportNotes/askAppHelp` 等共享能力；写与命令仍按安全模式确认。文档模式现仅 New/Legacy，旧 Both/非法值归一为 New，Legacy 可回退。
- 检索范围现为 reader 缺省 `current`、paper 缺省 `library`、central 恒 `all`；仅缺失 key 使用默认值。central 在两种模式均有论文 `getFigures/getCitations`，必须显式 `doc=paper:<id>`，书籍无独立 extras。
- 未索引文档除目录/原文直读外，还可用 `searchLibrary` 关键词/标题通道；命中通过 `hit.read → readDocument` 扩窗。library/all 正文扫描有界并报告 `partial/truncated`；带 `next_cursor` 时可用相同 query/参数续扫后续文档且跨页去重，current/doc 不使用 cursor，不再宣称未索引只能盲读或只能覆盖首批文档。
- 请求历史不再使用 `stripUnknownToolParts` 删除旧证据：仅在请求副本中适配 direct/directory 并 sanitize 旧 raw MCP 图片，保留未知/已下线工具的 output 与元数据；当前轮 MCP 图片和 UI/DB 历史行为不变。
- provider 持久化已升级到 v10：修复智谱 absent/empty baseUrl 与错位协议/端点组合，同时保留显式 Coding Plan、自定义代理、模型选择。上下文水位按模型窗口计算，未知模型默认 1M，显式小窗口的高低水位不超窗。
- 官方 OpenAI/Anthropic/Gemini 仍因无官方 key 而未验证；上文其他 provider 的实网记录只代表当时列出的模型与场景，不能扩展为“全部 provider/全部场景”结论。发布前仍需完成本轮全量回归、Release Notes 过目、版本号统一与发布流程；本轮不 bump 版本、不 publish。