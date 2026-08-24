# 05 · 转换与解析管线

> 两条转换管线：**Books_Converter**（书籍 PDF→EPUB）与 **Papers_Converter**（论文 PDF→paper.md），都是外置 Python 工具打包成的 sidecar exe，由 Rust spawn、stdout JSON 报进度。本章还包括论文格式契约、向量化管线与翻译管线。
>
> 注意：转换器的实现主体在独立仓库（随 sidecar exe 分发，实体在 `packages/app/src-tauri/binaries/`，gitignored）。本章标注"converter 侧"的小节以外部仓为准；SageRead 仓内的接线与消费均有行号出处。

## 1. Books_Converter（书籍 PDF→EPUB）

- **引擎**：hybrid = MinerU 云 API（版面解析/OCR）+ OpenAI 兼容辅助模型（结构重建/可选翻译）；不用本机 Python、无本地 GPU 模型。集成方案见 `docs/books-converter-integration.md:13-27`；exe 经 `tauri.conf.json:139-142` 的 externalBin 注册
- **拉起方式：Tauri sidecar**（非 HTTP 服务）。`convert_pdf_to_epub` 命令 spawn `books_converter`，env 注入 `MINERU_TOKEN`/`PADDLEOCR_TOKEN`/`DEEPSEEK_BASE_URL|API_KEY|MODEL`（辅助模型复用），args 传 `pdf --headless --output-dir {appData}/converter [--no-ocr] [--engine paddleocr] [--translate LANG]`。出处：`core/converter.rs:44-98`
- **进度协议**：stdout 逐行 JSON（`start / progress / stage_done / done / error`），Rust 按行转发 `convert://progress` 事件，退出时补发 `{"type":"terminated"}`；`cancel_convert` kill 子进程（`converter.rs:101-147,154-161`）。阶段顺序：MinerU(1) → Hybrid 结构重建(2) → [翻译(3)，可选] → EPUB 生成。Windows 管道 GBK 问题已用 `ensure_ascii=True` 规避
- **产物入库**：done 后前端 `importConvertedEpub` 用 plugin-fs 读 epub 字节 → 包成 `File` → 复用书籍既有 `uploadBook()` 链路（`save_book` 落 `books/{id}/` + 入库）。出处：`services/converter-service.ts:94-100`；辅助模型参数解析 `resolveLlmParams`（:39-57）
- **设置**：MinerU/PaddleOCR Token 存 **keyring**（`converter-store.json` 的 token 字段已随密钥迁移置空，`converter-store.ts:32-35,56-64`；注意该 JSON 本身会被收进 L1 备份小包——备份是"顶层 *.json 全收减 `CONFIG_JSON_EXCLUDES` 排除清单"而非白名单，但包里已无密钥）；书籍引擎 `engine` 默认 `"mineru"`（表格密集更稳，`store/converter-store.ts:6-7,43`）

## 2. Papers_Converter（论文 PDF→paper.md）

- **架构同构**：独立 sidecar `papers_converter`（`--headless --output-dir {appData}/papers-converter [--provider E] [--model M] [--no-ocr]`），同构 JSON 进度协议，事件名 `paper-convert://progress`（Rust 给每条注入 `pdf_path` 防并发串台）。出处：`core/paper_converter.rs:43-93,104-157`。产物落 `{appData}/papers-converter/{slug}/{paper.md,images/,source.pdf}`，入库复用 `importPapers → scan_papers_dir → save_paper`

### MinerU-VLM 强制 OCR 主引擎

论文 stage1 = 云端视觉解析（MinerU VLM 后端或 PaddleOCR-VL），**对文字版论文也强制 OCR（`ocr=True`）走生成式识别**——因为 MinerU pipeline 后端（文字层直取）的公式模型实测是字符错误元凶（`(14)→(I4)` 等），于 2026-08-13 被否决下线（决策记录 `docs/papers-converter-integration.md:59`）。当前默认 `paperEngine: "mineru"`（`store/converter-store.ts:9-14,44`）。

> 代码滞后点：`paper_converter.rs:31,59` 的注释与兜底默认值仍写 paddleocr——前端总是显式传 engine，Rust 默认值是死路径；`--model pipeline --no-ocr` 透传逻辑仍完整保留（:62-77），属"UI 下线、通道保留"的手动降级通道。备选 provider（PaddleOCR-VL）经 sidecar 的 `--provider/--model` 参数切换（:43-93）。

### 光栅化重裁（rasterize & re-crop）

PDF 无"图片层"，复合图常被排版打碎。converter 侧 `figure_merger.py` 的做法：**同图碎块 bbox 取并集 → 从源 PDF 页 200 DPI 整幅重新光栅化裁剪**（无损无接缝，不是拼碎图）。归组规则为**就近成组**：同页连续图片块中间只夹 ≤20 字符小文字块（面板字母）不断组，真图注为组界、caption-first 归组；守卫：并集纵跨 >页高 75% 或面积 >90% 放弃合并。

### 幻影图注规则（phantom captions）

converter 侧 `content_processor.py:_split_figure_legends` 处理两种图注形态：整块独立图注（`Figure N. …`，>40 字符）转 `fig_caption_text`；句中粘连时从 "Fig. N. " 切出图注尾部。防误判两条守卫：

1. **跨页断句守卫**：页首块且上一段句未完结（不以 `.!?` 收尾）则判定 "Fig. N." 是跨页句中引用，不切（真机事故：某论文 "…photon energies of ‖跨页‖ Fig. 3."）
2. **封闭类功能词表**：句中切分时若前缀以介词/连词/助动词收尾 ⇒ 句未完结 ⇒ 不切

另有文件名撞名防线：同 Figure 编号分两组时自动 `-2/-3` 后缀防互相覆盖丢图。

### QC 闸（三层）

1. **退化检测 `quality_guard.py`**（stage1 产物层）：签名周期法——字母→a、数字→0、空白折叠后，单行 ≥200 字符内找周期 4..50、连续重复 ≥10 次、覆盖 ≥300 字符的循环；命中即 stage1 重试（`MAX_STAGE1_RETRIES=2`），耗尽则降级到 pipeline 后端兜底；最终仍命中则 done 打标 `degenerate:true` 不阻断。**SageRead 侧有同算法 TS 移植** `src/utils/degenerate.ts:18-21,45-67`（阈值是事故回归出来的，见 `docs/papers-converter-integration.md:62`），入库后本地复检（`pages/papers/index.tsx:1026`、`services/paper-reparse-service.ts:153-190`）
2. **结构边界判定**（stage2 语义层）：`cover_detect.py`（只判 page 0 + 正文信号一票否决）+ 可选 `STRUCTURE_LLM` 辅助模型仲裁 + `ARTICLE_BOUNDARY` 脏 PDF 头切/尾切。方案稿 `docs/paper-structure-boundary-plan.md` 里计划的 `structure_detector.py` **未以该名落地**，实际拆成上述三文件
3. **完整性闸 `qc_paper.py`**（产物机械层）：WARN 级=图/表编号断号、References 顺序异常、超长参考文献段；**severe 级**=断号 + 页数对照（页锚数 ≤ `int(pdf_pages × 0.6)` 判整页丢失），severe 命中触发换引擎重试链，仍不完整则交付但 done 打标 `incomplete:true` + `qc_warnings` 清单。SageRead 前端消费：`services/paper-service.ts:204-209`（字段定义）、`pages/papers/index.tsx:1017-1019`（toast 提示换引擎重解析）

## 3. 论文格式契约与渲染衔接

产物目录 `{slug}/paper.md + images/ + source.pdf（可选）`，slug 优先 citekey（契约 `docs/paper-format-contract.md:13-20`）。

- **frontmatter**：YAML 对齐 Pandoc/CSL——必填 `title/author(结构化 name+affiliation)/date/abstract`，尽量填 `doi/container-title`，可选 `keywords/volume/issue/page`，本地扩展 `arxiv/zotero_key/zotero_pdf_path`；任意 CSL 变量可直传，渲染器忽略未知字段（`paper-format-contract.md:26-51`）
- **正文约定**：heading 从 `#` 起重建编号层级；Abstract 正文保留（RAG 需要）；公式 `$...$`/`$$...$$`；图片 `![Figure 3: caption](images/fig3.png)`；表格 GFM pipe 或 HTML `<table>`；每页起始 `<!-- page: N -->` 锚点；**行尾必须 LF**（CRLF 曾致 heading 提取整批失配）（`paper-format-contract.md:53-64`）
- **入库**：`save_paper` 把 `paper.md`/`images/`/`source.pdf` 拷到 `{appData}/books/{id}/`，写 `metadata.json`（frontmatter 解析缓存），单事务 INSERT `books`(format=MARKDOWN) + `book_status`；**id = paper.md 内容 sha256 前 16 hex**（天然去重）。出处：`core/books/commands.rs:1334-1461`、`services/paper-service.ts:19`。重解析用 `replace_paper_content` 整体替换内容但**保留论文 id**（文件夹/线程/标注存活，`books/commands.rs:1473-1527`）
- **渲染衔接**：`pages/paper-reader/`（react-markdown + remark-math + rehype-katex + rehype-slug + GFM）；图片相对路径经 plugin-fs 读字节转 blob URL（带缓存，不用 convertFileSrc），`paper-reader.tsx:454-484,1098-1114`；frontmatter 解析在 `paper-metadata.ts`

## 4. 向量化管线

- **统一分块器**：tauri-plugin-epub 的 `chunk_md_file_flagged`——Markdown 结构感知分块（标题/代码块边界优先），找不到结构回退按 token 行边界；`MIN_CHUNK_TOKENS=50 / MAX=300 / 重叠 20%`（`text/constants.rs:5-11`）；**首个 References 标题后的分片打 `is_references` 标**（检索默认排除）。书/论文共用同一调用（`pipeline.rs:234,737`）
- **embedding 调用**：`text/vectorizer.rs:74-165`——OpenAI 兼容 `/embeddings` 或 Ollama `/api/embed`（按 URL 结尾识别）；tiktoken o200k 计 token；首次调用自动检测向量维度；10s 连接/60s 总超时
- **写库两条路径**：
  - 书籍：**每书一库** `books/{id}/vectors.sqlite`（`process_epub_to_db`，`pipeline.rs:16-26,171-186`；重建时直接删库文件）
  - 论文：**全局单库** `{appData}/papers/vectors.sqlite`（`process_paper_to_db`，`pipeline.rs:709-779`；多论文共存绝不删库，按 `paper_id` 先删后插幂等重索引；命令入口 `commands.rs:520-590`）
  - sqlite-vec 不可用时降级普通存储（`pipeline.rs:186-191,770-772`）
- **BM25/混合检索**：`search_papers_db`（`commands.rs:612-670`）→ `search_papers_global`（`pipeline.rs:860-913`）：有嵌入配置走 hybrid，无配置降级 BM25-only；`paper_ids` 集合过滤即"逻辑知识库"的物理实现。hybrid = 两路各取 `limit*2` → min-max 归一化 → 加权合并（默认 vector 0.7 / BM25 0.3；短查询智能偏向 BM25），缺一侧只用另一侧（`database/hybrid.rs:81-162`）
- **已知结构性短板**：BM25 分词是 `to_lowercase + split_whitespace + 滤单字符`（`database/bm25.rs:78-91`），**纯空格分词未接中文**——`text/zh_segmenter.rs`（jieba）只用于论文词级对齐的 `tokenize_zh` 命令（`commands.rs:697-703`），中文论文的 BM25 召回偏弱
- 参考文献噪声治理：chunk 的 `is_references` 标记 + 检索 `include_references` 参数默认 false（`pipeline.rs:412-421,859-868`）

## 5. 翻译管线

- **书籍全书翻译在转换阶段完成**：Books_Converter `--translate LANG`（hybrid 链内用辅助模型整书翻译后产出译版 EPUB），SageRead 侧只是传参（`converter.rs:70-75`）。**书内没有运行时翻译管线**
- **论文翻译（前端 service 实现，非 Rust）**：`services/paper-translation-service.ts`
  - 粒度：**块级平行译本**——切块器 `cutPaperBlocks` 与渲染器 DOM 块枚举严格一致（工程不变量），块索引即对齐键；批次 ≤12 块且 ≤6k 字符（:88-89,248）
  - 缓存/幂等：产物 `{appData}/books/{paperId}/translation-zh.json`，每块键 = 源文本 sha256 前 16 hex，hash 匹配跳过重翻（续翻/崩溃恢复），每批落盘一次；`force` 重翻才全量重算（:91-98,120-124）。**不产出翻译版 markdown**，原文是唯一事实源
  - 脚注（2026-08-25 起）：`[^id]` 定义不占块序号，以 `fn:<id>` 独立键入同一译本（同一幂等 hash 语义）；视图重建译文模式整块替换、对照模式译文 div 内联进脚注区；`restoreFootnoteRefs` 保证译文模式 `[^id]` 引用标记不被模型弄丢（丢失则 GFM 不渲染脚注区）
  - 模型：复用辅助模型（压思考强度），首轮翻译前抽取 30~60 条动态术语表注入后续批次（:52,172-193）；公式/代码/图片引用/References 不翻（prompt 约束 :154-163）
  - 对齐（句级/词级）：`paper-alignment-service.ts`——译后自动批量 embed 两侧句子 → 余弦相似度矩阵 → 单调 DP；对齐表写回译本 `blocks[idx].align/alignW`，幂等键 = 源 hash + 译文 hash（:31-38）；词级中文分词走 Rust `tokenize_zh`（jieba）
  - 元数据：title/abstract 顺带翻译写入 `metadata.json` 的 `title_zh/abstract_zh`，frontmatter 不动（:266-303）
  - 导出：`lib/export-paper.ts` 合成原文/译文/对照 + 标注 + base64 内嵌图片为 Markdown/HTML/PDF（译文仍不落盘进书库，仅导出物）
- 注意：`types/book.ts:163` 的 `TranslatorConfig`/`translateTargetLang` 是**遗留配置**——`translateTargetLang` 无功能消费（仅默认值），但同结构的 `translationEnabled`/`showTranslateSource` 仍被阅读器 UI 读取（`utils/style.ts:537,553`、`pages/reader/components/toc-view.tsx:176-177`），别把整块当死代码删

## 6. Zotero 批量导入

- Rust 侧 `core/zotero.rs`：扫描本机 Zotero 7 库、维护去重键（`zotero_key` UNIQUE）与导入状态；表 `zotero_collections`（collection key → 本地 folder 映射缓存，`database.rs:216`）与 `zotero_paper_state`（链接去重状态，`database.rs:228`；无外键，彻底删书时手动清，`books/commands.rs:334`）
- 前端入口：论文库 `zotero-import-dialog.tsx`（`pages/papers/`）；批量导入的演进与排障记录见 `docs/zotero-batch-import.md`
- 导入的论文走同一 `save_paper` 入库链路（id = paper.md 内容 sha256 前 16 hex，天然去重，含回收站口径）

## 7. 论文阅读页结构

`pages/paper-reader/` 三段式布局（`paper-reader-view.tsx`：左笔记 | 中正文+HeaderBar | 右论文助手面板）：

- 正文渲染：`paper-reader.tsx`（react-markdown + remark-math + rehype-katex + rehype-slug + GFM）
- 块/句/锚点模块：`paper-blocks`、`paper-sentences`、`paper-anchors` 一整套——**切块器枚举必须与渲染器 DOM 块严格一致**（翻译对齐依赖这条工程不变量，见第 5 节）
- 划线/hover：hover 矩形计算与标注落 `book_notes`（`type=annotation|excerpt`，`source` 区分 user/ai）
- 侧边栏图表：`getFigures` 工具消费 paper.md 的图片 alt 与编号图注段（`captionFrom: "alt"|"block"`，`ai/tools/paper/paper-extras.ts:152-202`），图表面板消费 paper-blocks 提取的 caption（`paper-figures-tab.tsx:71-72`）——转换器幻影图注规则的下游受益者（`fig_caption_text` 是 converter 侧概念，SageRead 仓内无此字段）
- 质量信号外露：入库后本地复检退化（`utils/degenerate.ts`），`incomplete/qc_warnings` 由 `pages/papers/index.tsx:1017-1026` toast 提示换引擎重解析

## 8. 文档与代码不一致清单

1. **论文默认引擎**：`docs/papers-converter-integration.md:45` 正文仍写"paddleocr 基线"；实际已改 MinerU-VLM 主引擎（同文档 §六与 `converter-store.ts:44` 才是最新事实）
2. **`SUPPORTED_FILE_EXTS`**：books-converter 文档 §九称多格式导入解锁 epub/pdf/mobi/cbz/fb2/fbz；代码现状仅 `["epub","pdf"]`（`services/constants.ts:23`）
3. **结构判定模块命名**：`paper-structure-boundary-plan.md` §5 的 `structure_detector.py` 未以该名落地（实际 `cover_detect.py` + `article_boundary.py` + `structure_llm.py`）
4. **paper.md 存储位置两种说法都成立**：内容存 `books/{id}/`、向量存 `papers/vectors.sqlite`，引用时讲清分离
5. **"mineru-pipeline 已下线" vs Rust 保留接线**：UI 下线、通道保留（`paper_converter.rs:62-77`）
6. `docs/format-strategy-and-paper-module.md` §五的风险清单（如"全局向量库 5000 向量无压力"）是早期估算；其"images/ 不在同步文件通道"一说**已被代码推翻**——论文资产现为整目录 zip 捆（含 images/，`core/sync/files.rs:163-207`）

## 9. 附：入库链路与触发入口汇总

**书籍导入三条路**（汇入同一 `save_book`）：

- 书库拖放/选择文件 → 前端 `uploadBook()`（`services/book-service.ts`，含 MD5 与 convertFileSrc）→ `save_book`
- 转换产物：转换页 done 后 `importConvertedEpub` 读 epub 字节包成 `File` 复用 `uploadBook()`（`services/converter-service.ts:94-100`）
- Agent 工具：`importBook` / `convertPdf`（central scope）
- 支持的导入格式现状为 `["epub","pdf"]`（`services/constants.ts:23`）；转换页 UI 在 `pages/converter/`（引擎选择、进度条、取消），取消走 `cancel_convert` kill 子进程（`converter.rs:154-161`）

**论文导入三条路**（汇入 `save_paper`）：

- Papers_Converter 转换：`paper-convert://progress` 事件跟进度（每条注入 `pdf_path` 防并发串台，`paper_converter.rs:104-157`）→ `importPapers → scan_papers_dir → save_paper`
- 直接拖放 PDF 进论文库（有 `cdp-test-pdf-drag-import` 冒烟覆盖）
- Zotero 批量导入（第 6 节）
- **重解析不换 id**：`replace_paper_content` 整体替换内容但保留论文 id，文件夹/线程/标注全部存活（`books/commands.rs:1473-1527`）；前端 `services/paper-reparse-service.ts:153-190` 在重解析后本地复检退化

**向量化触发入口**：

- 书籍：书库 `embedding-dialog.tsx` → `plugin:epub|index_epub` → 每书一库，**重建时直接删库文件**（`pipeline.rs:171-186`）
- 论文：`services/paper-service.ts:271` → `plugin:epub|index_paper` → 全局库按 `paper_id` 先删后插（幂等）
- 未配置嵌入模型时检索自动降级 BM25-only（`pipeline.rs:860-913`）；本地向量模型（llamacpp，仅 macOS）由前端 `llama-store.ts:176-218` 拉起

## 10. 附：管线常见坑（排雷）

- **行尾必须 LF**：paper.md 若为 CRLF，heading 提取会整批失配（契约 `docs/paper-format-contract.md:53-64` 的硬性条款，真机事故）
- **Windows 管道编码**：sidecar stdout 走 GBK 会炸，converter 侧已用 `ensure_ascii=True` 规避（`docs/books-converter-integration.md` §九）；改进度协议时勿回退
- **并发串台**：多篇论文同时转换时靠 Rust 注入的 `pdf_path` 区分事件归属（`paper_converter.rs:104-157`）；消费侧分两路——Agent 工具 `import-paper.ts:88,104` 按 `pdf_path` 过滤事件，论文库页面则靠**串行队列**逐篇转换（`pages/papers/index.tsx:1096`）天然不串台
- **slug 即目录名**：优先 citekey，重名/变更会影响 `{appData}/papers-converter/{slug}/` 与云端产物对应关系
- **References 噪声**：分块器只认第一个 References 标题（`pipeline.rs:412-421`），变体拼写（如 "REFERENCES"、Bibliography）的覆盖以分块器正则为准
- **退化检测阈值勿放宽**：四阈值在 `utils/degenerate.ts:18-21`；阈值是事故回归出来的（`docs/papers-converter-integration.md:62`），放宽会让坏解析静默入库
- **换引擎重试链**：severe QC 命中后由 converter 侧自动换引擎重试；前端只消费 `incomplete:true` + `qc_warnings` 打标并 toast 提示（`pages/papers/index.tsx:1017-1019`），不要在应用侧重造重试逻辑

## 11. 附：两条管线对照

| 维度 | Books_Converter（书籍） | Papers_Converter（论文） |
| --- | --- | --- |
| 产物 | EPUB（进书库，foliate-js 渲染） | paper.md + images/ + source.pdf（进 books/{id}，format=MARKDOWN） |
| stage1 引擎 | MinerU 云 API（hybrid 含结构重建） | MinerU-VLM / PaddleOCR-VL **强制 OCR**（pipeline 后端已否决） |
| 翻译 | 转换阶段 `--translate LANG` 整书出译版 EPUB | 阅读期前端块级平行译本（translation-zh.json），原文不落译版 |
| 向量库 | 每书一库 `books/{id}/vectors.sqlite`（重建删库） | 全局单库 `papers/vectors.sqlite`（按 paper_id 幂等重索引） |
| 质量闸 | 无独立 QC（依赖 MinerU 云侧） | 三层：退化检测 / 结构边界 / 完整性闸（QC 打标随 done 上行） |
| 进度事件 | `convert://progress` | `paper-convert://progress`（注入 pdf_path 防串台） |
| 工作目录 | `{appData}/converter/` | `{appData}/papers-converter/{slug}/` |
| 应用侧接线 | `core/converter.rs`、`pages/converter/` | `core/paper_converter.rs`、`pages/papers/` |
| 引擎配置存储 | `converter-store.json` 的 `engine`（默认 mineru） | 同文件的 `paperEngine`（默认 mineru，token 已迁 keyring） |

两条管线共用同一套 sidecar 拉起/进度协议模式（stdout 逐行 JSON → Rust 转发事件 → 前端进度条），新增转换器类型时照此复制即可。
