# 协议现代化 Review 与纠偏（2026-10-22）

> 性质：**review only，本轮未改产品代码**。对象是上一轮 `docs/plans/protocol-modernization.md` + `docs/plans/handoff-2026-10-22.md` 的决策与"已落地"判断。
> 结论：**方向成立，但当前实现有 2 个 P0 逻辑缺陷 + 3 个厂商端点路径错误（已实网复现）**；不能按原 P0"逐 provider 验证"直接往下走，应先修 P0（约 0.5–1 天），再做验证与发版决策。

## 0. 一句话

用 AI SDK 7 的 `toModelOutput` + provider 原生协议，是当前唯一"官方支持"的多模态工具结果路径，**不是手搓，方向对**；但仓库现在"已落地"的判断偏乐观：Kimi/智谱/MiniMax 的预置 Anthropic 端点路径全错（AI SDK 自动追加 `/messages`，厂商文档要求 `/v1/messages`），`apiStyle` 只在 factory 一半生效，DeepSeek 换协议后丢了思考控制与轻量任务提速。

不需要回滚方案，也不需要引入新框架；修 P0 + 补回归测试，再继续 v0.5.0 是正确的路。

## 1. 我实际验证到的事实（不是转述旧文档）

| 探针 | 结果 | 含义 |
|---|---|---|
| `tsc -b`（app） | exit 0 | 上一轮"tsc 通过"属实（约 14s） |
| `node scripts/test-tool-image-bridge.mjs` | 34 passed, 0 failed | 图片桥 L1 无回归 |
| Kimi `/anthropic/messages` | **404** `url.not_found` | 当前 Kimi 预置实际会走这条 → App 内必挂 |
| Kimi `/anthropic/v1/messages` | 200 | 正确路径 |
| Kimi kimi-k2.6 原生 tool_result 图片 | **PASS**：准确读出 `SAGEREAD-77` + 蓝三角 + 红圆 | 能力存在，只是 URL 配错 |
| 智谱 `/api/anthropic/messages` | HTTP 200，响应体 `code:500, "404 NOT_FOUND"` | 更隐蔽：伪装成 200 的错误 |
| 智谱 `/api/anthropic/v1/messages` | 429（Coding Plan 到期） | 路径正确，能到鉴权/套餐层 |
| MiniMax `/anthropic/messages` | 404 | 当前预置必挂 |
| MiniMax `/anthropic/v1/messages` | 200 | 正确路径 |
| DeepSeek `/anthropic/messages` 与 `/anthropic/v1/messages` | 均 200 | DeepSeek 兼容两种；统一用 `/v1` 更稳 |
| DeepSeek `thinking:{type:"disabled"}` | 200，无 thinking block | **可修**轻量任务思考问题 |
| DeepSeek `thinking:{type:"enabled",budget_tokens}` / `adaptive` | 均 200 | 档位映射有素材 |
| DeepSeek `thinking:{type:"off"}` | 422（只接受 adaptive/enabled/disabled） | 不能下发裸 "off" |
| `ai@7.0.73` 文档 | "Multi-modal tool results are **experimental** and supported by Anthropic, OpenAI, and Google (Gemini 3 models)"；`{type:'file',mediaType,data:{type:'data',data}}` 是官方示例形状 | 风险已知且可控，但需锁版本 |
| npm latest `ai` | **7.0.148**（本机 7.0.73） | 同 major 内 75 个 patch；v8 会删旧 part 形状 |

探针脚本留在 `.tmp-review/`（未跟踪、不含密钥，可复跑）。

## 2. 逐条复核上一轮的决策

| # | 决策 | 判定 | 理由 | 处理 |
|---|---|---|---|---|
| 1 | 显式 `apiStyle` + 预置默认 | **方向对，实现漏一半** | `createProviderInstance` 传了 apiStyle，`createModelInstance`（factory.ts:356）没传，导致"设置里改 API 格式"对原生入口不生效；官方 OpenAI 显式选 chat 永远不生效 | P0 修 |
| 2 | 官方 DeepSeek 默认改走 Anthropic Messages | **收益真实，代价没算清** | 工具图片原生 PASS（真实 key + App E2E）；但 fetch 层的关思考/档位补丁不再挂载 → 轻量任务（标题/翻译）重新变慢，聊天档位失效；Anthropic 兼容层是 DeepSeek 的次要端点，不是主 API | 修 thinking + 保留 apiStyle 回退；不建议简单回滚 |
| 3 | Kimi/智谱/MiniMax 预置 Anthropic | **方向对，配置错** | 三家 baseURL 都缺 `/v1`（见 §1 实网）；文档里"文本 200"是 curl 打到 `/v1/messages`，不是 App 路径 | P0 修 baseURL |
| 4 | 保留 chat 图片桥 + 700k 字节预算 | **合理** | chat-completions 确实不支持工具结果图片（AI SDK 直接 JSON.stringify）；桥是唯一 fallback，L1 34 断言通过 | 保留 |
| 5 | native 图片预算交给 provider 原生限制 | **部分错** | `imageDetail`/`mediaResolution` 目前 0 处接线；且漏了"历史工具图每轮从内存缓存重发"的预算——native 通道可无限重放大图 | 补：只回灌最近 N 张 + 接线 provider 参数 |
| 6 | MCP 默认 18 工具 + legacy 开关 | **合理** | 正交、数量可控；legacy 留一版是标准迁移做法 | 保留；发布与 app 解耦 |
| 7 | 三档检索范围 | **未发现硬伤** | 范围同时约束检索与直读，按书/论文持久化，符合预期；与 MCP `search_library` 语义需对齐（非阻塞） | 保留 |
| 8 | 腾讯元宝搜索 | **未验证，不能宣传** | 只有 SecretId/Key，没有 WSA 服务 API KEY；无免费额度 | 挂起 |
| 9 | 发版顺序 | **有真实风险** | 官方 OpenAI/Anthropic/Gemini 无 key，native 路径没做 App 级验证；而预置默认就是 native | 需拍板（§6） |

## 3. P0 修复清单（发版前必须）

1. **apiStyle 贯通**：`createModelInstance` 第二次 `resolveProviderProtocol` 传入 `provider.apiStyle`（或让 `createProviderInstance` 返回 `{model, protocol}`）；补纯函数单测覆盖 explicit×6 组合。这是"compat 回退"能否成立的前提。
2. **Anthropic 兼容 baseURL 统一带 `/v1`**：改 `resolveAnthropicCompatibleBaseUrl` 与 `predefined-providers` 的 Kimi/智谱/MiniMax/DeepSeek 常量（AI SDK 的 baseURL 语义 = 厂商文档的 base_url + `/v1`）。custom 分支的 `normalizeAnthropicBaseUrl` 逻辑本身是对的，保留。
3. **原生通道 thinking**：把 `wrappedDefault` 传给 createAnthropic 分支，或让 utility/transport 下发 `{anthropic:{thinking:{type:"disabled"}}}`；DeepSeek/Kimi 已实网验证支持 disabled。DeepSeek 档位映射：off→disabled、其余→enabled+budget 或 adaptive（需按型号表定）。
4. **原生历史图重发上限**：`native-tool-output.ts` 当前对历史每个 toolCallId 都从 40 条 LRU 恢复图片并重发；native 通道没有 700k 预算，多图对话会持续膨胀。改为只回灌最近 N 张（建议 6）/最近 1–2 批，旧图换**诚实占位 + `readImage(path=...)` 提示**（当前占位文案"在线程里保留"在重启后是假话）。
5. **factory 清理**：`factory.ts:274` Gemini 的 `apiKey: apiKey || "https://generativelanguage.googleapis.com/v1beta"` 是明显 bug（空 key 会把 URL 当 key 发），且未 `normalizeGeminiBaseUrl`；删死代码 `normalizeDeepSeekAnthropicBaseUrl`；Anthropic 的 chat 假适配要么删除、要么在 official host 上直接 fail-fast（现在可达且必 404）。
6. **文档纠偏**：`protocol-modernization.md` §7.2/§7.6/§8.1/§9 与 handoff §3.2/§4 的若干"已验证/已处理"与代码不符（详见 §5）；"重启后按路径重读"目前没有任何实现。

## 4. 主流做法调研结论（"不优先手搓"核对）

- **AI SDK 7 的 toModelOutput 是官方唯一解**：API 本身 stable（v5 起改名去 experimental），但多模态工具结果整体仍标注 experimental；v8 会移除旧 `image-*`/`file-*` part 形状。→ 锁 `ai@7.0.73`（或先评估 7.0.148），在适配层（`native-tool-output.ts`）单点收口，并在探针断言 `result.warnings` 无 deprecated。
- **不存在更省的主流统一层**：AI SDK 新默认的 Vercel AI Gateway 只在"全部流量走一个网关"时成立，不覆盖 BYOK、自定义 baseURL、国产 Anthropic 兼容端点 → 逐协议路由是被事实逼出来的，不是过度设计。
- **但厂商级 heuristic 应降级**：`apiStyle` + 官方 host 推断应做主信号；CherryIN 的 model 前缀映射（protocol.ts:74-84）是唯一值得降级为 opt-in 的部分（硬编码第三方网关）。
- **图片预算不要手搓字节摊分**：native 通道应做"一次归一化 resize（长边 ≤1024/1536）+ 张数上限 + provider 原生参数"：
  - OpenAI Responses：附件级 `providerOptions.openai.imageDetail`（low/high/original/auto）在 SDK 里真实支持（provider-utils file part 有 providerOptions）；
  - Gemini：调用级 `providerOptions.google.mediaResolution`（low/medium/high/ultra_high）；
  - Anthropic：**没有 detail 旋钮**，只有硬上限（≤100 张/请求、≤5MB/张、单图 8000px、多图 2000px、tokens≈(w×h)/750）→ 靠 resize + `viewImages` ≤6 张即可；
  - 700k 字符预算只留 chat fallback。
- **成本数字不要写死**：Anthropic 的公式可算；OpenAI 85/170/2048/768 与 Gemini token 成本在本沙箱无法访问官方站点，未核实，不要进用户文案。

## 5. 上一轮文档中不成立 / 未验证的说法

- ❌ "自定义 baseURL 默认 chat"：预置 provider 的 apiStyle 显式优先，改 baseURL 到代理仍发原生端点（除非用户手动改 auto）。
- ❌ "§7.2/§8.1 自定义 DeepSeek 代理保持 chat+bridge"：同上，预置 apiStyle 覆盖。
- ❌ "§7.2 grok 显式 .chat()"：factory 忽略 apiStyle，只有 createModelInstance 的协议分支兜住；文字描述与代码不一致。
- ❌ "§7.6 factory 已处理自定义 Gemini 代理 models/ 前缀"：只对 auto + CherryIN 成立；显式 gemini 在任何非 CherryIN custom host 上都会因二次解析丢前缀而 404。
- ❌ "WP5 已删 Anthropic 假适配"：代码仍在且可达。
- ❌ "Kimi/智谱/MiniMax 文本 200"（§8.2）：是 curl 到 `/v1/messages`，App 路径是 404 / 伪 200 / 404。
- ⚠️ "原生图片预算交给 provider"（§9）：未接线；且漏了历史图重发预算。
- ⚠️ "重启后历史图按路径重读"（handoff §3.2）：没有实现，只是删了 base64。
- ⚠️ 官方 OpenAI/Anthropic/Gemini 原生端点：仍无 key、无 App E2E（CherryIN 是网关，不等于厂商）。

## 6. 修正后的下一步（建议顺序）

**P0（0.5–1 天，修复 + 测试）**：§3 的 1–5；每项配单测/探针（协议解析纯函数、URL 构造、apiStyle 一致性、native 重发上限）。

**P1（0.5–1 天，验证）**：
- App 内 E2E：DeepSeek 文本+图、Kimi 图（修后）、MiniMax 文本、CherryIN Responses/Anthropic/Gemini（有 key 的话）、目录牌 4/6 图。
- 锁版本 + warnings 断言；更新 `protocol-modernization.md` 的"已验证"清单为实际结果。

**P2（发版/收口）**：
- 官方三家：无 key 时只能单测 + 保守声明；`apiStyle` 回退（P0-1 修后）必须真实可用。
- CherryIN 前缀映射降级为文档化 opt-in；删死代码。
- MCP 0.3.0 publish 与 app v0.5.0 **解耦**，单独拍板；元宝等 WSA key。

**不建议**：换框架 / 上 AI Gateway（覆盖不了 BYOK 与国产兼容端点）；删 chat 桥；把 MCP 发布绑进 app 发版。

## 7. 需要拍板

- **A. 发版顺序**：
  - A1（推荐）先修 P0 + DeepSeek/Kimi 实网 E2E，再发 v0.5.0；
  - A2 回退 DeepSeek/国产到 chat（native 只留海外三家），先发版；
  - A3 推迟 v0.5.0，等官方 OpenAI/Anthropic/Gemini key 再验证。
- **B. 是否允许用密钥库的 DEEPSEEK/KIMI/MINIMAX key 做 App 级 E2E**（只用于探针，不改用户可见文案）。
- **C. native 历史图重发策略**：只回灌最近 N 张（推荐 6 / 最近 2 批），还是全量重发（token 成本高）。

## 8. 修复进展（2026-10-22 晚，代码已改、未发版）

原 §3 的 P0 已全部落地（本地未提交状态见 git status）：

| 项 | 状态 | 落点 |
|---|---|---|
| P0-1 apiStyle 贯通 | ✅ | factory.createModelInstance 第二次解析补传 apiStyle；单测覆盖 6 组显式/推断组合 |
| P0-2 原生 Anthropic thinking | ✅ | reasoning-map.anthropicThinkingBodyPatch（off→disabled；档位→budget_tokens；恒思考→最低档）+ factory fetch 包装；DeepSeek/Kimi 实网验证 |
| P0-3 Anthropic 兼容 /v1 | ✅ | resolveAnthropicCompatibleBaseUrl + 预置常量 + provider-store v7 迁移；Kimi/智谱/MiniMax 实网路径核对 |
| P0-4 native 历史图上限 | ✅ | native-tool-output 回灌预算：最近 2 批/6 张 + 当轮 live 6 张；占位文案改诚实；单测 12 组 |
| P0-5 Gemini bug / 死代码 | ✅ | apiKey/baseURL 修复；normalizeDeepSeekAnthropicBaseUrl 删除；Gemini 支持显式非原生协议 |

review 过程中新发现并修复的：
- **CORS/global fetch**：原生 provider 走 webview 的 globalThis.fetch 时，Kimi 直接 "Failed to fetch"（158ms 实测）；改为所有原生通道统一走 Tauri HTTP 客户端（fetchTauri）。
- **预置新增不迁移**：v4 之后新增的预置（MiniMax）旧用户 store 里永远不出现 → provider-store v8 合并缺失预置。
- **CherryStudio 式多端点**：预置 endpoints（协议→baseURL）+ 设置页端点下拉/请求路径预览/恢复默认 + 模型列表回退。
- **AI SDK 升级**：ai 7.0.73→7.0.148（provider 批次同升，去重）；单测/tsc 通过。

App 内实测（真实 key，2026-10-22 晚）：
- DeepSeek deepseek-flash：视觉探针 PASS（7.7s）+ 4 图 viewImages PASS（两个 profile，bridgeLog=[]）。
- Kimi kimi-k2.6：视觉探针 PASS（12.2s，bridgeLog=[]）。
- MiniMax MiniMax-M3.1-Flash：视觉探针 PASS（14.0s，bridgeLog=[]）。
- 智谱：套餐到期未测；官方 OpenAI/Anthropic/Gemini 仍无 key。

未完成：UI 文案需主人过目；官方三家实网验证；MCP 0.3.0 发布仍待拍板。
