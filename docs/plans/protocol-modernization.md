# 协议现代化（Provider-native）方案与工作量评估

> 2026-10-22 · 用户拍板：v0.5.0 周期尽量一起做；本文件先冻结方案，再按工作包实施。
> 原则：所有面向用户文案先给用户过目；不 push、不发版。

## 1. 现状（已核实）

### 1.1 provider 通道（packages/app/src/ai/providers/factory.ts）

| provider | 现状 | 问题 |
|---|---|---|
| deepseek（文本） | @ai-sdk/deepseek 原生 | 无 |
| deepseek（视觉） | openai-compatible chat + fetch 层图片桥 | 工具结果图片靠 user 消息注入；固定留 3 张 |
| openai | @ai-sdk/openai：`provider(modelId)` 在 ai@7 返回 **Responses 模型**（d.ts 核实；`chat()` 才显式走 chat completions） | 协议本身已是新一代；问题在工具结果仍是旧自定义 content 结构，AI SDK 不会当原生多模态处理 |
| anthropic | **createOpenAICompatible 指向 api.anthropic.com/v1** | 假适配：Anthropic 没有 OpenAI chat completions 端点，属于历史遗留 |
| gemini/google | @ai-sdk/google 原生 | 无 |
| grok | @ai-sdk/openai（provider(modelId) 同样指向 Responses 模型） | xAI 是否支持 Responses 端点未验证；需固定为支持的通道，否则可能 404 |
| openrouter | @openrouter/ai-sdk-provider | 无原生多模态工具结果 |
| 自定义/custom-* | openai-compatible + 图片桥 | 工具图片只能走桥 |

### 1.2 AI SDK v7 能力（本机 ai@7.0.73 文档核实）

- 官方文档明确：**Multi-modal tool results are experimental and supported by Anthropic, OpenAI, and Google (Gemini 3 models)**。
- 工具通过可选 `toModelOutput` 把结果转成 content part；工具结果格式示例：
  `{ type: 'content', value: [{ type: 'file', mediaType: 'image/png', data: { type: 'data', data: base64 } }] }`
- OpenAI provider 实例同时提供 `chat()` 与 `responses()`；Responses 是支持工具结果图片的通道。
- 我们现有工具（readImage 等）返回的是旧格式 `{type:'file', mediaType, url: dataUrl}`（自定义 content），AI SDK 未把它当原生多模态工具结果，因此 openai-compatible 会 JSON 序列化成 base64 文本——这就是图片 bug 的根因。
- 结论：**协议现代化不需要重写，现有依赖已具备；主要是 provider 路由 + 工具结果格式 + capability 判定 + 验证。**
- 追加核实（2026-10-22 晚）：OpenAI 实际已经在用 Responses（不是 chat completions）；真正需要“升级”的是 **Anthropic 原生通道 + 所有原生 provider 的工具图片结果格式（toModelOutput）**，以及 grok/自定义代理的通道确认。

## 2. 目标架构

```
createModelInstance(providerId, modelId)
  → resolveProtocol(): "responses" | "anthropic" | "gemini" | "chat"
      · 官方 OpenAI baseURL / 兼容开关：responses
      · 官方 Anthropic：anthropic（原生 Messages）
      · Gemini/Google：gemini（已是原生）
      · DeepSeek 视觉 / OpenRouter / Grok / 自定义：chat（保留桥 fallback）
  → 返回 model 实例 + capability 标志（supportsNativeToolImages / protocol）
```

- 原生通道：图片工具用 `toModelOutput` 输出官方 file content；不再挂 user 消息桥。
- chat 通道：保留现桥，但升级为字节预算 + 最新工具批优先（见 task-9）。
- 新增设置/调试开关：`protocol: auto | native | compat`（auto 按 provider 能力选，native 强制原生，compat 强制旧桥）——便于灰度与回退，默认 auto。

## 3. 工作包（WP）与文件面

### WP1 provider capability 路由（约 0.5–1 天）
- 新文件 `ai/providers/protocol.ts`：provider/model/baseURL → protocol + capability；纯函数、可单测。
- `factory.ts`：openai 保持现有 Responses 模型（显式 `openai.responses(...)` 便于读代码）；**anthropic 改为 `createAnthropic`**；deepseek 视觉保持 chat 桥；chat-only provider 保持桥；grok 固定为官方支持的通道。
- 注意：自定义 baseURL（用户填的代理）默认 chat，避免误发 Responses 导致 404。
- 兼容：旧 provider 配置无需迁移（按 providerId + baseURL 判定）。

### WP2 工具结果格式（约 0.5 天）
- `readImage`（以及 image 类的 getFigures/viewImages 输出）改为官方 `toModelOutput` 格式；UI 侧仍用 sanitize/cache 剥掉 base64。\n- 关键：原生 provider（OpenAI Responses / Anthropic / Gemini 3）需要 `{type:'file', mediaType, data:{type:'data',data:base64}}`；现有 `{type:'file', mediaType, url:dataUrl}` 不满足，需要在 transport 侧按 capability 包一层 `toModelOutput`（不改 UI 输出）。
- 桥的 walkImages 兼容旧格式与新格式（data 形式）。
- 保持 chat 通道行为不变。

### WP3 transport 参数/推理/缓存（约 1–2 天）
- `streamText` 传参按 protocol 分流：OpenAI Responses 的 reasoning 参数、Anthropic 的 thinking budget、Gemini 的 thinkingConfig；现有 reasoning-map 的 fetch 补丁只对 chat 通道生效。
- prompt caching：Anthropic 显式 cache_control（可选，后续）；先保证静态 prompt 前缀稳定（现状已做）。
- 错误归一化：Responses/Anthropic 的错误体不同，需补映射。

### WP4 验证矩阵（约 1–2 天，依赖 key）
- 现有 `scripts/cdp-verify-vision-probe.mjs` 合成图探针：单图/双图/4 图；原生与 chat 通道各跑一遍。
- provider 冒烟：有 key 的 provider 跑真实请求；无 key 用 mock/contract 单测。
- 当前 dev 配置：DeepSeek（可用）、自定义网关、智谱、小米、Ollama；**OpenAI / Anthropic / Gemini 官方未配置 key**——原生通道的端到端验证需要用户提供其中一个（或先只在 DeepSeek 上验证 chat fallback + 单测）。

### WP5 遗留清理（v0.5.0 后，v0.6 执行）
- 删旧 rag 工具集、documentToolMode both/legacy、旧 prompt 分支、旧 alias。
- 删图片桥（当所有在用的视觉 provider 都走原生后）。
- 删 anthropic 假适配；保留自定义 baseURL 的 chat-compatible 通道。

## 4. 风险

1. **AI SDK 多模态工具结果仍是 experimental**：升级小版本可能改行为；需锁版本/回归。
2. **provider 差异**：Responses 与 chat 的 tool schema、reasoning 参数、流式事件不同；自定义代理可能只支持 chat。
3. **无官方 key**：OpenAI/Anthropic/Gemini 原生路径无法端到端验证；只能单测+mock，发版声明需保守。
4. **缓存行为变化**：anthropic 原生会改变缓存命中；成本可能短期波动。
5. **旧工具与桥的兼容**：删除前必须保留 fallback 开关（settings protocol=compat）。

## 5. 工作量结论

- 代码本身：中等偏小（核实 OpenAI 已是 Responses 后，约 **2–4 个聚焦工作日**；文件面 ~8–12 个，主要是 Anthropic 原生 + capability 包装 + toModelOutput 改造 + transport 参数）。
- 真正成本在**验证**：provider 矩阵、视觉探针、回归评测；若只验证 DeepSeek + 自定义网关，1–2 天可完成；要覆盖 OpenAI Responses / Anthropic 原生 / Gemini，需要对应 key 和 1–2 天额外回归。
- 不是重写、无数据迁移；AI SDK 已装好，主要改“路由与格式”。
- 建议：与 v0.5.0 一起做，但用 `protocol=auto` 默认 + `compat` 回退；验证不过就先默认 compat 发版，native 随 v0.5.x 打开。

## 6. MCP 工具面（关联决策）

- MCP 0.3.0 未发布，是收口最佳窗口：默认精简现代集（约 18 个），旧工具 `SAGEREAD_MCP_LEGACY_TOOLS=1` 暂留一版。
- 新增 `search_library` 统一检索；`get_document_info/read_document/get_citation_graph` 为主入口。
- 原因：MCP 客户端动态发现工具不会硬报错，但工具净增加会让外部 Agent 上下文变大、选择困难、重复能力互相抢；精简正交优于数量。

## 7. 实测（2026-10-22 晚，用 CherryIN 中转 key）

前提：用户没有 OpenAI/Anthropic/Gemini 官方 key，但允许使用密钥库中的 CHERRYIN_API_KEY；CherryIN 文档确认支持：
- https://open.cherryin.net/v1/chat/completions（OpenAI chat）
- https://open.cherryin.net/v1/responses（Responses，GPT-5.x）
- https://open.cherryin.net/v1/messages（Anthropic Messages；Claude Code 同款配置）

curl 实测三条通道均 200。

### 7.1 协议层原生多模态工具结果（独立 SDK 探针）
用 @ai-sdk/openai 的 responses() 与 @ai-sdk/anthropic 原生 Messages，各跑一次“工具返回合成图片”的 generateText：
- 合成图内容：SAGEREAD-NATIVE-42 + 蓝三角 + 红圆；
- OpenAI Responses：PASS，模型准确读出字符串与颜色形状；8.2s / 566 tokens；
- Anthropic Messages：PASS，同样读对；7.2s / 1,780 tokens；
- 关键：模型确实看到了像素，而不是只看到工具文本/图注。

结论：provider-native 工具图片在可用网关上已经实际打通；AI SDK + 原生协议路径成立。

### 7.2 应用侧实现
- ai/providers/protocol.ts：provider/model/baseURL → responses / anthropic / gemini / chat；CherryIN 网关按模型前缀路由（openai/* → responses，anthropic/* → anthropic，其余 chat）；未知自定义端点保守走 chat。
- ai/providers/native-tool-output.ts：给 readImage/viewImages（含目录牌 useTool）补 toModelOutput，把旧 file+url:dataUrl 转成官方 file+mediaType+data；从 toolCallId 缓存恢复目录牌图片。
- factory.ts：Anthropic 改原生 createAnthropic（修掉 openai-compatible 假适配）；OpenAI 显式 openai.responses()；grok 显式 .chat()；自定义端点按协议选 createOpenAI/createAnthropic/兼容通道；chat 通道补挂图片桥。
- custom-chat-transport.ts：按当前选中模型解析协议，原生协议给工具加 toModelOutput 包装，chat 通道保持图片桥。

### 7.3 尚未验证
- 官方 OpenAI / Anthropic / Gemini 三个 provider id 的原生端点（无 key）；
- ~~Gemini 3 原生多模态工具结果~~ **已补测（2026-10-22 晚）**：CherryIN 的 google/* 模型暴露 gemini 端点，/v1beta 原生协议可用；gemini-3.8-flash、gemini-4-argon 的图片工具结果探针均 PASS；
- 应用 UI 内的端到端模型切换：已能在打开书籍后切到 `openai/gpt-5.6-luna`，但 L2 视觉探针在 UI 内 240s 超时（协议层 curl/SDK 探针均正常，初步判断是 UI 测试脚本/模型切换状态问题，不是令牌或协议不可用）；
- Anthropic 原生下的 prompt cache / thinking 参数与 AI SDK 的兼容细节。

### 7.4 工作量修正
协议层代码（路由 + 工具输出 + factory + transport）已完成并 tsc 通过；剩余主要是 UI 端到端 + 官方 provider 回归，约 0.5–1.5 个聚焦日（不含发版）。

### 7.5 国产模型同样可测（2026-10-22 晚补测）
协议可用性与厂商无关：用 CherryIN 的 Anthropic Messages 原生端点直接调用国产模型，均 HTTP 200 且返回合法 Anthropic message：
- agent/deepseek-v4-flash：200（含 thinking + text）
- agent/glm-5.2：200（含 thinking）
- agent/kimi-k2.6：200

因此“只有海外御三家能测原生协议”是误解；真实能力取决于网关暴露的 endpoint 类型与模型本身是否支持视觉，不是厂商国籍。

### 7.6 最新模型原生多模态补测（2026-10-22 晚）
- openai/gpt-6-luna（Responses）：PASS，看到图；小字号字符串有一处字符误读（SAGEREAD → SAGFAD），形状/颜色全对；
- anthropic/claude-sonnet-5.5（Anthropic Messages）：PASS，字符串与形状/颜色全对；
- google/gemini-3.8-flash、google/gemini-4-argon（Gemini 原生）：PASS，字符串与形状/颜色全对。

注意：AI SDK 的 Google provider 对含 `/` 的 modelId 不会自动补 `models/` 前缀，CherryIN 需要 `models/google/...` 路径；factory 已对 gemini 协议做 `models/` 前缀归一。
## 8. 2026-10-22 晚补：DeepSeek/Kimi/Zhipu 的 Anthropic 兼容端点（推翻“国产只有 chat”的判断）

### 8.1 DeepSeek 官方支持 Anthropic Messages（含工具结果图片）
- 官方文档：https://api-docs.deepseek.com/guides/anthropic_api/
  - base_url = https://api.deepseek.com/anthropic
  - 兼容表明确：content type=image 支持 base64/url；tool_result 的 content **Fully Supported**；tools/input_schema/tool_choice 均支持。
- 实网探针（DEEPSEEK_API_KEY）：createAnthropic + baseURL /anthropic，工具返回合成图片，deepseek-chat 与 deepseek-flash 均 PASS，准确读出图片字符串/形状/颜色。
- 应用改动：DeepSeek 官方 baseURL（api.deepseek.com）路由到 anthropic-messages 原生协议；自定义 DeepSeek-compatible 代理仍走 chat + 图片桥。
- App UI E2E：deepseek-flash 视觉探针 PASS（7.2s，bridgeLog=[]，说明不再走图片桥），token 23.9k。

### 8.2 其他国产 provider 的 Anthropic 兼容端点（本轮 curl 实测）
| provider | Anthropic base | 文本探针 | 说明 |
|---|---|---|---|
| Kimi | https://api.moonshot.cn/anthropic | 200 | Messages API 官方支持图片输入/工具调用 |
| 智谱 GLM | https://open.bigmodel.cn/api/anthropic | 429（Coding Plan 到期） | 协议可达；续订后可测 |
| MiniMax | https://api.minimaxi.com/anthropic / api.minimax.io/anthropic | 404 模型不可用 / 401 区域 key | 协议端点存在，模型名与 key 区域需匹配 |

结论：**不能按厂商假设“只有 chat-completions”**；要做的是 provider/endpoint 能力矩阵（官方 host + 模型视觉能力 + tool_result 图片支持），而不是按厂商贴“旧协议”标签。

## 9. 原生图片预算：不要拍脑袋手搓，优先 provider 原生限制

研究结论（以官方文档为准，后续把精确数字补进能力表）：
- Anthropic Messages：官方对每请求图片张数/单图大小/边长有明确上限，超出会自动缩放或拒绝；不需要我们自己按 dataUrl 字符数淘汰。
- OpenAI：图片有 detail=low/high/auto；low 约 85 tokens；high 按 512px tile 计费（每 tile 170 tokens + 85 基础），auto 在任一边 >512 时用 high；图片会先缩放到 2048 上限、短边 768。
- Gemini：有 media_resolution（low/medium/high）控制视觉 token 与精细度；由 provider 端缩放/计费。

应做：
1. **native 通道**：按 provider 原生 detail/mediaResolution 控制成本，图片只做一次规范化；不再套 700k dataUrl 字节预算（当前 native 通道本来也没有），上下文预算交给 token 用量与既有压缩机制。
2. **chat 通道**：保留字节预算 + 最新批优先作为兼容兜底（chat 端点没有统一规范，且大请求易挂）；这是 fallback，不是主路径。
3. 补 provider 能力矩阵与图片探针（单图/4 图/6 图）覆盖 native 与 chat 各一条。