# DocRef 与锚点协议 v0（设计记录）与当前实现口径

> 2026-10-22 · G0 已通过；§1–§11 保留当时 v0 设计记录，不作为当前行为的唯一依据。
> 目标：把「找、读、看图」收敛为少数通用原语；场景差异上移到可见性、上下文注入与工具 guidance。
> 关联：docs/audits/agent-architecture-benchmark.md（目标架构）、docs/plans/agent-refactor-kickoff.md（顺序与门禁）。
> **当前契约以 §12 为准**：设计名 outline/read/search/view 分别对应现有 `getDocumentInfo/readDocument/searchLibrary/readImage/viewImages`；旧工具仅在 Legacy 回退模式注册，不与 New 组成并集。

## 1. 范围

本版只定义阅读侧工具面，reader / paper / central 共用同一套实现：

    outline / read / search / view / list_figures / get_citations / get_reading_position

工作区工具（glob / grep / write / edit / web / 管理类）本版不重定义，保持现状；read 与 view 的文件模式与它们共用授权根。
非目标：不定 UI、不动向量索引内部结构；工具总数目标 ≤14 可见（见 §8），但不在本版冻结。

## 2. 概念

### 2.1 授权根（roots）

- 用户工作区：可写（现状不变）；
- 文献库根：%APPDATA%/com.bettersageread.dev/books，只读；
- 附件根：attachments，只读。

越界读取走现有 tool-guard 确认卡；对文献库根写入返回 READ_ONLY，并提示「导入 / 删除 / 翻译请用全局助手管理工具」。

### 2.2 DocRef

文档 = 书或论文。注意：论文不是独立表，是 books 表中 format=MARKDOWN 的行。
工具参数中的 DocRef 用字符串：

    book:<book_id>
    paper:<paper_id>

「当前文档」是缺省值，由上下文注入；显式传 doc 时以显式为准。没有当前文档且未传 doc → NO_CURRENT_DOC，错误信息里提示先 outline 某文档或从文献库打开。

### 2.3 规范文本层（canonical text layer）

- 书：优先 mdbook 文本层 books/<id>/mdbook/book/src/text/*.md（按 spine 顺序）；没有 mdbook 时按 EPUB spine 顺序抽取文本。
- 论文：books/<id>/paper.md。
- 锚点里的字符偏移一律指规范文本层；同一 parser 版本内稳定。parser 版本变化时，金标必须重算。
- 图片：mdbook/images、论文 images/、附件；工具输出一律给绝对路径。

## 3. 锚点语法

    doc       book:<id> | paper:<id>
    text      doc [ "/" <md-path> ] [ "#" <heading-path> ] [ "@" <char-offset> ]
    figure    figure:<doc-id>:<label>       例：figure:a27b187c6bd02d3c:3
    cite      cite:<doc-id>:<ref-no>         例：cite:43f3adfdea61b6d4:12
    position  position:<doc>                 例：position:book:9f1820c6dcc62250458da69162b72e5d
    file      file:<abs-path>

规则：

1. heading-path 用 / 连接层级；片段从 outline 输出原样复制，不要手写改写。
2. 模型可见的 chunk 不暴露：search 命中的分块返回为字符窗口锚点（可继续 read），chunk id 只进轨迹元数据。
3. figure label 做归一化：Figure 3 / Fig. 3 / 图 3 / 图3 → 3；多子图默认归到母图（1a → 1），view 返回母图，需要子图时用 panels 字段里的路径。
4. cite 编号从参考文献小节解析，接受 [12] / 12. / 12) 形式。
5. 所有工具输出里的 anchor 都可直接作为下一跳参数；不要自己拼接偏移。

## 4. 工具契约

统一返回：成功 { ok: true, ... }；失败 { ok: false, error: { code, message, hint? } }。
错误码：DOC_NOT_FOUND / ANCHOR_NOT_FOUND / AMBIGUOUS_HEADING / OUT_OF_RANGE / NO_CURRENT_DOC / NOT_INDEXED /
        POSITION_UNAVAILABLE / NO_VISION / IMAGE_TOO_LARGE / IMAGE_NOT_FOUND / READ_ONLY / EMPTY_RESULT。

### 4.1 outline(doc?, depth?)

    outline({ doc?: DocRef, depth?: 1..3 })
    -> { ok, doc:{kind,id,title,author?,format}, index:{status:"indexed"|"not_indexed",chunks?,model?},
         reading?:{has_position:boolean,label?,percent?},
         outline:[{ level, heading, anchor, chars? }],
         figures:{count, with_captions}, citations:{count}, truncated? }

用途：看目录 / 章节结构 / 索引状态 / 图与引用规模，不读正文。默认 doc = 当前文档。
书：目录优先 TOC 标签，锚点落到文本层 heading；没有 TOC 时用文本层 heading。
论文：先用 Markdown heading；heading 过少（<3）时加粗体/全大写行的伪标题，并在返回里标记 synthesized=true。
上限：outline 条目 ≤300。

### 4.2 read(anchor? | doc? | path?, before?, after?, offset?, limit?)

    read({ anchor?, doc?, path?, before?:0..8000, after?:0..12000, offset?, limit? })
    -> { ok, doc?, anchor, range?:{start,end,unit:"char"}, text, next?, truncated?, total_chars? }

- 锚点模式（阅读）：anchor 或 doc 二选一；doc 等价于「从文档开头读第一窗」。
  - heading 锚点 → 该标题起，读到同/更高级下一个标题之前；
  - char 锚点 → 从该偏移开始；
  - figure / cite 锚点 → 只读该图注 / 参考文献条目附近的有界上下文（≤1200 字符），不含全文；
  - position 锚点 → 从实时阅读位置开始，before/after 扩窗；
  - chunk 不暴露（search 已转换）。
  - 默认 after=6000；被截断时返回 next（下一窗锚点）。
- 文件模式（工作区/附件/文献库任意文件）：path + offset/limit 按行读，limit ≤2000；库根只读。
- 返回原文；不返回「门牌号」。

### 4.3 search(query, doc?, scope?, types?, top_k?)

    search({ query, doc?, scope?:"current"|"collection"|"all", types?:("text"|"figure"|"cite")[], top_k?:1..20 })
    -> { ok, query, scope, results:[{ anchor, doc:{kind,id,title}, heading?, kind, snippet, image_path?, label?, score?, source? }],
         total, truncated?, note? }

- current = 当前文档；collection = 当前上下文集合（论文=当前文件夹，书=书库）；all = 全库。
- 只返回「锚点 + 有界片段」：snippet 默认 400 字符，max 800；绝不回全文。
- figure 命中返回 image_path（绝对路径），后续用 view 看。
- 未索引文档不报错：自动退化为关键词/标题匹配，并在 note 里说明「该文档未建索引，已退化为关键词检索」。
- 无命中返回 EMPTY_RESULT + 明确「没有找到」，模型应据此拒答或换词，不要反复重试。

### 4.4 view(anchor? | path?)

    view({ anchor?, path? })
    -> 文本信封 + 图片块（AI SDK file part）
       信封示例：<path>…</path><type>image</type><content>image/png 1980x1420 px, 4.83 MB, downscaled to 2048px</content>

- figure 锚点解析绝对路径；path 必须落在授权根内（或走 guard）。
- 单张原始 ≤20MB；长边 >2048 自动降采样（JPEG q80），模型无感；超过 20MB → IMAGE_TOO_LARGE，提示先 crop/缩略。
- 每轮最多 4 张（超出返回错误与提示）；模型不支持视觉 → NO_VISION（「当前模型不支持图片输入，请切换视觉模型」），不得静默丢弃。
- 历史图片沿用现有存根 + 需要时重看。

### 4.5 list_figures(doc?, query?, limit?)

    list_figures({ doc?, query?, limit?:1..100 })
    -> { ok, doc, total, figures:[{ anchor, label, caption?, caption_source:"alt"|"block"|"toc"|null,
         section?, image_path, panels?:[{label,image_path}] }], truncated? }

- 书名/论文都可；书从 mdbook/EPUB 图片 + 图注匹配；论文从 paper.md。
- query 走图注/章节的语义或关键词过滤（未索引时关键词）。
- 图注缺失时 caption=null、caption_source=null，并说明「未找到图注，需 view 看内容」。

### 4.6 get_citations(doc?, n?, offset?, limit?)

    get_citations({ doc?, n?, offset?:0, limit?:1..200 })
    -> { ok, doc, heading, entries:[{ n, anchor:<cite:...>, text, title?, year?, doi? }], total, truncated? }

- 定位 References / 参考文献 小节；条目按编号拆；n 给定时只返回该条。
- 找不到参考文献小节 → EMPTY_RESULT，说明「该文档没有参考文献小节」。

### 4.7 get_reading_position()

    get_reading_position() -> { ok, doc, label, percent, range, md_file?, spine?, cfi?, chunk_range? }

- 主通道是每轮注入【当前阅读位置】；本工具只作结构化字段/注入异常时的逃生口。
- 位置不可用 → POSITION_UNAVAILABLE，提示可先看注入段或让用户翻动页面；P1 后评估是否删除本工具。

## 5. 解析规则

heading：精确 → 归一化（空白/标点/大小写）→ 前导编号（第三章 / 5.6）→ 前缀/包含；产生多个候选时返回 AMBIGUOUS_HEADING + 候选（≤5，含 anchor），让模型选，不做隐式猜测。
figure label：Figure 3 / Fig.3 / 图3 / 表 3（表格单列 kind=table）→ 数字；子图归母图。
cite：优先 <a id="ref-N"> 锚点，其次编号行；解析失败的条目保留原文并标记 parsed=false。
position：与注入段同源（同一 ReadingPositionSnapshot）；书走 mdbook 字符偏移，论文走 paper.md 偏移。
无索引兜底：outline / list_figures / get_citations 不依赖向量；search 退化为关键词；read 始终可用。

## 6. 预算与上限

| 项 | 默认 | 上限 |
|---|---|---|
| read 单窗 | after 6000 字符 | 12000 |
| search top_k | 8 | 20 |
| search snippet | 400 字符 | 800 |
| outline 条目 | — | 300 |
| list_figures | — | 100 |
| get_citations | — | 200 条 / 8000 字符 |
| view 单图 | 长边默认 1024 / 上限 1536 | 原图 20MB / viewImages 一次 1–6 张（2026-10-22 实际值） |
| 单次工具结果 | — | 沿用现有 tool-result-slimming 上限；超限写回执 + locator |

## 7. 注入与 guidance

1. 【文献库与读取约定】静态段（缓存友好，放最前）：
   - 根路径与只读边界；目录布局（书 mdbook/text、论文 paper.md + images）；
   - 图片链接是相对路径，工具已解析为绝对路径，直接 view；
   - 探索顺序：当前文档信息/outline → search（语义模糊）或 grep（精确术语）→ read 窗口 → view 图片；
   - 引用规则：回答里带工具返回的 anchor（图号/章节/引用编号）。
2. 【当前文档】动态段：docRef、标题、索引状态、图/引用计数。
3. 【当前阅读位置】动态段放最尾部（沿用现有 D3 布局，保 prompt cache）。
4. 工具 guidance 单一来源：每个工具定义旁一段 Markdown（例如「要看图内容请 view，不要只看图注猜」），组装时按可见性拼接；删除 prompt 里手工维护的工具清单副本。

## 8. 可见性目标（P1 收敛后）

| scope | 默认文档 | 阅读工具可见 | 目标可见工具总数 |
|---|---|---|---|
| reader | 当前书 | outline / read / search / view / list_figures / get_citations / get_reading_position | ≤14（含 shared） |
| paper | 当前论文 | 同上 | ≤14 |
| central | 无 | 同上（必须显式 doc） | 不设 14 上限（管理类工具多） |

## 9. 旧工具映射（保留 alias 一个版本）

| 旧 | 新 |
|---|---|
| ragSearch / paperSearch | search |
| ragToc / getPaperToc / getPaperInfo | outline |
| readPaperSection / readBookSection / ragRange / ragContext / readAtReadingPosition / readPaperFull | read（窗口 + next） |
| getFigures | list_figures（+ view 看内容） |
| getCitations | get_citations |
| getReadingPosition | get_reading_position（逃生口） |
| readImage（attachment://） | view（同时接受路径与 attachment） |

## 10. G0 结论与待拍板

> 2026-10-22：用户确认「先定协议」并开始 Phase 0；以下 6 项按建议默认执行，如需调整走 v0.1（改动需记录受影响金标）。

1. 锚点语法是否接受（book/paper/figure/cite/position/file 六种；chunk 不暴露）？
2. 书 A 的 TOC 标签「第三章 政治学」与 mdbook heading「# 第三章」不一致：按前导编号匹配、输出实际 heading 锚点，是否接受？
3. 论文 heading 过少（Science 格式只有 4 个 # 标题）时，是否允许 outline 生成伪标题（synthesized=true）？
4. 无 mdbook 的书（书 B）：规范文本层用 EPUB spine 拼接、char offset 全局，接受吗？（parser 版本变化需重算金标）
5. list_figures / get_citations 是否保留为独立工具，还是折进 outline(include=[...])？v0 建议独立，G1 后再定。
6. view 的每轮 4 张 / 单图 20MB 上限是否合适？

## 11. 版本

- v0：本文件，G0 冻结。
- 变更需记录：日期、变更点、受影响金标（evals/tasks）。

## 12. 当前实现口径（2026-10-23）

### 12.1 模式与范围

- `DocumentToolMode` 只有 `new | legacy`，默认 `new`。旧持久化 Both/非法值归一为 `new`，显式 Legacy 保留；两者互斥，不形成工具并集。Legacy 是回退路径，不保证新原语的跨文档能力。
- 缺省检索范围按角色解析：reader=`current`、paper=`library`、central=`all`。只有 persisted key 缺失时才使用默认值；不回填、不覆盖已保存选择。Legacy paper 的 `current` 映射为本篇，`library/all` 映射为全部论文；旧工具不能表达书籍跨库检索。
- 共享文件五件套、`exportNotes`、`askAppHelp`、笔记/对话召回与图片工具不随 New/Legacy 裁剪。

### 12.2 规范文本、读取与检索

- 论文正文为 `paper.md` 的 canonical body；heading 与普通 offset 都是正文绝对 UTF-16 坐标。窗口为半开区间，`next_offset` 可精确续读。
- 书籍 New/Legacy 共用 JS 高保真 canonical；保留 TeX/MathML、表格和图片。heading/spine 的 offset 为节内坐标；无 heading 的显式 offset 为全书 canonical 绝对坐标；`position + offset` 为当前 md 文件坐标。图片路径在切片后解析，缺盘资源仅物化窗口内图片到 AppData EPUB cache。
- `readDocument` 返回真实 `range`、可重放的 `read`、`next_offset/truncated`；搜索命中的 `hit.read` 可直接传入并叠加 `before/after`，不会把不兼容坐标套到 Rust 扁平文本。
- `searchLibrary` 支持 `topK=1..30`（默认 6）、`vectorWeight/bm25Weight`（默认 0.7/0.3）与 `includeReferences`（默认 false）。命中带 `source/index/read/anchor_precision`；只有验证过的 canonical offset 才标 `exact`。
- 未索引不是“只能盲读”：关键词/标题通道独立于向量配置，与 `getDocumentInfo` 目录和 `readDocument` 原文互补。current/显式 doc 可完整扫描；library/all 的标题覆盖完整、正文扫描有并发/时间/结果边界，并以 `partial/truncated` 如实标记覆盖不完整。通道各自 `allSettled`，单通道失败不抹掉其他结果。
- library/all 还支持可选 `cursor`：结果含 `next_cursor` 时，以相同 query/参数继续调用即可从后续文档续扫，直到游标消失。游标无服务端状态，绑定 kind/query/includeReferences，并记录已返回命中以防跨页重复；current/doc 不返回也不接受 cursor。每页仍遵守相同的并发、时间与结果上限。

### 12.3 论文 extras

- `getFigures/getCitations` 属于论文能力，不为书籍注册独立版本。paper 可省略 doc 以读取绑定论文；显式 doc 仍受范围门禁。
- central 在 New/Legacy 都注册这两个 extras，且必须显式传 `doc=paper:<id>`；缺 doc 或 `book:<id>` 返回错误。reader 不注册 extras。

### 12.4 图片与授权根

- 本地图片根为 AppData、共享工作区和所有 per-agent roots。`agent_resolve_path` 只做预检；真正的 canonical 判界、敏感路径拒绝、目录/20MiB 检查、授权复核与字节读取集中在同一次 Rust `agent_read_image` 调用，返回原始 `ArrayBuffer`。
- strict 的界外图片在读取字节前确认；relaxed/full 按界外读语义免确认，但仍注入逐路径、绑定原始 path 与 `expectedResolved` 的授权。确认后 junction/目标变化或原始路径不同均拒绝；敏感文件名在所有模式和授权下拒绝。
- `viewImages` 与 guard 共用 `collectImageTargets` 做 trim/分类/去重；混合批次聚合一张确认卡、逐路径 grants，无整批界外放行。`attachment://` 继续走附件服务，不进入本地判界。前端仍做魔数嗅探、20MiB 二次检查、解码与长边/预算降采样；单批 1–6 张，长边默认 1024、最大 1536。

### 12.5 请求历史兼容

- 发送前只在请求副本上执行旧 raw MCP 图片 sanitize、direct↔directory 历史适配和 `await convertToModelMessages`；UI/DB 原消息不改。
- 未知/已下线工具不删除，toolCallId/output/approval/metadata 保留；conversion-only stub 不扩大 live 工具面。旧 MCP 历史仅留路径或诚实重读占位，当前轮 live MCP 图片行为不变；内置图片继续按既有预算回灌。
