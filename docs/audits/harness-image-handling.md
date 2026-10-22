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

## 6. 追加（2026-10-22 下午）：两张 2048 图的代价

- 能力探针 `probe-multi-figure` 要求连续看两张图：模型在 10:30:51 连续调用两次 readImage（maxEdge 2048），之后请求**卡了 6 分 44 秒**才继续，最终超过 runner 的 7 分钟完成超时。
- 结论：dataUrl 体积是请求延迟的主因，不是 vision token。两张 2048 JPEG（各 600k+ 字符）同轮发送会让单次请求体接近 1MB，DeepSeek 端点处理明显变慢。
- 修复：
  1. `maxEdge` 上限从 2048 降到 **1536**（默认仍 1024）；
  2. local-image 增加 **dataUrl 目标体积**（≈420k 字符）：超了先降 JPEG 质量（0.82→0.72→0.6），再降尺寸（最小 512），保证单图请求体可控；
  3. readImage 信封带上实际 payload 大小（`payload N KB`），模型/排查时能看到成本；
  4. runner 支持 `harness.completion_timeout_ms`（探针配置 15 分钟），避免长任务被固定 7 分钟误杀。

经验：视觉成本要卡的是**字节**（请求体/上传延迟）和**上下文重复计费**两个维度，不是张数。

## 7. 追加（2026-10-22 晚）：按字节预算保留 + viewImages 批量看图

### 7.1 问题：硬编码「最近 3 张」与批量看图缺失

- 图片桥原先只保留全请求最近 IMAGE_KEEP_LAST = 3 张：同一批 4 张图会砍掉第 1 张，模型无法一次综合 4 张；
- readImage 一次只能看 1 张：4 张图要跨 4 步，每步重发历史图片，既慢又容易只答最后一张。

### 7.2 修复

| 项 | 改动 |
|---|---|
| 选图规则 | `tool-image-bridge.ts`：从「最近 3 张」改为「按 dataUrl 字符预算 + 最新工具批优先」——从新到旧装预算，最新一轮先占；装不下的老图换成带路径占位（readImage/viewImages 提示）；任何情况至少保留 1 张 |
| 预算 | `ai/utils/tool-image-budget.ts`：默认 700k 字符（≈500KB base64），运行时可用 `globalThis.__SAGEREAD_IMAGE_BUDGET_CHARS__` 覆盖；下限 60k |
| 多图路径 | 按 `<path>` 信封与图片同序遍历配对（readImage 单图、viewImages 多图），占位能指回具体文件 |
| 新工具 | `ai/tools/view-images.ts` 的 `viewImages(paths|refs, maxEdge)`：1–6 张，一个 tool result 返回多个 file part；按张数摊分本轮预算（每张 40k~420k 字符目标）；注册为 shared（reader/paper/central 可用） |
| 目录牌 | `lazy-toolset.ts`：图片占位带序号（#1/#2…）；缓存按 `foundPaths[index]` 给每张图各自的路径 |
| 落库 | `tool-result-slimming.ts`：readImage/viewImages（含 useTool 转发）的结果在落库前把 dataUrl 换成文本占位，线程 JSON/L2/备份不再带 base64；内存消息保持原样 |

### 7.3 验证

- **L1 单测** `scripts/test-tool-image-bridge.mjs`（esbuild 打包后直跑，34 断言）：4 图同批全保留、预算裁剪时最新批优先/老图先省略、占位路径正确、至少 1 张、缓存恢复、落库 sanitize 幂等、非图片工具不受影响。
- **L2 四图探针** `scripts/cdp-verify-vision-4images.mjs`（Pillow 合成 4 张已知图：`ALPHA-731` 红三角 / `BRAVO-264` 绿圆 / `CHARLIE-915` 蓝方 / `DELTA-482` 橙五边形）：
  - direct（工具直挂）：1 次 `viewImages(paths=4)`，4/4 字符串与形状颜色全对，7.2s，34k tokens，plan `images=4 kept=4 chars=59424/700000`；
  - directory（new 模式强制目录牌）：`describeTool → useTool(viewImages)`，4/4 全对，8.4s，18k tokens，缓存 4 张图各自路径正确；
  - 两条路径线程 JSON 分别为 3.5k/5.1k 字符且不含 `data:image/`（修复前 direct 路径 62.9k、含 base64）。
- **回归**：单图探针 `cdp-verify-vision-probe.mjs`、双图探针 `cdp-verify-two-images.mjs` 均 PASS。

### 7.4 已知限制

- 预算按请求即时计算（不写事件日志）：同一批图超过 700k 时仍会只保留最新部分，占位可重看；
- viewImages 的「每张摊分预算」受 local-image 最小长边 512 限制：6 张高细节大图可能压缩不到目标，最终由图片桥按预算再裁；
- 目录牌模式下模型看到的是图片占位文本 + 独立 user 消息里的真图，占位序号与图号信封需按顺序对应（信封含路径）；
- direct 模式下图片字节在内存消息中保留（落库已 sanitize），进程重启后历史 turn 的图只能按路径重取。
