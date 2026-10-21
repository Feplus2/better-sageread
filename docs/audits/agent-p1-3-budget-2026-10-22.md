# P1-3 记录：工具面瘦身、读取预算、图片上限与一次卡死事故

> 2026-10-22 · 数据：.tmp-eval-runs/p13-verify2 · L1：26/26 · 对照：agent-p1-ab / agent-baseline-g1

## 1. 改动

| 改动 | 说明 |
|---|---|
| new 模式工具面 | reader/paper 隐藏 readLocalFile/writeFile/editFile/searchFiles/runCommand；paper scope 从 29 → **17 个工具、schema 9,812 字符 < 12k**，目录牌模式不再触发 |
| 单轮读取预算 | `read-budget.ts`：每轮 readDocument 累计 ≤32k 字符（超出只返回剩余并提示停止），readImage 每张折算 8k；transport 每次发送前 reset |
| 书籍单窗上限 | readDocument 书籍窗口从 12k 压到 8k |
| 图片硬上限 | maxEdge 默认与上限统一为 **1024**（1536/2048 实测会把单图 dataUrl 推到 40 万字符以上，按步重复计费直接拖死请求） |
| 图片预算 | readImage 走同一轮预算（每张 8k），预算不足直接拒绝而不是静默降级 |
| harness | provider store 异步水合等待（重启后首次 run 不再 model pin fail） |

## 2. L1（26/26）

新增：new 模式工具数 ≤18、schema<12k 且 `shouldUseDirectoryMode=false`、工作区命令工具已隐藏、单轮读取预算生效（连续 4 次 12k 请求后第 4 次被截断提示）；其余原检查保持通过。

## 3. 验证（new 模式，单次）

| 题目 | 上轮 new | 本轮 new |
|---|---|---|
| methods-dataset-scale | 141,896 / 12（另一次卡死 >8 分钟） | **63,900 / 5** |
| unindexed-book-meaning | 92,073 / 13（TOC 修复后 251,302 / 8） | **112,376 / 5** |
| refusal-quantum | 4,698 / 0 | 9,918 / 0 |

methods 明显改善（预算 + 8k 窗口 + 无目录牌）；未索引书步数收敛但 token 仍高，主因是 EPUB TOC 81 条目录 + 多窗读取，下一步可把目录注入压到 30–40 条一级/二级。

## 4. 事故记录：dev webview 卡死

- 现象：methods 任务在 readImage(1536px) 之后请求持续 >8 分钟；kill 掉 harness 后页面主线程仍被孤立的流占住，Runtime.evaluate 全部超时。
- 恢复：先 kill renderer（无效），最终 kill dev app + tauri/vite 进程树，重新 `pnpm --filter app tauri dev`（带 remote-debugging-port=9223），页面恢复；生产版实例未动。
- 结论：图片是最高危路径（dataUrl 随每步重发 + 大图 base64），已加硬上限 1024 与预算；harness 增加重启后 provider 水合等待。

## 5. 下一步

1. 目录注入瘦身（EPUB TOC 81 → 35 条内），未索引书 token 目标 ≤60k。
2. 正式 A/B：10 题 × 3 次 new vs legacy（现在终于可跑，单次 methods 11s / 跨文献 ~30s）。
3. 达标后默认 documentToolMode=new，跑 L1 + 10 题冒烟 + 发版前回归。
