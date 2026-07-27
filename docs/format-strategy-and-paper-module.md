# SageRead 格式策略与论文模块路线图

> 2026-07-28 定稿。本文档定义格式支持策略、论文阅读模块的三阶段规划、以及与 Zotero Brain 的整合方向。

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

---

## 二、三阶段路线图

### 短期：格式清理 + PDF 体验修复（~2天）

**目标**：让现有格式支持诚实、PDF 导入不再半残。

- [ ] `SUPPORTED_FILE_EXTS` 收窄为 `["epub", "pdf"]`（md 在中期加入）
- [ ] upload.tsx 的 `accept` 属性对齐
- [ ] PDF 导入后的阅读体验修复（当前 foliate-js PDF 分支被注释，需确认实际渲染路径）
- [ ] 非 EPUB 格式打开时，AI 侧边栏降级处理：
  - 显示提示："当前格式不支持 AI 问答"
  - 提供操作引导："转换为 EPUB 以获得完整体验"（调用 Books_Converter）
- [ ] 向量化入口（vectorizeBook 工具）对非 EPUB 格式返回明确错误提示
- [ ] 验证 Books_Converter PDF→EPUB 端到端流程可用性

### 中期：Markdown 格式原生支持 + 文献库模块 MVP（~1-2周）

**目标**：Markdown 论文可以在 SageRead 中舒适阅读、向量化、AI 问答。

#### 2.1 Markdown 渲染器

- 新建 `packages/app/src/pages/paper-reader/` 模块
- 渲染器选型：react-markdown + remark-math + rehype-katex + remark-gfm
- 支持：
  - YAML frontmatter 解析 → 元数据面板（标题/作者/DOI/年份/期刊）
  - LaTeX 公式渲染（KaTeX）
  - 代码块高亮
  - 表格（GFM）
  - 图片（本地路径 + 相对路径）
  - Heading 树 → 自动生成 TOC 侧栏
- 阅读模式：滚动为主（论文不适合翻页），可选"分页聚焦"模式
- 进度追踪：滚动位置百分比 + 当前 heading 锚点

#### 2.2 数据模型扩展

```typescript
// BookFormat 扩展
type BookFormat = "EPUB" | "PDF" | "MARKDOWN";

// 论文元数据（从 frontmatter 解析）
interface PaperMetadata {
  title: string;
  authors: { name: string; affiliation?: string }[];
  doi?: string;
  year?: number;
  venue?: string;
  abstract?: string;
  keywords?: string[];
  zoteroKey?: string;  // 关联 Zotero Brain
}
```

- 数据库 `books` 表：format 字段已存在，新增 "MARKDOWN" 值
- 论文元数据存储：`books/{id}/metadata.json`（与现有 EPUB 元数据机制一致）
- 文件存储：`books/{id}/paper.md` + `books/{id}/images/`

#### 2.3 向量化管线适配

- 现有 `chunk_md_file` 已能处理 Markdown 分片 → **零改造**
- `pipeline.rs` 新增入口：接受"已有 MD 文件"路径，跳过 epub2mdbook 步骤
- 或前端直接调用 `index_epub` 的变体命令 `index_markdown`
- 向量化完成后，RAG 工具（ragSearch/ragToc/ragContext）自动可用

#### 2.4 文献库 UI（MVP）

- 主页新增"文献库"入口（与"图书馆"并列）
- 文献列表：卡片式，显示标题/作者/年份/进度/向量化状态
- 分组：按标签或文件夹（映射 Zotero Collection）
- 导入方式（MVP）：
  - 手动导入 `.md` 文件（拖拽/选择）
  - 从指定目录批量导入（指向 Zotero Brain 的 `parsed/` 目录）
- 导入流程：复制 MD + images → 解析 frontmatter → 写入数据库 → 可选自动向量化

#### 2.5 AI 侧边栏适配

- 论文阅读时的 AI 侧边栏与 EPUB 共享同一套对话系统
- Prompt 注入：论文元数据（frontmatter）+ 当前 heading + RAG 上下文
- 新增论文专属工具（可选）：
  - `getCitations`：提取论文引文列表
  - `getFigures`：列出图片及 caption

### 远景：文献库完整产品模块（~1月+）

**目标**：SageRead 成为集阅读、管理、AI 问答于一体的本地优先论文平台。

#### 3.0 核心定位：完全吸收，原生内化

**Zotero Brain 是原型验证，SageRead 文献库才是产品。**

- 最终形态：论文处理管线（发现→下载→解析→结构化→向量化→阅读→AI问答）**全部原生嵌入 SageRead**
- Zotero Brain 现有代码是思路参考，不是运行时依赖——它连 Pandoc 格式都没做，没有标题层级，只是纯 Markdown
- 未来 SageRead 内的解析工具，一体化程度远高于 Zotero Brain 的散装脚本
- 过渡期可以数据层对接（读 Zotero Brain 的 parsed/ 产物），但终态是 SageRead 自主完成全链路

#### 3.1 论文助手 Agent（独立于现有双 Agent）

文献库内新增第三个 Agent 上下文：

| | 阅读助手 | 全局助手 | **论文助手（新）** |
|---|---|---|---|
| 入口 | 书内侧边栏 | 主页 | **文献库内** |
| 范围 | 单本 EPUB | 整个书库 | **当前文件夹/跨论文** |
| 工具 | ragSearch 等 | 动作工具 | **跨论文检索/引文推荐/对比/翻译** |
| 提示词 | reader-prompt | central-prompt | **paper-prompt（独立设计）** |

#### 3.2 RAG 管线改造：以文件夹为知识库

- 图书馆：一本书一个 vectors.sqlite（现有模式不变）
- 文献库：**一个文件夹（研究方向）一个知识库**
  - 文件夹内所有论文的 chunks 共享同一个向量索引
  - 支持跨论文语义检索（"这个方向有哪些论文讨论了界面稳定性？"）
  - 元数据过滤：按作者/年份/期刊/DOI 精确筛选
  - 复用 sqlite-vec + BM25 hybrid 引擎

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

- 解析引擎：MinerU Cloud API（或未来本地模型），SageRead 原生调用（Rust/sidecar）
- 结构化后处理：纯 Markdown → Pandoc Markdown（补 heading 层级、frontmatter、引文标记）
- 进度 UI：流式进度条（复用 Books Converter 的进度事件模式）

#### 3.4 Zotero 联动

- 从 Zotero 导入：读取 Zotero 库（Web API）→ 选择论文 → 下载 PDF → 解析 → 入库
- Collection 映射：Zotero 文件夹 → SageRead 文献库文件夹
- 元数据同步：标题/作者/DOI/年份/标签
- 可选双向：SageRead 批注/笔记回写 Zotero（远景）

#### 3.5 PDF 原文对照面板

- 阅读 Markdown 论文时，侧边可展开原始 PDF（pdf.js 只读）
- 利用解析产物的页码映射做位置同步
- "当前阅读位置 ≈ 原文第 N 页"

#### 3.6 论文发现（对话驱动 + GUI）

- 论文助手工具：搜索学术数据库（OpenAlex/arXiv/CrossRef）
- GUI 搜索入口：文献库内"发现论文"面板
- 标志性体验："一句话搜索 + 下载 + 解析 + 入库 + 向量化"全自动

---

## 三、与旧方案（paper-reading-feasibility.md）的关系

| 旧方案（7/22） | 新方案（7/28） | 变更原因 |
|---|---|---|
| 多格式解锁（MOBI/FB2/CBZ） | **砍掉** | 无 AI 价值，无用户价值 |
| 论文 MD 打包成 EPUB 再导入 | **Markdown 原生渲染** | 公式/引文/交叉引用需要原生支持 |
| Zotero Brain 纯 MCP 挂接 | **完全吸收，原生内化** | Zotero Brain 是原型不是产品，功能应内嵌 |
| “不合并、不搬运” | **要的是思路和功能，不是现成工具** | 现有代码无Pandoc/无标题层级，需重做 |
| PDF 对照面板（阶段 2） | 保留，移至远景 | 优先级让位于 MD 渲染器 |

`paper-reading-feasibility.md` 中的核心洞察仍然成立：
- "SageRead 的 RAG 链路已格式无关"（向量化输入就是 MD 分片）
- "Zotero Brain 恰好握着 PDF→结构化 MD 这一段"
- "论文 MD 与 EPUB 章节结构天然同构"

---

## 四、生态位判断

**当前开源社区不存在：本地优先 + 舒适阅读 GUI + 论文 RAG + Zotero 联动 的一体化桌面应用。**

| 现有方案 | 缺什么 |
|---|---|
| PaperQA2（7k stars） | 纯 Python CLI/库，无阅读 UI |
| ScholarRead | 闭源、订阅制、数据上云 |
| KnowNote | 通用知识库，非论文阅读器 |
| PapersGPT for Zotero | Zotero 插件，无独立阅读体验 |
| KOReader | 电子书阅读器，无 AI/RAG |

SageRead 论文模块 = **PaperQA2 的 RAG 精度 + ScholarRead 的阅读体验 + 本地优先隐私 + Zotero 生态**

这是开源社区在 AI 时代阅读领域最重要的基建之一。

---

## 五、技术风险与开放问题

1. **Markdown 批注方案**：epubcfi 不适用，需设计文本锚点系统（heading + 段落索引 + 字符偏移）
2. **MinerU 解析质量**：双栏/公式密集论文需 5-10 篇真实验收
3. **大论文渲染性能**：100+ 页综述的 Markdown 渲染需虚拟滚动或分段加载
4. **Zotero Brain 依赖**：MinerU 免费额度/限速/可持续性
5. **跨论文向量索引规模**：100+ 篇论文 × 50 chunks/篇 = 5000+ 向量，SQLite-vec 是否够用
6. **同步**：论文 MD 文件走 L2 书籍文件通道（sha256 内容寻址）天然兼容
