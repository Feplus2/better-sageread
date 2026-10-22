# Agent 大更新 · 开工计划

> 2026-10-22 · 状态：Phase 0 · G0 待评审（协议 v0 + 10 题已出，未动产品代码）
> 目标架构：docs/audits/agent-architecture-benchmark.md
> 评测方案：docs/audits/agent-eval-plan.md
> 现状盘点：docs/audits/research/sageread-agent-inventory.md

## 0. 一句话

先冻结两个设计地基：固定 fixture + 锚点协议 v0；再用 10 道题的金标轨迹走查协议；然后才写第一行产品代码。题库先建 10 题，不建 30–50 题。

## 1. 为什么不先建 30–50 题的大题库

1. **题库的刻度是锚点格式。** 题目的金标要写成 book:/paper:/chunk:/figure:/cite: 与字符偏移；协议一旦调整，50 道题全部返工。先出协议 v0，再写题。
2. **题目质量靠「理想轨迹」检验。** 没写过 golden trace 的题，只是看起来像题；10 道带完整理想调用序列的题，比 50 道只有 prompt 的题更能暴露工具设计问题。
3. **评测集要防过拟合。** 30–50 题里要留 20% held-out；第一阶段就把规模做满，后面调工具时反而没题可用。正确顺序：10 题定设计 → 协议稳定 → 扩到 30–50（含 held-out）。

## 2. 为什么也不先写代码

- 现在的痛点不是缺某个工具，而是同一件事有 7 种读法（盘点结论）。先写新工具，很可能又长出一套平行实现。
- 新工具的价值只能在「旧工具集基线」上证明；没有基线，删旧工具没有依据。
- 旧工具集其实能完成大部分题目——它的问题是**慢、贵、选错工具、看不到本地图片**。A/B 要测的是这些，而不是拿旧工具集做不了的题去「证明」新架构。

## 3. 执行顺序

### Phase 0（1–1.5 天）：设计地基 + 旧工具基线

| 步骤 | 产出 | 门禁 |
|---|---|---|
| 0A fixture 冻结 | evals/fixtures/README.md：2 书 + 3 论文 + 2 备选的固定 id、索引状态、图/引用/阅读位置、备份恢复方式 | 你过目 fixture 选择 |
| 0B 协议 v0 | docs/design/anchor-protocol.md：DocRef、anchor URI 语法、outline/search/read/view 四原语签名、返回 envelope、错误语义、预算；只写 spec + TS 类型草稿，不改产品代码 | — |
| 0C 10 题金标 | evals/tasks/baseline-10.yaml：prompt、金标 anchors/facts/must_not、grader、budget；每题附理想工具调用序列（golden trace） | G0：你过目题目 + 协议 |
| 0D 设计走查 | 用 golden trace 在协议上人肉走一遍；别扭处改协议；输出 3–5 条设计修正 | G0 的一部分 |
| 0E 基线 harness | 页面内直连 harness（CDP 9223，已验证可行，默认不写 threads）；10 题 × 3 次跑旧工具集，落盘 results/report/transcripts | G1：基线数据 |

### P0（0.5–1 天）：补闭环，不动旧行为

- 本地路径 read_image（魔数嗅探、尺寸/张数上限、视觉门控、tool-guard 分档）；
- getFigures 返回绝对路径 + guidance 指向 read_image；
- 文献库地图静态注入（根/布局/图片规则/探索顺序/只读边界）；
- shared 工具 guidance 单源化（从 prompt 挪到工具定义旁）；
- 旧工具保留 alias；L1 脚本 + 10 题复跑，对比基线。

### P1（2–4 天）：收敛工具面

- read_document 吸收 readPaperSection / readBookSection / ragRange / ragContext / readAtReadingPosition；
- search_library 吸收 ragSearch / paperSearch（含 central 全库）；
- get_document_info 吸收 getPaperInfo / getPaperToc；
- DocRef + 锚点 URI 全链路；当前文档变缺省值；
- 每角色可见工具 ≤ 14；L2 A/B（10 题 → 30 题）；
- G2 门槛：成功率不低于基线 −2pp；跨文献/长阅读中位步数或 token 降 ≥ 20%；工具错误率 < 2%。

### Phase 2（P2，1–2 周）

- 题库扩到 40–50（含 20% held-out）+ rubric judge + 3 次重复；
- 子代理编排、引用图谱、技能沉淀、run_code 式批处理评估。

## 4. 第一批 10 题（方向；题面与金标随 0C 定稿）

| # | 类别 | 题目草稿 | 考什么 | 旧工具集 |
|---|---|---|---|---|
| 1 | 定位/结构 | 《福柯》第 3 章主要讲了什么？ | 目录→章节锚点→窗口读取 | 能做 |
| 2 | 图表 | 《Rational design...》图 3 说明了什么？ | 图号锚点 + 图注 + 视觉事实 | 只能靠图注猜 |
| 3 | 图表/未索引 | 《Dehydration-induced...》图 2 是什么实验？ | 未索引兜底 + 4.8MB 大图降采样 | 只能靠图注猜 |
| 4 | 阅读总结 | 用 5 句话总结我现在读到的这一节 | 注入位置 → 按位置读原文 | 能做 |
| 5 | 跨文献 | 两篇钠电层状正极论文的设计策略差异 | collection 检索 + 双文档 | 能做（慢） |
| 6 | 方法/结构 | 《At-Scale...》的数据集怎么构建？ | 长文定位 + 方法节 | 能做 |
| 7 | 引用 | 《Dehydration...》参考文献第 12 条是什么？ | cite 锚点 + 结构化引用 | 能做 |
| 8 | 未索引书 | 《民法总论》里「意思表示」在哪一章？读相关段 | EPUB TOC 匹配 + 未索引兜底 | 能做（易选错工具） |
| 9 | 拒答 | 《福柯》里有没有讨论量子色动力学？ | 不编造 + 明确说没有 | 能做 |
| 10 | 位置 | 我读到哪了？把这一节原文给我 | 位置坐标 + 原文窗口 | 能做（易重复读） |

> 2/3 是旧工具集唯一真正的能力缺口（看不到本地图片）；其余题旧工具集都能做，用来比步数/token/正确率。这样 A/B 才公平。

## 5. 本轮明确不做

- G0 通过前，不动 registry.ts、custom-chat-transport.ts 等产品代码；
- 不批量删除旧工具；不新增场景专用工具；
- 不追求一次到 P1 完成态；每步保留旧工具 alias，可回退。

## 6. 挂账

| 项 | 处理 |
|---|---|
| Biome 72 errors / 3 warnings（18 format + 12 organizeImports + 11 useExhaustiveDependencies + 9 noUselessElse + …） | 发版后单开 chore(biome) 提交；不混入重构分支 |
| 0.4.1→0.4.2 旧客户端更新弹窗标题兼容 | 可选；不做一次性补丁（除非你要求），下次更新起自然生效 |
| 跨书/跨文献检索的统一索引 | **后话**：v0 先 fan-out + RRF（无需重建索引）；统一全局索引放 P2 观察。现状 16 个书级 vectors.sqlite + 1 个全局论文库，schema 一致 FLOAT[2048]；另需清理 30 条 success 状态 vs 16 个库文件的历史漂移 |

## 7. 风险与止损

| 风险 | 止损 |
|---|---|
| fixture 漂移（dev 库被改动） | 记录 id + 内容校验；跑评测前备份 %APPDATA%/com.bettersageread.dev；后续做 seed 脚本 |
| golden trace 与模型实际行为脱节 | 10 题先跑旧工具集，失败轨迹回灌协议/guidance |
| 直连 harness 与 UI 路径不一致 | L2 直连跑 A/B；发版前 L3 CDP UI 冒烟兜底 |
| 书籍章节→mdbook 映射复杂 | 保留 readBookSection 薄包装一个版本；heading 锚点回退字符偏移 |

## 8. 已定决策

- 评测驱动设计：题库是设计工具，不是验收仪式；先 10 题后 30–50。
- 架构方向：三层（原语 / 锚点 / 约定）+ DocRef & 锚点协议（2026-10-21 已拍板）。
- 迁移策略：feature flag + 旧工具 alias，可回退；不整体推翻。
- 图片：P0 先补本地路径 read_image，不新造场景工具。
- 位置：主通道是每轮注入；get_reading_position 只做逃生口（P1 后评估删除）。
- 评测运行方式：L2 优先页面内直连 harness（CDP 9223 已验证），避免向 threads 写评测垃圾。

## 9. 进度记录

- 2026-10-22：0A 完成（evals/fixtures/README.md：6 个 fixture，含索引/图/引用/阅读位置）；
- 2026-10-22：0B 草案完成（docs/design/anchor-protocol.md：7 个阅读工具 + 六类锚点 + 预算 + 错误码 + 待拍板 6 问）；
- 2026-10-22：0C 草案完成（evals/tasks/baseline-10.yaml：10 题，含金标锚点/事实/禁编项/预算/golden trace）；
- 2026-10-22：**G0 通过**（用户确认「先定协议」并开始 Phase 0；协议 §10 六项按建议默认执行，改动走 v0.1）；
- 2026-10-22：0D 走查完成（修掉 TOC 标题 vs 文本层 heading 的匹配坑；跨文献题改为显式点名两篇论文）；
- 2026-10-22：0E 完成——UI 驱动 harness 跑通（打开文档/固定位置/新对话/发送/落库/提取轨迹/删评测线程/恢复位置），10 题 × 3 次基线完成；
- 2026-10-22：**G1 基线建立**——内容通过 29/30、干净通过 27/30、均值 40.5k token / 5.1 步 / 10.4 s；跨文献 1/3 空答案（撞 20 步上限）、2/3 靠外部搜索兜底、26.8% 工具调用是目录牌。详见 docs/audits/agent-baseline-g1-2026-10-22.md；
- 2026-10-22：**P0 完成**——本地 readImage(path/maxEdge)、getFigures 绝对路径、文献库约定注入、看图成本策略、步数收口（prepareStep）。L1 12/12 通过；10 题冒烟全过，均值 token 40.5k→30.4k、步数 5.1→3.4。详见 docs/audits/agent-p0-smoke-2026-10-22.md。
- 2026-10-22：**P1-1 完成**——readDocument / getDocumentInfo / searchLibrary 三原语落地（reader/paper/central），L1 19/19；跨文献轨迹首次用 searchLibrary(all)+readDocument 读第二篇，不再 readLocalFile/runCommand 翻库。详见 docs/audits/agent-p1-document-tools-2026-10-22.md。
- 观察：新旧工具并存阶段 10 题冒烟均值 42.1k token / 4.6 步（P0 30.4k / 3.4）——加法不成立，必须做可见性切换。
- 2026-10-22：**P1-2 完成**——documentToolMode（both/new/legacy）+ registry 可见性切换 + prompt/library guide 模式提示 + harness `--doc-mode`；L1 22/22；未索引书补 EPUB TOC 回退。首轮单次 A/B：new 47.8k token vs legacy 60.7k（−21%），但单次方差大、未索引书回归（92k→251k），需 3 次重复与书籍定位修复。详见 docs/audits/agent-p1-ab-2026-10-22.md。
- 2026-10-22：**P1-3 进行中**——new 模式工具面 29→17（schema 9.8k，退出目录牌）、单轮读取预算 32k、书籍窗口 8k、图片硬上限 1024；L1 26/26。methods 从 142k/12 降到 63.9k/5。期间 dev webview 因大图长请求卡死一次，已重启 dev stack 恢复（生产实例未动）。详见 docs/audits/agent-p1-3-budget-2026-10-22.md。
- 2026-10-22：**P1 正式 A/B 完成**（10 题 × 3 次 × 2 模式）——new 内容 30/30、步数 4.23（legacy 4.57）、describeTool 14（legacy 46），但 token 均值 52.0k（legacy 40.6k，+28%），门槛未过；未索引书 new 127.7k vs legacy 39.3k 是最大回归。默认模式暂不切换。详见 docs/audits/agent-p1-ab2-2026-10-22.md。
- 2026-10-22（方向修正）：撤回 readDocument 每轮次数/字符硬上限、图片每轮张数上限——分桶 A/B 方案见 docs/audits/agent-ab-plan-v2.md。
- 下一步 P1-4：按分桶方案补 3 个能力探针（multi-figure / deep-research / cross-doc-2plus），跑 Bucket I + Bucket F 的 new-vs-legacy 3 次 A/B；Bucket I 达标且 Bucket F 不退化为切默认前提。
- 发版推迟：先把 Agent 大任务整体做完（含 P1 收尾与 P2 必要项），再谈发版。
- 2026-10-22（图片通道修复）：调研 DeepSeek Harness 的图片处理（规范化 + 超预算省略最旧 + 路径占位，无张数上限）；发现我们的 OpenAI-compatible 适配器把工具结果图片 JSON 成 base64 文本、模型根本看不见。已在 fetch 层加工具图片桥（图片改挂 user 消息、保留最近 3 张、旧图带路径占位），合成图 L2 探针两种路径均 PASS。详见 docs/audits/harness-image-handling.md。
- 2026-10-22（多图修复）：两张图同轮挂起的根因是图片 user 消息插在 tool 响应之间（违反 OpenAI 协议）；已改为同组 tool 结束后聚合附图，双小图探针 6s PASS；useTool 输出脱敏 + 内存缓存（图片不进聊天记录，按 toolCallId 给模型）。
- 2026-10-22：**分桶 A/B 达标**——Bucket I new 18/18、干净 18/18、均值 39.1k vs legacy 42.7k、中位 24.1k vs 26.1k、耗时 11.3s vs 12.4s（步数 +9% 在容忍带）；Bucket F 12/12、向量化提及率 8/12（合格题 8/9）。详见 docs/audits/agent-ab-bucket-2026-10-22.md。
- 2026-10-22：新增 `plugin:epub|paper_index_status` 命令（论文级索引状态，含 ACL permission）+ readDocument/getDocumentInfo 返回 index 提示；未索引引导落地。L1 31/31。
- 2026-10-22：**默认切 new**——Agent 设置新增「文档工具模式」（new/both/legacy）+ 持久化迁移 v2（旧 both → new）；L1 32/32；默认模式 10 题冒烟 **10/10 通过**（含真实看图），旧工具可一键回退。
- 2026-10-22（P1 收尾）：**guidance 单源**——reader/paper 系统策略按 docMode=new 生成新原语文案（不再引用 ragSearch/readBookSection/readAtReadingPosition/paperSearch/paperContext）；`searchLibrary` 支持 `doc=book:<id>` / `doc=paper:<id>`，接入书籍混合检索（补上 new 模式的本书语义检索），L1 **35/35**；快速冒烟 3/3。**P1 完成**。
- 2026-10-22（P2-1）：**跨库统一检索落地**——Rust `search_all_books_db`（一次 embedding fan-out 所有已索引书）+ central `searchLibrary(scope=all)` 书库/论文库 RRF 合并（结果带 kind、book_total/paper_total）；L1 **38/38**（含跨库 8 book / 8 paper）。
- 下一步 P2：引用图谱、子代理评估（先调研 Harness 的 subagent 设计再决定是否做）；全量回归（L1 + 10 题 ×3 + 探针）后进入发版评审。
