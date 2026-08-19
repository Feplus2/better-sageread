# 链接重建施工计划（论文原生链接 / 参考文献增强 / 语义重建）

> 2026-08-19 用户拍板立项。对应 `next-round-backlog.md` 远景项⑥。
> **进度：P1 已完成（2026-08-19）**——转换器侧（Papers_Converter `31c2845`+`1b8a50a`：
> link_extractor.py 新模块 + renderer 锚点发射 + `--no-links` 开关；宇宙弦注入 301 条
> 链接/85 锚点，剥除链接语法后与无链接版逐字节一致；单测 22 例+既有 4 套全绿）；
> 阅读器侧（SageRead `bd69079`+`b10b870`：fragment 链接拦截 + getElementById 定位 +
> 闪烁强调 + 懒加载漂移三轮校正；真实产出 CDP 实测 8/8 链接精确落点）。存量论文需
> 重转获得链接。
> 目标读者：接手施工的 Agent——本文档给出全部集成点、数据形状与验收标准，
> 照做即可，不要自由发挥。涉及仓库：`F:/MyProjects/Papers_Converter`、
> `F:/MyProjects/SageRead`、`F:/MyProjects/Books_Converter`、
> `F:/MyProjects/zotero-brain-slim`。

## 0. 背景：链接是在哪一层丢失的

PDF 的跳转不是文字层智能，而是独立的 **link annotations**（链接注释对象）：
每个链接 = 源区域矩形 + 目标动作（`GoTo` 到某页某坐标 / `named destination` /
外部 `URI`）。正文里的 [12]、Fig. 3、Section 4.1 能点全靠它们。

现状：MinerU / PaddleOCR 只产出版面文本流，**link annotations 全部丢失**，
转成 paper.md 后无任何链接。扫描版论文与图书则是 PDF 里本来就没有注释，
只能靠语义重建（P3）。

竞品基准（ScholarRead）：原生链接全部保留；参考文献可锚定到具体条目并展示
元数据、在库状态、一键获取 PDF / 兜底落地页。我们按 P1→P2→P3 分期追平。

---

## P1 保留 PDF 原生链接（Papers_Converter + SageRead 阅读器）

确定性最高、零猜测：**丢掉的，捡回来。**

### P1.1 提取（新模块 `link_extractor.py`）

用 PyMuPDF（fitz，管线已有依赖）从源 PDF 提取链接注释：

```python
page.get_links()
# 每条: {"kind": fitz.LINK_GOTO|LINK_NAMED|LINK_URI, "from": Rect,
#        "page": int, "to": Point, "nameddest": str, "uri": str}
```

- `source_pdf` 在 `pipeline.py::convert_single` 签名里**已有**，直接透传；
  仅当输入是 PDF 且有链接注释时启用，扫描版/无注释 PDF 自动跳过（零副作用）。
- `LINK_URI` → 直接产出外部链接（mailto:/doi.org 等）。
- `LINK_GOTO` → (page, to.y) 目标坐标；`LINK_NAMED` → 先经
  `doc.resolve_names()` 解析成 (page, y)，解析失败则放弃该条（保纯文本，不猜）。
- **源区域取词必须字符级精确**：`page.get_text("rawdict", clip=link["from"])`
  按字符 bbox 与 link 矩形的相交关系拼接，得到链接的可见文字（如 `[12]`、
  `Fig. 3`）。**禁止**用块文本模糊匹配当作链接源文字。

### P1.2 目标映射（页 + y 坐标 → 文档树锚点）

`content_processor.py` 产出的块带 `page` 与 `bbox`；`renderer.py` 里已有
`page_anchor` 块概念。映射规则：

1. 目标页的目标 y 坐标 → 该页内 **bbox 垂直覆盖或最近的块**，作为目标块；
2. 目标块是图/表 → 锚点 `#fig-N` / `#tab-N`（N 取图注/表注编号）；
3. 目标落在**参考文献区**（参考文献 heading 到文末）→ 按 y 落入的条目
   生成 `#ref-N`（N 为条目的文献编号，从条目文本首部的 [N]/N. 解析；
   解析不到编号则锚到条目序号）；
4. 其余 → 锚到最近的 heading（`#sec-*`）或页面锚点；
5. 映射置信度低（目标页无块、跨栏歧义）→ 放弃该链接，保留纯文本。
   **宁缺毋滥，错链比没链更糟糕。**

### P1.3 输出（`renderer.py`）

- 块内链接注入：链接源矩形 → 所属块 → 块文本内的**字符级区间**定位
  （rawdict 字符偏移，不是 str.replace 撞运气——同一块可能有多个 [12]）；
- 语法：行内 `[显示文字](#锚点)`；外部 URI 用 `[显示文字](https://...)`；
- 参考文献区条目在渲染时补锚点标记（与阅读器约定的格式，见 P1.4）。

### P1.4 阅读器侧（SageRead `packages/app/src/pages/paper-reader/`）

- 渲染器拦截 paper.md 内的 fragment 链接（`#fig-3` / `#ref-12` / `#sec-*`），
  **复用图表速跳同款定位机制**（`paper-reader-view.tsx` 的 quote /
  `data-paper-src` 定位 + 闪烁强调），点击平滑滚动而非触发导航；
- 参考文献条目渲染出稳定锚点元素（与 P1.2 的 `#ref-N` 对应）；
- 外部链接默认新窗口打开（`target=_blank rel=noopener`，站内已有此约定）。

### P1.5 P1 验收

- 用 CC BY 论文（arXiv:2605.22944，宇宙弦）+ madler2001 + Zhao2020 三篇回归：
  链接数量与人工抽查目标正确率（Fig/Eq/文献各抽 10 条），**文本零丢失**
  （与无链接版 paper.md 逐字 diff，只允许链接语法差异）；
- 阅读器内点击 [12] 类链接正确滚动到参考文献条目并闪烁。

---

## P2 参考文献增强链（结构化 + 元数据 + 在库 + 获取闭环）

目标交互（对齐 ScholarRead）：点击参考文献条目 → 卡片展示标题/作者/摘要
→ 标注"已在库中"或给出 [获取 PDF] / [访问页面]。

### P2.1 条目结构化（Papers_Converter，转换期）

- 规则预切分参考文献区为条目列表（`[N]`/`N.` 行首编号、悬挂缩进启发式），
  再交辅助模型批量提取字段（**禁思考**，输出 JSON 数组）：
  `{n, raw, title, authors[], year, venue, doi?}`；
- 产物 `references.json` 落在论文目录（与 paper.md 同级）；
- LLM 失败/条目数与规则切分差 >20% → 整段降级为规则切分（title=raw），
  不阻塞转换。

### P2.2 元数据补全与在库检查（SageRead，运行期懒加载）

- 有 DOI → Crossref `api.crossref.org/works/{doi}`；无 DOI → OpenAlex 标题搜索
  （`api.openalex.org/works?search=`，取 title 相似度 ≥0.9 的首条）；
- 摘要取 OpenAlex `abstract_inverted_index` 重建；结果缓存进 references.json；
- 在库检查：DOI 精确匹配 → 标题归一化模糊匹配本地库 metadata。

### P2.3 获取闭环（zotero-brain-slim 改造 + 前端）

**zotero-brain-slim 改动**（`paper_importer.py` / `paper_discovery.py`）：

- 七级瀑布全部失败时，**不再只报错**，返回结构化结果：
  `{status: "no_pdf", landing_page: <url>, tried: [...]}`；
- `landing_page` 取值优先级：Unpaywall `best_oa_location.url_for_landing_page`
  → OpenAlex `primary_location.landing_page_url` → `https://doi.org/{doi}`；
- 找到 PDF 但校验失败等中间态也尽量带 landing_page。

**前端**：参考文献卡片按钮——[获取 PDF]（调 Zotero Brain；成功则走导入流程）
/ [访问页面]（landing_page，新窗口）。在库则显示[打开]直跳阅读。

### P2.4 P2 验收

- 三篇回归论文的参考文献解析条目数与人工计数一致；DOI 提取率 ≥80%（有 DOI 的条目）；
- 元数据卡片展示标题/作者/摘要正确；在库检查对库内已知论文命中；
- 获取闭环：一篇 OA 论文能一键进库；一篇非 OA 论文给出可访问落地页。

---

## P3 语义重建（无原生链接场景，最后做、保守做）

### P3.1 论文（扫描版/无注释 PDF）

- 白名单模式匹配正文引用：`Fig(?:ure)?.?\s*\d+`、`Table\s*\d+`、
  `Eqs?.?\s*\(\d+\)`、`Section\s+\d+(\.\d+)*`、`\[(\d+([,-]\s*\d+)*)\]`；
- 与已解析的图注/表注/公式编号/文献条目配对补链；**只对唯一命中补链**，
  多义或零命中一律不动（误链率必须接近 0）。

### P3.2 图书脚注（Books_Converter → foliate 弹注）

机制背景：EPUB3 原生注释语义——`<aside epub:type="footnote">`（内容）+
`<a epub:type="noteref" href="#fn1">`（引用点）；阅读系统识别 noteref 即弹注，
**foliate-js 原生支持**，阅读器侧零改动。

- stage2/3 识别页底/章末注释区（①②③、［1］等标记 + 位置/字号启发式）；
- 与正文引用标记配对（同页同号优先；配不上的注释保留为普通段落，不丢内容）；
- stage3 输出语义化标记；回归：高等数学/刘擎讲义抽查弹注 + 内容零丢失。

---

## 全局工程约束（每一期都必须遵守）

1. **文本零丢失是硬保证**：链接只增不删，diff 校验只允许链接语法差异；
2. 每期独立可交付、独立可回滚；转换器改动后跑全套回归（Papers：三篇；
   Books：41/41 + 12/12）；
3. 不确定就降级为纯文本，**禁止编造链接目标**；
4. 新依赖先确认：fitz 已在两转换器依赖内；前端不新增依赖。

## 开放问题（施工中遇到再定）

- 双栏论文的 link rect 与块归属歧义（先用 y 最近邻，实测看误配率）；
- 参考文献编号与条目对不齐（如 [12]→条目只有 11 条）时的锚定策略
  （当前约定：放弃该链接）；
- references.json 是否纳入 L2 增量同步（倾向：纳入 L1 备份，L2 视体积再定）。
