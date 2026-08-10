# 论文解析管线改造：VLM 默认 + 图合并 + 退化降级（2026-08-11 定稿）

> **2026-08-11 策略修订（替代 08-10 的"文字层直取"主线）**：08-10 方案建立在"图片可以像文字一样直接准确提取"的认知上——实测证伪（PDF 无图片层，复合图常被出版社排版打散，详见 §图片整幅提取路线）。公式 LaTeX 也是文字层路线的结构性短板（VLM 的公式表现明显更好）。**新共识三层架构**：
>
> 1. **VLM 类引擎默认**（paddleocr / MinerU VLM）——公式与正文质量优先
> 2. **figure_merger 保图**（引擎无关后处理）——同图碎块 bbox 并集、源页整幅光栅化重裁，已落地（Papers_Converter `figure_merger.py`；MinerU 系坐标已支持，PaddleOCR/GLM 需补 block_bbox passthrough）
> 3. **退化自动降级 pipeline**——quality_guard 规则检出循环输出且同引擎重试耗尽 → 自动换 MinerU pipeline 后端兜底（已落地 `pipeline.py:_degenerate_fallback_parse`），幻觉有兜底而不牺牲日常公式质量
>
> 本文档保留 08-10 的调研与机制分析作为参考依据；"三期实施"一节按新策略阅读：一期（MinerU pipeline 引擎选项接线）已落地并保留为手动/降级通道，二期（本地 textlayer provider）与三期（自动路由）**已降级为不做/暂缓**。

---

> 08-10 问题提出：书籍转换器的 OCR/VLM 管线是为**扫描版**书籍设计的，原样搬到**文字版**论文上是错配——VLM 重复输出幻觉（Yang 2021 三次重跑全复发，见 papers-converter-integration.md §六）、复合大图被按语义切碎。本文档给出改造方案。

## 一、现状事实（代码核实）

- 论文转换 = 独立 sidecar（`F:\MyProjects\Papers_Converter`，PyInstaller exe），四阶段：stage1 云引擎解析 → stage2 元数据 → stage3 内容处理 → stage4 渲染。SageRead 侧 `convert_paper_pdf`（`packages/app/src-tauri/src/core/paper_converter.rs`）只透传 `--provider`（paddleocr/mineru/glm），**默认引擎 paddleocr（PaddleOCR-VL——本身就是 VLM，幻觉默认路径）**。
- **sidecar 已内置解法但未接线**：MinerU provider（`stage1_mineru.py`）支持 `model=pipeline`（DocLayout-YOLO 路线，按整块裁图不拆子图）与 `ocr=False`（文字版不强制 OCR），CLI 有 `--model`/`--no-ocr`；SageRead 从未传过这两个开关。
- 管线有干净接缝：stage1 provider 契约（`ocr_provider.py`）——任何引擎产出 `{stem}_content_list.json` + `images/` + `{stem}.md`，下游 stage2-4 与 SageRead 入库/RAG 全链路零改动。
- 元数据不依赖解析引擎（规则 + 辅助模型 + CrossRef 兜底），换解析路径的风险面只有正文产物。
- 图切碎发生在**云引擎识别阶段**（vlm 后端行为，官方无配置关闭），converter 后处理的图组重组只是补救。

## 二、调研结论（2026-08 工具横评，来源见末节）

**核心判断：现代论文 PDF 是文字版，正文应直取文字层——零幻觉、阅读顺序正确、离线秒级。公式 LaTeX 与高保真表格是文字层路线的结构性短板，恰好现有 MinerU 集成切到 pipeline 后端即可补上。**

- **MinerU pipeline 后端**：文字版 PDF 正文直接读文本层（不经生成式模型，官方定位 "no hallucination"）；公式 = MFD 检测 + UniMERNet 识别 → LaTeX（含行内回填）；表格 = RapidTable → HTML（支持跨页合并）；图片按布局框整幅裁剪（官方确认不切碎）。**一次性解决幻觉 + 碎图两个痛点，且公式/表格能力保留**。云端 v4 API 暴露 `model_version=pipeline`、`is_ocr`、`enable_formula`、`enable_table`、`language`。
- **markitdown 排除**：pdfminer 底层，无分栏（官方注释明说 "not for multi-column text layouts in scientific documents"）、图片直接丢弃、无公式。
- **nougat 排除**：实质停更三年 + 权重 CC-BY-NC 禁商用 + 正文全走生成式（正是要逃离的路线）。
- **docling（MIT）**：表格最强（TableFormer），但图片只有渲染裁剪（官方明确不给原始位图）、公式 LaTeX 需生成式 enrichment、PyTorch 重型依赖——作为"本地高保真表格"备选记录，不做主线。
- **PyMuPDF4LLM**：文字层能力最全（Layout GNN 排序、嵌入位图原样字节），但 **AGPL/商业双许可**是分发拦路虎。注意：**papers_converter / books_converter 的 exe 已经内嵌 fitz**——AGPL 敞口已存在，发布前需统一处理（见风险节）。
- **GROBID**：元数据/参考文献结构化最强但 JVM/Docker 形态不适合桌面端内嵌；元数据现状（Zotero CSL + LLM + CrossRef）已够用，不引入。
- **marker v2**：fast+disable_ocr 零幻觉且快，但 PyTorch 重型 + 模型权重营收阈值条款，不押注。
- **文字版/扫描版自动判定**：成熟做法是多信号组合（文本算子数、图像覆盖率、字体可解码性、转曲检测），参考 firecrawl/pdf-inspector（Rust crate，MIT）的阈值：文字页占比 ≥60% 判文字版；论文 <30 页建议全扫不采样。

## 三、推荐方案（三期递进）

### 第一期：接线 MinerU pipeline 后端（改动最小，收益立现）

**把 sidecar 已有的能力接出来，born-digital 论文默认走 `pipeline + ocr=False`。**

- Rust：`convert_paper_pdf` 参数加 `model: Option<String>`（"vlm"|"pipeline"）与 `no_ocr: bool`，非默认时透传 `--model`/`--no-ocr`（延续现有"默认参数不传"惯例）。
- 前端：论文引擎选项细化——`mineru` 拆为 "MinerU（文字层管线·零幻觉，推荐）"（pipeline + no-ocr）与 "MinerU VLM（扫描版/疑难件）"；默认从 paddleocr 改为 MinerU pipeline。`paperEngineTokenError` 逻辑不变（同 token）。
- sidecar：零改动（开关已在）。可选加固：`pipeline + no-ocr` 时对扫描件给出"疑似扫描版，建议切 VLM/OCR"的提示（文字层覆盖率简单启发式即可，fitz 现成）。
- 预期效果：正文零幻觉（文本层直取）、图整块不碎、公式 LaTeX 保留（UniMERNet 识别模型，非生成式）、表格 HTML 保留（RapidTable）、stage2-4 与契约产物全复用。
- 仍走云端：MinerU token 照用，数据出机照现状（与书籍一致）。

### 第二期：本地文字层 provider（离线、零 token、零云）

sidecar 新增 `stage1_textlayer.py` 实现 `OcrProvider` 契约（产物 = content_list.json + images/ + .md），纯本地：

- 正文/阅读顺序：文字层逐块提取 + 双栏聚类排序（y 聚行 → x 直方图找栏间谷 → 栏内顺序）；乱码页（Identity-H 无 ToUnicode / Type3-only）检测后建议转云端。
- 图片：抽**嵌入位图原始字节**（整图天然不碎）；矢量图（matplotlib/TikZ）按区域 300 DPI 渲染整幅。
- 公式：文字层 Unicode 碎片直出（复用 PaddleOCR 路线的 `_unicode_scripts_to_latex` 部分补救）——**接受退化**，公式密集论文引导走云端 pipeline。
- 表格：无 HTML 表体时退化为整表图片（契约 §六 已有此降级形态）。
- 引擎选型：`"textlayer"`，免 token；设置页文案说清取舍（快/离线/零幻觉 vs 公式表格退化）。
- 依赖决策点：直接用现成 fitz（AGPL 敞口已在，见风险节）或 pdfium-render（Rust crate，Apache/BSD，~10MB 动态库，但分栏/表格要自己写）——**建议先用 fitz 快速验证产物质量，许可证问题发布前统一裁决**。

### 图片整幅提取路线（2026-08-11 专项调研定稿）

**机制事实**：PDF 无"图片层"——页面是绘制程序，复合图常被出版社排版打散成多个小位图+矢量路径（实测 Yang 2021：整图作为单一对象不存在于文件）。**所有主流管线（docling/marker/MinerU/GROBID 生态）出图方式一致：拿到区域 bbox → 从渲染页整幅光栅化**——这不是拼接碎图（无损、无接缝、矢量图天然覆盖），分歧只在"区域从哪来"。嵌入位图直接抽取只能当 fast path（出版社预切、矢量图无位图、SMask 黑底、JBIG2/CCITT 编码坑，工程界共识）。

**MinerU 碎图根因**：布局检测块粒度不稳，合并阈值硬编码、官方无开关（issues #4335/#4008/#4163/#4771，官方定调"等模型下版本"）——**必须在后处理自救，等上游不现实**。

**路线选型（推荐 D：规则优先 + 检测器兜底，统一区域渲染出图）**：

1. **第一步（后处理自救，成本最低）**：MinerU 产物 image 块自带 bbox——把同页相邻、共享图注的图块做 bbox 并集，从源 PDF 页 200+ DPI **重裁一整张**（不是拼碎图），直接修掉碎图。
2. **第二步（主路径提质）**：PyMuPDF 复现 **PDFFigures2 三阶段纯规则算法**（JCDL 2016，域内 94%P/90%R，零视觉模型全可解释）：图注正则锚定 + 一致性过滤 → 文档级字体/行宽众数区分正文与图内文字 → 四方向 proposal 区域 + 空白带切分。`page.cluster_drawings()` 等原语现成。规则校验失败（无图注命中、区域异常）回退第一步的检测器块路径。
3. **嵌入位图 fast path**：仅"单块=单 XObject、无 SMask/旋转、JPEG/PNG/Flate"时直接抽流保真。
4. 不引入 PDFFigures2 本体（JVM、停更）或 PaperMage（torch 重依赖、停更）；算法照搬，依赖零新增（fitz 已在栈内）。

**已知盲区（验收时如实告知）**：无图注装饰图规则法抽不到（靠检测器兜底）；跨页 figure 约 1.5% 救不了；扫描版无文字层需 OCR 前置；规则法跨版式域 recall 会掉（PDFigCapX 跨域证据 41–66%），所以检测器兜底不是可选项。

### 第三期：按页自动路由 + 元数据增强

- 逐页文字版/扫描版判定（pdf-inspector 多信号算法；封面纯图防误判；混合页正文走文字层），引擎选择从手动升级为自动："文字版 → 本地/pipeline no-ocr；扫描版 → vlm/pipeline+ocr"。
- 元数据兜底链按 2026 年现状更新：CrossRef 限速已收紧（polite 3 req/s），加 OpenAlex 按 DOI 单查（免费不限量）为第一兜底。
- 可选：自托管 GROBID 做参考文献结构化（远景，不进安装包）。

## 四、验收方案

- 取 fixtures 或真实样本 5–10 篇（覆盖：双栏 IEEE/ACM、公式密集、表格密集、多 panel 大图、RSC 版式 bio 照），vlm vs pipeline+no-ocr A/B：
  - 正文与原文逐段一致（零编造）；图数量=原文 figure 数且整幅；公式 KaTeX 渲染无报错；表格 HTML 结构可读；`<!-- page: N -->` 锚点齐全。
  - 退化检测（quality_guard）对 pipeline 产物应零触发。
- 生态兼容：`pandoc paper.md -s -o out.docx` 直接成功（契约 §五）。

## 五、风险与合规备忘（发布前处理）

1. **PyMuPDF（fitz）AGPL**：两个 converter exe 均已内嵌。发布选项：买 Artifex 商业许可 / 换 pdfium-render（Apache/BSD）/ 整体按 AGPL 合规开源。文字层 provider 若用 fitz 会扩大此敞口，先验证质量再裁决。
2. **MinerU 许可**：3.1.0 起 Apache 2.0 基底 + 附加条款（MAU>1 亿或月营收>$2000 万需商业授权；对外提供在线服务须署名）；模型权重许可可能独立于代码，商用前核实。我们走云端 API，受影响面小。
3. **云端数据驻留**：pipeline/vlm 都是云解析，论文 PDF 上传到 MinerU——与书籍现状一致，用户手册需明示。
4. **marker 权重 / GROBID pdfalto GPL 聚合**：仅记录，本期不引入。
5. 任何工具的官方宣称都替代不了目标期刊样本实测——第四节的 A/B 验收是放行前提。

## 六、来源

- MinerU：https://github.com/opendatalab/MinerU ｜ 云端 API https://mineru.net/apiManage/docs ｜ LICENSE.md（3.1+ Apache 基底）
- markitdown：https://github.com/microsoft/markitdown（issues #2226/#1845 双栏乱序实证）
- PyMuPDF4LLM：https://pymupdf.readthedocs.io/en/latest/pymupdf4llm/ ｜ AGPL https://artifex.com/licensing
- docling：https://github.com/docling-project/docling（讨论 #3137 不给原始位图）
- GROBID：https://github.com/grobidOrg/grobid（FAQ 表格认怂）
- marker：https://github.com/datalab-to/marker（v2.0 重写，权重 RAIL-M 修改版）
- pdf-inspector（版式判定）：https://github.com/firecrawl/pdf-inspector
- nougat 停更/许可：https://github.com/facebookresearch/nougat
- 元数据 API：CrossRef 限速公告 2025-12 ｜ OpenAlex DOI 单查免费 ｜ S2 search/match
