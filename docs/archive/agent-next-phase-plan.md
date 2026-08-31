# 下一阶段执行计划（G–J 批）

> 状态：G–I 批 + J1 部分 + J3 清单已落地（2026-08-08）；剩余：J1 算法残留两项（句首虚词错配/非连续对应，需探针实验场）、J2 多模态（待交互稿）。
> 本文档承接 `docs/archive/agent-ecosystem-plan.md` 附录盘点，
> 是 S–F 批全部落地后的下一轮施工蓝图。原则不变：按批次顺序施工、每批验收后进下一批、
> 破坏性操作恒确认、密钥绝不出 app 进程。

## 批次 G：向量模型体验重构（本阶段核心新需求）

背景：① 曾发生硅基流动向量模型参数（维度）变更导致用户向量库大面积出错的事件；
② 大部分用户不知道向量模型是什么、在哪申请、换模型意味着什么；
③ 现有设置页（`components/settings/vector-model-manager.tsx`）版面粗糙、无引导。

### G1 向量模型设置页重构（引导与解释）

现状页面只有"名称/URL/模型ID/Key"裸表单。重构为分区引导式页面：

1. **顶部说明区**（面向零基础用户）：
   - 什么是向量模型：把文字转成数字向量，支撑"语义搜索"（聊书问答、论文检索、句词对齐）
   - 用在哪：列出实际消费点（RAG 聊书、paperSearch、句词对齐的嵌入），让用户理解后果
   - 在哪申请：常见云端服务商及申请链接（plugin-opener 外链），含免费额度提示
2. **三种接入方式分区卡片**：
   - 云端 API（填 URL + Key）
   - 本地部署（指向 G2 的快捷引导）
   - 内置模型（llama.cpp 通道，说明平台限制：当前主要面向 macOS，Windows 走外部/本地服务）
3. **后果与风险区（重点）**：
   - 醒目警示："更换模型或维度变化后，已向量化的书库/文献库**全部失效**，需要重新向量化"
   - 展示当前向量库现状：已向量化条目数、所用模型、维度
   - 提供"全量重新向量化"入口（复用批量向量化）
4. **维度说明与校验**（并入 G3）

**验收**：新用户零背景读页面能回答"是什么/去哪申请/换了会怎样"三问；切换模型时出现强警示与重向量引导；页面 tsc/biome/build 全绿。

### G2 本地向量模型接入引导（技术接口已存在，补引导）

**调研结论（关键）**：本地接入在技术上**已经支持**——自定义 URL 配置兼容
OpenAI 兼容端点（`/v1/embeddings`）与 Ollama 原生端点（`/api/embed`，测试逻辑已识别），
apiKey 可留空。即用户本地部署 Ollama / Xinference / llama.cpp server / TEI 后，
把 URL 填进来即可用。这就是用户问的"本地 API"。本项不新造协议，补齐引导：

1. **预设快捷填入按钮**：Ollama（`http://127.0.0.1:11434/api/embed`，模型 id 如 `bge-m3`）、
   Xinference（`http://127.0.0.1:9997/v1/embeddings`）、通用 OpenAI 兼容（`/v1/embeddings`）
2. **本地部署指引文案**：以 Ollama 为主线（`ollama pull bge-m3` → 保持运行 → 填入预设 → 测试），
   提及 Xinference/TEI 作为进阶选项；本地模型免 Key 说明
3. **测试按钮文案强化**：返回维度与配置不符时明确告警（硅基流动事件防御）

**验收**：按指引在本机起一个 Ollama（或等价服务）可一键预设 + 测试通过；维度不符有告警。

### G3 维度校验与换模型警示（小，随 G1 落地）

- 测试连接时解析返回向量维度，与配置 `dimension` 不符 → 红色告警并建议修正
- 切换"当前使用的向量模型"时，若存量向量库非空：弹确认对话框说明失效范围 + 重向量入口

## 批次 H：对话体验

> ✅ 2026-08-08 落地：H1 流式节流落库+中断结算（onFinish isAbort 记相位，ready 后延迟 200ms 打标落库，避开 SDK 节流丢尾）；末条 assistant 「重新生成」恒存在（用户拍板，不依赖错误/中断）；中断提示精简为「回复已中断」；H2 重挂载续接最近对话（central 防污染）；H3 宽版布局收敛为全局助手头部快捷开关（StretchHorizontal 图标，设置页不再提供；宽版=去掉宽度上限自适应版面，消息/输入/滚动按钮同口径）+ 输入区顶边拖拽加高；顺带删除全局助手头部冗余设置按钮、修复分页跨章节回落滚动（manager 陈旧设置快照回写 store 根因）。

### H1 对话断点续传（中大，用户强痛点）

现状：整条回复完成才落库；app 崩溃/异常中断时，当次对话（用户消息 + 已产出回复）全部丢失，
用户看不到中断在哪一步。

方案：
1. **用户消息发送即落库**（handleSubmit 里 createThread 后立刻 editThread 写入用户消息）
2. **assistant 增量落库**：流式过程中节流写盘（如每 2s 或每 N parts）+ abort/异常/onError 时
   把已产出 parts 立即结算写入；中断消息标记 `interrupted` 元数据
3. **重进现场恢复**：加载对话时保留中断消息原样展示（含已产出的思考/正文/工具卡），
   末尾提供"继续生成"动作（复用 handleRetry 语义）
4. 注意与 P3 尾部窗口、sanitizeMessageParts 的兼容（中断残留 parts 已被归一，落库口径一致）

**验收**：流式中杀进程 → 重启后对话完整可见且标"已中断"，可继续生成；正常完成的对话行为不变。

### H2 切页续接对话（小修，用户已确认语义）

- 切换页面/tab 时**续接上一次对话**（全局助手与各阅读区同理）；
  **仅点击"新对话"按钮才开新对话**（用户 2026-08-08 确认）
- 现状排查要点：全局助手离开 #/chat 再返回时 currentThread 是否被重置；
  SideChat 卸载时 `setCurrentThread(null)` 的时机；按 bookId/paperId 记忆 lastThreadId
- 新对话按钮行为保持不变（显式清空 + 新 thread）

**验收**：全局助手聊几句 → 去书库 → 回来对话仍在；书籍/论文 tab 切走切回同理；点新对话才清空。

### H3 宽版聊天布局 + 输入区拖拽高度（中）

1. 设置项"宽版聊天布局"：放宽聊天区与消息列 max-w 约束（全局/书籍/论文三 scope 同改），
   默认关闭保持现状观感
2. 输入区顶边拖拽手柄：悬停框线变可调光标，向上拖放大输入区（方便大段输入），
   复用现有 re-resizable 模式；高度记忆到本地设置

## 批次 I：Agent 能力补完

> ✅ 2026-08-08 落地：I1 processPaper action=reparse（复用 paper-reparse-service，filePath 可覆盖，tool-guard 恒确认）；
> I2 app 侧 Rust 本地通道（localhost-only HTTP 随机端口 + 一次性 token 写 mcp-local.json，GET /health 免 token、POST /embed 凭 token，密钥走 keyring 不出 app）+ sageread-mcp 侧 semantic_search 改走本地通道（密钥路径整体移除）；端到端验证通过（embedding-3 2048 维真向量 + 检索命中）。

### I1 processPaper 补 reparse（小，地基已有）

调研结论：**手动重解析已完整落地**（`paper-reparse-service.ts` + 文献库页批量入口）：
源 PDF 解析链 `metadata.zotero_pdf_path → {appData}/books/{id}/source.pdf → 计失败`，
`replace_paper_content` 保留论文 id/文件夹归属/对话/标注。缺的只是 Agent 入口：

- processPaper 加 `action=reparse`：薄包装 reparsePapers 单篇模式，可选 `filePath` 覆盖源 PDF
- 返回文案明确提示两个后果：**译文转陈旧**（块 hash 失配，下次续翻自然更新）与
  **句词对齐需重建**（可 action=align force=true）；高亮可能漂移
- tool-guard：reparse 为破坏性动作，恒确认

### I2 sageread-mcp：从只读升级为"只读 + 执行类工具"（必做，中偏大，用户拍板）

**地基盘点（重要，不从 0 开始）**：`F:\MyProjects\sageread-mcp` 已是可用的只读 MCP server
（Node/TS，@modelcontextprotocol/sdk，bin 入口，stdio）：
- **18 个只读工具**：list_books / get_book_progress / get_reading_stats / list_threads / get_thread /
  list_book_notes / export_thread_markdown / list_tags / list_skills / get_paper_info / get_paper_toc /
  read_paper / read_paper_section / list_paper_folders / list_papers / export_paper_citation（8 种引用格式）/
  semantic_search / get_chunk_context
- readonly SQLite + sqlite-vec；有 smoke-test；README 含 Claude Desktop / Cherry Studio / Kimi CLI 接入示例
- 分发形态已定：**方案 A 独立分发**（现有即此形态：`node dist/index.js`，Node>=18）

**关键发现（改变 I2 性质的存量 bug）**：semantic_search 现状是 MCP 进程直读
`llama-store.json` 里的 apiKey 自己调嵌入接口。但**批次 A 已把 key 迁入 keyring，
llama-store.json 落盘的 apiKey 恒为空**——即云端嵌入模型的语义检索在批次 A 后实际已失效
（本地 llama.cpp 端点免 key 仍可用）。因此本地通道改造不只是安全偏好，是**必要修复**。

**已敲定约束**：
- 传输：stdio；能力：只读之外还要能调用我们的工具（如向量化检索）
- **安全红线：API Key 绝不出 app 进程**——MCP 进程不再碰嵌入配置/密钥，
  执行类调用经本地通道转发给运行中的 SageRead，app 用自己的 key 执行后只回结果

**施工内容（增量）**：
1. **app 侧本地通道（新）**：SageRead 启动时起 localhost-only HTTP（随机端口），
   启动时生成随机 token 写入 `{appData}/mcp-local.json`（仅当前用户可读）；
   端点首期一个：`POST /embed`（查询文本 → 向量，用当前选中向量模型）；后续按需加执行类端点
2. **sageread-mcp 侧改造**：semantic_search 的嵌入调用改走本地通道（读 mcp-local.json
   拿 port+token）；移除直读 llama-store.json 的密钥路径；app 未运行时返回明确降级提示
   （只读工具不受影响）
3. **向量检索执行位置**：嵌入在 app 做，sqlite-vec 近邻仍在 MCP 进程做（库是本地文件，只读安全）
4. **分发打包**（可后置）：现状要求用户自备 Node；发行时评估 Node runtime 随包 or
   文档要求 Node>=18，首发先文档要求，不阻塞
5. 审计：`/embed` 调用走 app 侧日志（复用 agent-audit 格式）

**验收**：smoke 全绿；Claude Desktop 接入后 18 个只读工具正常；配置云端向量模型后
semantic_search 经本地通道返回检索结果；确认 MCP 进程全程无 key（不再读 llama-store 密钥字段）；
app 未运行时 semantic_search 降级提示清晰、只读工具仍可用。

## 批次 J：必做质量项（用户明确：不是暂缓）

> 2026-08-08 进度：J1-3（-tgt 重复区间注册防护）已落地（paper-reader 注册前 dedupeRanges）；
> J3 手测清单已整理（见下）；剩余 J1 算法两项与 J2。

### J1 词对齐残留打磨（必做）

paper-polish-backlog D 批残留：句首虚词错配（worth↔远离）、非连续对应
（"not…at all"↔"根本"，jieba 粘连）、历史标注 -tgt 镜像疑似重复区间注册。
施工前逐个复现建 fixture，修一个绿一个。

> 2026-08-09 实验场结论（真实论文×真实嵌入×线上同款 DP）：
> 1. **句首虚词错配（worth↔远离）已不复现**：现行算法（缩放 DP+jieba）下重算与存量数据均为
>    "It is worth noting"↔"值得注意"（全库 worth/noting 词对逐个核实）——旧案已被此前修复消化。
> 2. 残留伪错配的根因是**中英词序交叉**（如 annealing at higher temperatures ↔ 在更高温度下退火，
>    not…at all ↔ 根本无法）——单调 DP 原理上不可表达，属算法固有边界而非参数可调。
> 3. 弱 token 降权原型验证：能小幅改善部分词对（because 从 4 词吞并中释放、different↔不同），
>    但对交叉区头部伪错配无效，且全库重算有洗牌存量正确词对的风险——收益/风险不对称，暂不采纳。
> 4. -tgt 重复区间注册防护已落地（dedupeRanges）。
> **2026-08-09 用户拍板：现行精度已足够，非单调对齐器不做**（避免全库重算洗牌风险）。J1 收尾。
> 若要继续提升，唯一有效方向是非单调对齐器（IBM-1 式 EM 或双向松弛 DP）——已否决，仅存档。

### J2 多模态图片输入（✅ 2026-08-09 落地，与 K2 合并实施）

实现要点：
- `ai/providers/vision-map.ts`：已知纯文本模型表（deepseek 全系/moonshot/kimi/非-v 的 glm/非-vl 的 qwen/gpt-3.5），
  未知/自定义端点默认放行（与 reasoning-map 同原则）
- 输入闸：非视觉模型添加图片当场 toast 拒绝；图片读为 base64 随消息 file part 落库，消息区渲染缩略图
- 请求闸：transport 在 convertToModelMessages 前对非视觉模型 `stripFileParts`（含历史图片）——
  上一轮多模态带图、下一轮换纯文本模型续聊绝不报错，模型只是看不到图
- 多图支持；内联定位与 K2 共用标记体系（⟦图片N⟧）

### J3 确认卡视觉与真实链路手测（✅ 2026-08-09 完成，七轮实测无真实缺陷）

实测报告：`{appData}/agent-workspace/perm-test/permission-test-report.md`（strict/relaxed/full × 工具类型 × 放行/拒绝/不再询问，含 MCP 加载弹窗独立机制澄清）。
结论：拦截无绕过、「不再询问此项」按目标（路径/操作）记忆符合设计、MCP 弹卡稳定；
早期观察到的"不稳定"均为 MCP 加载弹窗允许/拒绝差异与选项范围误解所致。
webSearch 三档均不弹卡为**设计使然**（GUARDED_TOOLS 只守写/执行/数据离机通道，搜索只发查询文本）。
测试残留：C:\\Windows\\Temp\\sage-perm-*.txt 建议用户自行清理。

## 验收期插队项（2026-08-09，J3 验收时发现的多轮工具调用卡顿）

✅ 上下文双水位活塞（用户提案，token 为单位）：点火线 256k / 泄压线 128k / 保底最近 10 条永不压缩（2026-08-09 用户拍板数值）。
旧机制超预算后每新一条消息就触发一次辅助模型压缩（频繁点火）；新机制超过点火线才压缩，
一次泄压腾出约半窗空间，间隙轮零压缩。摘要顺序不变（注入 system prompt，先摘要后具体）。
四场景功能测试全过（零压缩/泄压到位/间隙零压缩/巨无霸保底）。

✅ 渲染窗口收窄+视口填充：P3 尾部窗口 30→6 条（长消息时原 30 条远超可视区，纯浪费），
新增视口填充 effect：6 条填不满滚动区（短消息场景）时自动每次 +6 续加直到填满；
上滑渐进加载（+6/次，提前 200px 触发）保留。工具卡 JSON 截断同步降至 500 字（卡片默认折叠时内容本就不进 DOM，截断主要防展开大卡）。

✅ 多工具轮卡死真凶修复+定性（2026-08-09）：两层问题叠加。
第一层（已修）：H1 旧版"流式期间每 2s 节流落库"在工具密集长对话（几十 MB JSON）下每次全量序列化卡主线程；
砍掉流式周期写，落库改为事件触发（submitted 落用户消息、finish/abort/error 一次性落 assistant）。
第二层（定性）：production 前端对照实验证实，剩余卡顿全部来自 **React dev 模式埋点**（logComponentRender/
performance.measure 逐组件埋点，只存在于 development 构建）；`tauri build --debug` 的 production 前端实测
"丝滑到没有任何卡顿"。结论：发行版本无此问题；dev 卡顿为固有代价，如需缓解可后续加"dev 性能模式"（不排期）。

## 待排产（独立任务，2026-08-09 用户拍板：降消耗与渲染压力分离，先做渲染）

### 上下文降消耗（工具垃圾及时清理）

背景：工具调用的每次步骤都会重发全部历史+工具结果，token 总用量大（但 DeepSeek 等缓存端点实际计费低，用户拍板用量不担心，担心的是上下文被撞爆——已由活塞封顶 256k）。真正值得做的：
- **工具结果回喂截断**：回喂给模型的工具输出中，一次性任务的大 JSON（执行完即弃的"上下文垃圾"）应在后续步骤/后续轮次中截断或清除；但**有持续价值的结果要留**（如书籍/论文内容检索结果）——需按工具分类设计保留策略
- 业界通行做法对照：滑窗+滚动摘要（已有）、工具输出截断/摘要化（本项）、提示词缓存（端点自带）
- 风险：行为改动可能影响模型决策，需分类设计+实测

## 待排产（2026-08-08 用户新提，已调研）

### K1 提供商内置搜索能力适配（❌ 2026-08-08 用户拍板不做，仅存档）

调研结论：我们**未适配**任何提供商的内置搜索。各家现状：
- **DeepSeek**：开放 API 无联网搜索参数（其 App/网页版的搜索是产品层功能，不下发到 API），无需适配
- **OpenRouter**：支持（模型 id 加 `:online` 后缀或请求体传 `plugins: [{id:"web"}]`）
- 其他（OpenAI web_search 工具、Gemini grounding 等）各有原生参数面

落地形态（若做）：复用 P3 思考强度的双通道模式（reasoning-map 映射表 + providerOptions/请求体补丁），
在输入区加「联网搜索」开关。注意与现有 webSearch 工具的关系：工具是 Agent 主动检索，
内置搜索是模型自主联网，两条路径互补不冲突。

### K2 输入区内联引用（✅ 2026-08-09 落地，与 J2 合并实施）

实现（标记体系方案）：
- 引用/图片在输入区光标处插入 `⟦引用N⟧`/`⟦图片N⟧` 占位标记（textarea 注册制，未聚焦时追加末尾），
  chip 区同步展示（带序号前缀，删除同步清标记）
- 提交时按标记位置把正文/引用/图片交织成有序 parts（指代关系保真）；无标记旧式引用兼容前置
- 请求拼装 `processQuoteMessages` 改按 parts 顺序内联序列化（不再把引用堆在最前）
- 导出链路（md/html/image）本就按 parts 顺序渲染，自然兼容

## 条件触发（不排期）

- **RAG 命中块去重限流**：向量检索 top-k 被相邻重复/重叠块占满名额导致召回多样性差的问题
  （论文分块常产生近似相邻块）。轻量方案：同一文档相邻块合并/去重 + 简单 MMR。
  **出现召回质量投诉再做**。
- 轻量 AI 任务提速（辅助模型默认非推理）——观察项。

## 明确不做（用户拍板）

- **性能模式开关**（2026-08-08）：P2 休眠 + 施工 B 已覆盖大部分收益。
- **P0 KaTeX MathML 裁剪**（2026-08-08）：存量标注锚点偏移风险 > 边际收益，
  开设置剩余 ~1.8s 可接受。

## 建议实施顺序与依赖

| 顺序 | 批次 | 依赖 | 体量 |
|---|---|---|---|
| 1 | G1+G2+G3 向量模型体验重构 | 无 | 中大（UI 重构为主） |
| 2 | H1 对话断点续传 | 无 | 中大 |
| 3 | I1 processPaper reparse | 无（地基已有） | 小 |
| 4 | H2 切页续接 + H3 宽版布局 | 无 | 小 + 中 |
| 5 | I2 sageread-mcp 升级 | 地基已有（18 只读工具），增量=本地通道+密钥红线改造 | 中偏大 |
| 6 | J1 → J3 → J2 | J2 需交互稿 | 中 + 小 + 大 |

注：H2 为小修可随时插队；I2 地基已存在（sageread-mcp 仓 18 个只读工具），增量为本地通道 + 密钥红线改造。
