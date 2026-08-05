# Agent 能力边界拓展：落地路线

> 2026-08-04。基于全库现状调研（证据见各文件行号），衔接 paper-polish-backlog F 批。

## 一、现状判断（比想象中好）

编排层已经是**真 Agent**：AI SDK v5 `streamText` + `toolChoice:auto` + `stopWhen:20` 的 ReAct 循环（`ai/custom-chat-transport.ts:82`），三 scope 动态工具集（`ai/tools/registry.ts:318`），central 已有 26 个动作工具。**框架不缺，缺的是写类工具与 MCP 客户端运行时。**

## 二、既定设计约束（docs/local-roadmap.md §Agent 架构设想）

动作工具只挂全局助手（central）；阅读助手保持只读 + 本书 RAG，防工具过多误触发。本路线不推翻此原则；reader 要加写能力需另行论证。

## 三、分阶段落地

### P0 · 纯前端封装的写工具（零风险，1-2 天）—— ✅ 2026-08-04 已落地

底层 Rust 命令全部现成，走"一个文件 + 四处登记"套路（已沉淀为 docs/agent-tool-recipe.md）：

1. ~~createPaperAnnotation~~ **已否决并移除**（2026-08-04 当日复盘）：给论文创建 AI 标注的工具上线后被判定概念回退——"无划线纯文字笔记"功能此前已被用户清除，AI 版同类物是重蹈覆辙；手动划线是一划的事无须代劳，AI 长篇总结也不适合塞侧边栏。正确去向是 P1 写文件工具（工作区可指向 Obsidian 等外部库）与 P2 MCP 写入外部知识库。**保留的副产品**：C2"重新生成 AI 重点"清空语义已收窄为 `delete_ai_book_notes` 仅删 source='ai' 且 category IS NOT NULL 的重点标注（对话/其他无 category 的 AI 标注与人工标注均保留）；正文 `findQuoteRange` 兜底高亮机制（阅读器既有，未动）。
2. **managePaperFolders**（central）：list/papers/create/rename/delete/move/assign 七动作，与 Zotero 导入的文件夹体系衔接；assign 为整体替换语义（description 已写防空清空）。
3. **ragRange 注册**（reader，死代码盘活）：含存量库提示词迁移（database.rs v2.1 手术插入，已查库验证生效）。
4. **getCitations/getFigures**（paper 基础层，无向量门控）。getFigures 图注三来源（2026-08-04 加强）：alt 文本 → 图片下方正文图注段（Figure/Fig./图/表 编号开头，跳过空行/分版标号/纯图片行，多图版组共享一条）→ 无则 null 并标注 captionFrom；message 附游离图注计数（有编号文本但附近无图，图丢失残注）。

验证：tsc exit 0；biome 改动文件 clean（全库 14 报错均 HEAD 既有）；CDP 冒烟 11/11 PASS（scripts/cdp-test-p0-tools.mjs）。

### P1 · 写文件 + 执行命令（F 批核心，安全模型按下述设计）

**安全模型：三级分档，而不是全量确认或全量放行。**

- **Tier 0 只读**（检索/查询/读取）：静默执行，现状如此。
- **Tier 1 工作区内写入**：新增 `writeFile`/`editFile`/`runPython`，**根目录钉死在 `{appData}/agent-workspace/`**（用户可在设置里改到 Obsidian 库等外部目录）。钉死根目录 = 模型再离谱也写不坏系统与书库；工作区内写入静默放行。"文件即记忆"由此成立（memory.md 落工作区，提示词注入路径）。
- **Tier 2 破坏/越界/外发**：删除、覆盖工作区外路径、网络 POST 类，走**逐次确认**——聊天流内嵌确认卡（工具名 + 目标路径/命令全文 + 允许/拒绝），AI SDK 的 tool-approval 流程在 transport 层拦截实现。会话内可对单条命令选"本次会话不再询问"。

执行命令先做 `runPython`（cwd 钉工作区、超时、输出截断回传），不做自由 shell；真需要时再加并恒归 Tier 2。

### P2 · MCP 客户端运行时（盘活生态 + F 批 Zotero brain 夹带）

- mcp-store 配置模型已在（stdio/sse），registry 注入点是注释占位（registry.ts:359）。
- 落地：AI SDK `experimental_createMCPClient`（或 @modelcontextprotocol/sdk 直连 stdio）→ 聊天启动时按启用配置拉 `listTools` → 转 AI SDK tool 定义，命名空间 `mcp_{server}_{tool}` → 挂进 central（可选 scope 复选）。
- MCP 工具默认全部 Tier 2（外部进程行为不可预知），确认卡显示 server 名。
- 默认夹带：Zotero brain 精简版 MCP（搜库/下载/导入），与刚完成的 Zotero 批量导入形成"批量走原生、零散走 MCP"互补。

### P3 · 上下文与对话工程（长任务硬伤）

- 现状：最后 8 条消息硬截断（`ai/utils/message-selector.ts:3`），无 token 感知。
- **拓宽窗口（2026-08-05 用户拍板）**：截断放宽到 20+ 条且按 token 估算适配模型窗口（现代模型 1M 上下文且便宜，不必拘泥 8 条）；超额时调辅助模型滚动压缩旧消息为摘要（语义上下文已有同款基建 `ai-context-service.ts`，复用）。
- **对话思考强度档位**：聊天区目前无档位控制（软肋）。聊天 transport（`ai/custom-chat-transport.ts` streamText）加 reasoning 档位选择器（关闭/低/中/高），复用 P0 思考控制的两侧基建：`utilityTaskProviderOptions`（AI SDK 原生参数族）+ `thinkingOffPatch` 请求体注入（DeepSeek/GLM/Qwen/Kimi 分档表与 400 重放兜底已就位）。注意流式路径与 generateText 的参数面一致，providerOptions 直接可传。
- **多模态图片输入**：论文/书籍图片经"引用到对话"发给 Agent 识图解析。要点：消息 schema 扩展（AI SDK v5 的 parts/attachments，图片走 data URL 或 base64）、输入区附件 UI、模型多模态能力检测与提示（deepseek-v4-flash 非视觉模型时给引导）。图片点开预览（复制/保存）已在论文阅读器先行落地（2026-08-05），"发送到对话"按钮待本项落地时接到预览层。
- reader 未向量化时无正文通道：用 metadata.md 的目录偏移量直读小节原文兜底（不依赖向量）。

### P4 · 远期（已有 backlog，不展开）

全局批处理（全部向量化/翻译/归类）、定时/触发式 Agent、子 Agent 分工、对 docs/代码库建 RAG 的"最了解自己"助手。

## 四、工程纪律（来自工具生态的实践经验）

- **工具在精不在多**：description 写清"什么时候用、什么时候别用"，比堆工具数量更能提成功率；每加一个工具，先在真实对话里试 5 个场景再留。
- **工具输出即模型的眼睛**：返回结构化摘要（成功/影响对象/可继续的线索），不要只回 "ok"。
- **确认卡只挡真正不可逆的**：处处确认 = 用户点麻 = 等于没有安全。
- 建议沉淀一份 `docs/agent-tool-recipe.md`：把"一个文件 + 四处登记"写成 checklist，以后加工具照着抄。

## 五、建议排产

P0（本周）→ P1 安全模型 + 写文件/runPython（下周）→ P2 MCP（随后）。P3 可插入任何间隙。
