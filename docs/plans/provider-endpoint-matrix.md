# 提供商端点矩阵与预置端点方案（2026-10-22）

> 调研 + 实网核对 + 已落地到 `predefined-providers.ts` 的记录。所有 baseURL 都是**传给 AI SDK 的语义**：
> SDK 会再追加 `/chat/completions`（openai-chat）、`/responses`（openai-responses）、
> `/messages`（anthropic-messages）、`/models/{id}:generateContent`（gemini）。
> 因此这里必须带 `/v1` 等版本段——这是上一轮 Kimi/智谱/MiniMax 端点 404 的根因（厂商文档的
> base_url 是 Anthropic 官方 SDK 语义，SDK 自己会再补 `/v1/messages`）。

## 1. AI SDK 7 的端点语义（本地包核实）

| 工厂 | 追加路径 | 默认 baseURL |
|---|---|---|
| `createOpenAI({baseURL})` 直接调用 / `.responses()` | `/responses` | https://api.openai.com/v1 |
| `createOpenAI({baseURL}).chat()` | `/chat/completions` | 同上 |
| `createAnthropic({baseURL})` | `/messages` | https://api.anthropic.com/v1（传裸域名会自动补 /v1） |
| `createGoogleGenerativeAI({baseURL})` | `/models/{id}:generateContent` | https://generativelanguage.googleapis.com/v1beta |
| `createOpenAICompatible({baseURL})` | `/chat/completions` | 无默认 |

## 2. 预置端点表（已落地）

| 提供商 | 默认协议 | 预填端点（协议 → baseURL） | 核对情况 |
|---|---|---|---|
| OpenAI | openai-responses | responses/chat: https://api.openai.com/v1 | 官方文档；本机网络超时，未能实网（无 key） |
| Anthropic | anthropic-messages | https://api.anthropic.com/v1 | 官方文档；WAF 403 无法验证（无 key） |
| Gemini | gemini | gemini: https://generativelanguage.googleapis.com/v1beta；chat: …/v1beta/openai | 官方文档；网络超时 |
| DeepSeek | anthropic-messages | anthropic: https://api.deepseek.com/anthropic/v1；chat: https://api.deepseek.com/v1 | **实网 401 可达**（chat/responses/anthropic）；App 内视觉探针 PASS |
| Kimi (Moonshot) | anthropic-messages | anthropic: https://api.moonshot.cn/anthropic/v1；chat/responses: https://api.moonshot.cn/v1 | **实网 401 可达**；App 内 tool_result 图片探针（curl 层）PASS |
| 智谱 GLM | anthropic-messages | anthropic: https://open.bigmodel.cn/api/anthropic/v1；chat: https://open.bigmodel.cn/api/paas/v4 | 实网 401；Coding Plan 到期，图片能力待续订 |
| MiniMax | anthropic-messages | anthropic: https://api.minimaxi.com/anthropic/v1；chat: https://api.minimaxi.com/v1 | 实网 401；**App 内 tool_result 图片探针 PASS（2026-10-22 晚）** |
| 小米 MiMo | openai-chat | chat: https://api.xiaomimimo.com/v1；anthropic: https://api.xiaomimimo.com/anthropic/v1 | 实网 401 |
| 阿里云百炼 Qwen | openai-chat | chat/responses: https://dashscope.aliyuncs.com/compatible-mode/v1；anthropic: https://dashscope.aliyuncs.com/api/v2/apps/claude-code-proxy/v1 | 实网 401 |
| 豆包（火山方舟） | openai-chat | chat/responses: https://ark.cn-beijing.volces.com/api/v3 | 实网 401 |
| Grok (xAI) | openai-chat | chat: https://api.x.ai/v1 | 官方文档；网络超时；Responses 支持未确认，故暂不预置 |
| OpenRouter | openai-chat | chat: https://openrouter.ai/api/v1 | 实网 401；factory 目前只走 OpenRouter 专用 adapter，多协议未接 |
| Ollama | openai-chat | http://127.0.0.1:11434/v1 | 本地实机可用 |
| LM Studio | openai-chat | http://127.0.0.1:1234/v1 | 本机未启动 |

## 3. 其他主流提供商（调研结果，暂未做成预置）

| 提供商 | 协议 | AI SDK baseURL | 备注 |
|---|---|---|---|
| SiliconFlow | chat | https://api.siliconflow.cn/v1（国际 .com） | 实网 401 |
| Together | chat | https://api.together.xyz/v1 | WAF 403 |
| Fireworks | chat | https://api.fireworks.ai/inference/v1 | 路径存在（404 model） |
| Mistral | chat | https://api.mistral.ai/v1 | 网络超时 |
| Cohere | chat 兼容 | https://api.cohere.ai/compatibility/v1 | WAF 403；原生协议 AI SDK 未装 |
| Perplexity | chat | https://api.perplexity.ai（无 /v1） | 网络超时 |
| Cerebras | chat | https://api.cerebras.ai/v1 | WAF 403 |
| GroqCloud | chat | https://api.groq.com/openai/v1 | WAF 403 |
| DeepInfra | chat | https://api.deepinfra.com/v1/openai | 实网 401 |
| Novita | chat | https://api.novita.ai/v3/openai | 实网 401 |
| Hyperbolic | chat | https://api.hyperbolic.xyz/v1 | 40401 已下线（文档疑似过期） |
| 百川 | chat | https://api.baichuan-ai.com/v1 | 实网 401 |
| 腾讯混元 | chat | https://api.hunyuan.cloud.tencent.com/v1 | 实网 401 |
| 腾讯 TokenHub | chat | https://tokenhub.tencentmaas.com/v1 | 实网 401 |
| 01.AI | chat | https://api.01.ai/v1（未确认） | 网络超时，服务状态存疑 |

注意：OpenAI/Gemini/xAI/Mistral/Perplexity 等在本机出口超时；Anthropic/Together/Cohere/Cerebras/Groq 被 WAF 403。
这些状态是"文档核实、实网不可达"，不能写进用户可见的"已验证"文案。

## 4. 原生工具结果图片（多模态）能力矩阵

| 通道 | 工具结果图片 | 依据 |
|---|---|---|
| OpenAI Responses | ✅ | SDK 转成 `function_call_output.output[].input_image` |
| Anthropic Messages | ✅ | SDK 转成 `tool_result.content[].image` |
| Gemini 原生 | ✅ 仅 Gemini 3+ | SDK 转成 `functionResponse.parts[].inlineData` |
| openai-chat / openai-compatible | ❌（JSON.stringify 成 base64 文本） | 这就是图片桥存在的原因 |

国产 Anthropic 兼容端点（2026-10-22 晚 App 内实测）：
- DeepSeek：官方兼容表明确 `tool_result` 支持图片；App 视觉探针 PASS（bridgeLog=[]）。
- Kimi：App 视觉探针 PASS（12.2s，bridgeLog=[]），tool_result 图片可用。
- MiniMax：App 视觉探针 PASS（14.0s，bridgeLog=[]），能力矩阵新增一行；文档未明确但实测可用。
- 智谱：Coding Plan 到期，未测。

## 5. 与 CherryStudio 的对照

CherryStudio v2 的做法：一个 provider 持有 `endpointConfigs: Record<EndpointType, {baseUrl, adapter}>` +
`defaultChatEndpoint`；UI 预填主端点、显示请求路径预览；其它协议收在「更多端点」；用户正常只填 Key。

SageRead 的落地（更轻量，够用）：
- 类型：`ModelProvider.endpoints?: Partial<Record<ChatProtocol, string>>`（协议 → baseURL）。
- 当前选中值仍是 `apiStyle` + `baseUrl`（factory/transport 完全不用改）。
- 设置页：预置端点下拉（含"自定义"）+ 请求路径预览 + "恢复预置端点"；命中预置端点时不显示协议下拉。
- 模型列表刷新：Anthropic 主导的预置会回退到 OpenAI Chat 根地址取 `/models`。
- 未抄 Cherry 的 15 类端点、dialect、serviceTier、OAuth 等重机制。

## 6. 待办 / 风险

- Grok Responses、OpenRouter 多协议、Gemini OpenAI 兼容端点：代码路径已具备（factory 按协议分派），但未实网验证。
- 国产 Anthropic 兼容端点的工具图片：DeepSeek/Kimi 有证据，智谱/MiniMax 待补。
- 官方 OpenAI/Anthropic/Gemini 无 key：发版前只能保守声明。
- 所有新用户可见文案（端点选择器说明、路径预览）需主人过目后定稿。
