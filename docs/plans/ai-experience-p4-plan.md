# P4 AI 体验施工计划（ai-experience-p4-plan）

> 2026-08-25 建立。前置调研：`docs/archive/task-system-survey.md` §8（「向量化某篇论文搜不到」复盘，
> 含机制事实与改进建议）。痛点原点：全局助手找论文只能靠 `getBooks` 的 SQL LIKE 子串匹配，
> 对英文标题/主题式描述零命中；且 central scope 工具 36 个 > 30 阈值恒走目录牌模式。

---

## 0. 目标

全局助手（central scope）能像用户一样"找到"论文：按主题语义检索、按标题/作者子串匹配、
列全量挑条目——三条发现路径都有明确工具指引，模型不再猜 id。

## 1. 工具描述补跳板（零风险文案级，先行）

**改动**（照 `process-paper.ts:63,75` 的现成句式抄）：
- `ai/tools/central/vectorize-book.ts:128-156`：描述与 `bookId` 参数补
  「先用 getBooks(kind=paper) 按标题/作者查得条目 ID；topic 式描述查不到时，
  先 action=status 列全部条目让用户的描述与标题人工对齐」。
- `constants/central-prompt.ts:35` vectorizeBook 一行同步补跳板。
- 行为准则第 4 条（`central-prompt.ts:21`）「用户提到书名时先 getBooks」改为「书名/论文名」。
- 同口径巡检 processPaper / importPaper / convertPdf 描述（有则补、无则不动）。

**验证**：单测不受影响（纯文案）；CDP 实盘让全局助手执行「向量化那篇讲 XXX 的论文」，
观察是否正确走 getBooks → vectorizeBook 链路（审计日志复盘）。

## 2. getBooks / status 发现能力增强（小量）—— ✅ 已落地（2026-08-28，随 AI 用量面板同日）

**落地口径（用户拍板：文献库大几百篇常见，limit 提高 + 可再加翻页）**：getBooks 新增
`fields: "minimal"`（仅 id/标题/类型，走轻量 `get_books` 免 status join）+ `offset` 翻页
（SQL 级，updatedAt 降序）；limit 分层上限——minimal 1000 / full 200（原 50）。
kind/status 为查询后过滤的既有语义保持（筛选态翻页可能跳条，工具描述已注明）。

**原方案记录**：

**背景**：`getBooks` limit 上限 50（库 130+ 篇不够列）；`vectorizeBook action=status` 的 items
本就返回全量 id+title（`:172-198`）——零代码可用，只是描述没点明。

**改动**：
- `vectorize-book.ts` 描述点明「action=status 返回的 items 是全量条目清单（id+title），
  可当发现清单用」。
- 评估 getBooks 是否需要 `fields: "minimal"`（id+title 两列全量返回，突破 limit 50）——
  若 §1+上一条已够模型用则不做，避免 API 面膨胀。

**验证**：CDP 实盘 `vectorizeBook action=status` 返回结构确认；提示词巡检确认指引闭环。

## 3. central 语义检索（中量治本，独立特性）

**缺口**：paperSearch 是 paper scope 专属（`registry.ts:384`），ragSearch 是 reader scope 专属
（`:361`）；central 无任何语义检索。

**方案取舍**（实施前先与用户确认选型）：
- A. paperSearch 下放 central（scope 注册加 central 位；返回 paper_id+chunk 片段）。
- B. getBooks 接向量检索兜底（search 参数 LIKE 零命中时自动退化语义检索）。
- 倾向 A（职责清晰、B 会把 getBooks 变成两种语义的黑盒）；若选 A，注意 central 无
  「当前论文」上下文，返回需自带篇目标题。

**验证**：已向量化论文的主题式提问实盘（「我那篇讲宇宙弦的论文说了什么」→ 应命中并答出）。

## 4. 目录牌模式观测（审计增强）

**背景**：central 恒走目录牌（36>30）。模型"没查 schema 就传参"是没读牌还是读了牌也没指引，
目前无观测手段。

**改动**：`agent-audit` 日志（`agent-audit/local-api.jsonl` 同款落盘）增加 describeTool/useTool
调用序列记录（工具名 + 参数键名，不含值——防秘钥进日志）；供复盘目录牌指引质量。

**验证**：一次实盘任务后审计文件含 describeTool/useTool 序列；秘钥扫描确认无敏感值落盘。

## 5. 施工顺序与边界

1 → 2 → 4 可一批做（都是小改）；3 独立一批（要先选型）。全部不依赖 P2/P3，可提前搭车。
**不做**：目录牌模式本身的重构（阈值/分组策略）——观测数据出来后再议。

## 6. 回归矩阵

- tsc；`constants/{central-prompt,prompt,paper-prompt}.ts` 的提示词 diff 人工过目
  （提示词是行为面，改动必须逐字确认）；
- AI 工具实盘三连：按标题找论文、按主题找论文（§3 落地后）、向量化指定论文。
