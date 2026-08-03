# SageRead 格式策略与论文模块路线图

> 2026-07-28 定稿。本文档定义格式支持策略、论文阅读模块的三阶段规划、以及与 Zotero Brain 的整合方向。
>
> **2026-07-28 边界修订**：
> 1. 论文**搜索/下载不在 SageRead 内**——由全局助手挂接 Zotero Brain MCP（外挂/插件方式）完成，装不装都不影响文献库功能；
> 2. SageRead 论文管线**必须在没有 Zotero Brain 的情况下完全独立运作**，不读它的 `parsed/` 缓存；
> 3. **papers converter 是独立专用工具**（books_converter 同级 sidecar），不是 Books_Converter 换输出格式；产物遵循 `docs/paper-format-contract.md`。
> 4. Zotero 联动 = 直接读 Zotero 本身（Web API / 本地库），只要用户在用 Zotero 导入链路即通，与 Zotero Brain 无关。
>
> **2026-07-28 知识库模型修订**：文献库 RAG 采用**全局向量库 + 逻辑知识库**——物理上只有一个论文向量库（chunks 带 `paper_id` 与内容哈希），"文件夹的知识库"是查询时过滤而非物理分区。文件夹是组织视图，不是存储边界；向量化是增强，不是前提。详见 §3.2。
>
> **进度（2026-07-29 交接快照）**：
> - 开工顺序第 1–6 步全部完成：格式契约、paper-reader 渲染、MARKDOWN 入库与文献库列表、全局向量库与向量化（`index_paper`/`search_papers_db`）、文件夹模型（OS 式浏览 + 回收站）、论文助手 MVP（paper scope + 结构/检索工具 + 作用域选择器）
> - 标注体系完成：人工标注（复用 book_notes，三色笔触五色，锚点=块索引+字符偏移）、星标、批量管理/四格式导出、AI 自动标亮 C2（类型模板 + quote 句吸附 + AI 重点 tab）、"笔记"概念已清除（UI 层）
> - 翻译体系完成：T1 块级平行译本（三显示模式 + 幂等续翻）、T2 句级对齐、T3 词级对齐（跨语言标注/ hover 精确到词）
> - UI 打磨完成：论文标签页化与书籍分组、三段式阅读布局、skill/快捷指令/提示词预设（热插拔）、tooltip 统一、设置入口统一
> - 提示词热插拔：prompt_presets 表 + AI 中心"提示词"tab
> - **打磨细节全记录在 `docs/paper-polish-backlog.md`；方向与开放 MCP 契约见 `docs/living-library-vision.md`**
> - **下一批**：papers converter（Papers_Converter 三 bug 修复 + sidecar 整合，见 vision 文档开放问题）、第 8 步 Zotero 联动；备选：RAG 增强（LLM 重排/query 改写）、notes→标注迁移专项、术语表

## 一、格式策略决策

### 结论

| 格式 | 决策 | 理由 |
|------|------|------|
| **EPUB** | 核心格式，全功能 | 与 RAG 管线兼容性最好，foliate-js 原生支持 |
| **PDF** | 保留导入，引导转换 | 已有 Books_Converter sidecar；直接阅读无 AI 是合理的 |
| **Markdown** | 新增一等公民（论文模块） | 论文场景的最佳载体；复用现有向量化管线 |
| MOBI | 砍（不再宣传支持） | Amazon 2021 已弃用，用户可用 Calibre 转 EPUB |
| FB2/FBZ | 砍 | 俄语区格式，与目标用户群无关 |
| CBZ | 砍 | 纯图片漫画，AI/RAG 完全不可能工作 |

### 执行细节

- `SUPPORTED_FILE_EXTS` 收窄为 `["epub", "pdf", "md"]`
- foliate-js 底层代码保留（拖入 mobi 不 crash），但 UI 不宣传、不做向量化适配
- PDF 导入后：显示"建议转换为 EPUB 以获得完整 AI 体验"引导
- 非 EPUB/MD 格式打开时：AI 侧边栏显示"当前格式不支持 AI 问答，请转换为 EPUB"

### 为什么不是 .paper 格式？

不需要发明新格式。采用 **Pandoc-flavored Markdown**（标准 `.md` 扩展）：
- YAML frontmatter → 结构化元数据（title/authors/doi/year/venue/abstract）
- `$$...$$` → LaTeX 数学公式（KaTeX 渲染）
- `@key2024` → 引文标记
- `{#sec:intro}` → heading 编号与交叉引用
- 整个学术工具生态（Quarto/Jupyter Book/Zotero Better BibTeX）都建立在此之上

格式细节见 **`docs/paper-format-contract.md`**（转换器与渲染器的唯一约定）。

---

## 二、三阶段路线图

### 短期：格式清理 + PDF 体验修复（~2天）——✅ 已完成 2026-07-28

**目标**：让现有格式支持诚实、PDF 导入不再半残。

- [x] `SUPPORTED_FILE_EXTS` 收窄为 `["epub", "pdf"]`（其他格式保留导入能力为有意兼容）
- [x] upload.tsx 的 `accept` 属性对齐（已统一为 `.epub,.pdf`）
- [x] PDF 导入后的阅读体验修复（已验证）
- [x] 非 EPUB 格式打开时，AI 侧边栏降级处理（已做）
- [x] 向量化入口（vectorizeBook 工具）对非 EPUB 格式返回明确错误提示（已做）
- [x] 验证 Books_Converter PDF→EPUB 端到端流程可用性（已验证）

### 中期：Markdown 格式原生支持 + 文献库模块 MVP（~1-2周）

**目标**：Markdown 论文可以在 SageRead 中舒适阅读、向量化、AI 问答。

#### 2.1 Markdown 渲染器 —— ✅ 已完成 2026-07-28

- `packages/app/src/pages/paper-reader/` 模块已落地（paper-metadata.ts + paper-reader.tsx）
- react-markdown + remark-math + rehype-katex + rehype-slug + remark-gfm，KaTeX 渲染
- YAML frontmatter 解析 → 元数据面板（标题/作者/DOI/年份/期刊/摘要/关键词）
- Heading → TOC 侧栏（折叠、跳转、滚动高亮）；图片 blob 加载；滚动模式
- 待后续：进度追踪（滚动位置百分比 + 当前 heading 锚点回写）

#### 2.2 数据模型扩展 —— ✅ 已完成 2026-07-28

- `BookFormat` 增加 `"MARKDOWN"`（types/book.ts、types/simple-book.ts）
- 存储复用 `books/{id}/`：`paper.md` + `images/` + `metadata.json`（frontmatter JSON）
- id = paper.md 内容 sha256 前 16 hex（天然去重）；book_status 同一套进度/状态
- Rust 命令 `scan_papers_dir` / `save_paper`（任意目录 IO 全在后端，fs 宽权限已回收）
- 图书馆列表过滤 MARKDOWN；回收站/恢复/彻底删除零改动可用

```typescript
// 论文元数据（从 frontmatter 解析，字段名对齐 CSL，见契约 §三）
interface PaperMetadata {
  title?: string;
  author?: { name: string; affiliation?: string }[];
  date?: string;
  doi?: string;
  "container-title"?: string;
  abstract?: string;
  keywords?: string[];
  zotero_key?: string;
}
```

#### 2.3 向量化管线适配 —— ✅ 已完成 2026-07-28

- 现有 `chunk_md_file` 已能处理 Markdown 分片 → **零改造**
- `pipeline.rs` 新增 `process_paper_to_db`：读 `paper.md`，跳过 epub2mdbook
- 论文向量写入**全局论文向量库** `{app_data}/papers/vectors.sqlite`（见 §3.2），chunks 携带 `paper_id`（schema 幂等迁移）；重索引按 paper_id 删插，不删库文件
- 命令 `index_paper` / `search_papers_db`（paper_ids 过滤 = 逻辑知识库的物理实现；无嵌入配置时降级 BM25-only）；purge MARKDOWN 论文时自动清理其向量
- ⚠️ **经验：epub 插件新增命令必须三处同步**——`src/lib.rs` 注册、`build.rs` 的 `COMMANDS`、`permissions/default.toml` 的 allow 项，否则前端报 "Command not found"
- 向量化完成后，论文 RAG 工具（按文件夹/全库过滤检索）可用——随论文助手批次接入

#### 2.4 文献库 UI（MVP）—— 列表与导入 ✅ 已完成 2026-07-28

- 主页"文献库"入口（与"图书馆"并列）✅
- 文献列表：列表式（标题/作者/date·container-title/摘要两行/状态徽标）✅
- 导入：单篇目录 / 批量父目录（scan → 解析 frontmatter → 入库，重复跳过）✅
- 待做：文件夹树侧栏（§3.2 模型落地）、按文件夹分组展示、进度显示、向量化操作入口

#### 2.5 AI 侧边栏适配

- 论文阅读时的 AI 侧边栏与 EPUB 共享同一套对话系统
- Prompt 注入：论文元数据（frontmatter）+ 当前 heading + RAG 上下文
- 新增论文专属工具（可选）：
  - `getCitations`：提取论文引文列表
  - `getFigures`：列出图片及 caption

### 远景：文献库完整产品模块（~1月+）

**目标**：SageRead 成为集阅读、管理、AI 问答于一体的本地优先论文平台。

#### 3.0 核心定位：管线独立，边界清晰（2026-07-28 修订）

**SageRead 文献库的管线必须在没有 Zotero Brain 的情况下完全独立运作。**

- SageRead 负责：接受 PDF 源（直接导入或从 Zotero 导入）→ 解析处理 → Pandoc MD → GUI 阅读 → RAG/AI 问答
- Zotero Brain 负责：论文搜索与下载——以 **MCP 外挂**（全局助手挂接）方式提供；SageRead 本体不内置、不依赖其运行时，**不读它的 `parsed/` 缓存**
- Zotero 联动是直接读 Zotero 本身（Web API / 本地库），与 Zotero Brain 无关
- papers converter 是独立专用工具（books_converter 同级 sidecar）：论文的元数据（作者/期刊/DOI/摘要）、无目录有层级的结构与图书完全不同，必须针对性设计

#### 3.1 论文助手 Agent（独立于现有双 Agent）—— ✅ MVP 已完成 2026-07-28

文献库内新增第三个 Agent 上下文（`AgentScope` 加 `"paper"`）：

| | 阅读助手 | 全局助手 | **论文助手（新）** |
|---|---|---|---|
| 入口 | 书内侧边栏 | 主页 | **文献库阅读视图右侧栏** |
| 范围 | 单本 EPUB | 整个书库 | **本篇/所在文件夹（含子）/全部/自定义** |
| 工具 | ragSearch 等 | 动作工具 | **分层能力（见下）** |
| 提示词 | reader-prompt | central-prompt | **paper-prompt（`constants/paper-prompt.ts`）** |

**能力分层（向量化是增强，不是前提）**：

- **基础层（无需嵌入模型）**：`getPaperToc` / `readPaperSection` / `getPaperInfo` 结构工具直接操作 paper.md；prompt 注入论文元数据 + **当前小节正文**（PaperReader 经 `onActiveHeadingChange` 上报当前 heading，截断 3000 字符注入）。
- **增强层（已向量化）**：`paperSearch` → `search_papers_db`，**作用域选择器在聊天面板里**（本篇=默认/所在文件夹含子/全部/自定义文件夹），发送时换算 paper_ids。
- 持久化：复用 threads 表（`scope="book"`、`book_id=论文 id`，零迁移）。
- 待后续：列表视图的文件夹级聊天入口、paper 专属技能 scope、划词引用、getFigures/getCitations 工具。

#### 3.2 RAG 管线：全局向量库 + 逻辑知识库（2026-07-28 修订）

**核心原则：文件夹是组织视图，不是存储边界；向量化是增强，不是前提。**

- 图书馆：一本书一个 vectors.sqlite（现有模式不变）
- 文献库：**物理上只有一个全局论文向量库**（复用 sqlite-vec + BM25 hybrid 引擎）
  - 每条 chunk 携带 `paper_id` + 内容哈希（重建幂等：未变 chunk 跳过重嵌入）
  - "某文件夹的知识库" = 查询时按 paper_id 集合过滤，**不是物理分区**
  - **迁移论文 = UPDATE 关系表**，向量数据不动，无需重嵌入
  - **删除论文 = DELETE WHERE paper_id**
  - 只有换嵌入模型或改分片策略才需要重算
- **文件夹模型（对齐 Zotero Collection 语义）**：
  - `folders` 树表（id, name, parent_id），论文可挂任意层级节点
  - `paper_folders(paper_id, folder_id)` 多对多关系表（一篇论文可属多个文件夹）
  - 检索范围默认 = 精确选中文件夹；列表浏览为操作系统式导航（子文件夹以文件夹行点击进入，配面包屑），不设"包含子文件夹"开关
  - Zotero 导入：Collection 层级 → folders 树，成员关系 → paper_folders
- 元数据过滤：按作者/年份/期刊/DOI 精确筛选（来自 frontmatter）

#### 3.3 论文处理工具页（SageRead 原生，类 Books Converter 定位）

独立的工具页面（不是对话里操作），流程：

```
导入源                    处理                         输出
─────                    ────                         ────
Zotero 同步    ─┐
本地 PDF       ─┼→  解析（MinerU 级）           ─→  一键导入文献库
本地 Markdown  ─┘    → 结构化 Pandoc MD              + 自动向量化
                     → 标题层级重建                   + 打开即阅读
                     → 公式/图表/引文标注
                     → 翻译（可选，复用辅助模型）
                     → 元数据提取（frontmatter）
```

- 实现形态：独立 sidecar **papers converter**（books_converter 同级，headless CLI + PyInstaller exe + JSON 进度协议）——不是 Books_Converter 改输出格式，论文元数据与层级结构需专门设计
- **导入准入规则（2026-07-29 定稿）**：
  - 单篇 PDF 直接拖入即走解析；批量导入/Zotero linked-file 扫描**只接受 PDF**，非 PDF（docx/epub/html/CAJ/kdh/nh 等）拒收并给出"已跳过"清单
  - CAJ 是知网 CNKI 专有格式（CAJViewer 专用），MinerU 无法解析，提示用户从 CAJViewer 导出 PDF
  - **>200 页拒收**（正常论文 10–50 页、综述极少超 150；超出的更像书/学位论文，提示"建议放图书馆"）
- 解析引擎：MinerU Cloud API（或未来本地模型），SageRead 原生调用（Rust/sidecar）
- 结构化后处理：解析产物 → Pandoc Markdown（补 heading 层级、frontmatter、引文标记），输出遵循 `paper-format-contract.md`
- 进度 UI：流式进度条（复用 Books Converter 的进度事件模式）

#### 3.4 Zotero 联动

- 从 Zotero 导入：直接读取 Zotero 库（Web API 或本地库，**不经 Zotero Brain**）→ 选择论文 → 取 PDF → 解析 → 入库
- Collection 映射：Zotero 文件夹树 → folders 表，成员关系 → paper_folders（§3.2）
- 元数据同步：标题/作者/DOI/年份/标签
- 可选双向：SageRead 批注/笔记回写 Zotero（远景）

#### 3.5 PDF 原文对照面板

- 阅读 Markdown 论文时，侧边可展开原始 PDF（pdf.js 只读）
- 利用解析产物的页码映射（`<!-- page: N -->` 锚点）做位置同步
- "当前阅读位置 ≈ 原文第 N 页"

#### 3.6 论文发现（边界外，MCP 外挂；2026-07-28 修订）

- 论文搜索与下载**不属于 SageRead 的工作**，由全局助手挂接 Zotero Brain MCP 完成（插件方式，装不装都不影响文献库功能）
- SageRead 侧只保证：外部获取到的 PDF 进入导入链路后体验顺滑
- 不做 GUI"发现论文"面板

#### 3.7 翻译（2026-07-29 策略定稿；**T1 已落地**）

**总原则：原文是唯一事实源，翻译是"块级平行显示层"**——数据库、向量库、frontmatter 一个字不动。

> **T1 状态（2026-07-29）**：切块器（remark mdast，fixture 226 块与 DOM 枚举逐块相等）、平行译本 `translation-zh.json`（块哈希幂等/续翻/取消）、原文/译文/逐段对照三模式（persist `paperViewMode`）、对照译文 div 以 `data-translation` 排除出块枚举（锚点零漂移）、译文模式标注块级降级且禁新建、元数据 `title_zh`/`abstract_zh` 均已落地。rehype-raw 已启用（译文统一 escapeHtml，后续可加 rehype-sanitize 收紧）。
>
> **T2 状态（2026-07-29）**：句级对齐表已落地——翻译完成后对有译文的块自动计算（`paper-alignment-service.ts`：两侧切句 → 批量 embed（OpenAI 格式，Ollama `/api/embed` 按 URL 结尾识别）→ 余弦相似度矩阵 → 单调 DP (1,1)/(2,1)/(1,2)，cost=1-参与句平均相似度；低置信句对标 `low`），结果写回译本 `blocks[idx].align`（缓存键=块源 hash+译文 hash，幂等），无嵌入能力写 `alignStatus:"skipped"` 并提示；翻译下拉有"重建句对齐"（无对齐/陈旧时显示）。跨语言映射（`paper-cross-anchor.ts` 纯函数）：英文标注在对照/译文模式的中文侧显示同色低透明映射高亮（`-tgt` 注册名；译文模式有对齐的段升级为句级精确，无对齐维持块级降级）；中文划词恢复完整弹窗，标亮经 `mapTgtRangeToSrc` 句吸附映射创建**英文锚点**标注（无对齐的块标亮禁用并提示）；句子 hover 开放到对照模式译文 div。**待 T3+**：词级对齐（§3.7 词级方案）、术语表沉淀、译文 chunks 入向量库、rehype-sanitize。
>
> **T3 状态（2026-07-29）**：词级对齐已落地（§3.7 方案 a）——句对齐之后的第二相位在同一"翻译 → 句对齐 → 词对齐"链路自动执行：句对内分词（英文按词、中文按单字，无 jieba 依赖）→ 全部待算块的句对 token 汇总分片批量 embed（256 条/6k 字符双上限；单片失败仅牵连该片覆盖的块）→ 句对内余弦矩阵 + 单调 DP（(1,1)/(1,k)/(k,1)，k≤4，cost=1-参与 token 平均相似度，<0.45 标 `low`），结果写回译本 `blocks[idx].alignW`（幂等键同句级，顶层 `alignWStatus`；"重建对齐"句词两级同时重建）。映射升级：有 `alignW` 时 `mapTgtRangeToSrc`/`mapSrcRangeToTgt` 用词级精确区间（划中文几个字 → 英文精确词区间；英文旧标注在中文侧精确到词渲染），词级缺失/未命中自动回退句级；live≠stored（oneLine 折叠/markdown 渲染）时经词 token 下标对应换算（`mapOffsetsViaTokens`），失败降级句级句吸附。翻译下拉重排为三区（显示模式 radio+图标 / 翻译入口+主题色进度条 / 句词对齐状态行+"重建对齐"有译本时始终可见、无嵌入模型点击给配置引导 toast）；AI 重点生成按钮改全局主题色。**待 T4+**：术语表沉淀、译文 chunks 入向量库、rehype-sanitize。

- **产物形态**：`{blockIndex → 译文}` 的平行映射（存 `books/{id}/translation-{lang}.json`，块级源文本哈希做幂等键：只翻未翻译/已变化块，除非用户要求重译）。**不产出翻译版 markdown**。
- **显示模式**：原文 / 译文 / 逐段对照。渲染器始终渲染原 markdown 的块结构，译文模式替换块文本、对照模式块后追加——块索引即对齐键（与 C1 标注锚点同一套块枚举）。
- **标注兼容**（C1 锚点天然翻译就绪；T2 起译文侧经句对齐升级为句级精确，T3 起有词级对齐的块精确到词）：
  - 原文模式：精确高亮（偏移有效）
  - 逐段对照：原文段精确高亮 + 译文段词级/句级映射高亮（无对齐的块静默跳过）
  - 全译文：有词级对齐的段**词级精确高亮**（T3）；仅句级对齐的段句级精确高亮（T2）；无对齐的段降级为块级高亮
  - 中文划词标亮：经词级/句级对齐映射创建英文锚点标注（原文永远唯一事实源）
  - 笔记挂在标注实体上，与显示语言无关
- **TOC/标题**：heading 在块枚举内，译文取同一张映射表，无单独通道。
- **元数据**：`metadata.json` 增加展示用 `title_zh`/`abstract_zh`（frontmatter 不动；作者/期刊/DOI 不翻）。
- **RAG/工具**：完全不受影响（永远检索原文 chunks）。可选增强：译文 chunks 以同 paper_id 入库，提升中文查询的跨语召回。
- **学术翻译要求**：术语、人名、化学式、数学公式前后一致且不误译；**动态术语表已落地（2026-08-03）**——首轮翻译前辅助模型抽取 30~60 条领域术语（随译本落盘 `glossary` 字段、续翻复用、重翻重抽），后续批次与元数据翻译注入 prompt 强制一致；术语表跨论文/文件夹沉淀复用仍待做；`$$公式$$`/代码块/References 默认不翻。
- **工程不变量**：翻译管线的源文本块切分规则必须与渲染器 `listBlocks` 的 DOM 块枚举严格一致，落地时加一致性测试。
- **词级对齐（2026-07-29 定稿，对标 ScholarRead 的词级双语标注）**：在句级 {src,tgt} 对齐对内进一步做**词对齐**——方案：(a) 翻译时预计算（推荐）：句对两侧分词 → 本地嵌入服务取向量 → 余弦相似度矩阵 + 单调性 DP 对齐（vecalign 思路），对齐表随译文落库；选区跨语言映射 = 查表，零实时调用。(b) 选区时现算（轻量备选）：中文选段与英文候选句各发一次嵌入取最近邻。以此实现"中文侧划词 → 英文锚点"的词级对应，锚点永远存原文。
- 模型：复用辅助模型或用户指定模型。

#### 3.8 导出（2026-08-03 落地）

**给用户快捷方式拿到解析后的论文文档：内容（原文/译文/对照）+ 标注 + 图片合并为一份文档。**

- **管线** `lib/export-paper.ts`：视图 markdown 复用 `buildPaperViewMarkdown`（原文唯一事实源，译文不落盘）；导出文档 = frontmatter 原样 + 标题 H1（译文/对照优先 `title_zh`）+ 模式化正文 + 可选文末标注节（复用标注导出渲染器，按锚点块序排序）。
- **格式**：Markdown / HTML / PDF（打印版 HTML → 系统浏览器另存，与标注 PDF 导出同路线，零新依赖）；图片统一 base64 data URI 内嵌（单文件自包含，零新权限）。
- **对照 markdown 原生重建**：`buildPaperBilingualExportMarkdown`——译文以 md 原生形式插入（块后 `> 译文`、列表项缩进续行、表格单元格 `<br>`），公式保持 `$...$` 文本；不烘焙 KaTeX 进 md（MathML+HTML 双份渲染、臃肿不可编辑）。
- **HTML**：marked 渲染 + 公式占位保护 → KaTeX 服务端烘焙（样式与 20 个 woff2 字体全内联，动态 import 懒加载）；行间公式以 `<pre>` 占位保证导出 DOM 块枚举与阅读区一致（锚点对齐前提）。
- **标注内联高亮（HTML/PDF）**：锚点（块索引+textContent 偏移）按模式落位——原文/对照英文侧直接公式感知映射（`mapSourceOffsetsToLive`）；译文模式先经句/词对齐（`mapSrcRangeToTgt`）映射为中文区间（词级精确/句级吸附，未翻译块回退英文，无对齐静默跳过）；对照模式中文侧镜像（低透明）。逐文本节点 `<mark>` 包裹（笔触三态 + 颜色变量）。Markdown 格式受格式限制只做文末标注节。
- **入口**：论文顶栏 Download 按钮 → `paper-export-dialog.tsx`（内容默认跟随当前显示模式/无译本禁用译文与对照、附标注/嵌图片复选、三格式）。
- **遗留**：译文/对照模式 frontmatter 仍是英文元数据（`title_zh`/`abstract_zh` 不回写 YAML）。

---

## 三、与旧方案（paper-reading-feasibility.md）的关系

| 旧方案（7/22） | 新方案（7/28） | 变更原因 |
|---|---|---|
| 多格式解锁（MOBI/FB2/CBZ） | **砍掉** | 无 AI 价值，无用户价值 |
| 论文 MD 打包成 EPUB 再导入 | **Markdown 原生渲染** | 公式/引文/交叉引用需要原生支持 |
| Zotero Brain 纯 MCP 挂接 | **管线独立 + MCP 外挂**（2026-07-28 再修订） | 文献库必须在无 Zotero Brain 时完整可用；发现/下载归外挂 |
| "不合并、不搬运" | **要的是思路和功能，不是现成工具** | 现有代码无Pandoc/无标题层级，需重做 |
| PDF 对照面板（阶段 2） | 保留，移至远景 | 优先级让位于 MD 渲染器 |

`paper-reading-feasibility.md` 中的核心洞察仍然成立：
- "SageRead 的 RAG 链路已格式无关"（向量化输入就是 MD 分片）
- "Zotero Brain 恰好握着 PDF→结构化 MD 这一段"（其 MinerU 经验供 papers converter 参考，但产物与运行时不复用）
- "论文 MD 与 EPUB 章节结构天然同构"

---

## 四、生态位判断

**当前开源社区不存在：本地优先 + 舒适阅读 GUI + 论文 RAG + Zotero 联动 的一体化桌面应用。**

| 现有方案 | 缺什么 |
|---|---|
| PaperQA2（7k stars） | 纯 Python CLI/库，无阅读 UI |
| ScholarRead | 闭源、订阅制、数据上云、**无 RAG 管线**（仅导入-解析-整理-渲染，无法跨文献深度交互） |
| KnowNote | 通用知识库，非论文阅读器 |
| PapersGPT for Zotero | Zotero 插件，无独立阅读体验 |
| KOReader | 电子书阅读器，无 AI/RAG |

SageRead 论文模块 = **PaperQA2 的 RAG 精度 + ScholarRead 的阅读体验 + 本地优先隐私 + Zotero 生态**

这是开源社区在 AI 时代阅读领域最重要的基建之一。

---

## 五、技术风险与开放问题

1. **Markdown 批注方案**：epubcfi 不适用，需设计文本锚点系统（heading + 段落索引 + 字符偏移）
2. **MinerU 解析质量**：双栏/公式密集论文需 5-10 篇真实验收（见 `paper-format-contract.md` §五）
3. **大论文渲染性能**：100+ 页综述的 Markdown 渲染需虚拟滚动或分段加载
4. **MinerU 依赖**：免费额度/限速/可持续性（papers converter 的体验基石；Zotero Brain 已非运行时依赖）
5. **全局向量库规模**：100 篇 × 50 chunks = 5000 向量，sqlite-vec 暴力检索无压力；万篇量级再考虑索引（已有结论，非阻塞）
6. **同步**：paper.md 走 L2 书籍文件通道天然兼容；**images/ 不在文件通道内（已知限制）**；全局向量库与 folders/paper_folders 表是否随行同步待定

---

## 六、开工顺序（2026-07-28 定，随进度更新）

1. **格式契约**：`docs/paper-format-contract.md` ✅
2. **MD 渲染器 + 文献库路由**（§2.1）✅
3. **导入与数据模型**（§2.2/2.4）：MARKDOWN 入库、列表视图、元数据展示 ✅
4. **向量化适配**（§2.3/3.2）：`index_markdown` 入口 + **全局论文向量库**（chunks 带 paper_id + 内容哈希）+ 文献库 UI 向量化操作/状态——**当前批次**
5. **文件夹模型落地**（§3.2）：folders 树表 + paper_folders 关系表 + 文献库文件夹侧栏（新建/嵌套/挂载/迁移，迁移只动关系表）
6. **论文助手**（§3.1/2.5）：paper-prompt + 基础层（全文/小节注入 + 结构工具，无 RAG 可用）+ 增强层（语义/跨论文检索）
7. **papers converter**：独立 sidecar，PDF → 契约产物（参考 Zotero Brain 的 MinerU 经验，代码新写）
8. **批量导入目录增强 + Zotero 联动**（§3.4）：供给端闭环

块状/列表视图细化、PDF 对照面板（§3.5）、Markdown 批注锚点均在上述批次之后单独成批。
