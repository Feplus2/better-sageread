# P1-1 落地记录：readDocument / getDocumentInfo / searchLibrary

> 2026-10-22 · 对照：G1 基线、P0 冒烟 · 数据：.tmp-eval-runs/p1-1、p1-2 · L1：scripts/cdp-verify-p1-document-tools.mjs
> 一句话：三个通用文档原语已可用（L1 19/19），跨文献题第一次「不用 readLocalFile/runCommand 也能读另一篇」。但工具面处于「新旧并存」的加法阶段，10 题冒烟 token/步数没有净收益（均值 42.1k / 4.6 步，P0 为 30.4k / 3.4 步）。下一步必须做可见性切换，而不是继续加工具。

## 1. 新增

| 工具 | 能力 |
|---|---|
| readDocument(doc?, heading?, offset?, position?, before?, after?) | 按 DocRef 读任意书/论文的原文窗口；heading/offset/position 三种锚点 + next_offset 续读；书籍走 EPUB 章节读取，论文走 paper.md |
| getDocumentInfo(doc?) | 标题/作者/来源 + 目录（含锚点）+ 索引状态 + 图/引用计数 |
| searchLibrary(query, scope=current\|collection\|all, docType?, topK?) | 文献库论文混合检索；返回 doc 锚点 + ≤400 字符片段（移除旧 paperSearch 的 citation_guide 冗余） |

注册：reader / paper / central 三 scope；old 工具保留未删（alias 期）。prompt 增加了 readDocument/searchLibrary 的使用指引（paper policy、reader 跨文档段、library guide、searchLibrary description）。

## 2. L1（19/19）

- paper scope 含三工具；getDocumentInfo 标题/outline=4/figures=4/citations=23；
- readDocument 跨论文：doc=paper:43f3… + heading=Results and discussion → 标题正确、3000 字符正文、内容含 PB/Prussian；
- readDocument book：doc=book:9f18… + heading=第三章 政治学 → 命中、正文含「萨特/政治」；
- offset 窗口 ≤600 字符且 next_offset=1600；
- searchLibrary(all) 命中 6 条、片段 240–401 字符、全部带 paper: doc 锚点、无 citation_guide；collection 范围只返回 09515…。

## 3. 模型是否真的会用（关键）

cross-doc 单跑（p1-1）轨迹：
1. describeTool 查了一批旧工具 → 仍用 readPaperFull 读了当前论文；
2. 对第二篇：先用旧 paperSearch（范围被面板锁死，没用）→ 转向 searchLibrary(scope=all) 找到 paper:09515…；
3. 用 readDocument(doc=paper:09515…, offset=0/12000/24000, after=12000) 分 3 窗读完第二篇；
4. 没有再出现 readLocalFile/runCommand 到文献库翻文件。

结论：新原语被采纳，F1 路径 hack 消失。但该次 12 步 / 156k token——因为模型先试错旧工具、且用 12k 盲窗通读（没先 getDocumentInfo 拿目录）。

## 4. 10 题冒烟（p1-2，1 次）

| 题目 | G1 token/步 | P0 token/步 | P1 token/步 |
|---|---|---|---|
| book-locate-ch3 | 20,649 / 2.7 | 25,169 / 2 | 25,810 / 2 |
| paper-figure-3 | 39,579 / 6.0 | 32,199 / 4 | 31,902 / 4 |
| paper-figure-2 | 26,014 / 4.7 | 30,819 / 6 | 28,610 / 4 |
| position-summary | 17,477 / 2.3 | 18,321 / 2 | 18,699 / 2 |
| cross-doc | 176,790 / 15.0 | 104,484 / 9 | 94,052 / 9 |
| methods | 45,084 / 9.0 | 30,929 / 4 | 128,539 / 13 |
| citation | 14,582 / 2.0 | 16,008 / 2 | 16,185 / 2 |
| unindexed-book | 32,727 / 4.0 | 25,407 / 3 | 40,459 / 6 |
| refusal | 17,181 / 2.7 | 4,391 / 0 | 17,555 / 2 |
| position-where | 15,244 / 2.7 | 15,922 / 2 | 18,715 / 2 |

均值：P1 42.1k token / 4.6 步（P0 30.4k / 3.4；G1 40.5k / 5.1）。methods 与 unindexed 明显退化：模型在旧 readPaperSection 与新 readDocument 之间反复试探，且用大窗口盲读。

## 5. 结论与下一步

- 加法阶段不成立：新旧工具同时可见 → 目录牌更多、选择成本更高、token 不降。P1 真正的收益需要「可见性切换」。
- 下一步（P1-2）：
  1. 增加文档工具模式开关（new/legacy/both，默认 both 过渡）：new 模式下隐藏被替代的旧工具（readPaperSection/readPaperFull/readAtReadingPosition/getPaperToc/getPaperInfo/getFigures/getCitations/ragToc/ragRange/paperContext），只留 4 原语 + 位置注入；legacy 模式保持现状，保证回退。
  2. searchLibrary 命中结果补 heading 锚点（或引导 getDocumentInfo → readDocument(heading)），禁止 12k 盲窗通读。
  3. 用 10 题 × 3 次做 new-only vs legacy 的正式 A/B，对照 G1 门槛。
