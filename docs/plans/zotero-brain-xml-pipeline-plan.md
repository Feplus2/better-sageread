# Zotero Brain Slim 适配：XML 全文获取与转换管线（立项笔记，2026-08-26）

> 状态：**✅ 已落地（2026-08-26，全链路通）**。ZBS Elsevier 级（zbs e714e4e）→
> Papers_Converter XML→MD（1448830）→ SageRead 导入链路与 UI 文案（见本地
> commit）→ CDP 实盘 9/9（XML 拖入→任务卡→落库→阅读器目录/图/公式/引用锚点→
> references.json）。Elsevier 真实联调待用户 API key（dev.elsevier.com 自助申请，
> 填一行环境变量即可测试）。原始立项背景存档如下。

## 背景与痛点

Zotero Brain Slim（`F:\MyProjects\zotero-brain` 精简版，MIT 已开源）侧有上游升级。
现状痛点（用户原话"过去老是走歪门邪道"）：

- **检索**：经常失败或被限流。出路相对明确——几个正规 API 应该可以解决（立项时再选定）。
- **内容获取**：开放获取源往往**更支持 XML（JATS/BITS 全文）而不是 PDF**——PDF 经常拿不到或被墙，
  XML 反而稳定可下。但 **Papers Converter 目前只接受 PDF 输入，不支持 XML**，导致这条更可靠的
  获取通道用不上。

## 目标范围（三块联动，缺一不可）

1. **Converter 侧（Papers_Converter 仓）**：接受 XML（JATS/BITS 学术全文格式）作为输入，
   产出与 PDF 路径同构的 paper.md + 图 + references.json 产物。要点（立项时细化）：
   - XML 本身带语义结构（章节/图表/公式/参考文献全标好）——解析质量上限应高于 PDF-OCR 路径，
     排版重建策略与 PDF 路径不同（不需要 OCR/栏序恢复，但要处理 JATS 标签到 Markdown 的映射、
     公式 MathML → LaTeX、图表实体引用 → 本地图片下载/内嵌）。
   - 参考文献直接从 `<ref-list>` 结构化提取——比 PDF 路径的正则重建可靠得多。
2. **阅读器/导入链路（SageRead 仓）**：导入不再只认 PDF——支持 XML 文件导入（拖入/菜单/ZBS 推送），
   任务通道（paper-parse）按输入类型分派转换参数。
3. **UI 文案**：导入入口、任务卡片、错误提示、设置页转换引擎说明等一切写着"PDF"的文案，
   按"PDF / XML"双格式口径更新（用户明确点名"UI 文案方面也得跟进"）。

## 与既有事项的关联

- Zotero Brain Slim 的 P2 参考条目一键抓取链路（条目点击 → ZBS 抓 PDF → 解析导入）：
  XML 通道打通后，抓不到 PDF 的条目可以降级走 XML——**覆盖率直接提升**，这是本项最大的用户价值。
- 检索侧（API 选型）与内容获取可以分两阶段：先 XML 转换管线（价值大、边界清），检索 API 后做。

## 立项时要回答的问题（开工前对一遍）

- JATS 变体覆盖：PMC / arXiv(?) / Hindawi / eLife 各源的 JATS 方言差异，fixtures 怎么选。
- 图片：XML 里的图是外链/附件包（tgz）——下载策略、失败降级、与现有 figures 产物对齐方式。
- 公式：MathML → LaTeX 转换器选型（自研规则 vs 现成库），与既有公式渲染管线（KaTeX）的对齐。
- 产物契约：paper.md 的 frontmatter/块结构与 PDF 路径完全一致（阅读器/向量化/翻译不感知来源）。
- 转换器 CLI 接口：`--input-format auto|pdf|xml` 还是按扩展名嗅探；任务通道 payload 怎么带。
