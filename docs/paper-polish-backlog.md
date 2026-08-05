# 论文模块打磨待办（paper polish backlog）

> 2026-07-28 建立。记录文献库/论文助手的打磨项，逐批消化。完成项移入"已消化"并标注日期。

## 待办

### F 批：Agent 与生态（2026-08-04 用户输入）
- **Agent 能力大升级（"给它双手"）**：让 Agent 拥有读取/创建/写入/修改本地文件的能力 + 运行命令行（Python 指令等）的能力。定位共识：不做专业科研 Agent，但必须能完成基础任务（写报告、跑脚本）。现状盘点：已有 `readLocalFile`/`downloadFile`/`httpRequest`/`extractZip` 等 central 工具（ai/tools/central/），缺**写文件/编辑文件**与**执行命令**两大类；执行命令的安全模型需设计（白名单？沙盒目录？确认制？）
- **Zotero brain MCP 精简版（默认 MCP 夹带）**：只做 ① 搜数据库 ② 下载 PDF ③ 导入 Zotero ④ 导入 SageRead 解析放进文件夹；剪除解析与向量化（与 SageRead 已实现部分重叠）。作为 SageRead 默认 MCP 存在（用户自述"夹带私货"，但对外不承认与 SageRead 的绑定关系——灰色通道捞 PDF 的版权敏感性，文档与宣传口径注意）
- **记忆系统（2026-08-04 讨论结论：暂不引入）**：SageRead 的 Agent 目前是任务域助手（阅读/论文/全局），专职记忆系统（mem0 类）复杂度不值当。便宜路径优先：① 文件即记忆——Agent 大升级落地写文件能力后，让它把工作笔记/报告草稿写入指定目录，天然形成可检索的"记忆"；② 对话与标注已经在库（list_threads/get_thread/list_book_notes 已对 MCP 开放，语义检索可查）。等多会话长任务（跨天写报告）成为真实场景后再评估。
- **全局 Agent 批处理工具（早前记录，批量导入落地后排产）**：一键全部向量化、全部翻译、整理文献归类（依赖 Agent 能力升级与文献库规模上来）

### E 批：功能与愿景（2026-08-02 用户输入，按优先级排产见当轮结论）
- ~~**论文导出**~~（✅ 2026-08-03 已消化，见下"论文整篇导出"批；遗留：frontmatter 中文化，见 D 批）
- ~~**MCP 开放向量库语义查询**~~（✅ 2026-08-03 已消化，见下"sageread-mcp 论文适配 + 语义查询"批）
- ~~**多引擎解析适配**~~（✅ 2026-08-04 已消化，见下"多引擎 + 单篇 PDF 导入"批；设置页引擎选择落地，MinerU 输出重跑属 Converter 侧操作）
- **Zotero 批量导入**：优先利用 Zotero 直接可得的元数据，缺失时回退 PDF 内提取；支持按 Collection 复选导入（前端复选框小改动）；与路线图 §3.4 的 Zotero 联动（批注回写）是两条独立线。**slug 与元数据确定性（2026-08-03 定论）**：slug 必须由确定性输入生成——有 Zotero 时用 CSL（author 姓 + year + title 首词）；无 Zotero 的裸 PDF 场景把 LLM 提取结果缓存进 staging（metadata.json），重跑复用而非重新提取（Converter 七轮暴露 LLM 年份判定跨轮翻转致 slug 漂移 wang2018↔wang2013）；不统一走 LLM（非确定性反而加重）。**实质重复条目识别（用户提出的设计题，导入批次实现）**：元数据不同（机构/日期差异）但内容实质一致的文献判定重复——分层策略：① DOI 精确匹配；② 标题归一化模糊匹配 + 第一作者姓 + 年份容忍（±1）；③ 内容指纹（PDF 首页文本 simhash 汉明距离阈值）；④ 向量库近邻（嵌入已就绪， cosine 阈值辅助判定）。命中后：保留新条目并保留双方 zotero_key 链（Zotero 库治理在 Zotero 侧，SageRead 侧只标记重复关系不物理删除；Collection 分组对不上的条目进"未分组"虚拟集合人工归并）
- ~~**动态术语表学术翻译**~~（✅ 2026-08-03 已消化，见下"动态术语表"批；跨论文/文件夹沉淀复用仍待做）
- ~~**主题 CSS 上限探索（低优先，视觉向）**：图片/视频为底 + 毛玻璃等示例，探索全局主题系统能力边界（THEMING.md）；排在技术优化之后~~（✅ 2026-08-05 部分消化：主题「怜烟」落地——背景视频循环（亮=哀鸿水墨 0.7MB / 暗=苏怜烟暖金 1.0MB，1080p30 H.264 faststart）+ 变量半透明化 + 整屏磨砂层；视频层 `components/theme-background-video.tsx` 读 `--bg-video`/`--bg-frost` 挂载。同日追加：森林/红枫/海洋/薰衣草四个单色调主题下线（用户拍板"太简单不会有人喜欢"），新上两个撞色主题——「蒙德里安」（荷兰风格派：画布白×黑网格×红蓝黄原色块、硬偏移投影）与「莫兰迪」（冷调高级灰：雾灰绿×尘青×鼠尾草、柔阴影），亮暗双态 CDP 截图验收）

### D 批：杂项（未排期）
- **论文导出遗留（2026-08-03 整篇导出批）**：译文/对照模式 frontmatter 仍是英文元数据（title_zh/abstract_zh 不回写 YAML，js-yaml 重排会动用户字段顺序，暂缓）
- ~~**MinerU 公式 legacy TeX 兼容扫荡**~~（✅ 2026-08-02 实证关闭：对 Converter 全量产出 126 MinerU + 125 paddle 逐篇 grep，`\bf \cal \sf \tt \textcircled` 全库 0 次——Converter 侧已在落盘前处理，本项无需 SageRead 侧动作）
- **词对齐残留打磨（2026-08-02 测试发现；2026-08-05 用户拍板：影响已不显著但排产做好）**：句首虚词区错配（worth↔远离/noting↔分界线，功能词向量区分度低）；非连续对应不可表达（"not…at all"↔"根本"，jieba 把"根本无法"粘成一词）；历史标注 -tgt 镜像疑似重复区间注册（绿色标注 4 个相同 105 字区间）。jieba 已上线（见 2026-08-02 已消化批），本项为剩余残留
- **epub 插件 read_epub 潜在外观 bug（2026-08-05 发现）**：`reader.rs` 把 `get_current_str()` 的元组顺序搞反了——返回是（内容, MIME)，read_epub 取 .1 当内容（实为 MIME 串），导致其 chapters 的 content 全是 "application/xhtml+xml"、标题退化为 "Chapter N" 占位。当前无下游使用（pipeline 只取标题/计数，正文走 mdbook 转换），未动；若将来启用 read_epub 的章节内容，先修这个
- ~~**tauri-plugin-epub 测试目标既有损坏（2026-08-02 发现，未修）**~~（✅ 2026-08-03 已修，提交 4fa902e：25 个过期测试编译错误清零——失效 API 测试删除/接口变更跟进/tempfile 补 dev-dep，cargo test 15 全绿，zh_segmenter 3 组同步解锁）
- ~~**"笔记"概念清除计划（2026-07-29 用户拍板：逐步清除 notes 概念，全部迁移到"标注"）**~~（✅ 2026-08-03 全部消化，见下"笔记概念清除收尾"批）
- webSearch 结构化结果面板（chat 页右侧工具详情面板目前只支持 mindmap/rag）
- paper 设置下拉支持自定义字体之外的更多书籍阅读器设置项（按需）
- **C2 打磨项**（2026-08-05 用户拍板排产，下一批做）：AI 标亮命中稳定性——降 temperature 抑制 3~8 条抽奖波动、toast 附丢弃原因（复述/公式句/未匹配分类）、quote 匹配器再加一层宽松归一
- ~~**对话选段存笔记/引用**~~（2026-08-05 用户拍板**不做**：判定为冗余鸡肋——聊天内容要留存走导出/引用链路已够）
- foliate paginator 启动时对隐藏 tab 过早渲染抛 `el is null`（无害、切换即恢复；修复需动书籍挂载生命周期，风险不值，持续观察）
- **发行版 rebranding 清单（2026-08-05 用户提醒，封装自己的发行版时执行）**：脱离原作者单飞时 `tauri.conf.json` 必改——① `identifier`（现 `com.xincmm.sageread.dev`；⚠️ 它决定 appDataDir 路径，改标识 = 老用户数据目录变更：要么首发前改定，要么配数据目录迁移）；② `productName` / 窗口 `title`（现 sageread）；③ updater `endpoints`（现指向原作者仓库 xincmm/sageread releases——不改则"检查更新"跟随旧版本）与 `pubkey`（换自有 minisign 密钥对）；④ macOS `signingIdentity`（现为原作者 Apple ID）；⑤ icons 与关于页署名同步排查。
- **RAG 精度增强**（2026-08-03 重新评估，结论：**机制侧不改，提示词侧收口**；✅ 2026-08-05 提示词侧已收口）：
  - ~~LLM 重排~~（暂缓，证据驱动：当前融合检索无失败案例，重排每次检索多一次 LLM 调用（延迟+配额）；真出现召回质量问题时，先做便宜机制——命中块按小节/论文去重限流（top-k 被相邻重复块占满是真实痛点），重排兜底）
  - ~~query 改写/关键词扩展~~（**归 Agent 侧**：检索词由聊天模型生成，改写/扩写是它本来就会做的事；已补工具描述引导——paperSearch/ragSearch 注明"英文论文用英文术语查询 + 复杂问题拆 2-3 个不同措辞分次检索"（2026-08-03），此前只有"支持自然语言表达"。**2026-08-05 提示词层落实**：论文助手补「检索策略」节（语言对齐/复杂问题拆分/迭代扩展/基础层与检索层分工，paper-prompt.ts）；阅读助手 RAG 小节补「查询构造」条目（default-skills.json + database.rs v2.3 迁移，存量库已验证生效）；central 无检索工具不涉）
  - ~~译文 chunks 入库~~（**不做**：论文正文为英文，译文入库徒增索引体积与同步陈旧问题；中文查询由 Agent 侧翻译后检索即可覆盖）
  - 仍暂不做：动态召回数量、FTS5 迁移与空间压缩
- Tooltip 统一扫尾（✅ 2026-08-04 已全部消化，见下批；statistics 页实证无需改动）

## 已消化

### 2026-08-05 怜烟主题 + 多标签页堆叠修复批
- [x] **全局主题「怜烟」**：背景视频循环（亮=哀鸿水墨 / 暗=苏怜烟暖金，1080p30 H.264 faststart，1.0MB/0.7MB）+ 半透明变量 + 毛玻璃。机制：主题 CSS 声明 `--bg-video`/`--bg-frost`，`components/theme-background-video.tsx` 全局挂载（未声明的主题零侵入）。**毛玻璃走整屏磨砂层而非逐面 backdrop-filter**（resize 时残留合成块 + 性能差）；嵌套 `bg-background` 去重为 card 色防多层叠加实色。配色由抽帧决定
- [x] **多标签页内容堆叠（半透明主题显形的 latent bug）**：reader-layout 用 `visibility:hidden` 隐藏非活跃 tab，但两个 HeaderBar 的 className 里有静态 `visible` 工具类——CSS visibility 允许子元素覆盖父级 hidden，于是 N 个 tab 的顶栏全部同位渲染（文字堆叠 + 遮罩叠深/拖拽错位"幽灵色块"的真正根因）。修复：删掉两个 header-bar 的静态 `visible`（自动隐藏走子组 opacity，不受影响）。CDP 实测：7 个 .header-bar 仅活跃 tab visible
- [x] **Switch checked 色随主题**：硬编码 bg-blue-500/600 → bg-primary

### 2026-08-05 聊天区公式渲染 + RAG 提示词收口批
- [x] **聊天消息公式渲染（用户反馈：侧边栏助手不渲染公式）**：根因——`prompt-kit/markdown.tsx`（三助手 + central 页共用）的 ReactMarkdown 没挂 remark-math/rehype-katex（paper 阅读器有，聊天区漏了）。修复：挂 remarkMath + rehypeKatex + katex.min.css；**二轮根因**：remark-math 只把多行 `$$…$$` 识别为行间公式，整段单行 `$$…$$` 会当行内——`parseMarkdownIntoBlocks` 对整段单行 $$ 段落改写为多行形式（仅 paragraph token，代码块不误伤）；公式内 `[n]` 不会被吞成引用标注（KaTeX 逐符号分片，[n] 凑不成连续文本节点，天然规避）。CDP `scripts/cdp-test-math-render.mjs` 8/8 PASS
- [x] **RAG 提示词侧收口落实**：见待办区「RAG 精度增强」条目标记（论文助手补检索策略节、阅读助手 v2.3 查询构造迁移）
- [x] **发行版 rebranding 清单**：入待办区 D 批（identifier/productName/updater endpoints+pubkey/签名/图标，封装时执行）

### 2026-08-04 阅读体验修复 + 导入后台化批（用户反馈轮）
- [x] **"高级"导入收纳（2026-08-04 用户拍板）**：目录导入（批量导入/导入论文目录）是普通用户用不上的开发者路径——头部两个按钮收进「高级」下拉（附说明"适用于 Papers_Converter 转换好的目录；普通用户用导入 PDF"）；空状态主按钮改为「导入 PDF」并注明高级路径
- [x] **图注可见化（两层）**：SageRead 侧 img 组件把 alt 图注渲染为可见 caption（InlineMathText 渲染含公式图注，对存量产物立即生效）；converter 侧根治——renderer 改为「图片行（短 alt）+ 图注正文行（同段软换行）」，图注进 sourceText/RAG/翻译（见下 converter 批）
- [x] **References 堆叠根治（converter 侧）**：renderer 每条引用前插空行各自成段（此前裸行被 CommonMark 软换行合并成巨型单段）；附带修 paragraph 前驱集合补 image/table_image（图注行与后段粘连隐患）
- [x] **公式渲染**：新组件 `components/markdown/inline-math-text.tsx`（纯文本+KaTeX 混合，MATH_SEGMENT_RE 切段，失败保留 $ 源码）；应用于论文元数据标题/摘要、papers 列表标题/摘要、标注面板 quote（人工+AI）、图片 caption、论文助手空状态标题、**标签页标题**（app-tabs 加 renderTabTitleHtml 链路，renderInlineMathHtml 字符串渲染；toast 暂不做——瞬时组件且调用点分散）
- [x] **~~ 误删线修复**：论文里 ~~ 是"约"的意思——rehype-del-tilde 插件把 <del> 还原为字面 ~~，remarkGfm 关 singleTilde（单 ~ 同样误伤 ~25 μm 类写法）
- [x] **对话区横向滑块**：chat-container 加 overflow-x-hidden、消息气泡补 min-w-0、index.css 加 prose 换行（overflow-wrap:break-word）+ table/katex-display 各自独立横向滚动（不再连累整列）；**二轮根因**：两个空状态（论文助手/阅读助手）的 max-w-md(448px) 超出窄面板宽度，改 max-w-full + 容器 overflow-x-hidden
- [x] **标注面板滑块与缩放手柄重叠**：handleStyles right 0px → -6px（手柄感应区移到面板外侧间隙，不再盖住内容滚动条）
- [x] **导入 PDF 交互重构**：模态进度窗 → 选择弹窗（点击选择/拖入 PDF）→ 后台运行 + 右下角浮动进度卡（阶段点/进度条/可取消，成功 6s 自消失）+ 完成 toast；**拖放两轮根因**：① home-layout 书籍拖入导入限定图书馆/回收站页（此前全局 preventDefault 吞掉 Tauri 原生事件）；② **`tauri.conf dragDropEnabled:false` 才是拖入完全无感应的根因**（webview 原生拖放通道被关死，改 true 后两种方式均实测可用）；弹窗撑爆根治：grid/flex 的 min-width:auto=min-content 让 nowrap 长路径撑破轨道——dialog.tsx 头部内列与弹窗内容区/路径行补 min-w-0（CDP 实测 overflowCount=0）；CDP 冒烟（scripts/cdp-test-pdf-drag-import.mjs / cdp-diag-dialog-overflow.mjs / cdp-drag-probe.mjs）
- [x] **设置页 PDF 转换重排**：解析引擎配置（三 Token 常驻）/ 书籍转换 / 论文解析三区域；选中未配 Token 的引擎时该区域显示 amber 警告条
- [x] **converter QC 自检**（qc_paper.py，转换末尾 stderr WARN 不阻断）：图/表编号断号（Fig.5 无 Fig.4 类）、References 结构顺序异常（文首 References/后随正文节）、References 未分段迹象；laine 篇实测唯一 WARN 正确命中排序异常
- [x] 遗留：laine 篇 References 文首/Experimental 文末属 stage1/2 排序根因（QC 可探测，未修）；refs 标题公式缺 $ 定界属 converter 提取质量项（逐条粒度，挂 converter 后续）；存量论文需重转获得图注/refs 修复（exe 已重打包）

### 2026-08-04 多引擎适配 + 单篇 PDF 导入解析入库（E 批前两项）
- [x] **Books_Converter v1.3 接入**：sidecar 换 v1.3（12 条结构重建病例修复全量带入；协议零变化；exe 在 gitignore 不入库）
- [x] **书籍引擎选择**：converter-store 加 `engine`（mineru 默认/paddleocr）+ `paddleocrToken`；Rust ConvertParams 加 engine/paddleocrToken（非默认引擎才传 `--engine`，Token 按引擎进 env）；设置页引擎下拉 + 条件 Token 字段；转换页阶段名按引擎动态化；Agent convert 工具错误文案跟进
- [x] **Papers_Converter headless 化**（converter 侧）：`--headless` JSON 进度协议（与 Books 同构，stage 1-4 编号、percent 单调、done 带 slug/paper_dir/title）；config.py frozen 锚定修复（_MEIPASS 输出目录被删坑）；PyInstaller spec 打包 56MB exe（hiddenimports 补 stage1 懒加载四模块 + pypinyin 数据）；真实 PDF 冒烟（逐行 JSON 校验/error 路径/exe 一致）
- [x] **SageRead 单篇 PDF 导入全流程**：`core/paper_converter.rs`（convert_paper_pdf/cancel/state，事件 paper-convert://progress 逐行转发）；sidecar 注册（tauri.conf externalBin + capabilities spawn/kill）；paper-service（startPaperPdfImport/listen/cancel + paperEngineTokenError）；设置页论文引擎区（paddleocr 基线/mineru 表格备选/glm 第二备选 + glmApiKey；MinerU/Paddle Token 与书籍共享）；papers 页「导入 PDF」主按钮 + 四阶段进度对话框（关闭即取消；done 后复用 importPapers 入库，选中文件夹自动挂载）
- [x] **E2E 验证**：CDP（9223，dev 实例以 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS 启动）+ vite 模块注入走真实 startPaperPdfImport，事件流 → done → scan_papers_dir 产物可入库（scripts/cdp-test-paper-pdf-import.mjs）
- [x] 文档：docs/papers-converter-integration.md 新建（架构/协议/两侧落地/遗留）

### 2026-08-04 文献库布局与 hover 细节批 + Tooltip 扫尾（D 批 Tooltip 项关闭）
- [x] **New 判定修复**：论文此前 status 永远停留 unread（书籍靠自动保存标 reading，论文无此链路）——PaperReaderView 挂载时 unread → reading（startedAt 只填一次，lastReadAt 每次刷新），打开过标签页即不再显示 New
- [x] **列表项右侧布局重排**：星标/New/圆环与三个动作按钮从两列悬浮断裂改为一行统排（打星 → 状态徽标 → 向量化圆环 → 分隔线 → 向量化/移动/删除）
- [x] **hover 色硬编码清理**：向量化/移动按钮 hover 色 indigo → hover:text-primary（跟主题色底纹匹配；删除按钮保留红色语义）
- [x] **全局 hover 缓动**：index.css @layer base 新增交互元件统一过渡（button/[role=button]/a/input/combobox/tab/switch/checkbox/radix-collection-item，颜色/背景/边框/透明度 150ms ease-out；只覆盖绘制属性，动画与 transform 不受影响；组件自带 transition 类优先级更高自然胜出）
- [x] **Tooltip 统一扫尾（D 批关闭）**：图书馆 4 文件/设置 5 文件/converter/prompt-kit/preview/annotation-popover/sidebar 共 ~20 处原生 title= 改项目 Tooltip + ~10 个无提示图标按钮补齐；iframe title 属 a11y 语义回滚保留；notepad-header 死搜索按钮实证已不存在（早前 UI 批已删），该子项同步关闭

### 2026-08-03 文献库使用细节批（打星/检索/中文化/标识统一）
- [x] **重要度打星（0-3）**：book_status.rating 列（迁移 + sync 注册 + BookStatus/UpdateData/命令全链，cargo 34 绿）；列表项三颗星（点击设档/再点取消，乐观更新失败回滚）
- [x] **标识统一**：向量化状态改图书馆同款圆环（绿=已向量化/红=失败/灰=未向量化，进行中扇形环+百分比，替代原 sparkle+文字）；New 徽标硬编码蓝 → bg-primary/10 text-primary 主题色
- [x] **检索/排序基础设施**：工具栏关键词检索（空白分词 AND，匹配标题/作者/期刊/摘要/中英文/关键词）+ 排序（更新时间/导入时间/重要度/标题 + 方向切换，persist papersSortBy/papersSortAscending）
- [x] **元数据一键中文化**：Languages 切换按钮（persist papersMetaLang），标题/摘要用翻译服务已落盘的 title_zh/abstract_zh 显示，缺省回退原文；PaperMetadata 类型补两字段
- [x] tsc --noEmit 零错误；dev 实例迁移已应用（book_status.rating added）
- [x] 后续批量化导入后：全局 Agent 一键全部向量化/翻译/整理归类（用户排期，待批量导入落地后排产）

### 2026-08-03 笔记概念清除收尾（D 批）
- [x] **Agent 工具迁移标注**：`notesTool` 数据源从 notes 表改为 book_notes（type='annotation'，经新 Rust 命令 `get_all_book_notes` 跨书查询，JOIN books 带书名/作者；days/bookId/bookTitle/limit 参数不变）；`exportNotesTool` 剥离独立笔记（只导出书内标注，文件名改"-划线标注.md"）
- [x] **服务与类型残留**：删除 `services/note-service.ts`、`types/note.ts`（grep 零引用）
- [x] **Rust 侧移除**：删 `core/notes/` 模块与 5 个命令注册；schema.sql 删 notes 表与索引；迁移 `DROP TABLE IF EXISTS notes` + 清 `_sync_log` 残留行；同步注册 SYNC_TABLES/sync tables.rs 8→7；engine `notes_changed` 只匹配 book_notes；sync 测试改用 book_notes 覆盖同一机制（34 个 cargo test 全绿）；merge 对未注册表现状即跳过（零改动）
- [x] **MCP 侧**：sageread-mcp 删 `list_notes`/`get_note`（标注由 `list_book_notes` 覆盖）+ README 同步，build/smoke 绿
- [x] **文档**：路线图 §3.4"批注/笔记回写 Zotero"→"标注回写 Zotero"； backlog 清理 C2/翻译/句级基建三条僵尸条目

### 2026-08-03 动态术语表学术翻译（E 批）
- [x] `paper-translation-service.ts`：首轮翻译前 `extractGlossary`（辅助模型，标题+摘要+正文前 12k 字符采样 → 30~60 条领域术语规范译法，去重/上限 80 条），随译本落盘 `translation-zh.json` 顶层 `glossary` 字段
- [x] 注入：`buildBatchPrompt` 全部批次附"术语表（必须严格采用给定译法）"段；元数据（title/abstract）翻译同步注入
- [x] 幂等：force=false 续翻复用既有术语表（不重抽），force=true 重翻时重新抽取；抽取失败不阻断翻译（按无术语表继续，不落盘 glossary）；对齐服务读改写同一文件对象，术语表天然幸存
- [x] 测试：translation-tolerance 套件扩至 7 组（抽取注入落盘/续翻复用/force 重抽/抽取失败降级），mock 术语表通道独立于批次行为队列；export 46 组 + alignment-service 14 组回归全过
- [x] 遗留：跨论文/文件夹术语沉淀复用（路线图 §3.7 愿景，现为单篇动态抽取）；长文一致性真机评估

### 2026-08-03 sageread-mcp 论文适配 + 语义查询（E 批）
- [x] **论文库适配**（sageread-mcp `src/index.ts`）：`list_book_notes` 补 `starred/category/source` 三列（PRAGMA 防御检测）+ 论文锚点 cfi 渲染为可读形式（`论文块#N 字符[s,e)`）；新增 `get_paper_toc`（ATX 目录）/`read_paper`（offset/limit 切片，默认 30k 字符）/`read_paper_section`（小节截取）三论文内容工具（仅 format=MARKDOWN 开放，读 `{appDir}/books/{id}/paper.md`）；新增 `list_paper_folders`（folders + paper_folders 分组）
- [x] **语义查询 `semantic_search`**（新模块 `src/semantic-search.ts`）：解析 `{appDir}/llama-store.json` 的嵌入配置（外部选中模型优先，否则本地 127.0.0.1:3544，皆无→明确降级文案）→ 镜像 Rust vectorizer 的 OpenAI/Ollama 嵌入调用（URL 尾 `/api/embed` 判别）→ sqlite-vec（新依赖，vec0 `MATCH ? AND k=?`）检索；scope 三域（papers 全局库/books 逐书库/all 合并），paper_id 过滤 k 放大（max(topK*10,100)，同主应用），索引维度从 vec0 DDL `FLOAT[N]` 解析并与查询向量比对（不一致提示重建索引）；结果 = rank + 相似度（1-distance，与主应用同口径）+ chunk（截 800）+ 出处（书名/作者/类型/章节/文件/块位置）
- [x] 设计要点：秘钥不出本机——MCP 作为 SageRead 一方进程读本机配置自嵌，外部 Agent 只见查询文本与结果；standalone 设计保持（应用不在运行也能用，本地模型场景除外，有专属文案）
- [x] 实测：tsc 无错、smoke 全绿（含 `|| true` 恒真 bug 修复）、真实嵌入端到端命中（智谱 embedding-3 2048 维，"cationic potential" top-k 命中正确论文块）；README 工具表补全 16 个 + 语义检索说明
- [x] 遗留：LLM 重排/BM25 融合未做（D 批 RAG 精度增强统筹）；书籍域 BM25 中文弱（jieba 未接入）；相似度绝对值偏低是 vec0 L2 距离口径（与主应用一致，非 bug）
- [x] **可用性二轮拓展（科研 Agent 写调研报告场景驱动）**：`get_paper_info`（frontmatter 元数据 + metadata.json 的 title_zh/abstract_zh + 所属收藏，yaml 依赖解析折叠块/嵌套作者）——文献筛选与引用列表刚需；`semantic_search` 加 `collection` 过滤（文件夹名/id → paper_id 集合，与 paper_id 取交集；findFolder 按 id 精确→名称精确→子串优先级，防"测试文件夹1"误命中"测试文件夹1.1"）。真实冒烟全绿（collection 过滤前后对比/交集边界/未命中列可选名）
- [x] **可用性三轮拓展**：`list_papers` 批量文献卡片（collection 过滤/include_abstract 截 300/limit 防拉爆，读取失败降级不中断）；`export_paper_citation` 引用导出（bibtex key=首作者姓+年+标题首实词、GB/T 7714-2015 期刊格式三位作者 et al.、缺字段省略/跳过计数）；`get_chunk_context` 命中块上下文扩展（论文全局库/书籍单库两域，md_file_path 约束防跨文件拼接，当前块标记）；semantic_search 结果项附上下文提示引导发现。检索质量（LLM 重排/BM25 融合/中文分词）留在 SageRead 侧 D 批 RAG 精度增强统筹，MCP 镜像跟进
- [x] **引用导出八格式（四轮）**：bibtex / gbt7714 / apa(7th，>20 位前 19+…+末位) / mla(9th，Title Case) / chicago(>10 位前 7+et al.) / ieee(>6 位仅首作者 et al.) / vancouver(≤6 位，尾页缩写 708-11) / ris（Zotero/EndNote 可导入）；保守 Title Case（化学式/公式/含数字内部大写 token 原样）；17 断言式冒烟 + 八格式真实输出人工核对

### 2026-08-03 E 批：论文整篇导出（原文/译文/对照 + 标注 + 图片）
- [x] 管线 `lib/export-paper.ts`：复用 `buildPaperViewMarkdown` 视图重建（原文唯一事实源，译文不落盘）；导出文档 = frontmatter 原样 + 标题 H1（译文/对照优先 title_zh）+ 模式化正文 + 可选文末标注节（复用 renderAnnotationMarkdown/buildAnnotationsListHtml，按锚点块序排序）
- [x] 三格式：Markdown / HTML / PDF（打印版 HTML 路线，与标注 PDF 导出一致，零新依赖）；图片统一 base64 data URI 内嵌（单文件自包含，零新权限；对照模式译文 div 内的字面图片引用导出时清理——原文块紧邻其上已带图）
- [x] HTML：marked 渲染 + 公式占位保护（@@PAPER_MATH_n@@）→ KaTeX 服务端烘焙换回；`lib/export-html-shared.ts` 拆出 sanitizeHtml/EXPORT_HTML_CSS（thread 导出改复用同一份，避免论文导出经对话导出拖入 book-service→foliate-js 链）；KaTeX CSS + 20 个 woff2 字体 `?inline` 全内联（`lib/export-paper-katex-css.ts`，动态 import 懒加载 ~400KB 不进主 chunk）
- [x] 入口：论文顶栏 Download 按钮 → `paper-export-dialog.tsx`（内容默认跟随当前显示模式/无译本禁用译文与对照、附标注复选/嵌图片复选、三格式单选；卡片式选项行 + 分区标题层级）
- [x] **对照 markdown 原生重建（二轮反馈）**：`buildPaperBilingualExportMarkdown`（paper-blocks.ts）——译文以 md 原生形式插入（普通块/引用块后 `> 译文`、列表项缩进续行、表格单元格 `<br>`），公式保持 $...$ 文本、译文内图片引用清理；弃用"对照 div 烘焙 KaTeX 进 md"（MathML+HTML 双份渲染致公式重复、文档臃肿不可编辑）
- [x] **HTML 标注内联高亮（二轮反馈）**：锚点（块索引+textContent 偏移）经公式感知换算（mapSourceOffsetsToLive）映射进导出 DOM → `<mark>` 逐文本节点包裹（笔触三态 + --pa-color 颜色变量，逆文档序应用防坐标失效）；行间公式占位用 `<pre>` 包裹保证导出 DOM 块枚举与阅读区一致；映射失败静默跳过，文末标注节仍是完整事实源；Markdown 格式受格式限制只做文末标注节
- [x] **译文模式跨语言内联修复（三轮反馈：13 条标注只出 3 条）**：根因——用户导出的是译文模式，导出 DOM 已是中文，英文锚点 token 映射必然失败。修复：译文模式先经句/词对齐（mapSrcRangeToTgt，词级精确/句级吸附）映射为中文区间再包裹（未翻译块回退英文直接映射，无对齐表静默跳过）；对照模式加中文侧镜像（pa-mark-tgt 低透明，同阅读区 -tgt 语义）；params 新增 translationFile（携带 align/alignW）。真实数据（a27b187c 13 标注）验证：译文 35 marks / 对照 48 marks
- [x] **导出对话框重设计（三轮反馈：顶格/头部怪换行/粗糙）**：图标块 + 标题/描述双行 + 尾部选中指示圈的卡片式选项行；格式改三列紧凑卡片；头部/底部细分隔线；小区距字距标签分区
- [x] 单测 `scripts/test-paper-export.mjs` 46 组全过（新增：译文跨语言词级/句级/无对齐三档内联、对照中文镜像）；paper-blocks 两既有套件 33 组回归全过
- [x] 遗留记入 D 批：frontmatter 中文化（title_zh/abstract_zh 不回写 YAML）

### 2026-08-02 jieba 分词上线（方案 A：Rust jieba-rs + tokenize_zh）
- [x] 决策依据：离线对比实验（13 探针 单字 7.5 vs jieba 11.5）——词向量在"词"粒度区分度远高于单字，单字路径映射常落词中间（"离"/"致"）或边界多带一字（"或者根"）
- [x] Rust：`text/zh_segmenter.rs`（jieba-rs **0.6.8**——0.7 系依赖墦不可用：libflate 2.3.x let-chains 需 rustc 1.88（本地 1.87）、2.1/2.2 依赖被 yank 的 core2 0.4.0；0.6.8 无 libflate 依赖）；`tokenize_zh` 批量命令；token 偏移按 **UTF-16 code unit** 口径（与 JS string 下标一致）；空白/标点/符号过滤口径与单字路径一致
- [x] 权限坑：插件 `permissions/default.toml` 必须登记新命令，否则 invoke 被拒并静默走兜底（表现为"命令通了但切出单字"）
- [x] 前端：`zh-tokenizer.ts`（批量一次 IPC，失败回退单字不中断）；词级相位中文侧改 jieba；`alignWHash` 拼 `jieba1` 版本后缀——旧 alignW 自动失效重算，无需手动迁移
- [x] service 集成测试：zh-tokenizer 桩（默认单字/开关假 jieba 两字词）验证注入分词生效；14 组全过
- [x] 真机验收：重建后词对 7279→6961、low 18→6；落库探针 **10.5/11**（rocksalt→岩盐/spinel→尖晶石/or→或者/结晶/主要/致谢等全精确，仅"国家自然科学基金"多带"得到"0.5）；CDP 拖拽划"尖晶石"→EN 精确"spinel"（单字版会拖出 rocksalt）
- [x] 插件测试目标既有损坏记录入 D 批（未修）

### 2026-08-02 对齐系统性修复批（句词 DP 缩放成本 + 期刊缩写 + 无解兜底 + 公式归一）
- [x] **根因：DP 成本函数少步偏置**——cost=1-avgSim 每步基线恒为 1，合并移动一步顶两步天然省基线；相似度区分度中等时正确 1:1 路径的相似度优势补不齐基线差 → 句级乱并句（块 39 实证：5 步错路 1.805 < 7 步对路 1.900）、词级向最大合并漂移致级联错位（"lead to stable structures"↔"根"）
- [x] 修复：alignDP 成本按组大小缩放（×(src+tgt)/2，句词两级），合并只在交叉项确实差时胜出；词向量信号实测足够（stable→稳 0.68 行内最高），缩放后词对精确（stable↔稳 / structures↔定结构 / e.g↔例如）
- [x] 切句器白名单补 40 个期刊缩写（Appl./Mater./Inter./Res./Bull./Adv./Chem./Phys./Lett./Nat. 等）——参考文献条目不再被切碎；块 200（5:2 失衡零对齐）随之切成 2:2 正常对齐
- [x] DP 无解兜底：句数比超 maxGroup 时退化为整块单对（标 low），不再整块零对齐
- [x] 公式感知坐标归一（2026-07-30 批，补记）：normalizeMathText / normalizeLiveElement / mapOffsetsMathAware，stored md 源文 ↔ live KaTeX DOM 的 token 序列对齐，含公式块划词/高亮不再错位；22 组单测（test-paper-math-normalize.mjs）
- [x] 真机验收：块 39 七句全 1:1 正确；hover 中文"这展示了…"英文侧精确只亮"This demonstrates…"；"stable structures"↔"稳定结构"双向划词词级精确；整体 223/223 句词对齐、句级 low 0
- [x] 回归测试 4 组（块 39 真实矩阵不乱并 / 正当合译保留 / 词级低区分度不漂移 / 无解兜底）+ 既有 147 组全过

### 2026-07-29 T3 批：词级对齐 + 翻译菜单美化 + AI 重点按钮主题色
- [x] **词级对齐修复（2026-07-29 二轮）**：`EMBED_W_BATCH_SIZE` 256→64——智谱 embedding API 单请求硬限 64 条（实测 65 条 HTTP 400 "input数组最大不得超过64条"），256 导致满 shard 全灭、词级仅末尾小 shard 幸存 1/223；修复后真实数据端到端验证 223/223 完成（`scripts/verify-paper-alignment-e2e.mjs`）。教训：嵌入批量上限按最严供应商（64）设计
- [x] **嵌入自适应分批（2026-07-29 三轮）**：供应商 input 上限差异大（OpenAI 2048 / Cohere 96 / 智谱 64 / DashScope 10），写死任何值都不保险——`embedBatchAdaptive` 遇批量类 400 自动减半重试 + 运行期上限收敛（句词两相位共享），集成测试验证"上限 10 条也能句词全完成"
- [x] 词级对齐（`paper-cross-anchor.ts` + `paper-alignment-service.ts`）：句对内分词（英文按词/中文按单字）→ token 汇总分片 embed（256 条/6k 字符双上限，单片失败仅牵连该片块）→ 单调 DP（(1,1)/(1,k)/(k,1)，k≤4，<0.45 标 low）；写回译本 `blocks[idx].alignW` + 顶层 `alignWStatus`，幂等键同句级；"重建对齐"句词两级同重建；词级失败降级不影响句级
- [x] 映射升级：有 alignW 时 `mapTgtRangeToSrc`/`mapSrcRangeToTgt` 词级精确区间，缺失/未命中回退句级；`mapOffsetsViaTokens` 做 live↔stored 词 token 下标换算（oneLine 折叠/markdown 渲染场景）；22 组词级单测（分词/DP/映射/换算）
- [x] 翻译下拉重排三区：显示模式（radio+图标）/ 翻译（入口+主题色进度条+取消）/ 句词对齐（状态行 句 n/m·词 n/m + "重建对齐"有译本始终可见，仅计算中禁用；无嵌入模型点击给配置引导 toast）——修复"重建句对齐"对齐完成后入口消失的问题
- [x] AI 重点生成/重新生成按钮：蓝色硬编码 → 全局主题（bg-primary text-primary-foreground）

### 2026-07-29 T2 批：句级对齐 + 跨语言标注
- [x] 对齐服务 `paper-alignment-service.ts`：双侧切句 → 本地嵌入 → 余弦矩阵 → 单调 DP（(1,1)/(1,2)/(2,1)，cost=1-平均相似度，<0.5 标 low）；幂等键=(源 hash, 译文 hash)，写回译本 `blocks[idx].align` + `alignStatus`；无嵌入降级 skipped + "重建句对齐"手动入口
- [x] 跨语言映射 `paper-cross-anchor.ts`：src↔tgt 双向区间映射（句吸附/跨句/无覆盖），15 组单测
- [x] 英文标注映射到中文侧（对照/译文模式同色低透明 `-tgt` 高亮）；中文划词标亮 → 映射回英文锚点创建标注（text/context 一律英文，原文唯一事实源）；无对齐段标亮禁用提示
- [x] 中文句子 hover（对照/译文模式译文区）
- [x] T1 修复：图片引用双保险补回（restoreImageRefs）、译文 div KaTeX auto-render、进度条主题色、批次 JSON 容错（重试→跳过→不中止）、对照模式译文放开复制/Ask AI

### 2026-07-29 T1 批：全文翻译基础版
- [x] 切块器 `paper-blocks.ts`（remark mdast）：fixture 226 块与 jsdom DOM 枚举逐块相等（一致性测试钉死）；嵌套列表归最外层、表格逐格、公式/代码/图片不可翻译
- [x] 翻译服务 `paper-translation-service.ts`：分批 ≤12 块/6k 字符，学术 prompt（术语一致/公式代码参考文献不翻/只出 JSON），块哈希幂等（跳过已翻/可续翻），每批落盘，AbortController 取消，元数据 title_zh/abstract_zh 附加翻译
- [x] 三显示模式（persist paperViewMode）：原文/译文/逐段对照；源文本重建渲染（译文模式替换、对照模式插 `<div data-translation>` 且排除出块枚举——锚点零漂移，一致性测试验证）
- [x] 标注兼容：原文/对照精确；译文模式块级降级 + 禁新建；TOC/标题/摘要中文化
- [x] rehype-raw 启用（译文 escapeHtml；rehype-sanitize 收紧记 T2+）
- [x] 顶栏 Languages 下拉（模式切换/翻译/进度/取消）
- [x] 删除阅读区设置下拉冗余的明暗主题切换（设置里已有）

### 2026-07-29 标注星标 + 批量管理导出
- [x] `book_notes.starred`（幂等迁移 + sync 注册 + 宽容读取），书籍/论文标注共用；书籍侧 annotation-item 同加星标
- [x] 论文标注 tab：条目星标切换、全部/仅星标筛选、多选模式（复选/全选/底部操作条）、四格式导出（Markdown/HTML/图片/PDF=打印版 HTML 走系统浏览器另存，零新依赖）、多选删除
- [x] 导出管线 `lib/export-annotations-{md,html,image,pdf}.ts`：论文标题+色标+★+quote+评论+前后文；图片复用 thread 的 foreignObject→canvas 机制
- 铺路完成：Agent 工具"导出某文章星标标注"的数据基础（starred 列）已就绪（工具本身后续做）

### 2026-07-29 句子 hover bug 修复 + AI 清除按钮
- [x] 覆盖层叠加深色：KaTeX 可见 span 与隐藏 MathML 副本/上下标/列表 marker 产生重叠 rect 致 tint 叠加——渲染前几何求并（`mergeOverlappingRects`，y 行带 + x 贴边合并，跨行永不合并），11 组断言全过
- [x] 残影：rAF 节流中 mouseleave 未取消 pending 帧，离容器后旧坐标重画——clearHover 同步三件套（取消 rAF/空坐标/清状态）
- [x] AI 重点 tab 加"清除"按钮（ask 确认 + 条数 toast，仅删 source='ai'）
- [x] C2 打磨项记录：降 temperature 稳输出、toast 附丢弃原因、匹配器宽松归一（见 D 批）

### 2026-07-29 C2 批：AI 自动标亮
- [x] 定死 taxonomy 三模板（research 目标/方法/结果/结论/创新点；review 范围/框架/进展/争议/方向；report 精简三类），五色映射；类型由辅助模型判定（拿不准归 research），面板可手改
- [x] 管线：类型判定 → 模板抽取（严格 JSON、quote 逐字、避开公式、>40k 按一级 heading 切段合并）→ 本地 quote 匹配 + snapRangeToSentences 句吸附 → book_notes（category + source='ai' 两新列，幂等迁移；人工路径恒 user/NULL）
- [x] 安全：delete_ai_book_notes 仅删 source='ai'，重新生成不可能误删人工标注；同步列注册 category/source + engine 宽容读者加固（缺失列不绑 NULL，顺带消除 threads.starred 同类隐患，sync 27 测试全过）
- [x] 侧栏"AI 重点"tab 做实：类型选择 + 生成/重新生成（spinner + 命中/丢弃计数 toast）+ 按类别分组（色点/色条/跳转闪烁/右键删除）+ 无辅助模型降级引导；标注 tab 人工+AI 统一列表带 Sparkles 徽章
- [x] quote→锚点换算 11 组 fixture 实测全过（已知限制：含 $...$ 的 quote 因 KaTeX 渲染不可匹配，prompt 已引导避开）

### 2026-07-29 句级基建
- [x] 切句器 `paper-sentences.ts`（segmentSentences/findSentenceAt/snapRangeToSentences）：缩写白名单 ~45 个 + 小数/角标/闭合符保护，21 组单测全过；接口已为 C2（AI 重点句标亮）与句级翻译对齐预留
- [x] 句子 hover：覆盖层 div（tint+圆角+阴影，明暗两套），rAF 节流 + WeakMap 懒缓存（hover 路径零全量块枚举）；弹窗开/有选区/悬在 img·pre·a 上时禁用
- [x] 右键句子 → 自动选中该句并复用标注弹窗；右键已有标亮 → 回显路径优先
- [x] 弹窗宽度按状态自适应：选区态紧凑 180px，标亮后（笔触/颜色行）拓宽 272px

### 2026-07-29 笔记概念清除（UI 层）
- [x] 标注弹窗精简（书籍+论文）：选区态只留 复制 / Ask AI / 高亮 三按钮；"记笔记""评论""询问AI"按钮全删，评论能力保留在标亮后的回显弹窗（评论图标展开输入区，落 book_notes.note）
- [x] "引用到AI会话"统一改名 Ask AI（图标对齐 quote chip）
- [x] 对话消息区"存为笔记"按钮删除（chat-selection-popup 共享组件一处删除，图书馆/论文/全局三侧生效）
- [x] 书籍 Notepad 双 tab 改单一"标注"（删 notes 列表 UI/use-notepad/note-item/note-detail-dialog/无功能搜索图标）；删 home-layout 的 /notes 占位页与路由
- [x] 残留 grep 零命中（addNote/存为笔记/记笔记/AskAIPopup 等）；notes 表、note-service、Agent/MCP 工具保留待专项迁移

### 2026-07-29 F 批：一致性打磨六项
- [x] swapSidebars（theme-store）对论文生效：左笔记/右 AI 互换、手柄方向、顶栏折叠按钮控制对象互换，与书籍同语义
- [x] 设置入口统一：顶栏右侧（通知与窗口控制之间）加齿轮为唯一全局入口（横向 pinnedRight / 纵向顶条各挂一次），删除主页左下角与书籍 AI 侧栏头部旧入口；Ctrl/Cmd+, 保留
- [x] 论文标注弹窗复刻书籍版（PopupButton/HighlightOptions 三笔触+五色胶囊行）+ 二合一评论输入；CSS `::highlight()` text-decoration 补齐 underline/squiggly 渲染（15 个注册名，笔触×颜色聚合）
- [x] 二合一推广到图书馆：书籍标注弹窗加评论按钮（落 book_notes.note），annotation-item 显示评论预览；独立 notes 系统不动，epubcfi 链路零改动
- [x] 侧栏标注项左侧 4px 竖直色条（HIGHLIGHT_COLOR_HEX），书籍/论文两侧一致
- [x] 弹窗"解释"按钮 → "引用到AI会话"：`quoteToChat` 窗口事件 → handleAskSelection 注入 quote chip（不自动发送），书籍/论文两侧都有；AI 面板收起时先展开再注入

### 2026-07-29 C1 批：论文标注闭环
- [x] 复用 book_notes 表（零 Rust 改动，FK 级联/同步现成）；note 空串=纯标亮（标注笔记合一）
- [x] 锚点系统（paper-anchors.ts）：块索引+块内字符偏移 JSON 存 cfi 列；元数据块排除、嵌套块归并、块失配 quote 兜底；11 组 jsdom 断言通过
- [x] CSS Highlight API 五色渲染 + 划词弹窗（色点/评论/删除/回显）+ 点击命中（caretRangeFromPoint）
- [x] 侧栏"标注"tab：按文档位置排序、色标、quote+前后文、点击跳转+呼吸闪烁、右键改评论/删除；"AI 重点"tab 占位（C2）

### 2026-07-29 B 批：提示词热插拔（prompt presets）
- [x] 存储：新表 `prompt_presets`（id/scope/name/content/is_active/时间戳，`core/database.rs` 幂等迁移），Rust 新模块 `core/prompts/`（仿 skills 模块）；`set_active_prompt_preset` 事务内同 scope 互斥，`clear_active_prompt_preset` = 恢复默认
- [x] 装配接入：reader（`constants/prompt.ts`）有激活预设时替换 DB 系统技能基词（RAG 裁剪 regex 只匹配内置基词标记，对预设自然 no-op）；paper（`constants/paper-prompt.ts`）替换 `PAPER_AGENT_PROMPT_BASE`，能力分层后缀/技能注入/上下文注入照旧；`services/prompt-preset-service.ts` 带 5s TTL 缓存 + mutation 主动失效，失败回退默认不阻断对话
- [x] AI 中心"提示词"tab（已有）改造：阅读/论文助手各一组（默认提示词只读卡片 + 使用中/恢复默认 + 预设列表），新建/编辑对话框支持"从默认复制"，激活/删除（ask 确认）一键完成，切换下条消息生效；阅读助手原直接编辑入口由预设取代；全局助手本批不做（保留只读预览）

### 2026-07-28 E 批：阅读区 chrome 体感打磨
- [x] 删除"对话内搜索"误建功能：书籍/论文 AI 面板头部的放大镜按钮与搜索条、`chat-search-bar.tsx`、`ChatMessages` 的 searchQuery 过滤与高亮注册、`index.css` 的 `::highlight(chat-search)`（本文内搜索 `::highlight(paper-search*)` 保留）
- [x] 书籍/论文 AI 面板空状态引导统一恢复垂直居中（justify-center）
- [x] 论文阅读区容器对齐书籍 region/类名体系：`data-region="paper-chat-panel"` → `chat-panel`（修复 cake 等主题下论文 AI 面板不吃主题样式的问题）、左侧面板 → `notepad-panel`，去掉硬编码 border/bg，框线/圆角/阴影与书籍 chrome 一致
- [x] 尺寸对齐：论文 AI 面板 Resizable 380/320/560 → 书籍实际值 370/320/580；面板头部 h-11+border-b → 书籍同款 h-8；ModelSelector 宽度对齐 w-[10rem]；两侧面板包装间距（mr-1 / m-1 mt-0）与书籍一致
- [x] 垂直标签页顶栏：控件尺寸/颜色与横向 pinnedLeft 完全一致（size-5、neutral-700）；顶栏补 `data-region="reader-tabs"` 吃主题；修复垂直模式顶栏无法拖动窗口（Tauri `data-tauri-drag-region` 只在事件目标自身判定，子容器需各自带属性）
- [x] 垂直标签栏改 Edge 式悬停浮现：删除展开/收回按钮，常态 48px 窄条，悬停浮层（absolute、不推挤布局、过渡动画）展示分组+完整标签
- [x] Tooltip 全局统一（阅读区/论文区 chrome + 文献库页）：原生 `title=` 全部改项目 Tooltip（`components/ui/tooltip.tsx`），无提示的图标按钮补齐；遗留范围见 D 批

### 2026-07-28 A 批：布局全面对齐书籍阅读区
- [x] 垂直标签页模式：主页/切换横向/折叠展开三个控件固定于页面左上角（顶栏左侧顶格），折叠/展开状态位置一致；顶栏居中 SageRead 图标+文字
- [x] 论文阅读版面完全参考书籍阅读区：左侧笔记/标注面板（占位预留，可收回）、中间阅读区、右侧 AI 面板
- [x] 顶栏复刻：当前小节名称显示、悬停浮现左右 UI 组、TOC 下拉、设置面板（字号滑块 + 自定义字体，复用 globalViewSettings）、搜索下拉
- [x] 论文内 http(s) 链接（DOI 等）点击调默认浏览器打开
- [x] 本文内搜索（非对话内搜索）：书籍阅读区同款，高亮 + 计数 + 上下跳转
- [x] TOC 从独立成块改为顶栏下拉（书籍阅读区做法）
- [x] 论文助手面板头部精简：去掉"论文助手"文字标识、收回面板按钮改为图标（书籍同款）
- [x] 移除上批临时的 paperViewSettings，统一用 globalViewSettings

### 2026-07-28 早前批次（开工顺序 1–6 + 打磨批）
- 格式契约 / MD 渲染器 / MARKDOWN 入库与列表 / 全局向量库 / 文件夹模型（OS 式浏览+回收站）/ 论文助手 MVP
- 论文标签页化与书籍分组；skill·快捷指令·MCP scope 三复选（去 "both"）；模型选择器；消息多选导出；对话内搜索（CSS Highlight API）
- Bug：TOC 跳转版面上移（容器内 scrollTo）；引导页不显示（isInit ref 无重渲染，补 forceUpdate）；引导页位置顶部对齐
