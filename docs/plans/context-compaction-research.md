# 上下文压缩调研与实现对照（2026-10-22 晚）

> 起因：旧实现硬编码点火线 256k / 泄压线 128k，对 128k 窗口模型会顶爆、对 1M 窗口模型压得太早。
> 目标：按所选模型真实 context window 自动 compact，参考现代 Harness 做法。
> 实现：`ai/providers/context-window.ts` + `ai/utils/message-selector.ts` / `token-estimator.ts` / `custom-chat-transport.ts`；
> 单测：`scripts/test-context-budget.mjs`（20 断言）。

## 1. DeepSeek Harness（本机 app.asar 只读解包实证）

压缩拆成 5 个 Cordis 插件：`@deepseek-ai/dsh-compaction`（契约）、`-basic`（默认后端）、`-tool-result-pruner`、`-image-offload`、`dsh-command-compact`。

- **触发**：`agent/pre-step` 用 `ctx.tokenMeter.measure()` 量最近一次请求，超线压缩；`agent/request-error` 捕获 `CONTEXT_WINDOW_EXCEEDED` 后先 prune、绕过阈值做一次最大平衡头缩减并重试（`maxOverflowRetries=1`）；另有 `/compact`。
- **公式**（`dsh-compaction-basic/lib/index.js:124-147`）：
  ```
  messageBudget = W - O
  pressureBudget = messageBudget - headroom(默认 65536)
  threshold = floor(min(W * 0.8, pressureBudget))
  retain = floor(messageBudget * 0.16)   // 或 retainTokens
  ```
  `O` = 请求 maxTokens ?? adapter 默认 maxTokens ?? 0。DeepSeek adapter W=1,000,000、maxTokens=256,000 → 实际 trigger=min(800k, 1M−256k−64k)=**680k（68%W）**：80% 只是上限，先给输出+余量让路。
- **容量来源**：`ctx.llm.resolveModelInfo().context.contextWindow`；缺失时每目标告警一次并**跳过主动压缩**，只留溢出恢复。
- **保留/摘要**：system/message 永不入压缩区；尾部按 token 累到 retain 再向前吸到 tool 配对平衡点；其余替换为一条 user 消息（固定 preamble + `<compacted-summary>…</compacted-summary>`），原始事件留 log 可回放。摘要 = 一次 `purpose:"compaction"` 调用：system/tools/被遮消息逐字节重放 + 指令作最后一条 user 消息（复用 KV 前缀缓存），只取 text；8 段结构化模板（目标/概念/文件/错误/待办/现状/下一步/关键上下文），旧摘要增量合并；maxTokens 默认 65536，重试 1 次，失败 fail-open。
- **计量**：优先 provider 真实 usage 做锚，再估增量；无锚才 chars/4 启发式（官方承认低估 CJK）。
- **配套**：触发后先做无模型工具结果 head/tail 裁剪（8192/4096/1024 chars）；旧图换文本占位。

## 2. Vercel AI SDK v7.0.148（本机包）

- 无内置摘要压缩、不暴露 contextWindow；可复用三块机制：
  1) `prepareStep` 返回 `{messages}` 在环裁剪（streamText 支持；`steps.at(-1).usage.totalTokens` 是现成 usage 锚）；
  2) `pruneMessages({messages,reasoning,toolCalls,emptyMessages})`：确定性裁剪、按 toolCallId 保配对，零模型成本第一刀；
  3) `convertToModelMessages(..., { ignoreIncompleteToolCalls: true })`：配对兜底（transport 已用）。
- HarnessAgent/harness 抽象把 native session compaction 交给 Claude Code/Codex/Pi 运行时；SageRead 直接调 provider 用不上。

## 3. Cherry Studio：~80% 属实，是"输入空间"的 80%

- `inLoopCompaction.ts`（prepareStep 钩子）：`inputRoom = max(W − O, floor(0.2W))`；`trigger = floor(inputRoom × thresholdPercent/100)`，默认 **80**（`contextSettings.ts`，min20/max100，assistant 可覆盖）；`keepBudget = floor(trigger × 0.375)`，`constants.ts` 注释"0.375 keeps the default 80% trigger at exactly the 0.3×window budget"。
- 双通道：turn-start 持久压缩 + prepareStep 在环压缩；system 逐字节不动、只按 turn 边界切（assistant+tool 为原子 turn，至少留 1 turn）；未知窗口 → 窗口预算全禁用并告警（绝不算 NaN）。
- 摘要请求自身也预算：input ≤ (compressorW − maxOut) × 0.85、≥2000；一次失败本请求禁用；foldCache 记已压前缀避免每步重摘。
- 窗口存模型 schema `contextWindow?`，UI 可编辑，随 provider 目录落库。

## 4. 主流 Harness 对照（按源码/可查证资料，标注可信度）

| Harness | 触发 | 保留 | 备注 |
|---|---|---|---|
| Claude Code | effectiveW=W−min(maxOut,20k)；auto ≈ effectiveW−13k（200k→≈83.5%）；warn −20k；blocking −3k | 三层：MicroCompact（清旧工具结果）/SessionMemory/Full Compact（9 段摘要） | 二手逆向资料，需标注来源 |
| OpenAI Codex CLI | `model_auto_compact_token_limit` 绝对线 + `model_post_turn_compact_threshold_percent`（可用窗口%）+ `async_compaction_threshold_percent` 默认 65 | 最近 user 消息 ≤20k tokens（仅文本、图丢弃）+ 末尾 CompactionSummary | 有 remote/native compaction；"90%×raw"在代码中查不到 |
| OpenCode | ceiling=W−max(0.15W,16k)；测量锚+增量 ≥ ceiling 触发 | keep 默认 15k tokens；overflow 按 0.7/0.5/0.35 递减重试 | 未知窗口不自动、仅 overflow 触发 |
| Roo Code | 窗口百分比滑杆（默认 100%、可下调） | 摘要 + 保留尾部 | 官方文档 |
| Cline | auto-condense（文档未给默认值） | 摘要 + 尾部 | 不写未证实的 0.75 |
| LangGraph/langmem | 无固定阈值 | `summarize_messages(token_counter, max_tokens_before_summary, max_summary_tokens)` + running_summary | 框架只给机制 |

## 5. SageRead 实现（已落地）

`ai/providers/context-window.ts`（纯函数，可单测）：

```
W = 模型列表 context_window（实测 DeepSeek /models: 1,048,576；max_output_tokens 393,216）
  > 内置家族表（deepseek 1M / gemini 1M / gpt-5+ 400k / claude 200k / kimi 262k / glm-5 200k / ...）
  > 未知模型默认 1M（2026-10-23 用户拍板：现代 Agent 模型基本 1M 标配，更小的说明不是为 Agent 设计；
    模型列表真实值/家族表仍优先；记录 source 便于日志观察）
O = min(模型 max_output_tokens ?? 0, W/2)
IR = max(W − O, floor(0.2W))
B  = clamp(0.1W, 8k, 64k)
触发线 = max(24k, min(floor(0.8W), IR − B))
保留线 = max(12k, min(floor(0.3·IR), floor(0.75·触发线)))
最近消息 floor=10，但 10 条本身超触发线时自动缩到 4/2 条（避免刚压完又点火）
```

- `token-estimator.ts`：长字符串按 4k 采样密度外推（不再 10k 截断低估）；图片 file part 固定 1500 token（不按 base64 长度爆算）；`dynamic-tool`（MCP）input/output 计入。
- `custom-chat-transport.ts`：用所选模型 + provider 模型元数据解析预算，传 `{budget: highWater, lowWater, floor}` 给 selector；压缩日志带 contextWindow/source/highWater/lowWater。
- **P0 回归教训**：曾把 `ContextBudget` 对象整个传给 selector（它读 `options.budget` number），导致按模型窗口的触发线实际没生效、恒回落 128k 默认；已修并补 20 断言单测（1M 窗口 200k 线程不压 vs 128k 窗口会压）。

## 6. 尚未实现（建议 0.5.x）

1. **固定开销 F 计入预算**：system prompt + tools schema + 目录牌（约 8–20k）目前未从触发线扣除；建议用"上一轮 usage.totalTokens − 上一轮发送历史估算"做锚，无则估 system+tools。
2. ~~**摘要位置改到切点 user 消息**~~ **已完成（2026-10-23）**：摘要不再进 systemPrompt，改为合并到"保留段第一条 user 消息"的前缀（等价切点、避免连续 user 角色问题）；纯函数 `ai/utils/conversation-summary-message.ts` + 9 断言单测。摘要变化只击穿切点之后的前缀缓存。
3. **prepareStep 在环压缩**：20 步工具循环中真正会爆的位置是 step 内增长；用 `steps.at(-1).usage.totalTokens` + 尾部估算法，超线时返回 `{messages: pruned}`。
4. **溢出恢复**：捕获 context-length 错误 → 强制压缩一次并重试（DSH maxOverflowRetries=1 / OpenCode 递减 shrink）。
5. **pruneMessages 廉价第一刀** + 工具结果 head/tail 裁剪（8192/4096/1024 chars）先于 LLM 摘要。
   **作用域（2026-10-23 用户确认）**：头尾裁剪只针对**跨轮历史**；同一轮里刚读到的工具结果必须完整保留，
   不允许"刚读完下一步就忘"。只有在一轮内真正濒临溢出（在环压缩）时才处理更早的步骤，且要保留最近 N 步完整 +
   给"可按路径/偏移重读"的提示。
6. **独立压缩模型**：目前复用 utilityModel；建议单独配置 + 摘要 input 上限 `(compressorW−maxOut)×0.85`、失败一次本请求禁用、记录 aux usage。
7. **foldCache**：长会话已压缩前缀缓存，避免每次摘要重复计费。
8. **tool-pair 显式断言**：当前按 user 边界切（可保证 turn 完整），convertToModelMessages 的 ignoreIncompleteToolCalls 只是兜底网。