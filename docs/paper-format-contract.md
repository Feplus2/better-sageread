# 论文格式契约：Papers Converter ↔ SageRead 文献库

> 2026-07-28 初版。定义 papers converter 的输出格式（Pandoc-flavored Markdown），是**转换器与渲染器/向量化之间的唯一约定**。契约先行，两端可并行开发；任何一端只需要面向本契约，不需要兼容契约外的变体。

## 一、定位

- **papers converter 是独立专用工具**（books_converter 同级 sidecar）：PDF → Pandoc MD + images + frontmatter 元数据。
- 它不是 Books_Converter 换个输出格式。图书面向章节/目录/阅读流；论文的元数据（作者/期刊/DOI/摘要）、无目录但有明确层级、引文与参考文献结构，都必须针对性设计。
- **管线独立**：不依赖 zotero-brain 运行时，不读它的 `parsed/` 缓存。论文搜索/下载由 zotero-brain 以 MCP 外挂提供，装不装都不影响本管线。

## 二、输出目录结构

```
{paper-slug}/
├── paper.md        # 唯一文本产物，Pandoc-flavored Markdown，UTF-8，LF
├── images/         # 图片（png/jpeg），正文以相对路径引用
└── source.pdf      # 可选：原 PDF 拷贝（供未来 PDF 对照面板）
```

slug 规则：citekey 优先（Better BibTeX 风格 `author2024keyword`），否则 `姓氏-年份-标题首词`，全小写、连字符分隔。

## 三、Frontmatter（YAML）：对齐 Pandoc/CSL，不自创 schema

**设计原则：语法层全部使用 Pandoc Markdown 官方约定；schema 层字段名对齐 Pandoc 结构化作者与 CSL 变量**（pandoc `--citeproc` / Zotero / Quarto 通用）。本契约不自创任何语法与字段体系；只有明确标注"本地扩展"的字段是 SageRead 私有的。

```yaml
---
title: "..."                  # pandoc 标准
author:                       # pandoc 结构化作者（官方手册约定）
  - name: "..."
    affiliation: "..."        # 可选
date: "2024"                  # pandoc/Quarto 标准日期变量（CSL 对应 issued）
abstract: >-                  # pandoc 模板标准变量，多行用折叠标量
  ...
doi: "..."                    # CSL: DOI，有则必填
container-title: "..."        # CSL：期刊/会议名（对应 BibTeX journal/booktitle）
keywords: ["...", "..."]      # 可选（pandoc/Quarto 惯例）
volume: "..."                 # 可选，CSL 直传
issue: "..."                  # 可选，CSL 直传
page: "..."                   # 可选，CSL 直传
arxiv: "..."                  # 本地扩展：arXiv id
zotero_key: "..."             # 本地扩展：经 Zotero 导入时填
lang: "en"                    # pandoc 标准
---
```

- **必填**：`title`、`author`、`date`、`abstract`。解析失败时尽力回填（可按 DOI 查 CrossRef 兜底），不得留空。
- `doi`/`container-title` 尽量填，是列表展示与元数据过滤的主要字段。
- 任何额外的 **CSL 变量可原样直传**（`type`、`ISSN`、`URL`、`publisher` 等），渲染器忽略未知字段——这使 frontmatter 可直接被 pandoc `--citeproc` / Quarto 消费，并与 Zotero 的 CSL-JSON 导出同构。
- frontmatter 是元数据的唯一来源；文献库数据库/列表展示均从它解析缓存。

## 四、正文约定

- **Heading**：从 `#` 一级开始，converter 必须重建编号层级（`# 1 Introduction`、`## 2.1 ...`）。无编号的固定段（Abstract、Acknowledgments、References）用对应层级的 `#`。
- **Abstract 保留在正文中**（RAG 分片需要完整文本）；frontmatter 的 `abstract` 供列表/元数据展示，两处并存是有意冗余。
- **公式**：行内 `$...$`，独立 `$$...$$`（KaTeX 可渲染为准）。
- **图片**：`![Figure 3: caption text](images/fig3.png)`，caption 含编号。
- **表格**：GFM pipe table；跨行/跨列等复杂表格用 HTML `<table>`。
- **引文**：v1 保留原文样式 `[12]`；`[@citekey]` + bibliography 生成留待 v2（依赖 .bib，超出 MVP）。
- **参考文献**：`# References` 段原样保留，不做结构化。
- **页码锚点**：每页起始处插 `<!-- page: N -->` 注释（来自解析产物的页码映射），供未来 PDF 对照面板做"当前位置 ≈ 原文第 N 页"；渲染器天然忽略 HTML 注释。
- 段落单行书写，不做强制语义换行。
- **行尾必须归一化为 LF**（CRLF/CR 会破坏下游按行解析的正则与偏移计算——2026-07-28 实际故障：MinerU 产物 CRLF 导致 heading 提取整批失配）。converter 落盘前统一 `\r\n?` → `\n`。

## 五、验收标准

- 取 5–10 篇真实论文（覆盖双栏、公式密集、表格密集）转换后：
  - frontmatter 必填字段齐全；
  - heading 层级正确、可直接生成 TOC；
  - 公式 KaTeX 渲染无报错；
  - 图片相对路径可显示；
  - `chunk_md_file` 分片结果合理（heading 边界切分），向量化零改造可用。
- **生态兼容检查**：`pandoc paper.md -s -o out.docx`（或 Quarto 渲染）直接成功，无语法错误——证明产物活在 Pandoc 生态内，而非 SageRead 私有方言。

## 六、v1 现实偏差（2026-07-30 实录，渲染器可依赖但勿惊讶）

契约是目标态；以下是当前 converter 产物的**已知偏差与放宽**，均不改变语法层面约定：

- **表格**：跨页续表已合并为单个 HTML `<table>`（重复表头行去重）；表注为表前独立段落。无 HTML 表体的表格页退化为普通 markdown 图片（`![表注](images/tableN.jpg)`），不是 `<table>`。
- **图注与图版**：游离的 `Figure N.` 图注会绑回最近未编号图组；碎组图（MinerU 多图版切碎）图版归属是尽力而为，个别图注只能以编号段落留在正文流中。无编号图组命名 `figX{seq}`。
- **作者 bio 照**（RSC 版式）可能作为 Figure 1 子图出现。
- **公式**：MinerU 输出的 legacy TeX 命令（`\bf/\cal/\sf/\tt/\textcircled`）KaTeX/pandoc 可能告警，待 converter 侧扫荡。
- **元数据**：author/container-title/date/citekey 以 Zotero/CSL-JSON 为准，LLM 仅补 abstract；个别 Zotero 条目自身缺字段时以规则/CrossRef 兜底，仍可能缺 container-title/date（数据缺口，非解析失败）。
