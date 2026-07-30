# 活的向量库：SageRead 开放地基愿景

> 2026-07-29。整理自用户的战略思考，作为项目的方向性文档。回答"我们到底在造什么"。

## 一、核心命题：从死的 PDF 到活的向量库

我们表面上在做"论文阅读器"，实际上在做一件更决定性的事：**把论文从死的 PDF 变成活的、可计算的知识资产**。

PDF 是科研知识的坟墓格式——人能读，机器只能看影。一旦论文被结构化（Pandoc Markdown）、被索引（向量库 + BM25）、被锚定（块/句/词三级坐标系）、被关联（文件夹知识库、标注、对齐译本），它就从"文档"变成了"数据"：

- 能问答（RAG 对话）
- 能总结与产出（AI 重点、翻译、导出）
- 能被程序任意取用（MCP / 工具调用）
- 能深度参与科研流程（发现、对比、写作）

这是基础设施，不是功能。SageRead 正在搭建的是 **AI Agent 深度嵌入科研工作流的低门槛入口**。

## 二、已建成的地基（2026-07-29 盘点）

| 层 | 资产 | 对外价值 |
|---|---|---|
| 格式层 | Pandoc Markdown 契约（`paper-format-contract.md`，CSL 对齐 frontmatter） | 生态兼容，pandoc/Quarto/Zotero 直接消费 |
| 结构层 | `books/{id}/paper.md + images/ + metadata.json`；folders 树 + paper_folders 多对多 | 清晰的文件与组织语义 |
| 检索层 | 全局向量库（chunks 带 paper_id + **chunk 原文** + BM25 hybrid + 逻辑知识库过滤） | 文本层模型无关；检索可作为服务外包 |
| 锚点层 | 块/句/词三级坐标（标注、翻译对齐、句/词级跨语言映射） | 精确到词的机器可寻址性 |
| 标注层 | book_notes（高亮+评论+星标+AI 分类重点，source/category/starred） | 人与 AI 的知识标记沉淀 |
| 对齐层 | 平行译本（块哈希幂等）+ 句/词对齐表 | 双语知识态 |
| 智能层 | 三 Agent scope（central/reader/paper）+ 提示词预设热插拔 + 技能复选 | 可编程的行为面 |

## 三、开放契约：SageRead MCP 的三层暴露

未来的 SageRead MCP 服务器（供 SageWrite/SageResearch/任意 Agent 连接）按三层设计，**读优先、写谨慎**：

1. **文本与结构层（模型无关，永远可用）**：文献库目录树、论文元数据、paper.md 全文、chunks 原文、标注与星标、译本与对齐表。任何 Agent 不需要嵌入模型即可消费。
2. **检索服务层（我们提供结果，而非暴露向量文件）**：`search(query, scope?)`——query 由 SageRead 侧 embed（用用户已配置的模型），返回 hybrid 融合结果。调用方**不碰嵌入模型**，向量空间耦合被封装在 SageRead 内部。BM25-only 模式作为无嵌入模型时的降级。
3. **行动层（写操作，逐个授权）**：导入 PDF（走 converter 管线）、创建/修改标注、写回笔记与星标、触发翻译/对齐/向量化。这是"Agent 操作文件的工具"的正规入口——比自己写文件操作工具更安全（语义化、可审计、有边界）。

## 四、嵌入模型版本策略（"要不要同一模型"的正式回答）

语义检索确实要求查询与库在同一向量空间，但这不构成开放障碍：

1. **原文永在**：`document_chunks.chunk_text` 保存全部 chunk 原文——换模型 = 离线批量重嵌入，不是数据迁移灾难。`vectorization` meta 已有 model/dimension 字段，可做版本标记与一键重建。
2. **检索即服务**：外部 Agent 通过 MCP 拿检索结果，不需要持有模型（见三层契约第 2 层）。
3. **BM25 兜底**：关键词检索模型无关，永远可用。

结论：**模型会迭代，但我们的资产不绑定任何模型**——绑定模型的只是"索引"，索引永远可重建。

## 五、联动想象：SageWrite / SageResearch

- **SageWrite**（论文写作工具）连 SageRead MCP：按文件夹知识库检索论据 → 引用精确到词（锚点）→ 插入草稿；写作侧的结构化草稿又可回流为新的知识资产。
- **SageResearch**（科研流程 Agent）：发现（zotero-brain MCP）→ 入库（converter 管线）→ 结构化与索引（SageRead）→ 综述生成（跨论文对比、分类框架）→ 写作（SageWrite）。
- 文献库文件夹即"研究方向"：一个课题一个知识库，天然是多 Agent 协作的共享工作区。

## 六、开放问题（持续维护）

- [ ] **papers converter 整合**（下批）：~~审查 F:\MyProjects\Papers_Converter~~ 已审查（2026-07-29，结论：当前产物不可靠但核心可修）——**必修**：~~①table 分支缺失（123 篇 0 表格，源 table_body 是现成 HTML）~~ ~~②补编号触发条件过窄（67% 无 Abstract 论文压平 H1）~~ ~~③图编号正则截断小数（Fig 12.4→fig12.jpg 互相覆盖）~~ ~~④元数据全 LLM 猜测 → 接 Zotero/CSL-JSON（author/container-title/date/citekey 以它为准，收益最大）~~ **①②③④ 已修复（2026-07-30）**：table 分支透传 HTML 表体+caption；无 Abstract 论文以标题后首个非固定段标题为正文起点补编号；图编号支持小数（文件名 `fig12-4.jpg`）；`zotero_meta.py` 读 CSL-JSON 导出（`export_zotero_csl.py` 生成 → `data/zotero_csl.json`），Zotero 字段优先、LLM 只补 abstract，slug citekey 优先。**整合形态**：sidecar（books_converter 同级）+ 验收门禁 + 暂存区自动入库（scan/save_paper 现成）→ 可选自动向量化/翻译一条龙；文件夹导入降级为高级入口，主路径 = PDF 拖入；文档写清接受的数据结构（契约已备），后期出开发者详档。存量 123 篇产物待按修复后管线批量重转。**二轮修复（2026-07-30）**：⑤整书守卫（>200 页拒收，引导走图书馆导入，论文几乎不可能超 200 页）；⑥MinerU VLM 版面缺陷——双栏页正文被并进表格 HTML（重解析复现，非旧缓存问题；全库 148 篇仅 2TTNVYWG 命中）→ 后处理拆分器按判据拆出正文/标题单元格；⑦现行 VLM 输出的 `<sup>/<sub>` 标签与 nbsp 归一为 LaTeX（脚注符号不包 `$^{}$`）；⑧APS 罗马数字编号体系（I.→A.→1. 层级，枚举 I–XV 防 C./D. 字母小节误判）；⑨中文论文摘要（摘 要）/关键词识别。已知留待：MinerU 公式的 legacy TeX 命令（\bf/\cal/\sf/\tt/\textcircled）pandoc/KaTeX 兼容性扫荡（见 paper-polish-backlog D 批）。**三轮全量重转（2026-07-30）**：148 目录 126 成功 22 失败（zotero-brain 缓存缺 content_list.json）；再修⑩锚点层级（Nature 式无编号论文 Introduction/Methods/Results 等正文锚点词为顶级且不编号，其后无编号标题归位为 ## 子节；编号章节间无编号标题嵌到当前点号深度下）⑪slug 碰撞消歧（`chen2023d-ufj6tyeh` 后缀）⑫container-title 缺口按 DOI 走 CrossRef 兑底 ⑬Zotero 标题样式标签（sub/sup/i）归一。QC 门禁 `qc_scan.py` 全绿（表格对账零缺失、零残留标签、LF 干净），27 个旧格式孤儿目录已清；残留仅 Zotero 条目本身的数据缺口（6 篇 container-title、1 篇 date）
- [ ] **向量库/标注/译本的同步语义**：L2 同步对全局向量库、folders、对齐表的覆盖策略
- [ ] **MCP 权限模型**：读/写边界、工具粒度、审计
- [ ] **术语表沉淀**：翻译一致性的跨论文资产
- [ ] **译文 chunks 入向量库**：中文查询的跨语召回增强
- [ ] **多模型嵌入并存**：同库多向量空间 or 版本化重建的取舍
