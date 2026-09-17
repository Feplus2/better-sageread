# Books_Converter 侧优化清单（交接用）

> 2026-09-16 整理。来源：SageRead 阅读器侧两轮排查的实证记录（均有实机证据）。
> 每条含：症状（实证）、根因、建议修法、证据位置。
> 另见本仓库 `docs/plans/next-round-backlog.md` 的转换器 annotation 治本项。

## 1. latex2mathml 保留原始 LaTeX（治本，最高优先）

- **症状**：EPUB 里 MathML 无 `<annotation>`，阅读器/Agent/RAG 只能拿到扁平公式，复杂公式不可读；阅读器侧不得不用 mathml-to-latex 运行时反解（有保真损耗）。
- **修法**：latex2mathml 生成 `<math>` 时同时写 `<annotation encoding="application/x-tex">原始 LaTeX</annotation>`。MathML 规范原生元素，不参与渲染，所有阅读器（Calibre 等）一律忽略，零兼容风险。
- **配套（本仓库侧）**：向量化管道与文本提取优先读 annotation；阅读器提取器（`extract-structured-text.ts`）可无缝切换。
- **证据**：QFT（Maggiore）公式 5.46/5.96 实测；本仓库 C+B 施工记录。

## 2. 标题段号转义吃掉数字（ragToc/readBookSection 章节匹配的生产商侧根因）

- **症状（实证）**：向量库 `related_chapter_titles` 与 md 正文里的小节标题形如 `5.\. Wick's theorem and Feynman diagrams`——"5.5" 被转义成 "5.\."，**段号数字被吃掉**。按小节号检索永远"未找到章节"。
- **新增受害面（2026-09-16 实证）**：`metadata.md` 的 `## 目录` 段同样全灭——Agent 系统提示词里注入的目录所有子节同名（`5.\. The S-matrix` / `5.\. Renormalization` / …号码全丢），模型无法得知真实小节号，只能凭领域知识编幻觉标题（实测编出 "5.6 Basic Feynman graphs, in λφ4 theory"——本书真实 5.6 是 Renormalization），readBookSection 文本匹配因此全败。注：该书 EPUB 自带 toc.ncx 是干净的（且只到两级，5.x.y 不存在并非转换器丢层级），说明损坏发生在标题提取/转义环节而非 TOC 源。
- **根因猜测**：htmd/标题提取把 `5.5` 里的 `.` 做 Markdown 转义时把数字也吞了（"5.5" → "5.\." 而非 "5\.5"）。
- **修法**：转义只动 `.`，保留数字（"5.5" → "5\.5"）；或入库前统一去转义（`title.replace('\\.', '.')`）。metadata.md 目录段同源修复；存量书需重跑向量化（metadata.md 随之重建）才生效。
- **本仓库侧已做的兜底**：Rust `text_search` 比较前 `replace('\.', '.')` 归一 + 数字开头查询追加按标题文本匹配（已提交，实测命中）；readBookSection 加小节号相等命中通道（幻觉标题文本对不上也能按号命中，b16d328）；提示词目录段改用 EPUB 原生 TOC 注入（5a36e2b）——Agent 侧观感已治本，数据层残留仍待转换器修复。
- **证据**：`SELECT related_chapter_titles FROM document_chunks`（ae649ba 副本，chapter_004 全部小节号）；`books/ae649ba…/metadata.md` 目录段；E2E 线程 a8d9188e。

## 3. 表格漏转残留 Markdown 纯文本

- **症状（实证）**：Feeling Great（英文版）chapter_002 有一个表格未被转换成 HTML，以 Markdown 表格纯文本（`|---|` 管道符）留在 `<p>` 里，页面渲染成一坨管道文本并与相邻表格叠压。
- **修法**：排查该表格的提取路径（大概率是跨页/嵌套/异常合并单元格导致 table 识别失败后的纯文本回退），失败时至少包 `<pre>` 或转义管道符，不要让裸 Markdown 进正文。
- **证据**：`.tmp-diag` 排查记录（`<p>| Anger Scale | | Relationship Satisfaction Scale | |\n| Score | Meaning | ...`）。

## 4. 表格单元格文字按可视边界截断

- **症状（实证）**：Feeling Great（英文版）多个量表单元格文字被截断："1—Somev"（应为 Somewhat）、"2—Modern"（应为 Moderately）、"4—Extrem"（应为 Extremely）。疑似 PDF 提取按可视单元格边界裁剪了文字。
- **修法**：提取单元格内容时按文本块归属而非可视框裁剪；至少对截断词做完整性检查（词尾非字母/非完整词的合并到相邻块）。
- **证据**：`EPUB/chapter_002.xhtml` 的 table 0 表头行。

## 5. 图片不写尺寸 → 阅读器布局塌陷（滚动时位置误判、翻页抖动）

- **症状（实证）**：转换产物 `<img>` 无 width/height 属性且本地无物理尺寸约束时，未加载图片 0 高塌陷，文档高度随图片加载逐步增长——阅读器位置追踪在滚动中反复掉到章末（SageRead 已按视口顶部语义根治，但根源在此）。
- **修法**：转换时读取图片物理尺寸写入 `<img width height>`（或 wrapper 的 aspect-ratio 占位）。
- **证据**：SageRead A 案探针记录（滚动 relocate 的 Range 末尾反复落在 body 末尾）。

## 6. TOC href 与 spine 拆分对齐

- **症状**：部分转换产物按小节拆 spine 文件，但 TOC href 指向同一逻辑文件的 fragment——阅读器按 spine 分组的锚点解析不到后续小节（位置显示跳到本章末尾）。
- **修法**：TOC href 与实际 spine 拆分对齐（每个拆分文件配自己的无 fragment TOC 项），或保证 fragment id 在拆分后的文件里真实存在。
- **证据**：本仓库 TOC 根因分析记录（progress.js 组继承逻辑依赖 href 文件部分与 spine id 一致）。

---

**交接建议**：1 与 5 直接影响阅读体验与 Agent 内容保真，优先；2/3/4 是一批书的内容质量问题，次之；6 影响位置追踪的书较少，排后。
