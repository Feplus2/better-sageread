# 书籍对照翻译计划（book-translation-plan）

> 2026-08-29 首轮裁定并定稿方案；同日一期实现落地并于当晚实盘验收通过（含验收迭代四连修，见下）。
> **状态（2026-08-30）：一期+二期全落地（含 4d/批次 5/5b），已提交待发版。**
> 与论文侧对照翻译同构：翻译块 sidecar、不改动原 EPUB、词句对齐照搬。

## 一期实现落点（2026-08-29）

| 模块 | 文件 |
|---|---|
| 段落枚举+注入共享契约 | `packages/app/src/services/book-translation/section-blocks.ts` |
| 翻译服务（按章分文件/断点续翻/守卫/术语表） | `packages/app/src/services/book-translation/book-translation-service.ts` |
| 句级对齐（T2 数据层） | `packages/app/src/services/book-translation/book-alignment.ts` |
| 注入 transformer（第 4 个） | `packages/app/src/services/transformers/translation.ts` |
| 任务通道（并发 1） | `packages/app/src/services/task-executors/book-translate.ts` |
| 阅读器下拉（开关/全书一键/进度/取消） | `packages/app/src/pages/reader/components/translate-dropdown.tsx`（header-bar 插入） |
| CSS 显示开关（即时生效） | `packages/app/src/utils/style.ts` getTranslationStyles(showSource, translationEnabled) |
| 状态回写 | `book-service.ts` updateBookTranslationMeta → `book_status.metadata.translation`（类型在 types/simple-book.ts） |
| 契约测试 | `scripts/test-book-section-blocks.mjs`（8 用例，照搬论文侧一致性测试的 esbuild+jsdom 套路） |

实现与原方案的偏差（均已裁量的理由）：

1. **词级对齐（alignW）一期不自动计算**：数据结构已留位（BookTranslationBlock.alignW/alignWHash），
   但翻译一条龙只跑句级——词级量级约为句级数十倍、消费方在二期交互层，届时随交互层一起补，
   避免一期任务时长翻倍。句级照文档承诺随翻译自动跑（无嵌入能力跳过，不阻塞）。
2. **译文上屏双通道**：章节加载时由 transformer 注入（主通道）；翻译任务收尾广播
   `book-translation-updated`，阅读器对当前显示章节**直接 DOM 注入**——因为 foliate 的
   blob URL 缓存使同章重载不重流 transform（goTo 同章吃缓存），DOM 注入与 transformer
   共用同一 injectSectionTranslations 函数，契约不破、且不闪动不重渲染。
3. **注入为替换/更新语义**：同段已有译文块时更新文本而非重复插入；td/th 内译文是子元素，
   枚举取段文本时排除译文块子树（契约测试的"二次注入不重复、td 文本不漂移"用例即此回归）。
4. **守卫采样**：前 3 章累计 2000 字做中文判定（防单章中文版权页误杀英文书）；fixed-layout
   用 foliate 现成的 `bookDoc.rendition.layout === "pre-paginated"`。
5. **脚注边界**：EPUB 弹出脚注（aside[epub:type=footnote 族）不翻译（枚举排除）——与论文侧
   fn: 键不等价，书侧脚注结构无稳定 id 契约，一期不做。

### 验收迭代记录（08-29 实测）

1. **黑屏**：`useTaskCenterStore((s) => selectChannelAggregate(...))` 内联选择器返回新对象 →
   zustand v5 getSnapshot 不稳定 → 无限重渲整树崩。改订阅稳定 tasks/order + useMemo 聚合
   （global-convert-progress.tsx:235 有注释警告，写前先查惯例）。
2. **"仅 EPUB"误拦**：format 在 `bookData.book.format`（BookDataState 顶层无 format），守卫取值路径写错。
3. **按钮状态**："继续翻译（跳过已翻）"应由**有译本**驱动（论文侧同款），不能加 status 条件——
   complete 后再点走幂等路径提示"所有段落均已有译文"，无害。
4. **译文错位（跨页碎片书）**：转换器跨页切断的书（如《必须保卫社会》，见 Books_Converter
   FIXLOG 病例 018）相邻短行本是同一句，模型合并重分段 → 响应条目数少于输入、index 错位回显。
   加固：批响应 index 集合必须与输入完全一致（validateBatchResponse，整批作废重试→仍失败跳批）；
   prompt 增补"不得合并相邻条目、不得重新分段"硬约束（含 strict 重试措辞）。论文侧理论同病
   （mdast 段落完整、模型无合并动机，实测未炸）——暂不动已验收代码，此处挂账备案。


---

## 定位与产品形态

书籍（EPUB）在阅读器内获得与论文侧同等的对照翻译体验：原文段落后插入译文块，可开关、可断点续翻，原文件永远只读。成本参照：Books_Converter 的 `--translate LANG` 全书烘焙翻译实测**一本书不到 1 元**（同一辅助模型体系），经济上全书一键可承受。

### 已裁定事项（2026-08-29，用户拍板）

| # | 裁定 | 理由 |
|---|---|---|
| 1 | **全书一键翻**，不做按章可选入口 | 一本书成本 <1 元已由转换器侧验证，按章选择只是徒增交互复杂度；篇幅长带来的真问题是断点续翻，不是钱 |
| 2 | **批级落盘 + 取消保留 + 幂等续翻**为硬性验收标准 | 书是论文 10~20 倍体量，"翻到一半中止全嗝屁"不可接受；标准=论文侧现状（见下文基线） |
| 3 | 词句对齐**交互层**（hover 联动/标注镜像/划词对照卡）与**译文模式**（整段替换原文）→ **二期，终做** | 不是砍掉，是分期。交互层需 iframe 内跨语言 Range 计算并与 foliate overlayer 共存，是本功能最贵的部分 |
| 4 | 一期范围 = 全书翻译 + 段落对照展示 + 对齐数据随翻译一条龙生成 | 数据层管线（切句/embed/单调 DP）与文档来源无关，直接复用；交互层消费它放在二期 |

### 明确不做

- **按章可选翻译**（裁定 #1）。
- fixed-layout EPUB 不适用：分页排版固定，插入译文块会破坏版式，检测到即禁用入口并提示。
- 不与 Books_Converter 的 `--translate`（烘焙进产出文件）合并——那条线产新文件、一次性；本功能是 sidecar、可开关、可续翻、可清空，二者正交。

---

## 架构方案

### 1. 存储：按章分文件 sidecar

`{appDataDir}/books/{bookId}/translation/{spineIndex}.json`，每章一个文件，结构平移论文侧 `PaperTranslationFile`：

```
{ version:1, lang:"zh", updatedAt, sourceHash,          // sourceHash = 该章 XHTML 的 sha256-16
  alignStatus/alignWStatus, glossary,                     // glossary 按书全局抽取、写入每章文件
  blocks: Record<"paraIndex", { hash, text, align?, alignHash?, alignW?, alignWHash? }> }
```

- **为什么按章分文件**（与论文侧单文件的差异点）：论文侧 `save()` 是全量快照写，论文体量没问题；书籍 10~20 倍体量下单文件全量重写有写放大，且按章文件天然给断点续翻提供章级粒度。
- 幂等键照搬：块（段落）源文本 sha256-16，文本不变即复用译文。
- 陈旧判定照搬：章 `sourceHash` 与当前章节内容不符 → 该章按未翻译处理（EPUB 原文件入库后本不变，此锚是防御性的）。
- 运行状态（`complete`/`partial`）回写 `book_status.metadata.translation`，对齐向量化状态的模式（`book_status.metadata.vectorization` 先例）。

### 2. 定位键：spineIndex + 段落序号 + 文本 hash 三重

论文侧用「块 index」的根基是 `paper.md` 为 app 自产、mdast 切分与渲染枚举有契约测试。EPUB 段落无稳定 id，故改用三重键：章序号组织存储、段序号做块索引、hash 做幂等与容错。

**契约保障的结构性方案**：枚举段落与注入译文必须是同一段代码——在 translation transformer 内先枚举段落（拿到 paraIndex 与文本）再插译文 div，注入点=枚举点，从结构上杜绝错位（替代论文侧的 `test-paper-blocks-consistency.mjs` 契约测试）。

注意：向量化管线的 `chapters/*.txt`（Rust epub crate 解析）与 foliate 渲染是**两条解析路径**，不可拿前者的分块当定位键；段落枚举必须以 foliate transform 管道所见 XHTML 为准。

### 3. 注入通道：XHTML transform 管道扩展

在现有三 transformer（rawmath/punctuation/footnote，`foliate-viewer-manager.ts:327` → `transform-service.ts`）之后新增 `translation` transformer：

- 章节内容流入 iframe 前，按定位键枚举段落，在段落后插入 `<div class="translation-target-block">译文</div>`。
- CSS 类现成：`getTranslationStyles`（`utils/style.ts:358`，`.translation-source/.translation-target/.translation-target-block/.translation-target-toc`）早已注入 foliate 视图，等价物等实现。
- 显示开关走现成 `TranslatorConfig.translationEnabled`（`types/book.ts:173`，默认 false）。
- 译文 HTML 烘焙公式等富文本时，参照论文侧 `renderTranslationHtml`（KaTeX 服务端渲染、oneLine 防块错位）的经验。
- 分页影响：插入译文使每页承载内容变少，属自然结果。

### 4. 生成管线：新任务通道 `book-translate`

骨架平移 `translatePaper`（`paper-translation-service.ts:415`）：

- 通道并发 1（任务中心注册，模式同 `paper-translate`/`book-vectorize`）。
- 外层按 spine 章节迭代（章节枚举先例：`bookDoc.sections` 前端 / 向量化管线 Rust 侧），内层分批 ≤12 段且 ≤6000 字符、3 路并发 worker、批间 hash 幂等跳过。
- 首轮术语表抽取：标题 + 各章采样（论文侧为标题+摘要+正文前 12000 字，书籍改为跨章采样保证全书术语一致），注入所有批次。
- **记账照搬**：`recordAuxUsage(providerId, modelId, usage, "translate")` ——翻译已在论文侧走辅助口径进 AI 用量面板（08-29 核实，`paper-translation-service.ts:253,375`），书籍侧同款接入，无新增工作。
- 每章完成即落盘该章文件；全书完成盖 `complete` 章，中途取消盖 `partial`。
- 进度回写：`ctx.report` + `book_status.metadata.translation`（阅读器页内进度卡模式同论文侧 `readerTranslate` 切片）。

### 5. 对齐：数据层一期随翻译跑，交互层二期

- 数据层照搬 `alignPaperTranslation`（`paper-alignment-service.ts:209`）：章内切句 → 批量 embed → 余弦矩阵 → 单调 DP（`alignDP`）→ 字符区间写入 `align/alignW`。无嵌入能力 → `alignStatus:"skipped"`，翻译本体不受影响。
- 一本书的对齐嵌入量显著大于论文，走向量化同款嵌入通道（`embedBatchAdaptive` 自适应分批）。

### 6. 语言检测

中文书必须跳过，防"中文翻中文"：入口先看 `books.language` 字段，缺失或可疑时对全书段落采样判定；判定为中文 → 入口禁用并提示。

---

## 断点续翻验收基线（对齐论文侧现状）

论文侧已达标项，书籍侧同标准验收：

| 能力 | 论文侧实现（参照） | 书籍侧要求 |
|---|---|---|
| 批级落盘 | 每批 `await save()`（`paper-translation-service.ts:547,599`） | 每批落盘章文件 |
| 取消保留 | 取消时显式 save + `stampTranslationRunState("partial")`（`:553-555`），列表徽标区分完整/不完整 | 同；徽标回写 `book_status` |
| 幂等续翻 | 块 hash 命中即跳过 | 段级 hash + 章级 sourceHash 双层 |
| 陈旧判定 | `translation-zh.json.sourceHash` vs paper.md hash | 章 sourceHash vs 当前章 XHTML hash |

---

## 二期开工计划（2026-08-29 定稿；一期已于当日实盘验收通过）

四个批次按依赖序排列，每批独立可验收。批次 1 最小（纯 CSS），批次 4 最大（iframe 内交互）。

### 批次 1：译文视觉区分（参考论文侧，用户 08-29 提出）✅ 2026-08-29 落地

现状：译文块只有字号（0.95em）与边距，与原书正文混排无区分。论文侧的视觉语言
（`index.css:871` `.paper-translation`）：**左侧 2px 竖线（border-left）+ 弱化文字色 +
0.92em 字号 + 1.75 行距 + 左内边距**——"带引文线的注释"形态，明暗主题各一套 oklch 色。

落点与要点：

- `getTranslationStyles`（style.ts）补齐同款视觉：竖线 + 弱化色 + 字号；书籍样式在
  iframe 内，需主题上下文——`getStyles` 已有 `themeCode` 参数可传（isDarkMode 分支照
  `getScrollbarStyles` 的写法）；`applyTranslationStyle` 同步。
- 原书 CSS 大多只打 `p` 选择器，译文是 `div.translation-target-block`，天然逃逸大部分
  书内样式；色值声明加 `!important` 兜底（现有 display 已同款）。
- 验收：对照模式一眼区分原文/译文；明暗主题、深底主题书（深色正文 CSS）下协调。
- **08-29 用户裁定补充**：译文模式（translated）下原文不在屏，无对照即无区分——竖线/弱化色/
  字号行距全部回归正常正文样式（仅保留段距），对照视觉语言只在逐段对照模式生效。

### 批次 2：译文模式（显示模式三态补全）✅ 2026-08-29 落地；翻页卡顿挂账 2026-08-30 修复（见下）

下拉区 1 从两态补成三态（原文/译文/逐段对照，对齐论文侧 radio 形态，第三项图标已预留语义）。

- **设置存储改造**：新增 `bookViewMode: "original" | "translated" | "bilingual"`（对齐论文侧
  `paperViewMode` 语义，存 globalViewSettings）；`translationEnabled` 退役由三态派生
  （bilingual/translated → 显示译文），旧值迁移 enabled=true → bilingual。
- **实现**：transformer 注入时给原文段加 `translation-source` 类（CSS 类早已预留）；
  译文模式下 `.translation-source { display: none }`——与对照开关同一 CSS 通道，
  切换即时生效不重载章节。
- 已知边界（论文侧同款语义，直接沿用）：隐藏原文后每页承载内容变少属自然重排；
  进度 CFI 与标注锚点不受影响（隐藏≠移除）；被隐藏原文上的标注高亮不可见——预期行为。
- 验收：三态切换即时生效；译文模式下翻页/进度/标注/搜索不回归。

### 批次 3：词级对齐管线就位（alignW，触发策略=手动）✅ 2026-08-29 当日开工落地

UI 形态与语义（08-29 与用户讨论裁定，与论文侧"句词合一行+两级同建"**刻意不同**）：

- **下拉拆两个独立模块**：句对齐（句 n/m 已对齐 + 「重建句对齐」）与词对齐
  （词 n/m 已对齐 + 「构建词对齐」/「重建词对齐」按有无缓存切换）——书籍词级嵌入贵，
  成本可见、按需触发。
- **依赖关系**：词对齐建立在句对齐之上（词对区间以句对为计算域），但两张平行表独立
  存储、各有幂等键（词级键=译文 hash#分词器版本，与论文侧同款）。
- **三条依赖规则**：①触发词对齐时句级缺失/陈旧的段**自动先补算句级**（一次点击透明处理）；
  ②「重建句对齐」=句级全量重算 + **作废全部词级缓存**（词对键感知不到句对变化，须显式
  作废，否则词对会指向旧句对区间）；③「重建词对齐」只 force 词级、不碰句缓存。
- 实现落点：`book-alignment.ts` 的 `alignBookTranslation({ mode: "sentence" | "words", force })`
  双相位（词级相位移植论文侧 T3：句对内分词/分片 embed 双上限/单片失败仅牵连覆盖段/
  alignWordDP 换算）；executor payload 增 `alignPhase`；`summarizeBookAlignment` 返回句+词
  双计数。
- 翻译一条龙维持只自动跑句级（非 force 幂等档）。
- 验收：两模块独立触发/重建互不误伤；词对齐在句级缺失时点一次自动补句；重建句对齐后
  词计数归零；词级分片失败标 partial 可重建。

### 批次 4：词句对齐交互层（二期主体，最贵批次）🔶 2026-08-29 落地 4a/4b/4c；4b hover 失效挂账 2026-08-30 修复验收（见下）；**4d 标注镜像 2026-08-30 落地验收（见下）**；**批次 5 交互层体验对齐 2026-08-30 落地验收（见下）**

已落地（4a/4b；**4c 划词对照卡 08-29 用户裁定撤销**——hover 联动已覆盖"看某个短语对应译文"的需求，
保留属冗余入口，代码已删）：
- **4a 段内偏移映射**：`section-blocks.ts` 的 buildBlockTextMap/rawOffsetOf/rawToNormOffset/
  normToRange（DOM 文本节点 ↔ 规范化 norm 双向换算，WeakMap 缓存；排除译文子树），
  契约测试新增 5 用例（norm 与枚举一致/双向往返/跨节点 Range/caret 模拟/译文子树隔离）13/13 绿。
- **4b hover 联动**：`use-translation-link.ts`——宿主监听 foliate load → iframe 文档挂
  mousemove；caret 定位 → 偏移映射 → **词级优先/句级吸附**查表 → 双侧句子 Range。
  **呈现 2026-08-30 批次 5 改版**：::highlight(book-align-hover) 退役（CSS Custom Highlight
  不支持圆角/box-shadow），改 iframe 内覆盖层 div（圆角+柔和阴影，论文侧
  .paper-sentence-hover-rect 同款观感），详见下方批次 5 节；同句移动不重绘（lastKey）。
- ~~4c 划词对照卡~~（撤销，见上）。
- **hover 冷启动（08-29 验收轮修复）**：hook 生效时当前章多半已加载完（load 事件早已错过），
  必须对 renderer.getContents() 的现有章节立即补挂——否则停留在已加载章节时 hover 永不生效；
  WeakSet 防双路径重复挂载。（2026-08-30 补正：冷启动补挂只是必要条件，"完全没生效"的主因是
  hook 未订阅 view——开书时 view 未就绪 effect 空跑后永不重跑；译文侧映射另有 collectTextNodes
  根元素误排除 bug。两者均已修复，详见下方挂账节验收记录。）

挂账项（均为单独批次，勿捎带）：

**译文模式翻页/章节跳转卡顿（08-29 挂账 → 2026-08-30 修复验收）**。CDP 实证推翻了
原嫌疑清单（与 foliate 分页/display:none 无关；useTranslationLink 当时根本未挂载，亦非肇因）：
- 根因：每次章节加载 `handleLoad` 无条件 `onViewSettingsUpdate` → `setSettings` 产生新
  settings 对象（值不变、引用变）→ 所有整店订阅者重渲——后台保活论文 tab 的
  `PaperReaderView`（`paper-reader-view.tsx:81` 整店订阅）Markdown 重渲实测单次 ~0.8s（dev），
  每次章节跳转是一个 ~1.1-1.4s 长任务（goTo 内 load 事件 40ms 即完成，其余全是这次扇出渲染）。
  对照实验证明：休眠全部论文 tab 后 goTo 1.4s→0.46s，唤醒复现。模式无关、两模式同病；
  译文模式的真实差异只是**每章页数减半 → 章节跳转频次 ×2.3**（如 spine 11：对照 57 页/译
  文 25 页），单位时间撞上长任务的频率翻倍，体感"译文模式极度卡顿"。
- 修法：`foliate-viewer-manager.ts` handleLoad 同值守卫——updatedSettings 与当前设置逐键
  浅比较，无变化不回调（vertical/rtl 真变化照常透传）。未动 foliate、未动注入/隐藏方案。
- 验证（全 tab 唤醒、分页模式、CDP 计时）：章节跳转对照 131-179ms / 译文 89-127ms（修复前
  两模式均 1100-1400ms）；连续翻页 20 页两模式均 ~140-150ms 同量级；进度 CFI 随翻页正常更
  新；UI 下拉三态切换即时生效（译文 src=none/tgt=block、原文反之、对照双显）。
- 遗留（记入此账不扩大范围）：①后台论文 tab 的整店订阅+dev React 渲染墙是 pre-existing 架
  构问题（本修复只断了章节加载这一触发点，其它 setSettings 写路径仍会扇出）；
  ②译文模式章节跳转频次 2.3 倍是"内容减半"的固有结果。

**4b hover 联动失效（08-29 挂账 → 2026-08-30 修复验收）**。CDP 实证四嫌疑中 ③②排除
（渲染章节原文块 data-block-index/译文块注入齐全；::highlight(book-align-hover) 规则确随
StyleManager 进 iframe），①部分成立（事件通道本身可达，但监听器从未挂上），坐实两根因：
1. **hook 挂载时序（主因，解释"完全没生效"）**：useTranslationLink 的 effect 只在
   `[bookId, enabled, store]` 变化时运行，而 useFoliateViewer 的 view 是异步创建——开书时
   effect 首跑 `store.getState().view` 必为 null 直接 return，此后依赖不再变化，监听永不挂。
   修法：hook 改为 `useReaderStore((s) => s.view)` 订阅并入 deps，view 到达即重跑挂载
   （休眠唤醒重建视图同路径受益）。
2. **译文侧偏移映射恒 null**：collectTextNodes 的 `[data-book-translation]` 子树排除误伤根元
   素自身——hover 译文块时 buildBlockTextMap 得空表 → rawOffsetOf null → clearHover。
   修法：排除仅限后代子树（`node !== el`），td 场景译文子树隔离语义不变（契约测试 13/13 绿）。
- 验证（合成 mousemove 探针）：hover 原文句 → 原文+译文双句高亮（双向；译文侧 hover 同）；
  同句内移动 set 计数 0（不重绘）；翻章后新文档 CSS.highlights 注册表空（无残留）且新章
  hover 照常生效（load 路径挂载）；::highlight 视觉实锤（临时洋红化规则后截图可见双侧高亮块）。
- 顺手修的残留 bug（验收标准"开关切换无残留高亮"实测抓出）：hover 高亮后切回 original 模式，
  高亮滞留在当前文档注册表（原文在屏可见残留）——effect cleanup 现对全部已挂载 window
  补 `CSS.highlights.delete`（实证：切换后注册表清空）。

**4d 标注镜像**（用户定调对照翻译核心功能之一；~~挂账~~ → **2026-08-30 落地验收**）：
原文标注 ↔ 译文常驻镜像高亮，双向同效，效果对齐论文侧标注镜像。

- **锚定链**：标注 CFI → `view.resolveCFI` 反解（与 foliate `addAnnotation` 同一入口，同步
  `{index, anchor}`）→ 本章 Range → 按 `[data-block-index]` 段拆分（跨段标注逐段钳制，
  `intersectsNode` + `comparePoint` 双向钳到段界）→ section-blocks 偏移映射得 norm 偏移
  （**新增 `rawBoundaryToNorm` 边界语义换算**：rawToNormOffset 是字符位语义、丢 +1 边界，
  Range 端点须按"缝"换算；契约测试 13→14 用例覆盖）→ 查对齐表（词级优先/句级吸附回退，
  直接复用论文侧 `mapSrcRangeToTgt`/`mapTgtRangeToSrc`）→ 镜像区间 norm → 对侧段
  `normToRange` → 对侧 Range。
- **呈现**：CSS Custom Highlight 常驻层，注册名 `book-align-mirror[-{style}]-{color}`
  （3 笔触 × 5 色共 15 名，命名 helpers 在 `services/constants.ts`，与 hover 层
  `book-align-hover` 完全分开）；规则随 `getTranslationStyles` 注入 iframe（真值色，
  iframe 内主题变量不可达）。镜像与本体同色同笔触、透明度更弱（highlight 0.15/0.2 vs
  本体 overlayer 0.3；underline/squiggly 线色 55%，论文侧 `-tgt` 同款口径）。
- **时机挂钩（常驻全生命周期）**：章节 `load` 事件 + `getContents()` 冷启动补算（4b 同款
  教训，双路径）；`config.booknotes` 订阅（增/删/换色/评论全走 updateBooknotes 换新数组 →
  effect 重跑全量重算）；`book-translation-updated`（翻译/对齐收尾 → 章缓存失效 + 重算，
  含阅读器 DOM 直注入通道）；显示模式切换（`enabled` 变化即卸载清理/重挂）；视图休眠重建
  （`view` 订阅，重建后 effect 重跑）。翻页/resize 重排零挂钩：Range 是活引用、文档不重建，
  CSS Highlight 随布局自动重绘（resize 实测 rect 正确迁移）。attachedWins 卸载清理 +
  死 iframe window 剔除（长会话翻章不累积引用）。
- **落地文件**：新增 `pages/reader/hooks/use-annotation-mirror.ts`（hook + 纯函数锚定链）；
  `section-blocks.ts` +`rawBoundaryToNorm`；`constants.ts` +命名 helpers；`style.ts`
  +15 条镜像规则；`reader-viewer.tsx` 挂载（与 hover 联动同启停口径：非 original 启用）。
- **验收（CDP 实测，探针/截图存证 .tmp-bt-verify/40–46）**：原文划线 → 译文同色镜像
  （`biopolitics` → `生命政治，243-45，276`，逐跳核对锚定链数据）；译文侧划线 → 原文镜像
  （`节育实践…` → `birth control practices, in 18th cen`，本书无 alignW，句级吸附路径）；
  跨段标注按段拆分镜像（3 区间）；删除标注镜像同步消失；切 original 清场、切回恢复；
  翻章往返无残留、load 路径重注册；`setView(null)` 注册表实证清空、恢复后重注册（休眠
  重建同路径）；resize 后镜像存活且 rect 随重排迁移；hover 层与镜像层并立互不干扰
  （mouseleave 只清 hover）；无译本章节零镜像零报错（静默跳过）。译文模式（原文隐藏）
  镜像照常落在译文侧——核心场景截图实锤。UI 级本体回归：选区→弹窗→创建/换色
  （镜像名 squiggly-blue→squiggly-red 同步换名）/overlayer hitTest 回显/删除全链路无回归，
  标注面板列表同步。契约测试 14/14 绿，`pnpm tsc -b` 零错。
- **已知边界（与论文侧同款取舍）**：词级精确路径未实测（本书 alignW 未构建，全部走句级
  吸附；词级分支复用论文侧已验收的 mapSrcRangeToTgt，构建词对齐后自动升级精确区间）；
  无对齐数据的段（entry 无 align/alignW）结构性跳过（guard 为早退一行，live 覆盖了
  "整章无译本"分支）；译文模式下译文侧标注的镜像落在隐藏原文上不可见（本体同款预期）。

**批次 5 交互层体验对齐（08-30 用户实测反馈 → 当日落地验收）**：两件事——
①hover 联动视觉对齐论文侧（柔和边缘）；②右键快捷选中全句。

- **① hover 视觉覆盖层化**：`::highlight(book-align-hover)` 退役（CSS Custom Highlight
  不支持圆角/box-shadow，这是换掉的硬原因；常驻标注镜像层 `book-align-mirror-*` 保持
  ::highlight 不动——它要常驻自动重绘）。新方案照抄论文侧 `.paper-sentence-hover-rect`
  （paper-reader.tsx updateHoverRects）：命中后取双侧 Range 的 `getClientRects`（iframe
  视口坐标系），在 iframe body 挂 `position:fixed;inset:0;pointer-events-none` 容器
  （`.book-align-hover-layer`），逐行渲染圆角 div（`.book-align-hover-rect`：圆角 4px +
  背景 primary 14% + 阴影 `0 1px 8px 28%`；暗色 20%/36%/10px——浓度口径与论文侧逐项相等，
  CDP 计算样式实证完全一致）。颜色仍走 `getTranslationStyles` 的 globalPrimary 真值注入
  （iframe 内 `var(--primary)` 不可达的老坑不回踩）。rect 渲染前做几何求并
  （复用论文侧 `mergeOverlappingRects`，防半透明叠色）。
- **foliate 分页几何的实证要点**：本分叉为纵向展开分页——iframe 沿块轴展开到全内容尺寸、
  宿主容器滚动换页，**iframe 内文档不自滚**，故 `getClientRects` 坐标对翻页稳定、覆盖层与
  文字天然随宿主滚动同移；翻页/重排/滚动时清掉覆盖层即可（`view.renderer` 的 scroll 重派发
  + `view` 的 relocate + 文档内 scroll/resize 兜底；hover 是即态，鼠标再动即重算重绘）。
  mousemove 走 rAF 节流；同句内移动不重绘（lastKey，实证子节点引用零变化）。
  CSS zoom（阅读缩放）下 `getClientRects` 返回缩放后坐标而覆盖层同在 body 子树，
  几何属性除回 zoom（默认 100 → 1，无除算影响）。
- **② 右键句选**：iframe 文档监听 `contextmenu` → caret 定位 → 块 + norm 偏移 → 句边界
  （有对齐数据用 `align` 句对区间；无对齐数据用论文侧切句器 `segmentSentences` 对块 norm
  文本现场切）→ `normToRange` 得整句 Range → programmatic selection。**弹窗复用既有链路**：
  随后的右键 mouseup 由 annotator 既有监听（annotator/index.tsx onLoad 挂的
  `handleMouseUp`）拾起选区 → `makeSelection` → 标注弹窗，零新弹窗路径（CDP 实证成立）。
  **已有标注命中**：`overlayer.hitTest`（iframe 视口坐标，命中括除 foliate 搜索结果前缀）
  → 派发 foliate `show-annotation` 同一 CustomEvent 路径回显既有标注弹窗（含笔触/颜色行，
  截图实证）。守卫（论文侧同款）：img/a/aside 命中直接放行——img 由宿主
  `handleImageContextMenu` 接管（实证图片主题菜单消息照发、选区不被句选染指）；
  非句子区域不 preventDefault（系统菜单保留）。
- **未翻译书也可用**：无译本注入的文档没有 `data-block-index`——回退
  `enumerateSectionBlocks(wrapSectionDocument(doc))` 枚举契约找 caret 所在叶子块 +
  切句器定界（实证《牛津通识读本：福柯（中文版）》右键选句 + 弹窗成立）。
- **卸载语义修正（顺手修掉的存量 bug）**：切回 original 只重编译 CSS、不重建章节文档，
  旧实现只清注册表不清监听器——original 模式下 mousemove 仍会重画高亮（4b 验收漏网）。
  现 effect 用 `AbortController` 统一摘除全部文档监听（含右键），切模式后 hover/右键即死，
  切回重挂；实证 original 模式 hover 不再产层、回切后恢复、覆盖层容器唯一。
- **验收（CDP 实测，探针/截图存证 .tmp-bt-verify/50–64）**：hover 覆盖层双侧多行 rect
  结构与计算样式（bg/shadow/radius 与论文侧逐项相等）；明/暗/怜烟（lianyan 视频壁纸）
  三主题截图；同句移动零重绘、跨句重绘；翻页清除 → 再动重绘；切 original 清场无残留 +
  hover 失效 + 切回恢复；切 tab 往返（keepalive 休眠/唤醒路径）hover 照常且层容器唯一；
  右键原文句/译文句各选中全句并弹标注弹窗（截图）；右键已有标注回显既有弹窗（截图）；
  链接/图片/页边空白右键不接管；镜像注册表全程不动（4d 不受覆盖层影响）。
  `scripts/cdp-book-hover-theme-check.mjs` 改验覆盖层规则（ok）；契约测试 14/14 绿；
  `pnpm tsc -b` 零错；biome 改动文件零告警（顺手清零了该 hook 的存量
  useExhaustiveDependencies 告警，并给右键句选模块同款式 ignore 注释）。
- **已知取舍**：对齐句对缺失时切句器按块 norm 文本切（未对齐段/未翻译书），与论文侧
  locateSentenceAtPoint 同源同边界规则；译文模式原文隐藏时原文侧不可点属自然结果；
  右键句选仅在非 original 模式启用（hook 启停口径与 hover/镜像一致）。

**顶栏下拉交互优化（08-29 用户提出，通用 UI 待办）**：
- 点开动效：顶栏各下拉（目录/搜索/设置/翻译）展开与收起均无动画——按动效体系规范
  （docs/motion-system-plan.md）补 DropdownMenuContent 的进出场过渡；
- 外点收起：点开下拉后点击空白处不能收起、必须再点 icon——排查 radix DropdownMenu 的
  onPointerDownOutside 失效原因（受控 open/portal/modal 层级/全局事件拦截），四个下拉
  （toc/search/settings/translate）同治。

原批次 4 计划要点（保留备查）：

论文侧参照：`paper-reader.tsx` 的 `locateLinkedRange`（hover 句级联动）、标注镜像
effect（`mapSrcRangeToTgt`/`mapTgtRangeToSrc`，词级优先句级吸附回退）、
`openTranslationPopup`（划词对照卡）；区间映射与公式归一经验在 `paper-cross-anchor.ts`。

书籍侧特有工作与风险：

- **iframe 事件桥**：hover/划词发生在内容 iframe，经 `iframeEventHandlers` 的
  postMessage 桥回宿主（先例齐备），联动高亮需在 iframe 内定位 Range（`getContents().doc`）。
- **段内偏移基准差（本批次最大技术风险）**：对齐表偏移基于规范化段文本
  （空白折叠），渲染 DOM 的 textContent 可能含原始换行/空白——需要段级偏移映射函数
  （论文侧 `normalizeMathText`/`mapOffsetsMathAware` 的同族问题，书籍侧无公式展开问题、
  有空白与内联标签问题）。方案：映射函数进 `section-blocks.ts` 契约模块，配契约测试
  用例（DOM 文本 ↔ 规范化文本双向换算）。
- 分期降级：先句级联动（hover 句高亮+划词对照卡），标注镜像与词级精度随后
  （依赖批次 3 数据）。
- 验收：hover 原文句高亮译文句（双向）；划词弹对照卡；标注镜像同色；
  翻章/开关切换/取消任务无残留高亮。

### 批次外（维持"未来待办"节口径）

- 任务标签栏接入 + 阻塞矩阵：随任务体系下一轮统一治理，不在二期主线。
- EPUB 弹出脚注翻译：维持不做。

## 未来待办：任务队列体系跟进（2026-08-29 用户提出）

图书翻译任务（book-translate 通道）后续要纳入整体任务队列体系的统一呈现与治理：

- **右下角标签栏**：任务中心 UI（bottom-right-stack）展示 book-translate 的进度与队列状态，与论文翻译/转换/向量化等通道一视同仁；
- **阻塞矩阵跟进**：论文侧有 ensurePaperTaskConflictChecker（解析×翻译互斥注册表）；图书侧目前仅靠通道并发 1 + targetId 幂等拒入，翻译×向量化×转换（同一本书）之间的显式冲突矩阵需要补——
  典型竞态：翻译任务与向量化同时读 `books/{id}/book.epub`、转换重入库换文件时译本 sourceHash 全部失效等；
- 时点：随任务体系下一轮统一治理一并做，不单独开工。

---

## 现成地基清单（本功能成本意外低的原因）

| 地基 | 位置 |
|---|---|
| 设置项壳 | `types/book.ts:173` TranslatorConfig；`services/constants.ts:170` 默认值 |
| 翻译块 CSS 类 | `utils/style.ts:358` getTranslationStyles（已注入 foliate 视图，无人生成元素） |
| XHTML transform 注入管道 | `foliate-viewer-manager.ts:327`；`services/transform-service.ts` |
| 翻译生成骨架 | `paper-translation-service.ts:415` translatePaper（分批/术语表/落盘/续翻） |
| 对齐管线 | `paper-alignment-service.ts:209`；`paper-cross-anchor.ts`（DP+区间映射）；`paper-sentences.ts`（切句） |
| 任务通道 + 按章任务先例 | `task-executors/paper-translate.ts`（通道模式）；`book-vectorize.ts`（按章进度回写 book_status） |
| 用量记账 | `ai-usage-service.ts` recordAuxUsage，kind="translate" 论文侧已接，书籍同款 |
| 章节枚举 | 前端 `bookDoc.sections`；Rust 侧向量化管线（仅作参考，定位键不用它） |
