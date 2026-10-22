# 前沿 Agent 图片处理调研 & SageRead 图片通道修复

> 2026-10-22 · 调研对象：本机 DeepSeek Harness（app.asar 内 @deepseek-ai/* 包）· 产出：fetch 层「工具图片桥」+ 合成图 L2 探针

## 1. DeepSeek Harness 怎么做图片

包：`@deepseek-ai/dsh-compaction-image-offload`、`dsh-llm-deepseek`、`dsh-tool-fs`（README.zh.md 可读）。

| 维度 | 做法 |
|---|---|
| 协议 | 走 Anthropic Messages 兼容端点（`https://api.deepseek.com/anthropic`）；工具结果可原生携带图片块 |
| 单图规范 | 按官方视觉 token 网格：14px patch、3:1 降采样、单图 ≤1024 vision tokens；正方形最大 1302×1302，16:9 用 1708×961；单边 ≤4096；字节 ≤2 MiB；不透明 JPEG 85/75/60 质量阶梯 |
| 张数 | **没有每轮张数上限**；`maxImagesPerRequest` 默认 600，超预算才处理 |
| 超预算 | provider/适配器返回 `IMAGE_OFFLOAD_REQUIRED` → 插件把**最旧**的输入图片永久替换为文本占位（含附件 id、尺寸、媒体类型、只读路径），然后重试；选择写入事件日志，后续请求/恢复/回放都保持 |
| 模型体验 | 占位文本注明「附件 + 可读路径」；新一次 read_image 可重新引入同一附件的新出现位置，旧位置不会恢复 |
| 成本 | 图片在每次请求都计费，直到被省略/压缩；重复读取会累积 |

结论：前沿做法不是「限制张数/拒绝读取」，而是 **每张图规范化 + 超预算时省略最旧的、给可重看路径**。

## 2. 我们发现的真问题：工具图片根本没到模型

- SageRead 的 DeepSeek 视觉走 `@ai-sdk/openai-compatible`（`factory.ts` 的 deepseek-vision 分支）。
- 该适配器对工具结果的 `content` 输出做的是 `JSON.stringify(output.value)` 塞进 `role: tool` 的文本 content（`@ai-sdk/openai-compatible/dist/index.js` 工具转换分支），而 OpenAI 兼容聊天接口**不支持工具结果里的图片**（AI SDK 文档：多模态工具结果仅 Anthropic/OpenAI/Gemini 3 支持）。
- 后果：readImage 返回的 dataUrl 以 base64 文本进入上下文：① 模型看不到图，回答只能靠图注/正文；② 单图可达数十万字符，随每步重复计费（实测 figure 任务最高 917k tokens、methods 卡 10 分钟）。
- 之前的「视觉」验收只验证了工具返回 envelope，没有验证模型真的看见图；figure 任务「通过」是文本/图注路径的误判。

## 3. 修复：OpenAI 兼容层的「工具图片桥」

`packages/app/src/ai/providers/tool-image-bridge.ts`，挂在 deepseek-vision 的 fetch 上：

1. 扫描请求体里的 `role: tool` 消息，递归查找工具输出里的图片（兼容 `{type:'content',value:[…]}` 与 `useTool` 包裹的嵌套结构）；
2. 把图片从 tool 文本里摘掉，改挂到紧随其后的 `role: user` 消息（`image_url`）——OpenAI 兼容接口允许 user 消息带图；
3. 保留最近 3 张，更早的替换成带绝对路径的占位文本（`[较早的图片已省略：…（调用 readImage 可重看）]`），替代拒绝式上限；
4. 图片总量、尺寸仍由 readImage 单图规范化（默认 1024、可升 2048）控制。

## 4. 验证：合成图 L2 探针

`scripts/cdp-verify-vision-probe.mjs`：用 Pillow 生成内容已知的图（`SAGEREAD-VISION-42` + 红色三角形 + 蓝色圆形），在聊天里要求模型 readImage 后回答。

| 路径 | 结果 | tokens |
|---|---|---|
| 直连 readImage（目录牌关闭） | **PASS**：字符串/三角形/圆形全对 | 28.8k |
| 目录牌 + useTool 转发 | **PASS**：全对 | 14.3k |
| 修复前同图 | 模型明确回答「只拿到信封，看不到像素」 | 28.8k（且此前 figure 任务 900k 级） |

## 5. 影响与下一步

- 之前基于 figure 任务的「视觉通过」结论作废，需按新通道重跑 figure 任务并重定金标（答案应来自图本身）。
- 图片预算从「每轮张数拒绝」改为「保留最近 N 张 + 占位路径」；与 Harness 的 offload 语义对齐，但我们的选择是**每次请求按最近 N 张即时计算**，不写事件日志（SageRead 历史由 DB 持久化，重建规则确定即可）。
- 下一步：① 把 L2 探针接入验收链路（L1 加桥接单测 + 合成图探针）；② 重跑 figure/多图对比任务；③ 观察 3+ 张图同轮的成本，必要时把 N 调成 2；④ 评估把单图长边压到 ~1302（provider vision token 网格上限，再大只是多传字节）。
