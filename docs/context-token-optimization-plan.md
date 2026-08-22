# 上下文经济性优化：设计哲学与施工方案（2026-08-21 讨论定稿）

> 起因：阅读助手最简单的对话也轻松烧掉数万 tokens。本文档记录诊断结论、讨论中形成的
> 设计哲学、逐项拍板结果与对应施工方案。**讨论阶段全程只读，未改任何代码。**

---

## 一、实测基线（2026-08-21，CDP 探针连运行中实例）

| 组成部分 | 实测体积 | 备注 |
|---|---|---|
| 内置工具 schema（19 个） | 10,338 字符 | 最大头。单个 333~840 字符，大头是 parameters JSON Schema 而非描述行 |
| system prompt | 7,466 字符 | DB 基词 3,370 + 静态追加段 + metadata.md 目录段（最大一本书 6.8k 字符/203 行）+ 语义上下文 ≤500 |
| zotero-brain MCP 工具（6 个） | 2,849 字符 | mcp-servers.json 中 scope 含 reader 且启用 |
| 工作区段 + 记忆段 | 411 + 0 字符 | 记忆段上限 4,000 字符 |
| **固定开销合计** | **≈21,000 字符 ≈ 1.3万~1.9万 tokens** | 每轮重发重计费 |

放大器（叠加后即"数万"）：

1. **历史全量重发**：双水位活塞 256k 才压缩，之前的对话历史每轮全部重发；
2. **每条消息一次隐藏 LLM 调用**：语义上下文生成，且用的是**当前聊天模型**而非辅助模型（`ai-context-service.ts:23-33` 收 `selectedModel` 直传）；
3. **真正的滚雪球在历史 B 里**：RAG 工具结果永久驻留、图片 base64 每轮按图像 token 重复计费、长划线引用全文驻留。

## 二、机制结论（讨论中澄清的事实）

1. **A 不滚雪球**：`streamText({ system, tools, messages })` 三通道分离（`custom-chat-transport.ts:176-183`）。A（system+工具 schema）每轮重发恰好一次、按输入重计费，但不进历史、不自我复制。助手回复 B2 不含 A 的拷贝。第 N 轮输入 = A + B₁…Bₙ₋₁ + Cₙ。
2. **"固定开销不重复输入"在协议层做不到**（聊天 API 无状态）。唯一减免是提供商前缀缓存：命中部分按折扣计费。
3. **缓存要求前缀逐字节稳定**。现状 system 内部顺序：基词 → 技能 → **语义上下文（每轮变）** → 当前章节（翻页变）→ metadata（大块稳定）→ 工作区/记忆。每轮都变的段排在最稳定的大块**前面**，把 metadata 的缓存机会每轮全部污染。
4. **metadata.md 与 ragToc 完全重叠**：一急一懒。metadata.md 是向量化时 `pipeline.rs:135` 生成的（注释原话"用于模型提示"），内容 = 元信息 + 完整两层目录树，文件内自述目的"用于 ragToc 工具的 chapter_title 参数"——即给模型喂合法参数表；ragToc 是同一份数据的按需版。
5. **模型已在"传出"chunk 使用信息**：DB 基词的引用标注规范强制要求 RAG 引用句末标 `[chunk_id]`（如 `[118] [877]`），ragSearch 结果自带 chunk_id 与 related_chapter_titles；ragContext 的入参就是 chunk_id。全部规则可解析。

## 三、设计哲学（六条原则，后续同类问题的裁决基准）

1. **上下文是工作台，不是仓库**：把"随身携带"改为"知道去哪找"。原文/原图落盘或入库，上下文里只留 ID 坐标，按需取回。
2. **用则标注，不用即弃，误杀自愈**：翻字典翻错的页不占内存；判错的代价 = 一次重取，与按需哲学自洽，因此宁可 default-unused，不疑罪从有。
3. **回答即蒸馏，绝不重复劳动**：助手回答已是 RAG 原文的压缩版且永驻历史，不再为存根生成任何 AI 摘要。
4. **能用规则的绝不动用模型**：使用判定、存根生成、状态提取全部纯规则字符串操作，零模型调用。
5. **静止在前、变动在后；变化要批处理、单调推进**：缓存布局原则；批处理活塞付偶发一轮重启费，滑窗每轮断缓存（已否决）。
6. **一次性资源按需重读**：图片读一遍记住 ID 即可；提示词即时生效与缓存不冲突——"用户有意变更"付一次重启费是应得的，要消灭的只是"无谓的每轮自动变化"。

## 四、决策清单

### 已拍板

| # | 决策 | 要点 |
|---|---|---|
| D1 | **取消语义上下文** | 整个概念退役（AI 生成的"焦点描述"是伪问题：跨轮焦点本就是历史 B 的职责）。替代 = 规则提取动态状态（当前书/章节），随布局后置。附带消灭每条消息的隐藏调用 |
| D2 | **metadata 保守档** | system 常驻：元信息 + 一级章节平铺 + 当前章子树；深层目录走 ragToc 按需。生成侧（pipeline.rs）不动，文件仍是完整事实源，只在注入侧裁剪 |
| D3 | **布局重排（静态优先）** | 基词+静态段 → 工具 schema → metadata → 工作区 → 记忆 → 动态状态（最尾）→ 前情摘要。明确不搞"冻结"：改提示词下一轮即时生效照旧 |
| D4 | **图片一次性** | 发送时落盘；只有出现的那一轮真发图；此后每轮替换为 ID 存根；readImage 工具按需取回 |
| D5 | **RAG 结果批处理活塞** | 十进位轮次块分批降级为 ID 存根（含引用判用位，冻结语义）；零模型调用；吸纳业界 clear_at_least 保底量（2026-08-21 业界对照后简化：删三级信号，留单一引用位） |
| D6 | **工具结果两层瘦身** | 出生截断（落库即预览，本地不留全量；当轮在飞链路除外）+ 请求期存根（D5）。展示层截断先例：performance-optimization-plan.md:13 |
| D7 | **前情摘要分 scope 结构化** | reader/paper/central 三套模板；阅读场景以"理解进度"为主线，不是代码场景的"任务进度"（业界五段式仅 central 沿用） |
| D8 | **工具目录牌 + 按需说明书（含 MCP）** | 2026-08-21 由"缓办"升级立项：业界官方路线（Anthropic Tool Search Tool）+ 选工具准确率数据（25 工具已在劣化区间）+ 用户乱挂连接器的预算守门兜底 |
| D9 | **基建批：AI SDK v5→v7 原地升级 + DSH 观察名单** | 2026-08-21 拍板。v7（2026-06-25 发布）原生覆盖手搓四件套（工具审批/MCP/思考强度/压缩钩子），迁移 codemods 齐备；DeepSeek Harness（2026-08-13 开源，v0.1）进观察名单不迁移 |

### 待拍板

- 无（2026-08-21 第二轮修订后清空）。原 zotero-brain scope 议题撤销：连接器生效范围属**用户自由配置**（AI 中心-连接器），系统不预设；用户挂载过多连接器的风险由 P4 预算守门兜底。

## 五、施工方案

### P0 止血批（零 UX 风险，先行）

目标：固定开销 ≈21k → ≈12-13k 字符；消灭隐藏调用；缓存前缀稳定。

**P0.1 语义上下文取消**

- `hooks/use-chat-state.ts`：删除 `generateSemanticContextAsync`（:628-667）及其调用（:703）；删除 :428、:779 两处 `setActiveContext(getThreadContext(...))`；`ChatContext.activeContext` 字段退役。
- `services/ai-context-service.ts`：整文件删除（仅服务于语义上下文）。
- `services/thread-service.ts`：`getThreadContext` / `updateThreadContext` 停用；DB 的 context 列保留，存量数据不迁移不读取（无害遗留）。
- `constants/prompt.ts`：删【语义上下文】注入段（:105-107）。
- **DB 基词同步**（关键）：`src-tauri/src/core/default-skills.json` 的"系统提示词"技能——"—— 上下文信息说明 ——"段删除【语义上下文】行；走 `database.rs` 条件迁移惯例更新存量库（reader 基词在 DB，改 JSON 必须配套迁移）。

**P0.2 metadata 裁剪（保守档）**

- `constants/prompt.ts`（:54-72 读取处）：解析 metadata.md 目录树，注入视图 = 元信息 + 一级章节 + **当前章子树**（当前章用 `activeSectionLabel` 前缀匹配；匹配不到只留一级）。视图末尾加一行"完整目录可用 ragToc 获取"（无向量能力时改提 readBookSection 模糊匹配）。
- `pipeline.rs` 不动；metadata.json 回落路径（formatMetadataJson）本就无目录，不受影响。

**P0.3 布局重排**

- `constants/prompt.ts` `buildReadingPrompt` 组装顺序改为：基词+静态段+技能 → metadata。
- `ai/custom-chat-transport.ts`（:164-169）追加顺序改为：工作区段 → 记忆段 → **【当前阅读章节】（动态，移到这里）** → 前情摘要（罕见，最尾）。
- DB 基词"上下文信息说明"段口径同步（与 P0.1 同一次迁移）。

**P0.4 zotero-brain scope（待拍板后执行）**

- `mcp-servers.json` 的 zotero-brain 条目 scope 去掉 `reader`（设置页改或直接改配置文件均可，无代码）。

**P0 验证**

- 把本轮临时审计探针转正为 `scripts/cdp-context-audit.mjs`（量 system/tools/mcp 各段字符数），P0 前后对比，目标 ≤13k 字符。
- 巡检引用面：grep `generateContextWithAI|getThreadContext|activeContext|语义上下文` 全仓（含 cdp-*.mjs 脚本）；`tsc --noEmit` + `biome check` + 相关 `test-*.mjs`；DB 基词迁移后 CDP 冒烟一轮对话。
- 缓存命中观察：DeepSeek 等 usage 的 cachedTokens 字段（messageMetadata totalUsage 已有通道），P0 后应能看到前缀命中。

### P0.5 基建批：AI SDK v5 → v7 原地升级（D9）

> 拍板逻辑（2026-08-21）：既然对 AI 层大动刀，就把手搓的"标配件"还给框架。选原地升级而非换框架：
> TS 框架格局中 Mastra 服务端导向、LangGraph 生态偏 Python，均与"Tauri WebView 客户端 + 聊天 UI 驱动"
> 形态不对口；AI SDK v7（2026-06-25 发布）恰好原生覆盖我们的手搓件，且自带迁移工具。

**手搓件 → v7 原生件对照**

| 手搓件（现状） | v7 原生替代 | 备注 |
|---|---|---|
| `wrapToolsWithGuard` 确认卡（tool-guard.ts） | 工具审批策略（tool approval policies） | 守卫语义映射到原生审批流；三档安全模式语义保留 |
| mcp-manager（stdio/SSE 连接管理 + 密钥引用） | 完整 MCP 支持 | stdio 桥仍走 Rust 侧（WebView 无进程能力），JS 侧合并/生命周期用原生 |
| reasoning-map + factory 请求体补丁 | provider-agnostic reasoning control | 11 家预置 + openai-compatible 的档位映射改用原生参数 |
| 活塞压缩住在 transport（自定插入点） | `prepareStep` compaction 钩子（v6+ 官方插槽） | P2 的两层瘦身届时落进此钩子，不再寄生 transport |
| 自定 fetch 走向/代理分支（factory.ts） | v3 模型规范 provider 体系 | 迁移时逐 provider 核对 fetch 行为不回归 |

**施工步骤**

1. 依赖升级 v5→v7（v6 停留点不恋战），跑官方 codemods + 迁移 skill；
2. `useChat`/`CustomChatTransport`/UI 消息流适配（v3 规范 breaking 面）；
3. 工具审批替换 tool-guard（确认卡 UI 复用，触发逻辑换原生）；
4. MCP 管理器对齐原生 MCP（Rust stdio 桥保留）；
5. reasoning-map 退役，切原生 reasoning control；
6. H1 落库 / H2 切页续接 / 中断恢复等自定义钩子**全量重验**（本批最高风险点）；
7. P2 实施时把活塞写入 prepareStep（届时执行，本批只验证钩子可用）。

**门槛确认**：Node 22+（CDP 脚本既有要求，满足）；ESM-only（workspace 已 ESM，满足）；WebView 运行时兼容性以 v5 现状推定，冒烟首日先验证。

**风险与回归矩阵**：v3 规范与 UI 消息流 breaking → 三 scope（reader/paper/central）各一轮完整对话冒烟（含工具调用、中断恢复、图片、多步工具链）；既有 `test-*.mjs` 全量 + tsc + biome；落库续接专项（发消息→重启→续接）。**验收标准：四件手搓套至少三件删除、代码量净减，全矩阵绿。**

### P1 图片一次性（D4）

- **落盘**：提交时把 dataUrl 写 `{appData}/attachments/{id}.png`（Tauri fs 二进制写）；file part 增加稳定 `id` 字段（`use-chat-state.ts` `buildMessageParts` :607 一带）。
- **存储同步瘦身（2026-08-21 补，"本地也不留垃圾"）**：落库消息里的 dataUrl 替换为文件引用（id + 相对路径），UI 工具卡/气泡从盘渲染（应用已有 asset 路径渲染基础设施，实现时核验）；threads 表、L2 同步、备份小包不再携带 base64。attachments 目录本地保留；多设备同步暂不覆盖（L2 文件通道后续可加，非本批范围）。
- **请求期替换**（不动存量消息）：transport 新增 `stripAgedImageParts`——仅**最后一条 user 消息**保留真实 file part；更早轮次的 file part 替换为 text 存根：`⟦图片N（文件名）：已分析过，可用 readImage(N) 重看⟧`。非视觉模型路径沿用既有 `stripFileParts`。
- **readImage 工具**（shared 三 scope 注册）：execute 按落盘路径取回图片，以工具结果 file part 返回。
- **spike 项（半天）**：验证目标提供商工具结果带图支持——Anthropic 支持 tool_result image；OpenAI 兼容端点视实现；不支持时工具返回文本降级提示（罕见路径，可接受）。
- 存量兼容：老消息 file part 无 id——按消息内序号推断；首版从简。
- 验证：CDP 冒烟——带图消息发两轮，断言第二轮请求体无 dataUrl、模型仍能经 readImage 取回；`tsc`/`biome`。

### P2 工具结果两层瘦身（D5+D6，2026-08-21 业界对照后修订）

> 修订背景：对照 Claude Code microcompact / Anthropic context editing 后自我推翻原"三级判用/弃
> 信号"设计——其全部产出只是存根多一行坐标，而坐标可从结果元数据免费获得，收益不抵复杂度。
> 业界把智能花在"何时丢、丢多少"（保底量/保最近 N 组/分层触发），而非"丢时生成摘要"。我们看齐，
> 唯一保留差异：存根带 chunk ID（语义检索重搜不保证复现同一批块，ID 是精确重取的廉价保险，
> grep 类工具可原样重放故无此需求）。
> **同日晚间部分恢复（用户质询）**：丢弃时把"复杂的三级机制"和"一个免费的判用位"一起扔了——
> 引用标注 [chunkId] 在 assistant 文本里明摆着，正则即得，零 LLM 调用，与设计哲学第 2 条"用则标注"
> 对齐。恢复为**单一引用位 + 冻结语义**（见 L2），仍否决的是三级信号全机与差异化保留。

**L1 出生截断（落库即预览，"本地不留垃圾"）**

- 落库前把工具结果转为**结构化预览**：头部保留 chunk IDs + 来源坐标（`related_chapter_titles`，
  `rag-search.ts:120`），正文截断（建议 2000 字符，与展示层 4000 截断口径对齐可调）。
- **硬边界：当轮在飞的多步链不截断**——step 15 可能还要引用 step 3 的结果，截断只发生在轮末
  落库快照（persistMessagesNow 路径）。这正是"AI 当时读到就行"的准确含义。
- 连带收益：threads 表体积、L2 同步流量、备份小包同步缩小；与展示截断先例
  （performance-optimization-plan.md:13）同哲学、不同层。
- 存量线程不追溯（无迁移；新轮次自然变小）。

**L2 请求期存根（批处理活塞）**

- 超过保底窗口的预览降级为一行存根：`⟦rag#3：已引 118/877；未引 115/116，来源：《…》三章·二节⟧`（坐标取自预览头部，零模型调用）。
- **引用判用位（2026-08-21 恢复，纯规则零调用）**：扫描 assistant 文本中的 `[chunkId]` 标注（引用标注规范保证格式）即得已引/未引。语义价值：已引 = 内容已蒸馏在模型自己的早期回答里（回答全文仍在历史），不必重取；未引 = 需要时走 ragContext(chunk_id) 重取。
- **冻结语义（保缓存的关键约束）**：判用只统计到降级边界 B 为止的引用；边界之后新出现的引用**不回写存根**——那条引用本身就在更近的历史全文里可见，无需存根转述。若允许"未引→已引"随时回写，历史中段存根文本会变，前缀缓存从该点作废，批处理原则失效。判用位因此保持纯函数、单调、前缀稳定。
- **分批规则（十进位轮次块，免持久化纯函数）**：T = user 轮数，降级边界 B = 满足 B ≤ T−5 的最大 10 的倍数（块宽 10、窗口 5 可调）；user 轮号 ≤ B 的轮次中所有 RAG 工具结果（ragSearch/ragContext/ragRange）降级。T 在 6~14 期间 B 恒为 0（零降级、前缀稳定）；每跨一个十进位批量降级一次。单调、批处理、纯函数。
- **clear_at_least 保底量（吸纳自 Anthropic context editing）**：触发降级时若本次可清除量 < 下限（建议 2k tokens，用既有 token-estimator 估），推迟到下一批——任何历史变更都会打断缓存，"要断就一次断够本，否则别断"。
- 实现位置：`ai/utils/` 新模块（如 `compact-aged-tool-results.ts`），transport 在 `selectMessagesWithinBudget` 之后、`convertToModelMessages` 之前调用；只改请求期副本。webSearch 结果首版不纳入（可选扩展）。
- 否决的滑窗式（每轮把刚过龄的换掉）依旧否决：每轮变更前缀一处，缓存从该点起每轮全灭，比不降级更贵。

**验证**：新增 `scripts/test-rag-aging.mjs`（esbuild 惯例：构造合成线程，断言边界/存根/clear_at_least 推迟/单调性 + L1 落库预览格式与在飞链路不截断）；CDP 长对话冒烟断言请求体中老轮次 RAG 结果已存根、当轮结果全量。

### P3 前情摘要分 scope 结构化（D7）

业界五段式（任务概览/当前状态/重要发现/下一步/需保留偏好）是**任务驱动**场景的结构。阅读场景不同：不一定有任务主线，也不一定有"重要发现"，**理解文本内容本身才是主线**——所以三套模板分开定制（段数不限、思路一致：固定小节 > 自由摘要，恢复力更强，业界有内部基准背书）。

**reader（图书，理解进度主线）**
1. 在读书目与当前位置（书/章/节）
2. 已讨论的核心概念与结论（每条一两句，含用户提问关注点）
3. 已澄清的疑问与纠偏记录（含"作者观点 vs 用户理解"的偏差修正）
4. 用户理解偏好（类比习惯/要不要公式/语言深浅）
5. 建议续聊方向

**paper（论文，论证结构主线）**
1. 论文与当前小节（题目/作者/在读小节）
2. 论文核心主张与已讨论部分的方法链（问题→方法→证据）
3. 已解释过的图表/公式/引用（编号+一句话结论，防重复讲解）
4. 术语与符号约定（跨轮一致的译名/缩写）
5. 待续问题与阅读线索

**central（全局助手，任务驱动——业界五段式直接适用）**
1. 任务概览 2. 当前状态 3. 已做决定 4. 下一步 5. 需保留的偏好

实现：`conversation-summary-service.ts` 的 compressDroppedIntoSummary 按 threadScope 选模板；走辅助模型 + 既有轻量档位体系（utilityTaskProviderOptions）；输出强制固定小节。验证：三 scope 各构造一条合成长线程跑压缩，断言输出含全部小节标题；tsc/biome。

### P4 工具目录牌 + 按需说明书（D8，2026-08-21 升级为正式批）

> 升级依据（第二轮调研）：①Anthropic 2025-11-24 发布 Tool Search Tool / Programmatic Tool Calling，
> 官方钦定"渐进式披露"路线，与本案机制一致（Spring AI 已生产级实现）；②量化数据：工具池 >20-30 个
> 选工具准确率可见劣化（RAG-MCP：臃肿列表 13.62% vs 检索式 43.13%），**阅读助手现状 19 内置 + 6 MCP
> = 25 个，已在劣化区间**——这是正确性问题，不只是 token 问题；③"用户挂十几个连接器系统不能崩"
> 是硬需求，预算守门是业界共识兜底。

- **机制**：全量注入仅一张目录牌（工具名 + 一句话用途，内置与 MCP 工具统一编排，按来源分组）；注册 `describeTool(name)` meta-tool，模型首次使用某工具时取回完整 schema（同流多 step 内完成，不加用户回合）。取回的说明书随轮龄进 P2 的两层瘦身（出生截断/存根化），不新增驻留。
- **预算守门（系统不因用户乱来而崩）**：
  - 常驻 schema 预算：目录牌模式恒开时，常驻 = 目录牌本身（每工具 ~50 字符），天然与连接器数量近似解耦（15 个连接器 ≈ 目录牌多 15 组行，不崩）；
  - 若最终保留"部分高频工具全量常驻"的混合形态：常驻总量超预算（建议 30 工具或 12k 字符，对齐业界 30/40 警示线）→ 自动全量降级为纯目录牌 + UI 提示"工具较多，已启用按需加载"；
  - 连接器挂载超量（如 >10 个 server）→ 设置页黄条提示精度风险，引导收敛生效范围。
- **仓库内先例（2026-08-21 核实）**：skills 系统已是两级——三 scope 均只注入名字目录牌（`prompt.ts:99` 等，"当用户需求匹配时先调用 getSkills 获取详细执行步骤"），全文经 getSkills 工具按需取回。describeTool 直接复用该模式；取回的技能全文与工具说明书一样随轮龄进 P2 瘦身管道。
- **已知代价**：每工具每对话多一 step（首次）；盲参数失败风险（describeTool 先行缓解）；与 MCP 官方 Tool Search Tool 演进方向对齐，未来 server 原生支持时可直通。
- **验证**：CDP 冒烟——目录牌注入体积断言；describeTool → 实调 → 参数正确全链路；模拟挂 10 连接器场景断言预算守门触发与降级。

## 六、否决项存档（防止回头重议）

| 提案 | 否决原因 |
|---|---|
| 滑窗式 RAG 降级（每轮把刚过龄的换掉） | 每轮变更前缀一处，缓存从该点起每轮全灭，比不降级更贵 |
| 存根附带 AI 生成的一行要点 | 重复劳动（要点已在回答里）+ 多一轮调用；坐标行（章节标题）规则提取已够 |
| system prompt"冻结" | 语义澄清后撤回：用户改提示词须下一轮即时生效；要的只是布局稳定，有意变更付一次重启费应得 |
| metadata 激进档（system 完全不放目录） | 模糊匹配失手风险 + 导航类问题多一次往返；保守档已覆盖"我在哪/附近跳哪"高频需求 |
| used/unused 三级判用信号（P2 原设计） | 2026-08-21 上午自我推翻；当晚用户质询后**部分恢复**——否决的是"三级信号全机 + 差异化保留"（复杂度不抵收益，业界纯丢弃佐证），恢复的是"单一引用位 + 冻结语义"（零成本规则提取，与哲学第 2 条"用则标注"对齐） |
| exclude_tools 豁免清单 | 暂缓：暂无"某工具结果永不清除"的真实场景，出现后再加（参数设计已记录在案） |
| 子代理模式（subagent，业界主流） | 大炮打蚊子：阅读助手没有重到需要独立上下文窗口的研读任务；记入远景备查，不立项 |

## 七、执行顺序与依赖（2026-08-21 第三轮修订）

**P0（止血）→ P0.5（基建：v5→v7）→ P1（图片）→ P2（工具结果两层瘦身）→ P3（摘要分 scope）→ P4（目录牌）。**

排序理由：P0 动的是提示词组装（prompt.ts / use-chat-state / 基词），与 SDK 版本几乎不碰撞，先落地立即省钱；基建批随后，手搓件换原生件；P1-P4 全部建在 v7 原生插槽上（P2 活塞进 prepareStep、P4 审批用原生 tool approval），避免在旧地基上施工两遍。P0 内部：P0.1+P0.3 同一提交（都动基词与组装顺序），P0.2 独立可拆。P2 的 L1 出生截断若想提前见效（改动面小、仅 persist 路径，立即省存储/同步/备份流量），可在 P0.5 前先行——但 L2 存根活塞必须等 prepareStep 就位。P1/P2 互不依赖。每批独立验证、独立提交，出问题可单独回滚。

---

## 八、业界对照（2026-08-21 调研）与来源

调研动机：coding agent 面对的问题与我们同构（代码比书更烧 token），开源生态已卷出成熟解法。结论：**本方案 D1-D6 与业界主流逐条收敛**，个别处吸收其参数设计。

| 业界机制 | 出处 | 对应本方案 |
|---|---|---|
| repo map：tree-sitter 骨架 + PageRank 排序 + token 预算（默认 1k tokens 的全仓库地图） | [Aider](https://aider.chat/2023/10/22/repomap.html) | D2 metadata 保守档、P4 目录牌 |
| microcompact：纯机械清理旧工具结果为占位符、剥离旧消息 base64 图片、零模型调用 | [Claude Code 分层压缩分析](https://barazany.dev/blog/claude-codes-compaction-engine)、[Anthropic context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing) | D4 图片一次性、D5 存根 |
| context editing 参数族：keep 最近 3 组 / clear_at_least 保底清除量 / exclude_tools 豁免 / 客户端保留全史只清模型副本 | 同上 | keep→窗口 5 轮、clear_at_least→已吸纳 P2、exclude_tools→暂缓（无场景）、"只清副本"→被 D6 超越（本地也不留） |
| 分层触发：机械清理先上、语义摘要（compaction）兜底；结构化五段式摘要 | [Anthropic compaction](https://platform.claude.com/docs/en/build-with-claude/compaction) | 活塞（机械层）+ 前情摘要（语义层）双层同构；五段式→P3 按 scope 定制 |
| prompt cache：静态前缀折扣计费，Claude Code 重度依赖 | Anthropic 文档 | D3 静止在前 |
| 子代理：独立窗口干脏活只回传结论 | [Kimi CLI](https://moonshotai.github.io/kimi-cli/en/customization/agents.html)、[OpenCode](https://opencode.ai/docs/agents/) | 否决（大炮打蚊子），远景备查 |
| Tool Search Tool / 渐进式披露：工具定义不 upfront 注入，按需检索取回 | [Anthropic 2025-11 官方发布](https://medium.com/@richardhightower/do-agent-skills-kill-mcp-only-if-you-ignore-the-timeline-7c59c1a964cd)、[Spring AI 实现](https://docs.spring.io/spring-ai/reference/api/tools.html) | D8 目录牌 + describeTool |
| tool overload 量化：工具池 >20-30 选工具准确率劣化（13.62%→43.13%）；Cursor 40 警示线 / 80 硬上限；预算守门 + 动态裁剪 | [RAG-MCP 论文](https://arxiv.org/html/2505.03275v1)、[Speakeasy 动态工具集（-96% 输入）](https://www.speakeasy.com/blog/how-we-reduced-token-usage-by-100x-dynamic-toolsets-v2/) | D8 预算守门（30 工具/12k 字符线、连接器超量黄条） |

我方场景红利（保留项）：存根带 chunk ID 业界没有——语义检索重放不保证复现同一批块，ID 是精确重取的廉价保险；coding agent 的 grep 可原样重放故无需。

来源：[Anthropic Context Editing](https://platform.claude.com/docs/en/build-with-claude/context-editing) · [Anthropic Compaction](https://platform.claude.com/docs/en/build-with-claude/compaction) · [Claude Code 压缩引擎分析](https://barazany.dev/blog/claude-codes-compaction-engine) · [Claude Code 八种压缩模式](https://medium.com/data-science-collective/inside-claude-codes-leak-8-compaction-modes-3-memory-tiers-44-flags-anthropic-never-talked-c9740c501e63) · [Aider repo map](https://aider.chat/2023/10/22/repomap.html) · [Aider 文档](https://aider.chat/docs/repomap.html) · [Kimi CLI Agents](https://moonshotai.github.io/kimi-cli/en/customization/agents.html) · [OpenCode Agents](https://opencode.ai/docs/agents/) · [Gemini CLI 隔离代理](https://medium.com/google-cloud/advanced-gemini-cli-part-3-isolated-agents-b9dbab70eeff) · [上下文编辑性能基准](https://hyperdev.matsuoka.com/p/how-claude-code-got-better-by-protecting) · [LangChain 上下文工程](https://www.langchain.com/blog/context-engineering-for-agents)

---

## 九、观察名单：DeepSeek Harness（DSH）与基建升级依据（D9）

**DeepSeek Harness**：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，2026-08-13 开源，MIT，TypeScript（基于 Cordis 插件框架）。"Model + Harness = Agent"、一切皆插件（模型/工具/技能/会话/沙箱/存储/Agent Loop 全部插件化，可逆效应），CLI 与库嵌入双形态。**现为 v0.1 开发者预览版，不迁移、只观察。**

- **观察窗口**：约三个月（至 2026-11），看出稳定版与插件生态长势；
- **复评条件**：出稳定版 + 插件市场成形 + 可作为库嵌入 WebView 场景有社区验证；
- **届时接入路径**：v7 的 HarnessAgent 层（标准 Agent 接口包裹外部 harness）——**接入而非换地基**；连接器体系若对齐其插件规范，属于 P4 目录牌的远期延伸；
- **即刻可收割的思想**：一切皆插件（与 P4/连接器方向契合）、可逆效应（工具操作撤销场景的启发）、"模型只是数据库驱动"的定位（provider factory 的哲学背书）。

**AI SDK v7 升级依据**：[AI SDK 6 发布](https://vercel.com/blog/ai-sdk-6)（tool approval/MCP/DevTools/prepareStep compaction 钩子）· [AI SDK 7 changelog](https://vercel.com/changelog/ai-sdk-7)（2026-06-25：reasoning control/toolsContext/审批策略/WorkflowAgent/HarnessAgent/迁移 codemods）· [官方 compaction 指南](https://ai-sdk.dev/cookbook/guides/agent-context-compaction) · [压缩 API 提案](https://github.com/vercel/ai/issues/14017) · [TS 框架对比（Mastra 服务端导向不对口）](https://langfuse.com/blog/2025-03-19-ai-agent-comparison) · [Mastra vs LangGraph.js](https://www.developersdigest.tech/blog/mastra-vs-langgraph-js-2026)
