# P0 落地记录：本地图片、图注绝对路径、文献库约定、步数收口

> 2026-10-22 · 对照基线：docs/audits/agent-baseline-g1-2026-10-22.md（G1）· 数据：.tmp-eval-runs/p0-2/
> 结论：10 题冒烟全部通过；均值 token 40.5k → 30.4k（−25%），步数 5.1 → 3.4（−33%）。但 10 题里没有「必须看图才能答」的题，视觉闭环还需要一个专门的视觉事实题来验收。

## 1. 本次改了什么

| 项 | 文件 | 说明 |
|---|---|---|
| readImage 支持本地路径 | ai/tools/read-image.ts、ai/utils/local-image.ts | attachment:// 保持；新增 path（绝对路径）；魔数嗅探、20MB 上限、默认长边 1024（maxEdge 512-2048）、非视觉模型明确报错；仅允许文献库/工作区根内路径 |
| getFigures 返回绝对路径 | ai/tools/paper/paper-extras.ts | 新增 image_path（appData/books/<paperId>/<src>）；description 指向 readImage |
| 文献库导航约定 | ai/prompts/library-guide.ts、constants/prompt.ts | 三 scope 共用静态段：根/目录布局/探索顺序/图片策略/只读边界/跨文档规则 |
| 看图成本策略 | read-image.ts、library-guide.ts、paper-prompt.ts | 「先图注/正文，最后看图，看完立即作答」；默认 1024，看不清再升 1536-2048 |
| 步数收口 | ai/custom-chat-transport.ts | step 18 起 prepareStep 强制 toolChoice=none，并要求给出最终答案；stopWhen 仍 20 步 |

## 2. L1 工具级验收（scripts/cdp-verify-p0-read-image.mjs）

12/12 通过：paper scope 含 getFigures/readImage；4 张图；image_path 绝对路径；readImage 返回 content + image/jpeg file part + dataUrl + 信封；maxEdge=512 生效（62,263 < 227,391 chars）；相对路径被拒；非图片被拒；reader prompt 注入文献库约定（len 4264）。

## 3. 10 题冒烟（P0-2，1 次）

| 题目 | G1 token/步 | P0-2 token/步 | 通过 |
|---|---|---|---|
| book-locate-ch3 | 20,649 / 2.7 | 25,169 / 2 | 是 |
| paper-figure-3-rational | 39,579 / 6.0 | 32,199 / 4 | 是（未看图） |
| paper-figure-2-prussian | 26,014 / 4.7 | 30,819 / 6 | 是（未看图） |
| position-summary-ch2 | 17,477 / 2.3 | 18,321 / 2 | 是 |
| cross-doc-interface-design | 176,790 / 15.0 | 104,484 / 9 | 是（仍用 readLocalFile 读第二篇） |
| methods-dataset-scale | 45,084 / 9.0 | 30,929 / 4 | 是 |
| citation-ref-12 | 14,582 / 2.0 | 16,008 / 2 | 是 |
| unindexed-book-meaning | 32,727 / 4.0 | 25,407 / 3 | 是 |
| refusal-quantum | 17,181 / 2.7 | 4,391 / 0 | 是（靠注入的元信息/目录直接判断） |
| position-where-ch2 | 15,244 / 2.7 | 15,922 / 2 | 是 |

均值：token 30,365（G1 40,533）、步数 3.4（G1 5.10）、耗时 ~10s。describeTool 仍存在（library guide 不减少目录牌，属于 P1 工具面问题）。

## 4. 关键发现：图片成本与「模型会跳过看图」

- 第一次冒烟（P0-1，无成本策略、默认 2048）：图 3 任务 329,621 token、图 2 任务 917,058 token。原因：图片以 dataUrl 进入工具结果后，会随每一步重新发送；2048px JPEG dataUrl 约 46-64 万字符（≈11.5-16 万 token/步）。
- 加成本策略 + 默认 1024 后：图 3 32,199、图 2 30,819 token（降 90%+）。但这两题都能从图注/正文答对，模型理性地**跳过了 readImage**。
- 结论：现有 10 题不能验收视觉闭环。P0 的 L1 已证明 readImage 可用；Phase 2 要加 1-2 道「视觉事实只在图里」的题（例如图 2(f) 的寿命数值、图 3(B) 衍射峰位移），用图内标注做金标，强制模型看图。
- 同时 P1 需要图片预算（每轮 ≤N 张 + 历史图片 stub 化），否则多图任务仍可能爆炸。

## 5. 未验证 / 下一步

- 步数收口（prepareStep）代码已落地，但本轮 10 题最多 9 步，没有触发；需要一道压力题（或临时调低 STEP_LIMIT 的测试开关）验证。
- 跨文献题仍然靠 readLocalFile 读第二篇正文（没有 DocRef/read(doc) 原语）；答案正确但有路径 hack，P1 的 read_document 直接消掉。
- 下一轮：P1-1 read_document(anchor) + search_library 的统一入口先做最小闭环；同时给 `paperSearch` 加 scope 显式参数，消除「第二篇不在库内」的误判。
