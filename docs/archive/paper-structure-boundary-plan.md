# 论文结构边界语义判定专项（封面误杀事故 → LLM 结构地图）

> 状态：**方案已定，待新对话施工 + 大量测试**（用户 2026-08-11 拍板：不急着动手，先完善文档，新对话见）
> 施工仓：`F:\MyProjects\Papers_Converter`（main 分支）；交付物：重打 exe → `SageRead/packages/app/src-tauri/binaries/papers_converter-x86_64-pc-windows-msvc.exe`（gitignored，不入库）
> 阅读对象：接手施工的新对话。本文含全部已复核证据，**不要重查已铁证的结论**，直接从 §5 实施计划开工。

---

## 1. 事故全记录：zhao2020 封面误杀（2026-08-11 定位）

### 1.1 现象

应用内重解析 Zhao 2020《Rational design of layered oxide materials for sodium-ion batteries》（Science 370, 708–711，机构订阅版 PDF）后，Figure 2 / Figure 3 及配套图注、若干正文段落**整体消失**，交付产物图块只剩 [Figure 1, Figure 4]，被打 incomplete 标记。

### 1.2 真凶（铁证，勿重查）

`Papers_Converter/content_processor.py` 的 `_detect_cover_pages`（`content_processor.py:486-502`，`55f1ab0` 引入）把 `page_idx=1`（PDF 第 2 页）误判为"大学仓库封面页"，`process_content` Step 2（`content_processor.py:251-267`）将该页 22 个块**静默全部丢弃**。

已复核数据（产物在 `Papers_Converter/.tmp-qc-gate-run/_staging/Zhao 等 - 2020 ...-6546e9/`）：

- 引擎原始 `*_content_list.json`：**78 块、5 页齐全**——page0: 16 / page1: 22 / page2: 11 / page3: 13 / page4: 16；staging images 24 张
- page1 的 22 块 = **8 text + 1 equation + 6 chart + 2 image**（Figure 2/3 图块与图注、正文段落全在这里）+ 5 噪声块
- 命中的两个封面标记（标记表在 `content_processor.py:95-103`，阈值 ≥2 个即杀）：
  - `university of technology` ← 来自 **`page_footnote` 块**（作者单位 "Delft University of Technology"，正文脚注）
  - `downloaded from` ← 来自 **`aside_text` 块**（机构订阅水印 "Downloaded from http://science.sciencemag.org/ on November 5, 2020"，**每页都有**）
- **两个命中标记全部来自 Step 2 自己本来就会丢弃的噪声块**——判定跑在噪声过滤之前，把将要扔掉的块计入页面文本。规则自相矛盾，这是教科书级的规则翻车案例
- 旧 fixture（`SageRead/fixtures/papers/zhao2020rational/paper.md`）完整，因为当年源 PDF 无机构订阅水印——印证水印是诱因

### 1.3 为什么现有 QC 闸没拦住

本批已建成的 QC 体系（均已在 main 分支）：

- `quality_guard.py`：引擎产物退化循环检测（签名周期法）——防引擎随机失控，与本事故**正交**
- `qc_paper.py` severe + pipeline 完整性闸：图/表编号断号 + 页数对照（页锚 ≤ int(pdf_pages × 0.6) 判整页丢失）——本次**图编号断号子项确实命中了**（缺 Fig. 2/3），触发换引擎重试链

但换引擎链**治不好后处理系统性误杀**：每个引擎的产物都流经同一个 `process_content`，同一页被同一条规则杀掉——paddle [1,4] severe → 重试 → MinerU-VLM 同 severe → pipeline [4] → 最佳保留交付 [1,4] + incomplete。重试链是为引擎随机故障设计的，对 Stage 2 的确定性错误无效。

另外页数对照子项暴露了盲区：杀 1 页后剩 4 页锚，4 > int(5×0.6)=3，**不触发**。0.6 阈值只防大开裂，防不住"丢中间一页"。

### 1.4 事故定性

这是第三类解析事故，与前两类不同：

| 类别 | 故障层 | 性质 | 已有防线 |
|---|---|---|---|
| 退化循环（单词/数字递增失控） | Stage 1 引擎产物 | 随机 | quality_guard + 重试/降级链 |
| 漏块/漏页 | Stage 1 引擎产物 | 随机 | qc_paper severe + 换引擎链 + 最佳保留 |
| **结构边界误判（封面误杀）** | **Stage 2 后处理** | **系统性、确定性** | **无——本次暴露** |

---

## 2. 为什么规则路线被否决（用户 2026-08-11 拍板）

我曾提出纯规则修复（排除噪声块 + 收紧判据），用户否决，理由如下（整理自原话，作为本专项的根本设计约束）：

1. **规则 = 枚举已知模式，而问题空间是开放的**。"玄学就是玄学，规则总会在你意想不到的地方出问题，而且往往等你发现的时候已经晚了。"本次事故即实证：标记表里 `university of technology` 是为大学仓库封面设计的，谁能想到它会出现在作者单位脚注里。
2. **封面位置硬约束被规则无视**。封面/尾页只可能出现在文献最前或最后；封面必定在标题/摘要之前（如果有的话）。page_idx=1 是一页 22 块、含图表方程的正文页，被判封面——现有判定连最基本的位置语义都没有。
3. **脏数据是规则死穴（关键场景）**：一类 PDF 的几页并非完全是目标文献内容，更像从杂志/合订本里截取出来的——目标文献的标题摘要**前面**还粘着上一篇文章的长篇结尾和参考文献，本文结束后**后面**又跟着下一篇文章的标题和摘要。对这种数据，规则无法回答：
   - 这篇文章从哪里开始、到哪里结束？
   - 会不会把第一页（上一篇的尾巴）当作封面切掉？
   - 会不会把下一篇文章的标题误以为是我们的标题/章节？
   - 页眉页脚跑着别的文献名，规则如何去噪？
4. **我们有辅助模型**。封面识别、正文起止、标题摘要定位、参考文献边界——这类判断对 LLM 是一眼即知的简单语义任务（禁思考即可），成本极低。

**结论：结构边界判定是语义任务，主路线交给辅助模型；规则降级为 sanity check 与无 LLM 时的保守兜底。核心 fail-safe 原则：拿不准就保留——丢内容是灾难方向，多留是轻微方向。**

---

## 3. 目标设计：LLM 结构边界判定层

### 3.1 输出：结构地图（structure map）

对每篇 PDF 的 stage1 产物（content_list）生成页级 + 块级边界地图：

```jsonc
{
  "doc_pages": 5,
  "pages": [
    { "page_idx": 0, "role": "cover",            "confidence": 0.95, "evidence": "repository cover sheet, citation block" },
    { "page_idx": 1, "role": "title_abstract",   "confidence": 0.9 },
    { "page_idx": 2, "role": "main" },
    { "page_idx": 3, "role": "references", "start_block": 4 },
    { "page_idx": 4, "role": "other_article", "confidence": 0.85, "evidence": "new title+abstract of next article" }
  ],
  "article_span": { "start_page": 1, "end_page": 3 },
  "block_boundaries": [
    // 同页内角色切换时的块级边界（如 page 3 的第 5 块起进入 references）
    { "page_idx": 3, "from_block": 4, "role": "references" }
  ]
}
```

**页角色标签集**：

| 标签 | 含义 | 处置 |
|---|---|---|
| `cover` | 仓库封面页/出版商封皮 | 隔离（不进 IR） |
| `toc_ad` | 杂志目录页、广告页 | 隔离 |
| `front_matter_other` | 前一篇文章的内容（结尾/其参考文献） | 隔离 |
| `title_abstract` | 本文标题页/摘要区 | 保留 |
| `main` | 本文正文（含图/表/方程/脚注） | 保留 |
| `references` | 本文参考文献列表 | 保留 + 打 `section_role=references` |
| `appendix` | 本文附录/致谢/SI（属本文） | 保留 + 打标 |
| `other_article` | 后一篇文章的内容 | 隔离 |
| `uncertain` | 模型拿不准 | **一律保留** |

### 3.2 输入（给辅助模型看什么）

- **每页全部块，含 header / footer / aside_text / page_footnote / page_number，带类型标签**。注意：噪声块此刻是**信号**不是噪声——页眉跑着别的文献名、页脚水印、版权行，恰是判断页面归属的核心证据，绝不能预先扔掉
- 每块文本截断（建议 text 前 ~300 字符，caption 全留），整篇一次调用（论文通常 ≤ 40 页，token 完全可控）
- 辅助模型无视觉能力（已确认），走纯文本；但输入构造函数要抽象好，未来接视觉模型时可加页缩略图通道而不改主流程
- 调用参数：禁思考、temperature≈0、严格 JSON 输出。复用 `config.DEEPSEEK_*` 通道（与 metadata 提取、标题分类同一路），模型/超时建议加独立 env 覆盖（如 `STRUCTURE_LLM_MODEL`）

### 3.3 硬约束校验器（LLM 输出必须过这关）

无论 LLM 返回什么，强制执行：

1. **序列单调**：合法转移只允许 `cover*/toc_ad*/front_matter_other* → title_abstract → main+ → references? → appendix? → other_article*`。`main` 之后出现 `cover`/`title_abstract`（本文的）即违例
2. **cover 只能在 title_abstract 之前**（且通常 page 0）；`other_article` 只能在 `references`/`appendix` 之后
3. **封面/他文页被判隔离时，若该页含 image/chart/equation 块或正文 text 块 > 2 个，强制降级为 uncertain（保留）**——"瘦页才可能是封面"作为不可违抗的兜底
4. JSON 解析失败 / 序列违例 / 整体置信低 → **全量保留**，打 `structure_uncertain` 标记进转换报告，不杀任何页

### 3.4 消费方（结构地图改什么）

- **Stage 2（content_processor）**：`_detect_cover_pages` 退役；改为消费结构地图，隔离 `cover/toc_ad/front_matter_other/other_article` 页与块边界外的块。**隔离 ≠ 删除**：被隔离内容写入产物目录 `_quarantine/`（或转换报告内嵌清单），用户/调试可恢复
- **页锚与图编号对账**：限定在 article_span 内做，避免他文图表干扰 QC 对账
- **references 边界 → `section_role` 块级标签**（main / references / appendix），随 ProcessedBlock 下传，下游三处消费：
  1. renderer：可选视觉区分（第二批再做，不阻塞）
  2. **SageRead 向量化 / RAG 噪声治理**：与此前"RAG 检索命中参考文献噪声"议题联动——references 块带 role 标签后，索引时可默认排除或检索时按 role 过滤（具体策略见 §7 开放问题 2）
  3. QC：图/表编号对账限定 `main` 范围

### 3.5 与既有 QC 层的关系

三层互补，不互相替代：quality_guard（引擎产物层，随机失控）→ **structure map（后处理语义层，系统性误判，本专项新增）** → qc_paper（产物机械层，断号/页数）。qc_paper 页数对照的盲区（§1.3）可由结构地图顺带补上：隔离页是"主动丢弃"，页锚统计应只数保留页，避免误报。

### 3.6 无 LLM 兜底路径（use_llm=False / 未配 key）

规则不追求"杀得准"，只做最低限度保守版，宁可不杀：

1. 标记统计**排除噪声块**（只数 text/list 正文块）
2. 位置约束：只查 page 0 与末页，且必须在 title/abstract 证据之前
3. 瘦页约束：正文块 ≤ 2 或正文总字符 < 200 才可判 cover
4. 任何一条不满足 → 保留

（开放问题 3：无 LLM 时是否干脆完全不杀封面，待用户拍板。）

---

## 4. 脏数据处理规范（杂志截取场景，用户钦定重点）

**规范场景**：PDF 共 N 页，第 1 页（或前几页）是上一篇文章的结尾 + 其参考文献列表，随后出现目标文献的标题 + 摘要，正文若干页，本文参考文献结束后，又出现下一篇文章的标题 + 摘要开头。

处理要求：

1. **判定信号**（供 prompt 设计参考）：页眉/页脚出现与目标标题不符的文献名；references 列表出现在 title_abstract 之前；第二个 title/abstract 区块出现在本文 references 之后
2. **保留范围**：仅 article_span [start..end]；边界可能在页中间（同页上半是上篇结尾、下半是本文标题）→ 必须用 block_boundaries 块级切割，不能整页一刀切
3. **隔离内容**：前后他文内容进 `_quarantine/`，转换报告记录"检测到多文献混杂 PDF，已截取第 X–Y 页/块 a–b 为本文"
4. **标题提取防串**：metadata 提取（`metadata.py`）必须限定在 article_span 内取标题/摘要，防止把上一篇/下一篇的标题当成本文标题
5. 不在本层处理的事：双栏/三栏阅读顺序错乱（引擎层问题）；跨页图/表合并（既有 figure_merger / table_merge）

---

## 5. 实施计划（新对话按序施工）

### 阶段 1：`structure_detector.py` 新模块（纯 converter 侧）

- 新建 `Papers_Converter/structure_detector.py`：输入构造函数（content_list → 页块清单文本）、LLM 调用（复用 config.DEEPSEEK_*）、JSON schema 校验、§3.3 硬约束校验器
- 单测：`test_structure_detector.py`——schema 校验、单调序列违例判保留、瘦页约束强制保留、JSON 坏返回 fail-safe、无 key 时返回 None（走兜底）
- 验收：新单测全绿 + 既有 `python test_quality_guard.py` 27 测试不挂

### 阶段 2：process_content 接线

- `process_content` 签名加 `structure_map: dict | None = None`；pipeline 在 Stage 2 前调 structure_detector 生成地图传入
- `_detect_cover_pages` 退役（保留函数但不再调用，或直接删除——施工时定）；Step 2 改按地图隔离 + `_quarantine/` 落盘
- metadata 提取限定 article_span（§4.4）
- 验收：zhao2020 staging content_list 本地跑 `process_content`，page 1 的 22 块全保留，Figures 1–4 图块齐全

### 阶段 3：`section_role` 透传（references 边界）

- ProcessedBlock 加 `section_role`；renderer 可选输出（第二批）
- SageRead 侧向量化消费 role（与 RAG 噪声议题联动，策略待 §7.2 拍板）——**可独立成批，不阻塞阶段 1/2/4**

### 阶段 4：无 LLM 兜底规则收紧（§3.6）

### 阶段 5：测试矩阵 + 金标语料（见 §6，本专项重点，大量测试）

### 阶段 6：打包交付

- `.venv/Scripts/python.exe -m PyInstaller papers_converter_cli.spec --clean --noconfirm` → `dist/papers_converter.exe` → 改名复制到 SageRead binaries 路径
- 应用内重解析 zhao2020 E2E（CDP 套路见附录 C），确认 Figures 1–4 全回来、incomplete 标记消除
- 提交 Papers_Converter main（提交前与用户说一声）；SageRead 侧若有改动走 local 分支

---

## 6. 测试计划（新对话重点投入）

### 6.1 金标语料类目（每类至少 2 篇，人工标注每页角色作 gold）

| # | 类目 | 来源建议 | 关键考点 |
|---|---|---|---|
| 1 | 大学仓库封面页 PDF | TU Delft / MIT DSpace 等仓库下载 | cover 正确隔离、正文零损失 |
| 2 | 订阅水印学会刊 | Science/Nature 机构订阅版（zhao2020 同款，**回归必测**） | 水印页不再误杀；Figures 1–4 全 |
| 3 | **杂志/合订本截取（脏数据）** | Science Perspectives 合订页、老扫描期刊合页 | article_span 切割准确；他文内容进 quarantine；标题不串 |
| 4 | arXiv 预印本（干净） | arXiv 直下 | **不得回归**——零隔离、零误杀 |
| 5 | 正文 + SI 同文件 | 期刊官网 combined PDF | SI 标 appendix 保留（或按 §7.1 拍板处置） |
| 6 | 中文期刊（封面/目录页） | 知网/万方下载 | 中文封面标记、目录页隔离 |
| 7 | 老扫描件（pipeline 路径） | 扫描版 PDF | 引擎产物质量差时结构判定仍稳 |

### 6.2 指标（硬门槛）

- **本文块召回率 = 100%**：任何情况下本文的 text/image/chart/equation 块不得丢失（灾难方向零容忍）
- 隔离精度：被隔离内容确实非本文（允许"该隔离的没隔离"——轻微方向）
- article_span 边界准确率（页级 & 块级）
- A/B 对照：纯规则兜底 vs LLM 判定，输出失败分类学（哪类 PDF 上哪条路线还差什么）

### 6.3 回归与既有测试

- `test_quality_guard.py` 27 测试 + 新增 `test_structure_detector.py` 全绿
- zhao2020 进 fixtures 回归集（应用内 fixture 现为旧完整版，需替换为新产物并核对 Figures 1–4）
- E2E 后顺带重跑老批次 ~14 篇强信号异常论文（此前全库扫描 90 篇出 27 信号、去误报约 14），验证同因误杀被批量治愈

---

## 7. 待用户拍板的开放问题（新对话开工前先问）

1. **SI 同文件**：正文 + SI 合并 PDF，SI 部分保留+打 appendix 标，还是拆成独立产物？
2. **references 在 RAG 的待遇**：向量化时默认排除 references 块？还是索引进库但带 `section_role`，检索时按 role 过滤/定向（"只搜参考文献"也是真实需求）？
3. **无 LLM 时封面策略**：收紧规则保守杀（§3.6），还是干脆完全不杀封面、宁可多留？
4. **quarantine 产物形态**：独立 `_quarantine/` 目录，还是转换报告内嵌清单即可？
5. **视觉通道预留**：未来若辅助模型有视觉能力，页缩略图输入是否现在就在输入抽象里留口（建议留，成本极低）。

---

## 附录 A：关键文件与代码位置

| 文件 | 位置 | 说明 |
|---|---|---|
| `content_processor.py:95-103` | 封面标记表 `_COVER_PAGE_MARKERS` | 事故标记表 |
| `content_processor.py:251-267` | `process_content` Step 1/2 | 封面判定应用点（噪声过滤之前） |
| `content_processor.py:486-502` | `_detect_cover_pages` | 真凶函数（只查前 2 页、标记 ≥2 即杀、噪声块计入） |
| `content_processor.py:415-483` | `_llm_classify` | 既有 LLM 通道范例（config.DEEPSEEK_* 用法、JSON 解析、失败回退） |
| `pipeline.py:313-526` | `convert_pdf` | Stage 1→QC→Stage 2→severe 闸→换引擎链→最佳保留 |
| `pipeline.py:51-201` | `convert_single` | staging 复用路径 |
| `metadata.py` | 元数据提取 | LLM 标题/摘要提取，需限定 article_span |
| `qc_paper.py` / `quality_guard.py` | 既有 QC 两层 | 见 §1.3 / §3.5 |
| `config.py:48-50` | DEEPSEEK_* | LLM 通道配置 |

## 附录 B：zhao2020 证据数据（已复核）

- 证据目录：`Papers_Converter/.tmp-qc-gate-run/_staging/Zhao 等 - 2020 - Rational design of layered oxide materials for sodium-ion batteries-6546e9/`（content_list.json + 引擎 md + images 24 张）
- 页块分布：page0: 16（text 10, image 2）/ page1: 22（text 8, equation 1, chart 6, image 2）/ page2: 11 / page3: 13 / page4: 16；每页另有 header/footer/aside_text/page_number 噪声
- 水印形态：每页 `aside_text` 块 "Downloaded from http://science.sciencemag.org/ on November 5, 2020"；每页 `footer` 跑 "Zhao et al., Science 370, 708–711 (2020) 6 November 2020"
- 应用内当前产物：`SageRead` 库内 zhao2020 paper.md 图块 [Figure 1, Figure 4]，incomplete 已标

## 附录 C：环境与操作要点（防重复踩坑）

- Python：仓库 `.venv`（PyInstaller 在内），系统 python 是 miniconda（有 PyMuPDF/pdfplumber）；单测跑法 `python test_quality_guard.py`
- 打印中文注意 GBK 控制台：`PYTHONIOENCODING=utf-8` 或避免直接 print 特殊字符
- 应用内重解析 E2E 走 CDP（主实例 9222）：动态 import 用绝对路径 `/src/services/paper-reparse-service.ts`，调 `reparsePapers([{id, title, sourcePdfPath: '<PDF 绝对路径>'}], {})`——**必须传 sourcePdfPath**，否则"找不到源 PDF"白等 8 分钟；多引擎链全程约 6–8 分钟
- 打包后 exe 路径：`Papers_Converter/dist/papers_converter.exe` → 复制改名至 `SageRead/packages/app/src-tauri/binaries/papers_converter-x86_64-pc-windows-msvc.exe`（gitignored）
- 两仓当前状态：SageRead `local` 分支 `d858666`（incomplete 透传）、Papers_Converter `main` `b7bec37`（最佳产物保留），工作区均干净
