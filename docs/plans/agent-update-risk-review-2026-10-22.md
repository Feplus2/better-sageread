# Agent 大更新 · 生产风险审计与修复（2026-10-22 晚）

> 背景：本轮 Agent 大更新改动面很大（工具面、检索范围、图片链路、provider 协议、MCP）。主人要求发版前做一次"查漏"，避免带病上生产。
> 方式：3 个 fresh-context 只读审计员（工具面/图片文件/安全；provider/迁移/发布；陈旧引用/文档一致性）+ 本轮真机/实网验证 + 逐项代码复核修复。
> 结论：**发现并修复了 2 个安全级 P0 和 1 个生产阻断 P0**；其余为 P1/P2，已修关键项，剩余项列在 §4，发版前需拍板。

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

## 4. 已知但本轮未修（发版不阻塞，建议 0.5.x 跟进）
- **书籍插图在 reader/central 新模式无合法读取路径**：getFigures 仅 paper 有；readDocument 返回的图片仍是 `images/xxx` 相对路径，readImage 拒收相对路径。建议 readDocument 输出时把图片链接重写为绝对路径（或给 reader 只读 getFigures）。
- **MCP 工具结果图片/base64 未统一剥除**：@ai-sdk/mcp 的 image part 可能整段进上下文/落库（省 token/DB 膨胀），建议在 mcp-manager 包装 execute 统一转信封+缓存。
- **上下文水位硬编码 256k/128k**，不读模型 context window；token 估算不计 file part/dataUrl 与 dynamic-tool 输出。长线程/MCP 大结果有超限风险。
- **provider P2**：apiStyle 协议下拉仍有不可行的组合（未 fail-fast）；粘贴与预设同址但不同协议的端点显示可能不同步；删除 provider 不删 keyring 密钥；模型刷新无超时；编辑 baseUrl/apiStyle 后已选模型实例不重建（需重选模型）；Cargo/package 版本 0.1.0 与 tauri 0.4.2 不一致（UI 取 tauri，用户不可见）。
- **发布/评估卫生**：evals baseline-10 的 golden_trace 仍引用不存在的 outline/read/view 工具名；MCP package-lock 版本/许可证与 package.json 不一致。

## 5. 代码/文档落点
- 安全：`ai/tools/image-shared.ts`、`ai/tools/central/extract-zip.ts`、`ai/utils/tool-guard.ts`
- 转换器：`services/converter-service.ts`
- 提示词：`constants/{prompt,paper-prompt,central-prompt}.ts`、`ai/prompts/library-guide.ts`
- 协议/思考：`ai/providers/{protocol,factory,reasoning-map}.ts`
- 图片/工具面：`ai/providers/native-tool-output.ts`、`ai/tools/{registry,lazy-toolset}.ts`、`ai/utils/tool-result-slimming.ts`
- 预置/迁移：`constants/predefined-providers.ts`、`store/provider-store.ts`（v9 智谱）
- 验证：`scripts/test-provider-protocol.mjs`、`scripts/test-tool-slimming.mjs`、`scripts/cdp-*.mjs`
