# 评测 Fixture（第一版）

> 2026-10-22 · 状态：已冻结候选，待 G0 确认
> 原则：题库钉在固定文档上；文档 id 一旦选定不再漂移；内容变化时更新校验并同步金标。

## 0. 数据根与事实

- dev 实例 identifier：com.bettersageread.dev（tauri.conf.json），数据目录为 %APPDATA%/com.bettersageread.dev。
- 书籍目录：books/<book_id>/（book.epub、mdbook/、chapters/、vectors.sqlite、images/ 等）。
- 论文不是独立表：论文是 books 表里 format=MARKDOWN 的行（file_path 指向 books/<id>/paper.md）。
- 论文向量库：papers/vectors.sqlite（全局，当前 17 篇 / 3072 chunks，含 sqlite-vec 虚拟表）。
- 书籍向量库：books/<id>/vectors.sqlite（每书一个，当前多本已有）。
- 当前选中文档都是用户 dev 库真实数据；跑评测前先备份整个数据目录。

## 1. 选中文档

| 角色 | id | 文档 | 格式 | 向量 | 关键资产 | 用途 |
|---|---|---|---|---|---|---|
| 书 A | 9f1820c6dcc62250458da69162b72e5d | 牛津通识读本：福柯（中文版） | EPUB | 已索引 288 chunks | mdbook 42 md、15 张图、阅读位置 65/167 | 结构/定位/位置/EPUB 图 |
| 书 B | 718a0d5d6514980ce87dd8b0d39ad2dc | 民法总论（杨代雄） | EPUB | 未索引 | 7.3MB EPUB、无 mdbook、阅读位置 670/845 | 未索引兜底/长书 |
| 论文 A | a27b187c6bd02d3c | Rational design of layered oxide materials for sodium-ion batteries | MARKDOWN | 已索引 84 chunks | 4 张 jpg 图 + 完整图注、translation-zh.json | 图表/检索/结构 |
| 论文 B | 43f3adfdea61b6d4 | Dehydration-induced CN- defects ... Prussian blue cathodes | MARKDOWN | 未索引 | 6 张 png（1.1–5.0MB）、refs 到 [12]、10 个标题 | 未索引/大图/引用 |
| 论文 C | 09515f7218b81d7f | Environmentally stable interface of layered oxide cathodes | MARKDOWN | 已索引 140 chunks | 48KB、8 个标题、多子图 Figure 1(a-e) | 跨文献对比（与论文 A） |
| 论文 D（方法型） | 5c33d4493541c1f7 | At-Scale Data-Driven Exploration ... | MARKDOWN | 未索引 | 63KB、7 张图、方法节完整 | task 6：方法/数据管线题 |
| 备选（长综述） | 9cb0c0d36b71df5c | Review of cathode materials for sodium-ion batteries | MARKDOWN | 未索引 | 112KB、26 个标题、15 张图 | 长文大纲/综述（暂未用） |
| 冒烟 | ba90a9372a2bbe47 | 合成小样本（2.4KB，图仅 140B） | MARKDOWN | 未索引 | 极小 | L1 快速结构检查 |

## 2. 已核实的坐标与内容（2026-10-22）

- 书 A：reading 65/167；location=epubcfi(...)；mdbook/book/src 下 42 个 .md（text/part*.md）；15 张插图（00001–00015.jpeg）；chapters/001-Chapter 1.txt … 为章节文件。
- 论文 A：paper.md 24,962 字符；4 个顶层标题（# 标题 / # REFERENCES AND NOTES / # ACKNOWLEDGMENTS / # SUPPLEMENTARY MATERIALS）；4 个图：Figure 1–4，均 jpg，图注在图片后独立段落。
- 论文 B：paper.md 47,533 字符；# Introduction / # Results and discussion / # Conclusion / # References；图注 Figure 1–6；参考文献 [1]–[12] 可定位（ref-12 为 Gao Q 等 2023）；图 1–6 为 png，最大约 4.98MB（用于降采样验证）。
- 论文 C：paper.md 47,923 字符；标题含 # Results / # Discussion；Figure 1 拆成 (a)–(e) 多图。
- 论文 D：paper.md 112,584 字符；# ABSTRACT / # 1. Introduction / # 2. Transition metal oxides 等 26 个标题；15 条图片行。
- 全局论文向量库：a27b…=84 chunks、09515…=140 chunks、9cb0…/43f3…/5c33…=0（未索引）。

## 3. 备份 / 恢复

- 评测前：整目录复制 %APPDATA%/com.bettersageread.dev 到 .tmp-eval/backup-<timestamp>/（排除 sync-staging）。
- 至少备份：database/app.db、books/<5 个 fixture id>/、papers/vectors.sqlite。
- 恢复：停 dev 实例 → 覆盖回目录 → 重启（启动前确认没有别的实例写同一目录）。
- 后续做 seed 脚本：从干净数据目录导入固定 fixture，避免依赖当前 dev 库状态。

## 4. 评测隔离

- L2 直连 harness：页面上下文 import registry + provider，直接 execute 工具/streamText，不创建 thread、不写 notes（读类任务天然只读）。
- 若必须 UI 驱动：线程标题加 [eval] 前缀，跑完按前缀清理；不碰用户已有 thread。
- 位置类任务需要「当前阅读位置」处于已知状态：跑之前在 UI 打开对应书/论文并用固定 CFI 定位；harness 记录位置快照，跑完恢复。

## 5. 待验证

- 书 A 的 EPUB TOC 与 mdbook text/part*.md 的章节标题映射（目录是否够用）；
- 书 B 无 mdbook 时 readBookSection 的 EPUB 解析成功率与耗时；
- 论文 C 的 Figure 1 多子图在图注/锚点里如何编号；
- 旧工具集在 10 题上的真实失败模式（G1 基线时记录）。
