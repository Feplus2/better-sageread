# 论文模块打磨待办（paper polish backlog）

> 2026-07-28 建立。记录文献库/论文助手的打磨项，逐批消化。完成项移入"已消化"并标注日期。

## 待办

### C2 批：AI 自动标亮（锚点体系已就绪）
- 辅助模型按类别（研究目标/方法/结论/创新点；综述另套模板）抽取 quote → 同一锚点体系换算 → 分类着色入侧栏"AI 重点"tab（占位已留）
- quote-based anchoring：模型只返回类别+逐字引用，本地匹配换锚点，匹配失败丢弃

### E 批：功能与愿景（2026-08-02 用户输入，按优先级排产见当轮结论）
- ~~**论文导出**~~（✅ 2026-08-03 已消化，见下"论文整篇导出"批；遗留：正文内联高亮导出、frontmatter 中文化，见 D 批）
- **MCP 开放向量库语义查询**：外部 Agent 通过 sageread-MCP 只传文本查询，SageRead 内部完成嵌入（秘钥不出进程）并返回检索结果——把论文知识库盘活给 Agent 生态；前提是用户已配嵌入模型（无配置时明确降级提示）。需设计：查询 API（书籍/论文/全局三域？）、top-k 与重排、结果形态（chunk + 出处）、与现有 MCP 工具注册方式对齐
- **多引擎解析适配**：不绑死单一解析引擎——MinerU / paddleOCR 可选（用户实测 paddleOCR 质量更好），设置页选择，书籍转换与论文解析两侧都适配；等 Converter 侧 paddleOCR 适配验证完成后排产。**2026-08-02 产出审查实测（126 MinerU + 125 paddle 全量）**：两者互补——paddle 段落顺序/图注绑定/引文保留/错字优，MinerU 公式/表格优；基线已定 paddle + MinerU 表格备选。**数据质量门已修复（2026-08-03，Converter 七轮 e756771）**：paddle 断裂公式 unexpected eof 1001→20（残留 7 篇高定形态挂账）、References heading 缺失 32→0、引文 `$^{[n]}$` 全形态归一 `[n]`（残留仅作者单位脚注）、stage1 伪包裹源头封堵；125 篇 staging 零配额重跑复扫达标（详见 Converter docs/ocr-providers.md 五之六）。**遗留**：lamb2020 等 7 篇 20 处 eof 长尾、LLM slug 漂移需 zotero_key 锚定、Zotero 库 8 组重复条目待治理、MinerU 输出未重跑（修复已进共享 Stage 2/3，重跑自动生效）
- **Zotero 批量导入**：优先利用 Zotero 直接可得的元数据，缺失时回退 PDF 内提取；支持按 Collection 复选导入（前端复选框小改动）；与路线图 §3.4 的 Zotero 联动（批注回写）是两条独立线。**slug 与元数据确定性（2026-08-03 定论）**：slug 必须由确定性输入生成——有 Zotero 时用 CSL（author 姓 + year + title 首词）；无 Zotero 的裸 PDF 场景把 LLM 提取结果缓存进 staging（metadata.json），重跑复用而非重新提取（Converter 七轮暴露 LLM 年份判定跨轮翻转致 slug 漂移 wang2018↔wang2013）；不统一走 LLM（非确定性反而加重）。**实质重复条目识别（用户提出的设计题，导入批次实现）**：元数据不同（机构/日期差异）但内容实质一致的文献判定重复——分层策略：① DOI 精确匹配；② 标题归一化模糊匹配 + 第一作者姓 + 年份容忍（±1）；③ 内容指纹（PDF 首页文本 simhash 汉明距离阈值）；④ 向量库近邻（嵌入已就绪， cosine 阈值辅助判定）。命中后：保留新条目并保留双方 zotero_key 链（Zotero 库治理在 Zotero 侧，SageRead 侧只标记重复关系不物理删除；Collection 分组对不上的条目进"未分组"虚拟集合人工归并）
- **动态术语表学术翻译**：当前为分批直译 + 静态学术 prompt（"术语全篇一致"靠模型自觉，temperature 0.2），无动态术语表。改进方向：首轮先抽取术语表（辅助模型）→ 后续批次注入 prompt 强制一致；长文一致性与 AI 标亮命中稳定性可一并评估
- **主题 CSS 上限探索（低优先，视觉向）**：图片/视频为底 + 毛玻璃等示例，探索全局主题系统能力边界（THEMING.md）；排在技术优化之后

### D 批：杂项（未排期）
- **论文导出遗留（2026-08-03 整篇导出批）**：译文/对照模式 frontmatter 仍是英文元数据（title_zh/abstract_zh 不回写 YAML，js-yaml 重排会动用户字段顺序，暂缓）
- ~~**MinerU 公式 legacy TeX 兼容扫荡**~~（✅ 2026-08-02 实证关闭：对 Converter 全量产出 126 MinerU + 125 paddle 逐篇 grep，`\bf \cal \sf \tt \textcircled` 全库 0 次——Converter 侧已在落盘前处理，本项无需 SageRead 侧动作）
- **词对齐残留打磨（2026-08-02 测试发现）**：句首虚词区错配（worth↔远离/noting↔分界线，功能词向量区分度低）；非连续对应不可表达（"not…at all"↔"根本"，jieba 把"根本无法"粘成一词）；历史标注 -tgt 镜像疑似重复区间注册（绿色标注 4 个相同 105 字区间）。jieba 已上线（见 2026-08-02 已消化批），本项为剩余残留
- ~~**tauri-plugin-epub 测试目标既有损坏（2026-08-02 发现，未修）**~~（✅ 2026-08-03 已修，提交 4fa902e：25 个过期测试编译错误清零——失效 API 测试删除/接口变更跟进/tempfile 补 dev-dep，cargo test 15 全绿，zh_segmenter 3 组同步解锁）
- **"笔记"概念清除计划（2026-07-29 用户拍板：逐步清除 notes 概念，全部迁移到"标注"）**：开发版无用户无数据负担。后续批次：Agent 工具（notesTool 等）改为读取标注（高亮+划线下评论）；MCP（list_notes/get_note 等）迁移为标注；导出对象为标注；最终移除 notes 表与 notes 服务残留；文档同步（路线图 §3.4"批注/笔记回写 Zotero"→标注）。本批已完成 UI 层清除（弹窗按钮、notepad 笔记 tab、对话"存为笔记"按钮）
- webSearch 结构化结果面板（chat 页右侧工具详情面板目前只支持 mindmap/rag）
- paper 设置下拉支持自定义字体之外的更多书籍阅读器设置项（按需）
- 翻译功能（策略已定稿，详见 format-strategy-and-paper-module.md §3.7"块级平行显示层"，独立批次）
- **C2 打磨项**：AI 标亮命中稳定性——降 temperature 抑制 3~8 条抽奖波动、toast 附丢弃原因（复述/公式句/未匹配分类）、quote 匹配器再加一层宽松归一
- **句级基建（2026-07-29 设计定稿）**：切句器（缩写白名单 + 小数/引用保护，块内子区间，懒计算+缓存）→ 句子 hover 悬浮高亮/阴影 + 右键菜单（复制/引用到对话/标亮/记笔记）；翻译管线按句返回 {src,tgt} 对齐对并用 src 匹配校验（句级翻译映射 → 全译文模式句级高亮，失败回退块级）
- **对话选段存笔记/引用**：AI 问答消息划词 → 引用到对话/存为笔记（与标注锚点不撞车——标注锚的是 paper.md DOM 块，对话是另一 DOM 语境；可按 book_notes type="excerpt" 挂论文，独立小功能）
- foliate paginator 启动时对隐藏 tab 过早渲染抛 `el is null`（无害、切换即恢复；修复需动书籍挂载生命周期，风险不值，持续观察）
- **RAG 精度增强**（2026-07-29 评估，结论：融合骨架正确，按优先级升级）：
  - [ ] LLM 重排（召回 top 20-30 → 辅助/对话模型打分重排，性价比最高的精度升级）
  - [ ] query 改写/关键词扩展（辅助模型，成本低收益稳，治查询措辞 mismatch）
  - 暂不做：动态召回数量（边际收益小）、FTS5 迁移与空间压缩（BM25 LIKE 全表扫是工程债，万篇量级再议）
- Tooltip 统一扫尾（E 批只覆盖了阅读区/论文区 chrome 与文献库页，其余页面的原生 `title=` 待改项目 Tooltip）：
  - 图书馆页：`pages/library/components/status-bar.tsx`、`book-item.tsx`、`data-cleanup-button.tsx`、`embedding-dialog.tsx`
  - 设置弹窗：`components/settings/general.tsx`、`llama.tsx`、`sync.tsx`、`vector-model-manager.tsx`、`web-search-settings.tsx`
  - 其他页面：`pages/statistics/index.tsx`、`pages/converter/index.tsx`
  - 共享组件：`components/prompt-kit/code-block.tsx`、`prompt-kit/tool.tsx`、`preview/*`、`markdown/annotation-popover.tsx`、`ui/sidebar.tsx`
  - `components/notepad/notepad-header.tsx` 的搜索图标按钮无任何提示（且目前无功能，需一并确认去留）

## 已消化

### 2026-08-03 E 批：论文整篇导出（原文/译文/对照 + 标注 + 图片）
- [x] 管线 `lib/export-paper.ts`：复用 `buildPaperViewMarkdown` 视图重建（原文唯一事实源，译文不落盘）；导出文档 = frontmatter 原样 + 标题 H1（译文/对照优先 title_zh）+ 模式化正文 + 可选文末标注节（复用 renderAnnotationMarkdown/buildAnnotationsListHtml，按锚点块序排序）
- [x] 三格式：Markdown / HTML / PDF（打印版 HTML 路线，与标注 PDF 导出一致，零新依赖）；图片统一 base64 data URI 内嵌（单文件自包含，零新权限；对照模式译文 div 内的字面图片引用导出时清理——原文块紧邻其上已带图）
- [x] HTML：marked 渲染 + 公式占位保护（@@PAPER_MATH_n@@）→ KaTeX 服务端烘焙换回；`lib/export-html-shared.ts` 拆出 sanitizeHtml/EXPORT_HTML_CSS（thread 导出改复用同一份，避免论文导出经对话导出拖入 book-service→foliate-js 链）；KaTeX CSS + 20 个 woff2 字体 `?inline` 全内联（`lib/export-paper-katex-css.ts`，动态 import 懒加载 ~400KB 不进主 chunk）
- [x] 入口：论文顶栏 Download 按钮 → `paper-export-dialog.tsx`（内容默认跟随当前显示模式/无译本禁用译文与对照、附标注复选/嵌图片复选、三格式单选；卡片式选项行 + 分区标题层级）
- [x] **对照 markdown 原生重建（二轮反馈）**：`buildPaperBilingualExportMarkdown`（paper-blocks.ts）——译文以 md 原生形式插入（普通块/引用块后 `> 译文`、列表项缩进续行、表格单元格 `<br>`），公式保持 $...$ 文本、译文内图片引用清理；弃用"对照 div 烘焙 KaTeX 进 md"（MathML+HTML 双份渲染致公式重复、文档臃肿不可编辑）
- [x] **HTML 标注内联高亮（二轮反馈）**：锚点（块索引+textContent 偏移）经公式感知换算（mapSourceOffsetsToLive）映射进导出 DOM → `<mark>` 逐文本节点包裹（笔触三态 + --pa-color 颜色变量，逆文档序应用防坐标失效）；行间公式占位用 `<pre>` 包裹保证导出 DOM 块枚举与阅读区一致；映射失败静默跳过，文末标注节仍是完整事实源；Markdown 格式受格式限制只做文末标注节
- [x] **译文模式跨语言内联修复（三轮反馈：13 条标注只出 3 条）**：根因——用户导出的是译文模式，导出 DOM 已是中文，英文锚点 token 映射必然失败。修复：译文模式先经句/词对齐（mapSrcRangeToTgt，词级精确/句级吸附）映射为中文区间再包裹（未翻译块回退英文直接映射，无对齐表静默跳过）；对照模式加中文侧镜像（pa-mark-tgt 低透明，同阅读区 -tgt 语义）；params 新增 translationFile（携带 align/alignW）。真实数据（a27b187c 13 标注）验证：译文 35 marks / 对照 48 marks
- [x] **导出对话框重设计（三轮反馈：顶格/头部怪换行/粗糙）**：图标块 + 标题/描述双行 + 尾部选中指示圈的卡片式选项行；格式改三列紧凑卡片；头部/底部细分隔线；小区距字距标签分区
- [x] 单测 `scripts/test-paper-export.mjs` 46 组全过（新增：译文跨语言词级/句级/无对齐三档内联、对照中文镜像）；paper-blocks 两既有套件 33 组回归全过
- [x] 遗留记入 D 批：frontmatter 中文化（title_zh/abstract_zh 不回写 YAML）

### 2026-08-02 jieba 分词上线（方案 A：Rust jieba-rs + tokenize_zh）
- [x] 决策依据：离线对比实验（13 探针 单字 7.5 vs jieba 11.5）——词向量在"词"粒度区分度远高于单字，单字路径映射常落词中间（"离"/"致"）或边界多带一字（"或者根"）
- [x] Rust：`text/zh_segmenter.rs`（jieba-rs **0.6.8**——0.7 系依赖墦不可用：libflate 2.3.x let-chains 需 rustc 1.88（本地 1.87）、2.1/2.2 依赖被 yank 的 core2 0.4.0；0.6.8 无 libflate 依赖）；`tokenize_zh` 批量命令；token 偏移按 **UTF-16 code unit** 口径（与 JS string 下标一致）；空白/标点/符号过滤口径与单字路径一致
- [x] 权限坑：插件 `permissions/default.toml` 必须登记新命令，否则 invoke 被拒并静默走兜底（表现为"命令通了但切出单字"）
- [x] 前端：`zh-tokenizer.ts`（批量一次 IPC，失败回退单字不中断）；词级相位中文侧改 jieba；`alignWHash` 拼 `jieba1` 版本后缀——旧 alignW 自动失效重算，无需手动迁移
- [x] service 集成测试：zh-tokenizer 桩（默认单字/开关假 jieba 两字词）验证注入分词生效；14 组全过
- [x] 真机验收：重建后词对 7279→6961、low 18→6；落库探针 **10.5/11**（rocksalt→岩盐/spinel→尖晶石/or→或者/结晶/主要/致谢等全精确，仅"国家自然科学基金"多带"得到"0.5）；CDP 拖拽划"尖晶石"→EN 精确"spinel"（单字版会拖出 rocksalt）
- [x] 插件测试目标既有损坏记录入 D 批（未修）

### 2026-08-02 对齐系统性修复批（句词 DP 缩放成本 + 期刊缩写 + 无解兜底 + 公式归一）
- [x] **根因：DP 成本函数少步偏置**——cost=1-avgSim 每步基线恒为 1，合并移动一步顶两步天然省基线；相似度区分度中等时正确 1:1 路径的相似度优势补不齐基线差 → 句级乱并句（块 39 实证：5 步错路 1.805 < 7 步对路 1.900）、词级向最大合并漂移致级联错位（"lead to stable structures"↔"根"）
- [x] 修复：alignDP 成本按组大小缩放（×(src+tgt)/2，句词两级），合并只在交叉项确实差时胜出；词向量信号实测足够（stable→稳 0.68 行内最高），缩放后词对精确（stable↔稳 / structures↔定结构 / e.g↔例如）
- [x] 切句器白名单补 40 个期刊缩写（Appl./Mater./Inter./Res./Bull./Adv./Chem./Phys./Lett./Nat. 等）——参考文献条目不再被切碎；块 200（5:2 失衡零对齐）随之切成 2:2 正常对齐
- [x] DP 无解兜底：句数比超 maxGroup 时退化为整块单对（标 low），不再整块零对齐
- [x] 公式感知坐标归一（2026-07-30 批，补记）：normalizeMathText / normalizeLiveElement / mapOffsetsMathAware，stored md 源文 ↔ live KaTeX DOM 的 token 序列对齐，含公式块划词/高亮不再错位；22 组单测（test-paper-math-normalize.mjs）
- [x] 真机验收：块 39 七句全 1:1 正确；hover 中文"这展示了…"英文侧精确只亮"This demonstrates…"；"stable structures"↔"稳定结构"双向划词词级精确；整体 223/223 句词对齐、句级 low 0
- [x] 回归测试 4 组（块 39 真实矩阵不乱并 / 正当合译保留 / 词级低区分度不漂移 / 无解兜底）+ 既有 147 组全过

### 2026-07-29 T3 批：词级对齐 + 翻译菜单美化 + AI 重点按钮主题色
- [x] **词级对齐修复（2026-07-29 二轮）**：`EMBED_W_BATCH_SIZE` 256→64——智谱 embedding API 单请求硬限 64 条（实测 65 条 HTTP 400 "input数组最大不得超过64条"），256 导致满 shard 全灭、词级仅末尾小 shard 幸存 1/223；修复后真实数据端到端验证 223/223 完成（`scripts/verify-paper-alignment-e2e.mjs`）。教训：嵌入批量上限按最严供应商（64）设计
- [x] **嵌入自适应分批（2026-07-29 三轮）**：供应商 input 上限差异大（OpenAI 2048 / Cohere 96 / 智谱 64 / DashScope 10），写死任何值都不保险——`embedBatchAdaptive` 遇批量类 400 自动减半重试 + 运行期上限收敛（句词两相位共享），集成测试验证"上限 10 条也能句词全完成"
- [x] 词级对齐（`paper-cross-anchor.ts` + `paper-alignment-service.ts`）：句对内分词（英文按词/中文按单字）→ token 汇总分片 embed（256 条/6k 字符双上限，单片失败仅牵连该片块）→ 单调 DP（(1,1)/(1,k)/(k,1)，k≤4，<0.45 标 low）；写回译本 `blocks[idx].alignW` + 顶层 `alignWStatus`，幂等键同句级；"重建对齐"句词两级同重建；词级失败降级不影响句级
- [x] 映射升级：有 alignW 时 `mapTgtRangeToSrc`/`mapSrcRangeToTgt` 词级精确区间，缺失/未命中回退句级；`mapOffsetsViaTokens` 做 live↔stored 词 token 下标换算（oneLine 折叠/markdown 渲染场景）；22 组词级单测（分词/DP/映射/换算）
- [x] 翻译下拉重排三区：显示模式（radio+图标）/ 翻译（入口+主题色进度条+取消）/ 句词对齐（状态行 句 n/m·词 n/m + "重建对齐"有译本始终可见，仅计算中禁用；无嵌入模型点击给配置引导 toast）——修复"重建句对齐"对齐完成后入口消失的问题
- [x] AI 重点生成/重新生成按钮：蓝色硬编码 → 全局主题（bg-primary text-primary-foreground）

### 2026-07-29 T2 批：句级对齐 + 跨语言标注
- [x] 对齐服务 `paper-alignment-service.ts`：双侧切句 → 本地嵌入 → 余弦矩阵 → 单调 DP（(1,1)/(1,2)/(2,1)，cost=1-平均相似度，<0.5 标 low）；幂等键=(源 hash, 译文 hash)，写回译本 `blocks[idx].align` + `alignStatus`；无嵌入降级 skipped + "重建句对齐"手动入口
- [x] 跨语言映射 `paper-cross-anchor.ts`：src↔tgt 双向区间映射（句吸附/跨句/无覆盖），15 组单测
- [x] 英文标注映射到中文侧（对照/译文模式同色低透明 `-tgt` 高亮）；中文划词标亮 → 映射回英文锚点创建标注（text/context 一律英文，原文唯一事实源）；无对齐段标亮禁用提示
- [x] 中文句子 hover（对照/译文模式译文区）
- [x] T1 修复：图片引用双保险补回（restoreImageRefs）、译文 div KaTeX auto-render、进度条主题色、批次 JSON 容错（重试→跳过→不中止）、对照模式译文放开复制/Ask AI

### 2026-07-29 T1 批：全文翻译基础版
- [x] 切块器 `paper-blocks.ts`（remark mdast）：fixture 226 块与 jsdom DOM 枚举逐块相等（一致性测试钉死）；嵌套列表归最外层、表格逐格、公式/代码/图片不可翻译
- [x] 翻译服务 `paper-translation-service.ts`：分批 ≤12 块/6k 字符，学术 prompt（术语一致/公式代码参考文献不翻/只出 JSON），块哈希幂等（跳过已翻/可续翻），每批落盘，AbortController 取消，元数据 title_zh/abstract_zh 附加翻译
- [x] 三显示模式（persist paperViewMode）：原文/译文/逐段对照；源文本重建渲染（译文模式替换、对照模式插 `<div data-translation>` 且排除出块枚举——锚点零漂移，一致性测试验证）
- [x] 标注兼容：原文/对照精确；译文模式块级降级 + 禁新建；TOC/标题/摘要中文化
- [x] rehype-raw 启用（译文 escapeHtml；rehype-sanitize 收紧记 T2+）
- [x] 顶栏 Languages 下拉（模式切换/翻译/进度/取消）
- [x] 删除阅读区设置下拉冗余的明暗主题切换（设置里已有）

### 2026-07-29 标注星标 + 批量管理导出
- [x] `book_notes.starred`（幂等迁移 + sync 注册 + 宽容读取），书籍/论文标注共用；书籍侧 annotation-item 同加星标
- [x] 论文标注 tab：条目星标切换、全部/仅星标筛选、多选模式（复选/全选/底部操作条）、四格式导出（Markdown/HTML/图片/PDF=打印版 HTML 走系统浏览器另存，零新依赖）、多选删除
- [x] 导出管线 `lib/export-annotations-{md,html,image,pdf}.ts`：论文标题+色标+★+quote+评论+前后文；图片复用 thread 的 foreignObject→canvas 机制
- 铺路完成：Agent 工具"导出某文章星标标注"的数据基础（starred 列）已就绪（工具本身后续做）

### 2026-07-29 句子 hover bug 修复 + AI 清除按钮
- [x] 覆盖层叠加深色：KaTeX 可见 span 与隐藏 MathML 副本/上下标/列表 marker 产生重叠 rect 致 tint 叠加——渲染前几何求并（`mergeOverlappingRects`，y 行带 + x 贴边合并，跨行永不合并），11 组断言全过
- [x] 残影：rAF 节流中 mouseleave 未取消 pending 帧，离容器后旧坐标重画——clearHover 同步三件套（取消 rAF/空坐标/清状态）
- [x] AI 重点 tab 加"清除"按钮（ask 确认 + 条数 toast，仅删 source='ai'）
- [x] C2 打磨项记录：降 temperature 稳输出、toast 附丢弃原因、匹配器宽松归一（见 D 批）

### 2026-07-29 C2 批：AI 自动标亮
- [x] 定死 taxonomy 三模板（research 目标/方法/结果/结论/创新点；review 范围/框架/进展/争议/方向；report 精简三类），五色映射；类型由辅助模型判定（拿不准归 research），面板可手改
- [x] 管线：类型判定 → 模板抽取（严格 JSON、quote 逐字、避开公式、>40k 按一级 heading 切段合并）→ 本地 quote 匹配 + snapRangeToSentences 句吸附 → book_notes（category + source='ai' 两新列，幂等迁移；人工路径恒 user/NULL）
- [x] 安全：delete_ai_book_notes 仅删 source='ai'，重新生成不可能误删人工标注；同步列注册 category/source + engine 宽容读者加固（缺失列不绑 NULL，顺带消除 threads.starred 同类隐患，sync 27 测试全过）
- [x] 侧栏"AI 重点"tab 做实：类型选择 + 生成/重新生成（spinner + 命中/丢弃计数 toast）+ 按类别分组（色点/色条/跳转闪烁/右键删除）+ 无辅助模型降级引导；标注 tab 人工+AI 统一列表带 Sparkles 徽章
- [x] quote→锚点换算 11 组 fixture 实测全过（已知限制：含 $...$ 的 quote 因 KaTeX 渲染不可匹配，prompt 已引导避开）

### 2026-07-29 句级基建
- [x] 切句器 `paper-sentences.ts`（segmentSentences/findSentenceAt/snapRangeToSentences）：缩写白名单 ~45 个 + 小数/角标/闭合符保护，21 组单测全过；接口已为 C2（AI 重点句标亮）与句级翻译对齐预留
- [x] 句子 hover：覆盖层 div（tint+圆角+阴影，明暗两套），rAF 节流 + WeakMap 懒缓存（hover 路径零全量块枚举）；弹窗开/有选区/悬在 img·pre·a 上时禁用
- [x] 右键句子 → 自动选中该句并复用标注弹窗；右键已有标亮 → 回显路径优先
- [x] 弹窗宽度按状态自适应：选区态紧凑 180px，标亮后（笔触/颜色行）拓宽 272px

### 2026-07-29 笔记概念清除（UI 层）
- [x] 标注弹窗精简（书籍+论文）：选区态只留 复制 / Ask AI / 高亮 三按钮；"记笔记""评论""询问AI"按钮全删，评论能力保留在标亮后的回显弹窗（评论图标展开输入区，落 book_notes.note）
- [x] "引用到AI会话"统一改名 Ask AI（图标对齐 quote chip）
- [x] 对话消息区"存为笔记"按钮删除（chat-selection-popup 共享组件一处删除，图书馆/论文/全局三侧生效）
- [x] 书籍 Notepad 双 tab 改单一"标注"（删 notes 列表 UI/use-notepad/note-item/note-detail-dialog/无功能搜索图标）；删 home-layout 的 /notes 占位页与路由
- [x] 残留 grep 零命中（addNote/存为笔记/记笔记/AskAIPopup 等）；notes 表、note-service、Agent/MCP 工具保留待专项迁移

### 2026-07-29 F 批：一致性打磨六项
- [x] swapSidebars（theme-store）对论文生效：左笔记/右 AI 互换、手柄方向、顶栏折叠按钮控制对象互换，与书籍同语义
- [x] 设置入口统一：顶栏右侧（通知与窗口控制之间）加齿轮为唯一全局入口（横向 pinnedRight / 纵向顶条各挂一次），删除主页左下角与书籍 AI 侧栏头部旧入口；Ctrl/Cmd+, 保留
- [x] 论文标注弹窗复刻书籍版（PopupButton/HighlightOptions 三笔触+五色胶囊行）+ 二合一评论输入；CSS `::highlight()` text-decoration 补齐 underline/squiggly 渲染（15 个注册名，笔触×颜色聚合）
- [x] 二合一推广到图书馆：书籍标注弹窗加评论按钮（落 book_notes.note），annotation-item 显示评论预览；独立 notes 系统不动，epubcfi 链路零改动
- [x] 侧栏标注项左侧 4px 竖直色条（HIGHLIGHT_COLOR_HEX），书籍/论文两侧一致
- [x] 弹窗"解释"按钮 → "引用到AI会话"：`quoteToChat` 窗口事件 → handleAskSelection 注入 quote chip（不自动发送），书籍/论文两侧都有；AI 面板收起时先展开再注入

### 2026-07-29 C1 批：论文标注闭环
- [x] 复用 book_notes 表（零 Rust 改动，FK 级联/同步现成）；note 空串=纯标亮（标注笔记合一）
- [x] 锚点系统（paper-anchors.ts）：块索引+块内字符偏移 JSON 存 cfi 列；元数据块排除、嵌套块归并、块失配 quote 兜底；11 组 jsdom 断言通过
- [x] CSS Highlight API 五色渲染 + 划词弹窗（色点/评论/删除/回显）+ 点击命中（caretRangeFromPoint）
- [x] 侧栏"标注"tab：按文档位置排序、色标、quote+前后文、点击跳转+呼吸闪烁、右键改评论/删除；"AI 重点"tab 占位（C2）

### 2026-07-29 B 批：提示词热插拔（prompt presets）
- [x] 存储：新表 `prompt_presets`（id/scope/name/content/is_active/时间戳，`core/database.rs` 幂等迁移），Rust 新模块 `core/prompts/`（仿 skills 模块）；`set_active_prompt_preset` 事务内同 scope 互斥，`clear_active_prompt_preset` = 恢复默认
- [x] 装配接入：reader（`constants/prompt.ts`）有激活预设时替换 DB 系统技能基词（RAG 裁剪 regex 只匹配内置基词标记，对预设自然 no-op）；paper（`constants/paper-prompt.ts`）替换 `PAPER_AGENT_PROMPT_BASE`，能力分层后缀/技能注入/上下文注入照旧；`services/prompt-preset-service.ts` 带 5s TTL 缓存 + mutation 主动失效，失败回退默认不阻断对话
- [x] AI 中心"提示词"tab（已有）改造：阅读/论文助手各一组（默认提示词只读卡片 + 使用中/恢复默认 + 预设列表），新建/编辑对话框支持"从默认复制"，激活/删除（ask 确认）一键完成，切换下条消息生效；阅读助手原直接编辑入口由预设取代；全局助手本批不做（保留只读预览）

### 2026-07-28 E 批：阅读区 chrome 体感打磨
- [x] 删除"对话内搜索"误建功能：书籍/论文 AI 面板头部的放大镜按钮与搜索条、`chat-search-bar.tsx`、`ChatMessages` 的 searchQuery 过滤与高亮注册、`index.css` 的 `::highlight(chat-search)`（本文内搜索 `::highlight(paper-search*)` 保留）
- [x] 书籍/论文 AI 面板空状态引导统一恢复垂直居中（justify-center）
- [x] 论文阅读区容器对齐书籍 region/类名体系：`data-region="paper-chat-panel"` → `chat-panel`（修复 cake 等主题下论文 AI 面板不吃主题样式的问题）、左侧面板 → `notepad-panel`，去掉硬编码 border/bg，框线/圆角/阴影与书籍 chrome 一致
- [x] 尺寸对齐：论文 AI 面板 Resizable 380/320/560 → 书籍实际值 370/320/580；面板头部 h-11+border-b → 书籍同款 h-8；ModelSelector 宽度对齐 w-[10rem]；两侧面板包装间距（mr-1 / m-1 mt-0）与书籍一致
- [x] 垂直标签页顶栏：控件尺寸/颜色与横向 pinnedLeft 完全一致（size-5、neutral-700）；顶栏补 `data-region="reader-tabs"` 吃主题；修复垂直模式顶栏无法拖动窗口（Tauri `data-tauri-drag-region` 只在事件目标自身判定，子容器需各自带属性）
- [x] 垂直标签栏改 Edge 式悬停浮现：删除展开/收回按钮，常态 48px 窄条，悬停浮层（absolute、不推挤布局、过渡动画）展示分组+完整标签
- [x] Tooltip 全局统一（阅读区/论文区 chrome + 文献库页）：原生 `title=` 全部改项目 Tooltip（`components/ui/tooltip.tsx`），无提示的图标按钮补齐；遗留范围见 D 批

### 2026-07-28 A 批：布局全面对齐书籍阅读区
- [x] 垂直标签页模式：主页/切换横向/折叠展开三个控件固定于页面左上角（顶栏左侧顶格），折叠/展开状态位置一致；顶栏居中 SageRead 图标+文字
- [x] 论文阅读版面完全参考书籍阅读区：左侧笔记/标注面板（占位预留，可收回）、中间阅读区、右侧 AI 面板
- [x] 顶栏复刻：当前小节名称显示、悬停浮现左右 UI 组、TOC 下拉、设置面板（字号滑块 + 自定义字体，复用 globalViewSettings）、搜索下拉
- [x] 论文内 http(s) 链接（DOI 等）点击调默认浏览器打开
- [x] 本文内搜索（非对话内搜索）：书籍阅读区同款，高亮 + 计数 + 上下跳转
- [x] TOC 从独立成块改为顶栏下拉（书籍阅读区做法）
- [x] 论文助手面板头部精简：去掉"论文助手"文字标识、收回面板按钮改为图标（书籍同款）
- [x] 移除上批临时的 paperViewSettings，统一用 globalViewSettings

### 2026-07-28 早前批次（开工顺序 1–6 + 打磨批）
- 格式契约 / MD 渲染器 / MARKDOWN 入库与列表 / 全局向量库 / 文件夹模型（OS 式浏览+回收站）/ 论文助手 MVP
- 论文标签页化与书籍分组；skill·快捷指令·MCP scope 三复选（去 "both"）；模型选择器；消息多选导出；对话内搜索（CSS Highlight API）
- Bug：TOC 跳转版面上移（容器内 scrollTo）；引导页不显示（isInit ref 无重渲染，补 forceUpdate）；引导页位置顶部对齐
