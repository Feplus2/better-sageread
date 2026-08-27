# 交接施工总册（2026-08-26 创建；2026-08-28 本轮收尾更新）

> **本册定位**：主 Agent（大脑/决策层）不在场时，执行 Agent 按任务卡施工。每张卡 =
> 目标 / 背景指针 / 施工规格 / 验收标准 / 审计方法 / 报告格式。
> **先读「全局纪律」再挑卡。** 拿不准的地方**停下来问用户**，不许自由发挥。
>
> **2026-08-28 状态**：任务卡 1-6 全部完成 ✅。卡 7 备案用户悬置中
>（ICP 已批/公安数据码在手/30 天时限）。卡 8 发版待用户审验 push 后启动。
> 本轮额外完成：映射表三轮重构（枚举制定稿）+ API 申请冲刺五 key 入库 + 备案指引。
> **三仓均有本地 commit 待 push**（用户审验后统一执行，push 要代理）。

## 全局纪律（每张卡都适用）

### 仓库与环境速查

| 项 | 值 |
|---|---|
| SageRead 主仓 | `F:\MyProjects\SageRead`（git 分支 `local`；远端 main 经 `local:main` 推） |
| Papers_Converter 仓 | `F:\MyProjects\Papers_Converter`（分支 main） |
| zotero-brain-slim 仓 | `F:\MyProjects\zotero-brain-slim` |
| dev 实例 | `packages/app` 下 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223" pnpm tauri dev`（vite 1420 / CDP 9223） |
| dev 数据目录 | `C:/Users/20995/AppData/Roaming/com.bettersageread.dev/`（用户真实开发库，**只许读，不许做删除类操作**） |
| 同步 E2E 环境 | `scripts/sync-e2e/README.md`（dufs `.tools/dufs.exe` + dev2/dev3 worktree 双实例，复跑手册在案） |
| 站点仓 | `F:\MyProjects\SageRead\site`（腾讯云 EdgeOne 静态站） |

### 铁律

1. **不 push、不发版、不删数据**。本地 commit 可以（conventional prefix + 中文长正文：
   根因链 + 验证证据，参考 `git log` 近 10 条风格）。push 由用户审验后统一执行
   （push 要代理：`git -c http.proxy=http://127.0.0.1:7897 push`）。
2. **最小改动**：任务卡没点名的文件不碰；不顺手重构；发现既有问题记入报告「发现的问题」
   一节，不擅自修（例外：挡住主任务的 pre-existing bug，修完必须在报告里单列）。
3. **交付前自证**：测试/截图/CDP 实测定论，不许"看起来正常"。报告里每条 PASS 都要带证据指针。
4. **行为等价优先**：涉及 UI/交互的任务，首末态必须与施工前一致（除非任务卡明说行为变化），
   只加中间过程。
5. **文档同步**：改了代码口径（wiki 七章、用户手册、提示词、AGENTS.md 有对应描述的），
   同 commit 更新文档，不许留旧口径。

### 中断交接通则（接手中断任务时先读）

任何一张卡都可能以上游 Agent 中断的形态落到你手里。接手规程：

1. **先盘点现场，再决定续作还是重做**：
   - `git status --short` + `git log --oneline -10`：看任务相关改动是已 commit 还是
     还在工作区（未 commit）。对照任务卡的「改动文件清单预期」判断完成度。
   - `git diff --stat`：改动规模与任务卡规格对得上 → 大概率接近完工，进入「验证优先」
     流程；只有零星改动 → 当作刚开工，按施工规格从头做，**保留**已有改动在其基础上续作。
2. **工作区未提交改动一律视为在制品（WIP），禁止 `git checkout -- .` / `git clean -fd`
   / `git stash` 清场**——那是上一个 Agent 的半成品，不是垃圾。确实需要放弃时先
   `git diff > 备份.patch` 留底。
3. **验证优先**：接近完工的现场，先跑任务卡的验收基线（tsc / cargo test / 指定回归
   脚本）。全绿 → 直接按纪律 commit 收尾；有红 → 以失败信息为锚续作。
4. **WIP 快照**：`.tmp-e2e/wip/` 下有主 Agent 拍的中断前快照（status + patch，
   文件名带时间戳）。现场意外被清时用 `git apply` 恢复；现场还在则快照仅作参照，
   以工作区实际内容为准（快照可能落后于最新进度）。
5. **中断任务的 commit 边界**：你完成的部分与捡来的 WIP 可以合并为一个 commit，
   commit message 里注明「含上游中断遗留 WIP 的续作与验证」。

### 验证基线（别拿空转当绿）

- `cd packages/app && pnpm tsc -b` 零错（**必须 `-b`，裸 tsc 历史上空转过**）。
- `cd packages/app/src-tauri && cargo test --lib` 基线 **54 绿**；EPUB 插件在
  `plugins/tauri-plugin-epub` 目录单独跑，基线 **25 绿**。
- 翻译容错：`node --test scripts/test-paper-translation-tolerance.mjs`（8/8 基线）。
- CDP 三坑（高发，已在多份脚本注释里）：① Vite HMR `?t=`——动态 import store 必须从
  消费方转换源码抠版本 URL（`scripts/cdp-e2e-task-channels.mjs` 开头探法是对的）；
  ② 裸 URL 裸 import 拿到的是页面启动代的旧模块；③ evalJS 模板里正则 `/^\\?t=\\d+/`
  单层转义，awaitPromise 要求表达式尾部直接是 Promise（`.then(...)` 结尾）。

---

## 任务卡 1：memo 拆墙（切 tab 的 ~2s React render 墙 → ms 级）

**状态**：✅ 已完成并提交（commit `0f4b793`，2026-08-26）。paper↔paper 中位
1726→107ms（验收 <200ms PASS）；home↔重论文 1187→216ms、book↔paper 335→290ms
（残余 = 涉及 tab 自身必要重渲 + DEV 插装税，生产构建无此税）；批次 3 回归 22 项全绿。
**遗留（另立项，见挂账记录）**：MessageItem 级 memo（chat-messages.tsx 1042 行中型重构）；
批次 4 F 节首挂载聊天面板 maxGap≈1.2s（一次性，非切换路径）；foliate paginator.js:208
异步竞赛错误（vendored 渲染器既有，间歇，与 React 改动无交集）。

<details><summary>原任务卡（存档）</summary>

**状态**：主 Agent 的子代理（agent-92）在跑/可能已将改动落工作区未提交。
**接手方法**（先按「中断交接通则」盘点，再用本清单判完成度）：
2026-08-26 08:32 快照（`.tmp-e2e/wip/`）显示在制改动已覆盖——`home-layout.tsx`、
`reader-layout.tsx`、`side-chat/`（index/chat-input-area/chat-messages）、`chat/index.tsx`、
`library/components/book-item.tsx`、`paper-reader-view.tsx`、`papers/paper-chat-panel.tsx`、
`reader/components/`（header-bar/reader-viewer）、`store/layout-store.ts`、三个 CDP 脚本
适配 + 新探针 `scripts/cdp-tab-switch-wall.mjs`（未跟踪）。完成度判据：
- [ ] `PaperReaderView` 与 `HomeLayout` 已包 React.memo；
- [ ] 订阅面收窄改动（layout-store/side-chat 等）有注释说明；
- [ ] `scripts/cdp-tab-switch-wall.mjs` 可跑出 tWall 数据；
- [ ] tWall 中位 < 200ms（10 轮）；批次 3 回归 22 项全绿；tsc 零错。
四项齐 → 验证后直接 commit 收尾；缺哪项续哪项。
**背景**：`scripts/cdp-opacity-ab.mjs` A/B 实盘已证：切 tab 墙不是 CSS 隐藏模型问题
（tReflow≈0），而是 `activateTab` 触发 ReaderLayout 全保活树（~11 万元素/三层论文）
重 reconcile 的单个 long task——`PaperReaderView` 未 memo。
**施工规格**：
- `React.memo` 包 `PaperReaderView`（props 仅 paperId/title/viewSleeping 三原始值）；
  memo 只许跳过重渲，不许改变渲染结果——逐一核对其 store/context 订阅在 activateTab
  时不变（变了的在报告点名）。
- `React.memo` 包 `HomeLayout`（无 props 直接包导出）。
- 书籍 tab 层先量后动：书籍内容在 foliate iframe（React DOM 浅），实测不贵就不抽组件。
- 排查 SideChat/PreviewPanel 订阅面：activateTab 不应触发其 store 变化；有全局
  activeTab 订阅导致全量重渲的，点名 + 收窄建议（改动克制）。
**验收标准**：同靶子（11.4 万元素三层论文 tab）同探针 10 轮采样，**tWall 中位 < 200ms**；
回归 `scripts/cdp-motion-batch3-verify.mjs` 22 项全绿；休眠唤醒/阅读位置/chat 流式不断；
tsc 零错。
**审计方法**：探针数据前后对比表（中位/均值/p90）+ React Profiler 或插桩归因剩余瓶颈；
回归脚本输出留档。
**报告格式**：tWall 对比表 + memo 清单（包了谁/没包谁及理由）+ 订阅面审计 + 回归证据 +
改动文件清单。

</details>

---

## 任务卡 2：动效批次 5——路由 keepalive + TabsContent 进场动画

**状态**：✅ 已完成并提交（现场盘点确认无上游源码 WIP——`.tmp-motion-verify/` 遗留
是任务卡 1 收尾验证产物，卡 2 从零施工；批次 5 验证脚本
`scripts/cdp-motion-batch5-verify.mjs` 17/17 全绿，批次 3 回归适配 keepalive 断言后
22/22 全绿，tsc -b 零错）。2A 已按 visited 集合落地（7 路由懒挂载常驻、二次访问
零重挂载、滚动/img 节点同源、往返像素 diff=0、heap 序列无泄漏形态）；2B 除 radix
TabsContent（embedding-dialog 唯一使用方）外，设置页/AI 中心/书籍+论文笔记面板
均为条件渲染/手写切换——已按验收意图在各切换点挂 `motion-enter-slide-up`
（key 重挂载播动画，token 驱动三档退化）。**已知行为变化（改善方向，向用户说明）**：
主页 7 路由切走再切回，页面本地状态保留（筛选/滚动/未提交输入），此前是重置；
不喜可给单页加 `data-no-keepalive` 白名单退路。**2026-08-27 用户验收迭代（①落盘保留；②③已回退）**：①设置页进场动画 slide-up → 纯 fade——弹层
DialogContent 是 overflow-y-auto，translateY(8px) 起步帧超出弹层底边 → 弹层自身滚动条
闪现一帧（用户实测"尾巴没收好"）；AI 中心/笔记面板动画容器父级非滚动容器，无此问题
维持 slide-up。②隐藏模型 opacity 转正为默认、visibility 降为逃生门（main.tsx 钉值同步
翻转）——keepalive 大层 visibility 翻转触发全量 raster+paint，图书馆↔文献库实测 620ms
长任务（窗口遮挡/冷态下最重；页面热身后降至 ~110ms 的 dev 渲染税）；opacity 模型层恒
栅格化，切换纯合成器操作。③.tab-layer 全模型移除 pointer-events——pe 是继承属性，
层上翻 none↔auto 会弄脏整棵子树计算样式（实测 89ms/层全子树 style recalc）；交互隔离
由 inert（React 侧）+ 活跃层恒 inset-0 盖顶（命中测试实证）承担。两回归套件适配后全绿
（批次3 46/46：E 节改新鲜探针层构造级证明——存量层在运行期翻 token 时 transform 过渡
不保证重启是测试伪象；批次5 34/34：B2 改构造级 getAnimations 证明——设置分区挂载有
~1s 主线程块会饿死 rAF 采样、A5 改终态稳定性对比+壁纸视频暂停——lianyan 动态主题的
全屏 loop 视频让任意两截图必然 diff、A6 改 GC 地板值×1.3）。
**回退记录（同日晚，用户实测否决）**：②③上线后原丝滑路由（AI 中心/全局助手/
阅读统计）出现新卡顿——opacity 常驻栅格化的 GPU 合成开销在多保活大层下扩散到
全部路由，得不偿失（图书馆↔文献库的 raster 墙只是换了个形态分摊）。index.css
与 main.tsx 已 revert 回 visibility 默认 + pointer-events 版本；归因知识与脚本
健壮化保留（批次3/5 回归仍全绿——两套件模型感知，visibility 下按旧断言跑）。
教训：A/B 探针测的是切换瞬间的长任务，没测常驻合成态的持续开销——单点指标
优化被全局面感否决，**性能改动必须整组路由手感验收后再定去留**。
**测量教训（脚本已固化）**：
resource buffer 250 条会挤掉 asset 条目（计数恒 0 无效，img 节点同源才是证据）；
settled 截图必须等全部 `img.complete`（早拍捕到未解码封面 → 假像素差异）；
Chromium 把 0.01ms 序列化为 `1e-05s`（断言两者都要认）。

<details><summary>原任务卡（存档）</summary>

**状态**：未开工。**前置**：任务卡 1 落盘（同碰 `home-layout.tsx`，必须串行）。
**背景**：用户实测图书馆↔文献库切换"过渡没被覆盖 + 卡顿"。根因：批次 3 的路由转场是
两槽 keepalive（旧页播完离场即卸载），每次切换目标页**冷挂载**——React 重建网格 +
封面重新走 asset 协议取图解码（`book-item.tsx:482` convertFileSrc），300ms 淡入播在
空壳上。两个子项：

### 2A. 主页路由 keepalive 化（治根）

**施工规格**（`packages/app/src/components/home-layout.tsx` AnimatedRouteLayers）：
- 两槽 `[prev, current]` 改为 **visited 集合**：按首次访问顺序 append，只增不减
  （懒挂载——首访才 mount，之后常驻；不启动时全挂，保启动速度）。
- `key=path` 保持实例；`.tab-layer data-active` 交叉淡入不变；非活跃层 inert/aria-hidden
  （已有）；/chat 层本就常驻，不动。
- 7 条路由全部适用；未知 path 仍渲染空（行为不变）。
**已知行为变化（向用户说明，属改善方向）**：切走再切回，页面本地状态保留（管理态/
筛选/滚动位置/未提交的输入）——此前是重置。若用户验收不喜，退路是给单页加
`data-no-keepalive` 白名单。
**验收标准**：图书馆→文献库→转换器→回图书馆：① 二次访问零重挂载（expando 标记或
effect 计数实证）；② 滚动位置/筛选保持；③ 封面不重新取图（Performance resource
计数对比）；④ 终态与施工前逐像素一致；⑤ JS heap 简单采样无失控；⑥ 批次 3 回归
22 项全绿（keepalive 断言需适配更新）；tsc 零错。

### 2B. TabsContent 进场动画（覆盖设置页/AI 中心/全部 Tabs）

**施工规格**（`packages/app/src/components/ui/tabs.tsx`）：
- TabsContent 挂载即播进场动画：radix 每次切换重 mount → CSS **animation**（非
  transition，mount 无过渡）自然播放。复用批次 1 工具类（index.css `motion-fade-in` /
  `motion-slide-up-in`，token 驱动，fade-only 纯 fade、reduced 0.01ms 硬切自动生效）。
- 只加动画类，不动 mt-2 等布局类；三个已知使用方（paper-notepad-panel、notepad-header、
  embedding-dialog）+ 设置页 + AI 中心逐个人肉核对。
**验收标准**：设置页/AI 中心/笔记面板 tab 切换有 80-200ms 淡入+微位移；三档退化正确；
布局零变化；tsc 零错。
**审计方法**：CDP 中途截图（动画进行中 opacity 中间态）+ 终态截图对比 + 三档构造级
computed 断言；脚本沉淀 `scripts/cdp-motion-batch5-verify.mjs`，截图 `.tmp-motion-verify/`。
**报告格式**：两子项各自的实现要点/取舍 + 验收证据 + 行为变化说明 + 改动文件清单。

</details>

---

## 任务卡 3：动效二期（共享元素转场 + 手势侧栏）

**状态**：立项文档在 `docs/motion-phase2-plan.md`（含开工门禁、工程量评估、风险）。
**前置**：批次 5 落盘 + 一期整体稳定运行一段（用户手感签字）。
按该文档执行即可；候选 A（封面→阅读器 layoutId）先做 spike 最小闭环验证再全面铺，
候选 B（手势拖拽）先把热区地图画出来给用户过目再动手。

---

## 任务卡 4：ZBS 适配 Phase 1——zotero-brain-slim Elsevier 级基建

**状态**：未开工。**施工蓝本**：`zotero-brain-slim/docs/roadmap_legit_channels.md`
（改动项清单 A 节逐条照做，合规红线先读）。
**前置人工（Phase 0，用户做）**：dev.elsevier.com 自助注册个人 API key。
若用户尚未持有 key：基建照做，真实联调留待 key 到位（mock 先行，与蓝本一致）。
**验收标准**：`tests/` elsevier 级 mock 测试四类场景全过（命中/无权限/未收录/无 key）；
下载结果结构泛化（XML 产物：后缀/contentType/source 标记）不破坏既有 PDF 路径
（既有测试全绿）；`no_pdf` 文案含"挂交大 VPN 可解锁"；README 同步。
**审计方法**：pytest 输出 + 既有套件回归 + 一份手工 mock 瀑布演示日志（六级全败 →
elsevier 级命中 XML 落盘）。
**报告格式**：清单 A 节逐条勾选状态 + 测试证据 + 遗留（VPN 实测待 Phase 1.5）。

---

## 任务卡 5：ZBS 适配 Phase 2——Papers_Converter XML→MD 转换器

**状态**：未开工。**蓝本**：`roadmap_legit_channels.md` B 节 +
`SageRead/docs/zotero-brain-xml-pipeline-plan.md`（立项五问先回答进报告）。
**施工规格**：
- 标准 JATS 先试 `pandoc -f jats -t markdown`；Elsevier 变体 pandoc 不认则轻量解析
  （正文/标题层级/图表占位/参考文献）。
- 输出严格对齐契约 **`SageRead/docs/paper-format-contract.md`**（Pandoc MD + YAML
  frontmatter 对齐 CSL、slug citekey 优先、images/ 相对路径、必填不留空）。
- 参考文献从 `<ref-list>` 结构化提取生成 references.json（比 PDF 路径正则重建可靠，
  质量下限：DOI/标题/作者齐的条目比例不低于 PDF 路径）。
- 公式 MathML→LaTeX、图表实体引用→本地 images/ 落盘；与 PDF 路径产物**同构**
  （阅读器/向量化/翻译不感知来源）。
**验收标准**：fixtures 至少 3 篇（PMC JATS / Elsevier 变体 / 带公式表格各一），
产物导入 dev 实例阅读器人肉核验（目录/图/公式/参考文献转跳链接全部可用）；
CLI 回归（既有 PDF fixtures 全绿）；契约校验脚本（若有）零告警。
**审计方法**：产物 diff 对照 + 阅读器截图 + 回归输出；重打 exe
（`.venv/Scripts/pyinstaller.exe papers_converter_cli.spec --noconfirm`）并部署到
SageRead binaries 后 CDP 实盘一篇。
**报告格式**：立项五问答案 + fixtures 清单与产物质量 + 回归证据 + 与 PDF 路径的
产物同构性说明。

---

## 任务卡 6：SageRead 侧 XML 导入链路与 UI 文案适配

**状态**：✅ 已完成并提交（CDP 实盘 `scripts/cdp-xml-import-verify.mjs` 9/9 全绿：
XML 经导入入口 → 任务卡（阶段名「XML 解析」跟随 converter 实报）→ 落库 →
阅读器目录/公式/图（data-paper-src blob 渲染）/引用锚点 → references.json
结构化落库；重跑同内容 outcome=skipped 顺带实证去重语义；tsc 零错；文案 grep
复查零遗漏——导入入口/弹窗/拖放罩/任务卡/设置页/AI 工具描述/提示词/用户手册
01+03 章全按「PDF / XML」口径，书籍转换器（PDF→EPUB）与 Zotero 条目附件盘点
的 PDF 字样属别的语义不动）。**链路实现**：Rust convert_paper_pdf 本就路径直通
（零改动），converter CLI 按扩展名分派；TS 侧改扩展名闸门（importPaperPdf/
拖入过滤/文件对话框）+ 阶段名跟随 + terminated 竞态修复（见下）。
**顺手修复的 pre-existing bug（单列）**：paper-parse 执行器 `terminated` 事件缺
`finishing` 守卫——done 进落库路径后进程退场的 terminated 会把成功任务误记
「已取消」；XML 管线秒级解析把该竞态从偶发撑到必现，已在 terminated 分支补
finishing 判断（PDF 路径同步受益）。**PDF 零回归依据**：pipeline.py 的 PDF 分支
逐字未动（仅在其前加 .xml 分支）+ Papers_Converter 全仓 243 测试绿 + 重打 exe
（已部署 binaries，bak-pre-xml 留底）；PDF 实盘导入未跑（烧 OCR 配额），
留用户日常使用验证。**遗留**：XML 导入论文的「重新解析」找不到 source.pdf
（XML 管线无源 PDF 拷贝）会走 zotero 回链/失败提示——接受（重解析对 XML 论文
本就应重抓）；Elsevier 真实样本联调待 key。

<details><summary>原任务卡（存档）</summary>

**状态**：未开工。**前置**：任务卡 5 的 exe 已部署到 SageRead binaries。
**施工规格**：
- 导入入口双格式：拖入/菜单/ZBS 推送接受 `.xml`（与 `.pdf` 同链路），paper-parse
  任务通道 payload 带输入类型，converter CLI 按类型分派参数。
- UI 文案全扫：导入入口/任务卡片/错误提示/设置页转换引擎说明中"PDF"字样的地方
  按"PDF / XML"口径更新（用户点名项，一处不漏——grep `PDF` 全仓逐条判）。
**验收标准**：CDP 实盘拖入一篇 XML → 任务卡正常 → 落库可读；PDF 路径零回归；
文案 grep 复查零遗漏；tsc 零错。

</details>

---

## 任务卡 7：站点/备案线收尾（人工为主）

**状态**：等外部审核。bettersageread.cn 备案审核中、EdgeOne KV 审核中。
- 备案批后：EdgeOne 绑域名 → 页脚填备案号 → 公安联网备案（用户人工，辅以指引）。
- KV 批后：配 `DL_KV` + counterEndpoint 下载计数（site 仓边缘函数，见 `site/DEPLOY.md`）。
- COS 桶保留最新版包即可（历史版本清理口径：保留最新 1-2 版）。

---

## 任务卡 8：发版 v0.3.0（最后做，前置全齐才动）

**前置条件（逐条核）**：① 动效批次 5 落盘；② ZBS 适配 Phase 1-2 落盘（用户的
发版口径：动效全批 + ZBS 适配齐后发）；③ 用户已审验并 push 全部本地 commit；
④ 发版巡检三件套：**wiki 七章/提示词/用户手册** 与代码口径一致（逐章核，改代码
没改文档的补齐）；⑤ RELEASE_NOTES.md 更新（动效一期+opacity 实验+memo 拆墙+
sync 修复+E2E+ZBS XML 管线）。
**步骤**：版本号 bump（tauri.conf.json + 相关处）→ commit → push → tag `v0.3.0` →
CI 出 draft（~20min）→ 检查 draft 产物（win 安装包 + 更新包）→ 发布 → cos-sync
自动进桶 → curl 验 200 → 盯一次真实更新链路（更新确认框/快捷方式/版本小红点）。
**发版后用户侧盯办**：桌面/开始菜单快捷方式是否重复（历史 bug，复现要留现场排查）。

---

## 挂账记录（不修只记，防遗忘）

- **sync P6 已知取舍**（`docs/sync-direction-audit.md` 末节）：20MB 大行静默跳过、
  >50 包兜底删除、防回环 DELETE 并发窗口、ui-config 前端 LWW——备查不动。
- **foliate-resize-update dead dispatch**：全部发送方发 `{bookId}` 单数、消费方
  `event-manager.ts:63` 读 `{bookIds}` 数组——全死；重分页实际靠 paginator 自身
  ResizeObserver 兜底。建议维持现状（修活会双重重分页）；要清理另立任务。
- **多模态/思考映射表例行维护**（`vision-map.ts`/`reasoning-map.ts`）：新型号上线
  时人工补枚举；OpenRouter 目录 API 可作校验源（TODO 在 `vision-map.ts` 头注，
  不做运行时依赖）。**2026-08-27 vision-map 已定稿为纯静态枚举表**（用户两轮裁定：先废家族
  命名启发式，再废产品线前缀/明文规则/七家兜底——glm-5.3-flash 不带 v 事件 +
  "厂家随时变卦"论证）：`MODEL_VISION` 精确型号 → 布尔，151 行（true 100/
  false 51），每行独立对照官方文档；范围 = 能生成文本的聊天模型（text-to-text
  vs any-to-text），图像/视频生成与语音系不在表内。未收录（含未来新型号）
  **默认放行**——代价不对称裁定：文本模型收图最坏一次可见报错，误拦视觉模型是
  无声功能残废；漏收 ALLOW 行代价为零（放行恰好正确），故只有"用户真在用的
  文本型号"需要收全 DENY 侧。仅存两条身份归一（非能力推断）：OpenRouter 作者
  前缀剥离、日期快照别名剥离（厂商口径：日期 ID 是基名快照）。研究底稿
  `docs/vision-map-research.md`（2026-08-24 逐家官方引用）。
  维护 = 查官方文档往表里加一行。
- **AI 用量统计面板**（想法池 `docs/next-round-backlog.md` 末节）：不排期。
- **opacity 隐藏模型试验与回退**（2026-08-27）：raster 墙/pe 继承税两项归因实测成立，
  但 opacity 默认上线后被用户实测否决——常驻栅格化把合成开销扩散到原丝滑路由。
  已 revert 回 visibility 默认。结论留存：图书馆↔文献库冷态 620ms 墙的真因是
  visibility 翻转的全量 raster（非 React），若未来再优化，方向是 content-visibility
  或层的按需降级，而非恒驻栅格化。
- **设置分区挂载 ~1s 主线程块**（2026-08-27 实测，字体管理最重 ~1.2s、网络代理 ~0.9s）：
  切设置项时可感卡顿，怀疑分区组件全量重渲/字体枚举；与动效无关（动画本身正常），
  排期另查。

---

## 本轮完成清单（2026-08-27~28，三仓 42 笔 commit）

### 任务卡线

| 卡 | 内容 | SageRead commit | 配套仓 commit |
|---|---|---|---|
| 1 memo 拆墙 | （前轮已完成 0f4b793） | — | — |
| 2 动效批次 5 | keepalive + 进场动画 + 验收迭代 + opacity 回退 | 5b50c51→9c1b9a5→e60b51b | — |
| 4 ZBS Phase 1 | Elsevier 级基建 + mock 测试 + 文案通用化 | — | zbs: e714e4e→c469f78 |
| 5 XML→MD 转换器 | 适配器 + 媒体图 + 引用 CJK + 链接 + 脚注 + source.xml | — | converter: 1448830→83ff6e5 |
| 6 XML 导入链路 | 双格式 + 文案 + 重解析 + 代理注入 | a607b51→144d286→35694c3 | — |

### 映射表三轮重构

| 轮次 | 内容 | commit |
|---|---|---|
| 一轮 | 家族启发式→枚举制（glm-5.3-flash 事件） | 654eb9d |
| 二轮 | 废除全部规则层→纯静态表+未收录默认放行 | 10c2025 |
| 广撒网 | 22 家 247 行（vision）+ 128 行（reasoning） | 60227fb→d8c2cdd→1067cf3 |
| reasoning 枚举 | 能力行 + UI 档位动态化 + 三形态选择器 | 6dad673→c312799→af07939 |
| bug 修复 | lookupCap 前缀剥离 + hunyuan-hy3 正式版 | a1104df→ba98fd3 |

### API 申请冲刺

| key | 状态 | 存放 |
|---|---|---|
| Elsevier | ✅ 已验证（元数据 200 / 订阅离校 403） | zbs .env |
| Springer Nature ×2 | ✅ 已验证（OA JATS 端到端通） | zbs .env |
| OpenAlex | ✅ 已验证 | zbs .env |
| CORE | ✅ 已验证 | zbs .env |
| IEEE | ⏳ waiting | zbs .env |

### 备案

- ICP 已批（2026-08-27），公安备案数据码在手（30 天时限）
- 用户当前悬置；顺序 = EdgeOne 绑域名上线 → 公安联网备案 → 页脚挂号

### 遗留事项

- 三仓本地 commit 待用户审验 push（push 要代理 `git -c http.proxy=http://127.0.0.1:7897 push`）
- Elsevier 全文获取待校园网/VPN 环境实测一篇（用户到校后）
- IEEE key 审批中（waiting）
- 对话召回工具（readThread）方案在想法池，不排期
- 动效二期等用户手感签字
