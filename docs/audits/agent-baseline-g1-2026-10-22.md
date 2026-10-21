# Agent 旧工具集基线（G1）

> 2026-10-22 · 环境：dev 实例（CDP 9223，vite 1420）· 模型：deepseek-flash（temperature 0）· 10 题 × 3 次 = 30 次
> 数据：.tmp-eval-runs/baseline-1/（results.json + 30 份 transcript）· 任务：evals/tasks/baseline-10.yaml · 协议：docs/design/anchor-protocol.md
> 目的：给 Agent 大更新留一份「改之前」的对照。没有基线，就没有资格说「更优雅了」。

## 1. 一句话结论

旧工具集**能答对大部分题**（内容通过 29/30），但代价是：**跨文献题 1/3 直接失败（撞 20 步上限、答案为空）、另 2/3 靠外部学术搜索兜底**；同时 **26.8% 的工具调用是目录牌模式开销**（describeTool），单次平均 4.05 万 token、10.4 秒。问题不在「知识」，在**工具面形状**。

## 2. 总指标（30 次）

| 指标 | 均值 | 中位 | 说明 |
|---|---|---|---|
| 内容通过率 | 96.7%（29/30） | — | 人工核对金标；唯一失败是跨文献 rep1 空答案 |
| 「干净通过」率 | 90%（27/30） | — | 答案正确且只用库内工具；跨文献 0/3 干净 |
| 总 token / 次 | 40,533 | 25,041 | 合计 1,215,981 |
| 工具调用 / 次 | 5.10 | — | 其中 describeTool 1.37（26.8%） |
| 真实操作 / 次 | 3.73 | — | 153 个工具调用里 41 个是目录牌 |
| 端到端耗时 / 次 | 10.4 s | — | 模型时间合计 5.2 分钟；最长 36 s（跨文献） |
| harness 级失败 | 0/30 | — | 打开文档/发消息/落库/提取全通 |

## 3. 分题结果

| 题目 | 内容通过 | 干净通过 | 平均步数 | 平均真实调用 | 平均 token | 平均耗时 |
|---|---|---|---|---|---|---|
| book-locate-ch3（定位） | 3/3 | 3/3 | 2.7 | 1.0 | 20,649 | 5.9 s |
| paper-figure-3-rational（图 3） | 3/3 | 3/3 | 6.0 | 5.0 | 39,579 | 10.1 s |
| paper-figure-2-prussian（图 2） | 3/3 | 3/3 | 4.7 | 3.7 | 26,014 | 8.8 s |
| position-summary-ch2（位置总结） | 3/3 | 3/3 | 2.3 | 1.0 | 17,477 | 6.3 s |
| cross-doc-interface-design（跨文献） | 2/3 | **0/3** | 15.0 | 12.0 | **176,790** | 32.4 s |
| methods-dataset-scale（方法） | 3/3 | 3/3 | 9.0 | 7.7 | 45,084 | 14.6 s |
| citation-ref-12（引用） | 3/3 | 3/3 | 2.0 | 1.0 | 14,582 | 4.1 s |
| unindexed-book-meaning（未索引书） | 3/3 | 3/3 | 4.0 | 2.0 | 32,727 | 10.5 s |
| refusal-quantum（拒答） | 3/3 | 3/3 | 2.7 | 2.7 | 17,181 | 6.4 s |
| position-where-ch2（位置） | 3/3 | 3/3 | 2.7 | 1.3 | 15,244 | 4.8 s |

> 图 2/图 3 的「通过」只能证明图注/正文读对了：旧工具集**没有一次真正读到图片字节**（readImage 只接受 attachment://）。

## 4. 失败模式（从轨迹里读出来的）

### F1. 跨文献：没有「读另一篇库内文档」的通用入口 → 撞步数上限

rep1（23 步 / 262,274 token / 空答案）：模型先用 paperSearch（只命中当前篇）→ getBooks 找到第二篇 → 但没有任何工具能按 docId 打开它 → 转去 searchFiles（参数错）→ 开始 runCommand 摸文件系统（dir / python / 写脚本 dump DB）→ 第 20 步被 stopWhen(isStepCount(20)) 截断，**没有最终答案**。

轨迹里的命令：dir /s /b ...、python dump_paper.py、readLocalFile(第二篇 paper.md) …… 这是在用「编码 Agent 的兜底手段」补「阅读 Agent 缺的原语」。

### F2. paper scope 的检索范围默认只看当前篇 → 模型以为第二篇「不在库内」

rep2/rep3 的 paperSearch 结果 rank1 都是当前篇；模型随后 getBooks 调错参数（传 keyword/type，实际要 search/kind）拿到错误结果，于是判断「第二篇不在文献库」，改用 **sciverseSearch 外部学术搜索**捞原文。答案内容正确，但：
- 不是库内检索；
- rep3 明说「你的文献库检索范围当前只覆盖这一篇」——**这是错的**，第二篇就在库里（09515f7218b81d7f）；
- 外部检索返回 28–36k 字符的块，进一步推高 token。

### F3. 目录牌模式（lazy-toolset）开销

30 次里 41 次 describeTool（26.8%）：book 题 1.7 次/次，跨文献 rep2 高达 5 次。模型必须先查 schema 再 useTool；有的 run 只做 1 个真实操作却也花 2–3 步。paper scope 的 schema 体积触发目录牌，这是工具面过大的直接成本。

### F4. 参数校验摩擦

强制 reasoning 字段 + 各工具参数名不一致（getBooks: search/kind vs 模型传 keyword/type；getPaperToc 漏 reasoning；readAtReadingPosition 漏 reasoning）→ 每次报错都多一个 step，并增加上下文噪音。跨文献 rep1 里至少 4 次无效调用。

### F5. 读取策略不稳定

methods-dataset-scale 三次分别是 4 / 10 / 13 步：一次用 readPaperFull（24k 字符一次灌入），一次用 2 次 readPaperSection，一次连读 8 次 readPaperSection。没有稳定的「先结构后窗口」路径，token 从 29,920 到 53,295 波动。

### F6. 步数上限容错

20 步上限本身是保护，但跨文献这种任务在没有通用读取原语时必然超限；超限后没有「先给部分答案」的兜底。

## 5. 对 P0/P1 的直接含义

| 基线观察 | 新架构的对应改动 | 预期可量化收益 |
|---|---|---|
| F1 没有按 docId 读文档的入口 | read(doc / anchor) + DocRef；central/reader/paper 同一实现 | 跨文献步数 15 → ≤8；不再出现命令行摸文件 |
| F2 检索范围被 scope 锁死 | search(scope=current / collection / all) 显式参数 + 库地图注入 | 库内文献 0 外部兜底；token 176k → 显著下降 |
| F3 目录牌开销 | 阅读面 ≤8 个工具（P1 目标 ≤14 含 shared）；不再触发 lazy-toolset | describeTool 占比 26.8% → 0 |
| F4 参数摩擦 | 统一 envelope；保留 reasoning 但 schema 简化（P1 评估是否只留统一字段） | 无效调用 → 0；步数下降 |
| F5 读取策略漂移 | outline → search → read(窗口+next) 固定探索顺序写进 guidance | 步数方差收窄；token 中位下降 |
| F6 步数上限 | 窗口化读取 + 先给结构再读原文；必要时子代理 | 不再空答案 |

## 6. A/B 验收门槛（沿用 eval plan，改成可执行数字）

以本题库 30 次为基线：

- 内容通过率不低于 29/30（−2pp 容差 → ≥28/30）；
- 「干净通过」从 27/30 提升到 ≥29/30（跨文献必须库内完成）；
- 跨文献题：平均 token ≤ 80k（基线 176k），步数 ≤ 10（基线 15）；
- 全部题：describeTool = 0；平均工具调用 ≤ 4（基线 5.1，含目录牌）；
- 工具参数错误率 < 2%（基线轨迹里至少 5 次无效调用）；
- 平均 token 中位 ≤ 25k（基线 25k，目标先不退化再下降）；
- 端到端平均耗时 ≤ 12s。

## 7. 附注

- 本报告数据在 .tmp-eval-runs/baseline-1/（不入库）；transcripts 里含完整工具输入/输出（图片 base64 已剔除）。
- refusal-quantum 的自动判分有一例假阳性（正则把「第四章…但量子」误判成编造），人工核对为通过；报告采用人工口径。
- 跨文献 rep2/rep3 的答案质量本身不错——这说明模型能力不是瓶颈，**工具的「可达性」才是**。
