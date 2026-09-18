# 0.4.1+ 工作讨论落档（2026-09-17）

> 仅讨论/归档/施工方案，**本批不施工**。0.4.0 发版本轮已验收改动；下列事项排 0.4.1 或之后。

## 1. 翻页模式滚轮翻页（补强，设置可选）

**需求**：分页（双栏）模式下用滚轮翻页，设置页开关，默认关。

**撞车分析（用户已点名）**：阅读区已有两类滚轮接管者——超宽/超高表格滚动框（`.sr-table-scroll`，横纵双导轨）与超长公式横向导轨。滚轮翻页的生效区域必须排除它们；同理还有一切 `overflow` 可滚的块级内容（代码块、长引用框）。

**施工方案**：
- 事件层：阅读器宿主容器捕获 `wheel`（composedPath 检查）；命中 `.sr-table-scroll`、公式导轨、或任何 `scrollWidth/Height > clientWidth/Height` 的元素 → 放行给元素自身，不翻页。
- 翻页动作：`view.goLeft()/goRight()`（foliate 原生翻页 API），垂直滚轮 deltaY 映射左右；触控板平滑滚动需防抖+阈值（防一滑连翻三页）。
- 设置项：设置页「阅读」区加「滚轮翻页」开关（全局，默认关）；翻页动画遵守动效三档（reduced 档瞬时）。
- 验收矩阵：滚动模式不受影响；分页模式滚轮翻页正/反向；大表上滚轮仍滚表格不翻页；长公式上滚横向导轨不翻页；开关切换即时生效免重启。

## 2. 朗读听书（大功能，分期）

**现状**：tts 基建半闲置——`tts-service.ts`（audioPlayerManager + synthesizeSpeechChunked）只服务消息朗读；原版 SageRead 有听书，我们未推进。

**需求**（用户口径）：正文朗读 + 可折叠播放面板（进度条/暂停继续/播放模式）+ **进度跟读联动**（朗读到哪，阅读位置跟到哪）+ 通道上 API 之外探索本地 TTS 一键部署。

**施工分期**：
- **P1 引擎层**：按章取正文文本（复用 readBookSection 的结构化提取，剥公式/表格为口语化旁白或直接跳过公式块——技术书听公式的语义待定，讨论时定）→ 逐句切块（复用句子切分基建）→ 现有 TTS API 逐句合成 + 音频队列播放（audioPlayerManager 扩展为播放列表模式）。
- **P2 播放面板**：阅读区底部可折叠条（动效三档）；进度条（当前句/全章位置，可拖拽跳句）；暂停/继续/上一句/下一句；倍速（0.75–2x）；播放模式（本章停/顺序连播/定时停止）。
- **P3 跟读联动**：句 → 原文位置映射（切块时记录 CFI/锚点）→ 播放时 view.goTo + 高亮当前句；与章节定位体系对接（relocate 链路），注意滚动卡顿纪律（跟读触发频率节流）。
- **P4 本地 TTS 探索**：候选 piper / sherpa-onnx，sidecar 化（与 sageread_markitdown 同基建：PyInstaller 单文件 + Job Object + JSON 行协议）；中文音色质量是主要风险，先出对比样音再定。

**风险**：长书文本切块与位置映射的数据量；跟读联动与滚动性能的冲突；公式/代码块的朗读语义。

## 3. 本地模型服务支持

**用户反馈**：Ollama 本地向量模型报 failed to fetch（未复现）。

**排查先行（施工第一步）**：
- Ollama 端点分歧：`/api/embeddings`（原生）vs `/v1/embeddings`（OpenAI 兼容）——先确认我们向量模型配置走的是哪个路径、自定义 baseUrl 是否允许 http://localhost（tauri http 插件对 http://*:* 已放行，但渲染进程 fetch localhost 有 MixedContent/CSP 坑，走 Rust 侧 reqwest 则无此问题——查 embedding 请求实际走的通道）。
- 加「连接自检」按钮 + 错误翻译（ECONNREFUSED → "Ollama 未启动"类可操作文案）。

**本地 LLM 接入**（Ollama / LM Studio）：
- 两家都是 OpenAI 兼容端点（localhost:11434/v1、localhost:1234/v1）——查 providers/factory.ts 的自定义 OpenAI 兼容端点基建是否已有；有则补预设 + `/v1/models` 自动发现模型列表。
- 定位：辅助模型任务（标题生成/对话压缩）优先接入，聊天主模型亦可。
- 向量模型维持「不提倡但允许」：本地模型维度/质量不一，换模型需全库重建（链路已有）；移动端共享统一向量库的麻烦照旧提示。

## 4. PDF 解析更新（跟 Books_Converter 侧定型联动）

**背景**：Books_Converter 新增 VLM 解析管线，并在探索 MinerU 4.0（"小钢炮"，无 GPU 可跑）→ 本地一键部署文档解析成为可能。

**施工方案**：
- 转换器设置页引擎选项扩展：VLM / MinerU4-local 入选项（等 Books_Converter 侧 CLI 定型）。
- books_converter sidecar 升级通道：版本号 + 兼容性矩阵（老 app 新 sidecar / 新 app 老 sidecar）。
- 附件 Phase C 引擎选择同步扩展：`pickAttachmentOcrEngine` 的"有哪个用哪个、优先 MinerU"加入本地 MinerU4 优先序（本地免费且无需 token → 有本地优先于云端）。
- 一键部署评估：MinerU 4.0 本体的包体/依赖/模型下载体积，sidecar 化还是独立安装器，待调研。

## 发版讨论结论记录

- 0.4.0：本轮已验收改动全部可发（详见下节答复）。
- 本页四项排 0.4.1+，施工顺序建议：1（滚轮翻页，小）→ 3（本地模型，中）→ 4（PDF 引擎适配，等上游）→ 2（听书，大）。
