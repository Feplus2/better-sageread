# P2 统一任务队列施工计划（task-queue-p2-plan）

> 2026-08-25 建立。前置调研：`docs/task-system-survey.md`（现状地图 §0、差距 §7、批次建议 §9）。
> 本文档是**施工规格**：每个阶段给出文件级改动清单、必须保留的行为语义（不动清单）与验证清单。
> 目标读者是实施者（可能是其他 Agent）——照单执行即可，不必重走调研。
>
> **进度（2026-08-25）**：P2-0 ✅（地基 + test-task-center 8/8）；P2-1 ✅（图书转换通道，
> CDP 实盘 E2E 通过，顺手根除 convertPdf 5s 监听 bug）；P2-2 ✅（图书向量化通道）；
> P2-3 ✅（论文向量化/翻译迁入，三通道实盘验证）；P2-4 施工中（解析通道）；
> P2-5 待开工。额外产出：task-executor-registry.ts 独立叶子模块（dev HMR 丢注册的根修）。

---

## 0. 总原则（先读这个）

1. **行为保持迁移**：现有队列/卡片/恢复链路全是实测打磨过的语义（大量注释是事故教训）。
   迁移 = 换数据归属与入口形态，**不换用户可感知行为**。每阶段必须列出"不动清单"并逐条核对。
2. **UI 与 AI 同一入口**：所有任务发起（页面按钮、右键菜单、AI 工具）统一走 `enqueue`。
   AI 工具当前多为阻塞式直跑（等结果再答）——入队后用 `enqueueAndWait` 保持阻塞语义不变
   （拿到队列可见性/冲突检查，不改变 AI 的回答节奏）。
3. **内存态保持**：不做 SQLite 队列持久化（调研 §9 明确不做）。刷新/重启恢复走各通道
   既有机制（parse 的 pending_done 已落盘；vectorize/translate 的挂载扫描恢复）。
4. **冲突矩阵保留**：`store/paper-task-registry.ts` 的 `conflictKinds` 纯函数与同篇互斥模型
   原样保留；统一队列的 enqueue 改读同一注册表（parse 通道状态源从 convert-progress-store
   换成 task-center 的 parse 通道）。
5. **每阶段独立可发布**：阶段间 `pnpm tsc -b` + 相关单测全绿；CDP 实盘验证按各阶段清单执行。
   并发（P3）、central 语义检索（P4）不在本文档范围。

## 1. 目标形态

**五通道**（channel）：`paper-parse` / `paper-vectorize` / `paper-translate` / `book-convert` / `book-vectorize`。

**统一数据模型**（新 `store/task-center-store.ts`，zustand）：

```ts
type TaskChannel = "paper-parse" | "paper-vectorize" | "paper-translate" | "book-convert" | "book-vectorize";
type TaskStatus = "queued" | "running" | "success" | "error" | "cancelled";

interface TaskItem {
  taskId: string;            // crypto.randomUUID()
  channel: TaskChannel;
  targetId: string;          // paperId / pdfPath / bookId（归属与冲突判定键）
  title: string;
  payload: unknown;          // 通道私有（reparse 的 paperId、translate 的 force、convert 的引擎/translate 标志…）
  enqueuedAt: number;
  status: TaskStatus;
  percent: number;           // 0-100
  detail: string;            // 进度行文案（对齐现状卡片 detail）
  error?: string;
}

interface TaskRun {          // 一次"通道批次"：enqueue 调用产生的连续执行段
  runId: string;
  channel: TaskChannel;
  taskIds: string[];
  startedAt: number;
}
```

**通道注册表**（同文件）：每通道登记 `{ executor, concurrency: 1, card: 卡片元数据 }`。
执行器签名：`execute(task: TaskItem, ctx: TaskContext): Promise<void>`，其中
`ctx.report(percent, detail)` 报进度、`ctx.signal` 取消语义、`ctx` 携带 app 级服务句柄。

**卡片**：右下角五张聚合卡沿用现有视觉与 BottomRightStack（禁区逻辑不动），
数据源改为 task-center 的通道聚合视图；**点击展开通用子任务面板**
（题名 + 状态图标 + 实时 percent/detail + 单任务取消）。图书转换小卡的
"点击还原大窗口"保留为该通道的专属详情入口（通用面板之外的可选增强）。

## 2. 分阶段施工

### P2-0 地基：task-center store 骨架（纯新增，零行为变化）

**改动**：
- 新建 `packages/app/src/store/task-center-store.ts`：模型 + 注册表 + `enqueue(channel, items)` /
  `cancelTask(taskId)` / `cancelChannel(channel)` / 通道聚合选择器（供卡片订阅）。
- 队列泵：通道内串行（concurrency=1），逐任务调执行器， settles 后推进；运行期新入队接续。
- 单测 `scripts/test-task-center.mjs`：入队/泵序/取消/冲突拒绝/幂等去重（同 targetId 同通道
  不重复入队），对齐既有 `scripts/test-task-conflict.mjs` 的断言口径。

**不动清单**：本阶段不接任何 UI/执行器，现有功能零变化。

**验证**：tsc + 新单测绿 + `test-task-conflict.mjs` 绿。

### P2-1 图书转换通道（收益最明确：顺手根除 AI convertPdf 的 5s 监听 bug）

**背景**：`convert-progress-store.startBookConvert`（:204-229）直起 sidecar 无队列；
`convert://progress` 事件**无归属字段**（converter.rs:114）；AI convertPdf 自持监听 5s 即弃
（`ai/tools/central/convert-pdf.ts:63-80`，"完成自动导入"承诺不兑现）。

**改动**：
- Rust `converter.rs`：进度事件注入 `pdf_path` 归属（照抄 `paper_converter.rs:117-125` 的
  注入模式）；`convert_paper_pdf` 侧的 `ConverterState` 单 child 句柄维持现状（并发是 P3）。
- 新建 `services/task-executors/book-convert.ts`：吸收 startBookConvert 的监听注册、
  阶段流水线推进（buildBookStages/markStages 复用）、完成/失败结算、自动导入逻辑。
- 入口改入队：图书馆转换对话框（`library/index.tsx` 大窗口提交处）、AI convertPdf
  （删自持监听，改 `enqueueAndWait`，返回语义保持"完成后告知 epubPath/导入结果"）。
- `convert-progress-store.bookConvert` 状态保留为大窗口详情数据源，由执行器回写
  （大窗口 UI 不动）；小卡改读 task-center 聚合。

**不动清单**：大窗口视觉/阶段展示；转换参数面板；转换完成后的 toast 与导入询问；
Job Object 孤儿防护与 kill_tree 取消（2026-08-25 落地）。

**验证**：CDP 实盘转一本书（进度卡 + 大窗口同步 + 完成导入）；AI convertPdf 实盘调用一次；
取消按钮实盘。

### P2-2 图书向量化通道（新通道，消灭三入口互不知情的竞态）

**背景**：book-item.tsx:301-356 直跑 indexEpub、AI vectorizeBook 自带串行循环
（vectorize-book.ts:283-291）、设置页全量重建串行循环（vector-model-manager.tsx:338-387）——
同一本书可被两入口同时索引（删库重建竞态，白烧 embedding 费用）。

**改动**：
- 新建 `services/task-executors/book-vectorize.ts`：吸收 indexEpub 调用与进度事件
  （`paper://index-progress` 已带归属 id，复用）+ book_status.metadata.vectorization 回写。
- 三入口改入队：book-item（按钮态改读 task-center 排队/运行态）、设置页全量（逐本 enqueue）、
  AI vectorizeBook 图书分支（enqueueAndWait 数组，保持"全部完成后汇总返回"语义）。
- 入队去重：同书已在通道队列/运行中 → 拒入队并 toast（对齐论文侧 enqueue 幂等口径）。

**不动清单**：每书一库删库重建语义；维度变化自愈（图书侧现状）；进度环 UI。

**验证**：同一本书双入口并发 → 第二次被拒；三入口各实盘一次；cargo/单测绿。

### P2-3 论文向量化/翻译通道迁入（存量最厚，迁移而非重写）

**改动**：
- `paper-task-store.ts` 的 vectorizeQueue/translateQueue/drainVectorize/drainTranslate 迁入
  task-center 成为两个通道执行器；`TaskItem.force`（重翻标志）随 payload 透传。
- **solo 卡收编**：`trackSoloVectorize` 的 `total===1 && title===标题` 双重比对所有权守卫
  （paper-task-store.ts:337-340）退役——统一队列后按 taskId 发卡天然无串台。
- 直跑入口改入队：
  - 阅读器翻译下拉（paper-reader-view.tsx:245-265）→ 翻译通道入队（readerTranslate 阅读器
    内进度卡保留，由执行器回写；与通道卡并存——用户在阅读页看页内卡，主页看通道卡）；
  - AI processPaper translate/align（process-paper.ts:132-203 阻塞式）→ enqueueAndWait；
  - AI vectorizeBook 论文分支 → enqueueAndWait（trackSoloVectorize 逻辑删除）。
- 翻译收尾的 metadata 徽标回写与 translate→align 一条龙（现状已接）原样保留。

**不动清单**：翻译批次 3 路并发、每批落盘幂等、续翻/重翻/陈旧判定（sourceHash 语义）；
脚注 fn: 键相位（2026-08-25 落地）；向量化先删后插幂等；onSettled 回调（列表页刷新联动）；
readerTranslate 页内卡的取消窗口语义。

**验证**：`test-task-conflict.mjs` + `test-paper-translation-tolerance.mjs` 全绿；
CDP 实盘：批量向量化 2 篇 + 批量翻译 2 篇 + 阅读器单篇翻译（页内卡与主页通道卡同显）+
AI processPaper translate 阻塞返回语义不变。

### P2-4 论文解析通道迁入（恢复语义最多，放最后）

**改动**：
- `convert-progress-store.ts` 的 paperQueue/drainPaperQueue（:359/:552）迁入 task-center 的
  paper-parse 通道执行器；三类工作项（parse/reparse/acquire）payload 化。
- **恢复链路适配**（本阶段最大风险点）：
  - `recoverPaperImportAfterReload`（:1277）三情形（A 在跑/B 补落库/C 中断报错）原样保留，
    恢复卡改在 task-center 模型上重建（paperDraining 泵位语义等价物保留）；
  - pending_done 落盘恢复（2026-08-25 落地）不动；
  - 情形 B 的 settleRecoveredDone reparse/parse 分流、toast、reparsedPapers 横幅逐项对齐。
- AI importPaper 的 importPaperPdf 自持监听链路（paper-service.ts:366-433）改入队
  （enqueueAndWait，返回语义保持）。
- Zotero 批量导入对话框的解析段进度（zotero-import-dialog.tsx:343-375 本地 run 状态）
  改读统一 store；对话框自有 UI 不动。
- `startPaperImportBatch`/`startPaperReparse`/`startPaperAcquireImport` 公共入口保留签名，
  内部改为 enqueue 薄壳（调用点零改动）。

**不动清单**：内容哈希预去重（paper-dedup.ts）；取消按钮的 kill_tree 树杀；
刷新恢复三情形；`isPaperQueuedOrRunning`/`paperConflicts` 组合判定（改读新数据源，口径不变）。

**验证**：`cdp-e2e-refresh-recovery.mjs` 实盘 PASS（刷新恢复不回归）；
解析→向量化→翻译链路的冲突矩阵实盘（解析中翻译被拒等）；取消实盘；Zotero 导入实盘。

### P2-5 卡片点开子任务面板（UI 层收尾）

**改动**：
- 通用子任务面板组件（`components/task-run-panel.tsx`）：聚合卡点击 → 弹出层列出该 run 的
  TaskItem 列表（题名 + 状态图标 + percent/detail + 单项取消按钮）。
- 五张聚合卡接入（视觉沿用；图书转换小卡额外保留"还原大窗口"入口）。
- BottomRightStack/阅读页禁区逻辑不变。

**验证**：五通道各起一批，点开面板核对子任务状态流转与单项取消；禁区页（阅读/聊天）不显示。

## 3. 全局回归矩阵（每阶段必跑）

- `cd packages/app && pnpm tsc -b`（裸 tsc 假绿，必须 -b）
- `cd packages/app/src-tauri && cargo test`（主 crate + 插件 crate）
- 单测：`test-task-conflict.mjs`、`test-task-center.mjs`（新）、
  `test-paper-translation-tolerance.mjs`、`test-paper-blocks-consistency.mjs`、
  `test-paper-footnote-translation.mjs`
- CDP 实盘：按各阶段验证清单（dev 实例 vite 1420 / CDP 9223；
  注意 Vite HMR `?t=` 陷阱——动态 import store 须先抠消费方转换源码里的版本 URL）

## 4. 风险与回退

- **最大风险在 P2-4**（解析通道恢复语义）。若实盘出现恢复回归，回退 = 该通道留在
  convert-progress-store，task-center 只做投影（卡片数据源），其余四通道成果不受影响。
- 执行器迁移坚持"一次一通道"，每通道迁移后实盘验证再动下一个。
- 任何阶段发现"不动清单"被破坏 → 停下来对齐，不要用新行为覆盖旧语义。

## 5. 明确不做（本批边界）

- 通道内/跨通道并发（P3：解析有界 2、向量化单篇内并行 embed + busy_timeout）。
- 队列持久化到 SQLite（调研 §9 结论：内存态 + metadata 标记已够用）。
- central scope 语义检索下放（P4 独立排期）。
- 阅读器内翻译交互形态变化（入队是执行层的事，UI 不变）。
- 图书翻译独立任务（图书翻译只作为转换管线阶段存在，现状如此）。
