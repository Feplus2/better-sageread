# 侧边栏三件套：图表速跳 + 笔记面板 实施计划（2026-08-11 定稿）

> **完成状态（2026-08-11 全部落地）**：功能 A（8c18118）、B1（28d7d5d）、B2（ea0e3ec）、B3（64210b1）、RAG 伴生小项（0ecad08 + a7d4745）。
> CDP E2E 全通：图表提取三产物实测、笔记 CRUD/自动保存/预览折叠/管理态/跳转降级链、manageNotes 模型实调、存为笔记实时刷新、notes L2 本地 WebDAV 双向同步（含 LWW）。
> 剩余：坚果云全量终验（用户择时）；存量已向量化论文需重索引才有参考文献过滤。

> 来源：用户新点子两轮讨论。结论：两个功能都成立，但笔记必须钉死边界防 PKM 化。
> 前置事实：`PaperNotepadPanel` 已有 Tabs 骨架（`"annotations" | "ai-highlights"`），新 tab 直接挂；旧 `notes` 表已被迁移 DROP（`database.rs:151`），本次新建全新 schema，无历史包袱。

## 一、点子梳理与边界裁定

| 点子 | 裁定 | 理由 |
|---|---|---|
| 图表速跳 tab（图注/表注锚点，论文专属） | **通过，先行** | 纯运行时解析，零数据层改动，组会/汇报是硬场景；书籍图注体系不同，不做（边界正确） |
| 笔记面板（侧栏 Markdown 编辑器） | **通过，分三批** | "人话版总结存哪"的痛点真实：存本地松散、挂 Zotero 割裂、挂阅读侧绑定最紧；原作者的"划线想法"已并入标注，新笔记是**长文载体**，定位不冲突 |

**笔记的三条铁边界（防 PKM 滑坡，用户确认）**：

1. **只绑书籍/论文**（`book_id` 必填），不做全局笔记本——全局笔记是 Obsidian 的领域，不做
2. **编辑器不引重依赖**：textarea + 实时预览（复用 paper-reader 的 react-markdown + KaTeX + 主题渲染管线），不上 Milkdown/Tiptap
3. **AI 写入走工具 + 用户确认**：助手可提议"整理入笔记"，落笔前用户过目，不静默自动写

## 二、功能 A：图表速跳 tab（论文）

**数据源（运行时解析，不入库）**：当前文档块模型（`paper-blocks.ts`）中的 image 块（`Figure N: caption`）与 table 块（`Table N` caption）；表图比例高的综述类同样适用。中文译文：若 `translation-zh.json` 有对应块译文则并列显示（复用现有块索引键）。

**交互**：

- `PaperNotepadTab` 新增 `"figures"`；列表项 = 编号徽章（图3/表1）+ caption 一行截断（+译文一行）
- 点击 → 正文滚动定位 + 闪烁强调（复用 TOC/标注定位链路 `paper-highlight-locator`）
- 可选增强（视实现成本定）：hover 缩略图（images/ 直接有图，零成本，建议做）

**涉及文件**：

- `pages/paper-reader/paper-notepad-panel.tsx`：注册新 tab
- 新增 `pages/paper-reader/paper-figures-tab.tsx`：块解析 + 列表 + 跳转
- `paper-blocks.ts`：核对 image/table 块的 caption 字段完整性（缺则小补）

**验收**：he2024review（17 图 3 表）全部条目跳转准确；译文模式下 caption 中英并列；无图注图片（figX 组）显示为"未编号图 N"。

## 三、功能 B：笔记面板（书籍 + 论文）

### 3.1 数据模型（新表，无迁移包袱）

```sql
CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',   -- Markdown 正文
  location_tag TEXT,                  -- 位置标签：论文=heading 文本；书籍=章节标题/CFI 摘要
  location_block INTEGER,             -- 位置序（论文=块索引；书籍=CFI 排序键），排序用
  starred INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

- 位置 tag **带满结构信息、降级兜底**（2026-08-11 用户裁定）：论文存 `heading 文本 + 块索引`；书籍存 `CFI + 章节标题`。跳转优先块索引/CFI（精确）；锚点校验失败（重解析后内容漂移）退化到 heading/章节文本匹配；再失败降级为打开文档顶部 + toast。重解析是低频操作，不为它牺牲日常的精确跳转
- 排序：默认按 `location_block`（阅读流顺序），可切创建时间；星标置顶

### 3.2 UI 交互（`paper-notepad-panel.tsx` + 书籍阅读器标注面板同位）

- `PaperNotepadTab` 新增 `"notes"`（书籍侧面板同型 tab）
- 列表态：笔记卡片（标题、位置 tag chip、更新时间、★）——卡片上**无删除/导出按钮**，保持干净
- 编辑态：点开卡片 → **在左侧边栏区域内**进入编辑/预览子视图（像点进子文件夹），**不扩宽侧栏**——标题行 + Markdown textarea（等宽字体）+ 预览/编辑切换（预览走 react-markdown + KaTeX + 当前主题）+ 输入区/预览区各自可折叠；自动保存（debounce）+ 关闭未保存提示
- 管理模式：列表态点"管理" → 卡片出现复选框（多选/全选）→ 批量操作：导出 Markdown（**逐篇各自存为独立 .md 文件**）、删除；非管理态不常驻导出/删除按钮
- 快捷操作：单篇的删除/导出收纳进卡片**右键菜单**（对齐 AI 助手侧边栏会话卡片的右键菜单交互）
- 新建：自动捕获当前阅读位置（论文=当前 heading，书籍=当前章节），可手改 tag
- 星标：列表内 toggle
- 左侧栏宽度上限调大（用户裁定 2026-08-11：当前最大可调值太小，仅调参数）

### 3.3 AI 工具（central 注册，全局助手与论文助手同享）

- `noteList`（按 book_id）/ `noteRead` / `noteCreate`（title+content+location_tag 可空）/ `noteUpdate`（replace | append 两模式）/ `noteToggleStar`
- 提示词（`constants/central-prompt.ts` + paper-prompt）：增补"讨论产出可提议整理入笔记；写入前须向用户展示草稿并获确认"
- 聊天区入口：助手消息末尾的"存为笔记"快捷操作（轻量，调用 noteCreate 预填整理稿）

### 3.4 导出

- 单篇导出 `.md`（frontmatter：title/book_title/location_tag/starred/created_at）——右键菜单快捷入口
- 批量导出：**逐篇各自存为独立 .md 文件**（不做全部笔记合成一份——没人想要混杂成单文件）；经"管理"模式下发，多选/全选后批量导出（复用标注导出的下载链路 `export-annotations-*` 同构，多文件走多选保存目录）

### 3.5 备份与同步

- **L1**：app.db 全量含 notes 表，零改动（备份/恢复自然覆盖）
- **L2**：`sync/tables.rs` 注册 `notes`（pk=id，列对齐 book_notes 模式）+ 迁移中建 `_sync_log` 触发器；merge 走通用行 LWW（updated_at），删除走墓碑（对齐 book_notes 的删除语义）

### 3.6 批次与验收

- **B1（数据层+骨架）**：迁移 + notes-service CRUD + tab 列表/新建/编辑(textarea)/删除 + 位置 tag 捕获与跳转。验收：建 3 条不同章节笔记，跳转准确，重启不丢
- **B2（编辑器完整态）**：编辑/预览子视图（侧栏内、不扩宽）+ 输入/预览折叠 + 预览渲染（KaTeX/主题）+ 星标 + 管理模式（多选/全选 → 批量逐篇导出/删除）+ 右键菜单。验收：含公式表格的长笔记预览与 paper-reader 渲染一致；导出文件 pandoc 可消费
- **B3（AI 闭环）**：五个工具 + 提示词 + "存为笔记"入口。验收：对话讨论后一键整理入笔记（预填草稿可改）；Agent 经工具改笔记，列表实时刷新

## 四、不做清单（明确排除）

- 全局笔记本 / 笔记间双链 / 标签体系（只用一个位置 tag）
- WYSIWYG 重编辑器（Milkdown/Tiptap 级别依赖）
- 笔记向量化进 RAG（v2 候选，届时全局向量库加 `notes` 域即可）
- 移动端适配

## 五、风险与开放问题

1. **位置 tag 漂移**：论文重解析/编辑后 heading 文本可能变化 → 跳转降级策略已定（文档顶部+提示）；不接受存块偏移的方案（脆）
2. **侧栏内子视图切换**：列表态 ↔ 编辑态 ↔ 管理态三态在同一侧栏区域内切换，配合 swapSidebars 布局、主题透明度（怜烟背景）、窗口小宽度需过一遍手测；左侧栏宽度上限调大后同测
3. **AI 写入确认形态**：聊天内确认卡（推荐，标注 AI 已有同款交互）vs 静默+撤销——实施时对齐 AI 标注的确认卡组件复用
4. **与 AI 重点 tab 的关系**：AI 重点是"模型标的重点句"（进标注），笔记是"用户/讨论的长文产出"——prompt 里须说清分工，防助手混写

## 六、伴生小项：RAG 参考文献噪声 + topK（2026-08-11 用户批准）

- **参考文献打标**：`chunker.rs` 的 `chunk_by_markdown_structure` 按标题切分时跟踪是否处于 `# References` 区段 → `document_chunks` 加 `is_references` 列；hybrid 检索默认过滤（`includeReferences` 参数，默认 false），想要参考文献的场景可显式开启
- **topK**：`paper-search.ts` 上限 20 → 30，工具说明引导"长综述总结优先走大纲/小节读取工具，不靠堆检索数"
- 需重建向量索引生效（当前仅 2 篇论文向量化，代价最小）

## 七、与既有待办的衔接

- 表格内 `$...$` 不渲染的渲染器缺口（paper-reader 原生 HTML 表格不走 KaTeX）独立小项，B2 预览管线落地时可顺手带掉（同一渲染管线）
- L2 notes 注册后进本仓双实例 E2E 常规项
