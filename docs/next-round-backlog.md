# 下一轮待办清单（2026-08-09 补漏审计 + 用户拍板修订版）

G–J 批已全部完工（详见 `agent-next-phase-plan.md`）。本文档收录剩余事项，按施工顺序排列。
用户手册 + repo wiki + 提示词对齐按用户要求放到**最后**；原 P3（外部跟踪）、P4（可选润色）移除。

---

## ⓪ 复审必修缺陷（2026-08-09 代码复审发现）—— ✅ 2026-08-09 当日全部修复

复审基准：cargo test 35+1 绿、tsc 绿、E1 fixture 16/16 绿；均为静态审查+实测确认的确定性问题。
修复后复验：cargo test 35+1 绿、cargo check 干净（仅插件既有警告）、tsc 绿、biome 19 个改动文件全绿。

### 🔴 必修（5 项）—— 全部已修

1. **WebDAV 密码两处回写泄露（A 批成果被对冲）** ✅：`sync_update_prefs` 与 `migrate_cloud_layout_inner` 写盘前强制 `config.password = String::new()`（对齐 `sync_save_config` 口径）；全模块写盘点已复查（共 3 处，第三处本就正确）。
2. **迁移器部分失败丢 key 且不可重入** ✅：`take_str_field` → `migrate_str_field`，仅 set 成功后才置空字段；文件级迁移标记改为零失败才落盖（有失败项则不盖标记，下次启动重试）。
3. **MCP env 迁移成孤儿数据** ✅：改为只迁疑似密钥值（键名含 KEY/TOKEN/SECRET/PASSWORD/AUTH/CREDENTIAL/PRIVATE）入 `user:` 保管箱（命名 `MCP_{serverId}_{envKey}`，登记进保管箱名称表、设置页可见可管理），JSON 改写为 `{{secret:...}}` 引用（stdio 启动时 resolve_secret_refs 注入）；非敏感值（如 `ZOTERO_LOCAL=true`）原样保留；旧版已产生的孤儿（env 已空、keyring 躺 `mcp:` 条目）每次启动自动回收——搬入保管箱并补写引用。该段天然幂等，不走迁移标记。
4. **stdio 首启确认卡与 10s 连接超时竞态** ✅：确认卡移出超时窗（先 confirm 再计时 connect）；`withTimeout` 增加迟到成功兜底——超时后连接才成功立即 `close()`，防客户端/子进程泄漏。
5. **token 估算器"先全量序列化再截断"** ✅：改结构探针估算（字符串叶子 CJK 感知截断采样，对象/数组 for-in 计数 + 采样外推，节点预算 200 / 深度 4），全程不再 `JSON.stringify`。

### 🟡 建议修 —— 全部已修

- **秘钥**：`agent_search_files` glob/grep 双模式补齐 denylist 过滤（与 read_file/list_dir 同口径），grep 命中行进模型上下文前先过 A5 同款模式脱敏；MCP stderr 进 `log::debug!` 前脱敏；keyring Linux fallback 打通（set/get/delete 三处后端失败均兜底降级文件并告警）。
- **MCP**：SSE legacy `send()` 失败必抛错（不再静默吞错致工具调用永久挂起）；C2 密钥引导补兑现（skill 导入成功后扫描 `{{secret:NAME}}` 占位，缺失名称 toast 引导至「设置 → 密钥保管箱」）；importPaper 进度事件加 `pdf_path` 归属过滤 + listen 先于 invoke 注册；市场安装映射补全 packageArguments/named 参数展开（named 展开为 `--name value`），oci 条目安装按钮置灰，"待批次 D" 过时文案修正。
- **G–J 批**：H2 续接查询按 scope 过滤（central：`scope='global'` 不限 book_id，钉书线程覆盖；book：`book_id + scope='book'`；双向不再串）；视口填充死代码移除（IntersectionObserver 哨兵本就覆盖短消息续加场景）；I2 补 /embed 与 auth-fail 审计（`agent-audit/local-api.jsonl`，脱敏 + 预览 80 字符截断）+ mcp-local.json Unix 0600；H1 落库竞态族三修（persistMessagesNow 尾沿合并队列——在飞请求不再丢弃；finish 落库归一同一队列保序；abort 打标按调度时刻快照执行，200ms 窗口内切换对话不误标不覆盖）；G1 补「全量重新向量化」入口（向量模型状态卡右侧，复用幂等重建路径，含确认与进度）；G3 维度变化告警改琥珀色；K2 重复引用先判重再分配标记号（不再产生孤儿 `⟦引用N⟧`）。
- **性能/体验**：PDF 标签页永不休眠（原生 iframe 无位置恢复通道）；foliate 设置写回改读 `useAppSettingsStore.getState()`（陈旧闭包消除）；useAutoPreview 排除 markdown 代码块（手动预览不变）；休眠唤醒路径 syncPullNow 静默（一次性标记消费；正常开书 toast 保留；1.5s 远端进度等待保留）。

**修复期记录的既有边界（非本次引入，暂不处理）**：`PaperConverterState` 单 child 句柄（并发两次论文转换会互相覆盖取消句柄，进程与事件本身可区分）；`isOciEntry` 只看 `packages[0]`（与安装映射同取舍）；registry named 参数的 value 模板变量（`{api_key}` 类）按原样预填不替换；G1 全量重建范围为全部可向量化条目（含从未索引的，是"换模型重建"场景的严格超集）。

### 文档口径 —— 已全部修订

1. `README.md` 技能表格删"技能市场"表述；`agent-capability-roadmap.md` P2 段自建技能索引仓市场划线删除（注明 2026-08-09 拍板不做，以 ecosystem-plan 为准）。
2. E5 按用户拍板「改文档不改代码」修订：plan 原文改为实现口径 `sandbox="allow-scripts allow-modals"`（`html-preview.tsx`，opaque origin）并附风险评估。
3. `registry.ts` 头注释与 `mcp-registry-service.ts` oci 文案已按现状改写（"MCP 预留后续迭代"、"待批次 D" 两处过时口径清除）。

---

## ① L2 增量同步整体禁用（保留代码，锁死开关）

用户拍板（2026-08-09）：L2 基本测通但细节不完善（阅读进度等），属移动端配套能力，现阶段用不上。

- 设置页「增量同步」开关：**强制关闭 + 禁用（用户无法打开）**，附简短声明："增量同步将在移动端版本发布后开放"
- 具体位置：`components/settings/sync.tsx`（`l2_enabled` Switch，约 L566）
- 防御性兜底：同步调度器/engine 入口对 `l2_enabled` 做运行期短路（即使配置被手动改为 true 也不跑），防残留定时任务
- L2 资产通道（字体/背景同步）随 L2 一并停用 → **字体/背景改由 L1 备份覆盖**（见 ②）
- 代码不删除，移动端启动时可原样复活

## ② L1 全量备份覆盖扩容（含流量安全设计，坚果云月 1G 上传配额约束）

**现状**（`backup.rs`）：`app.db` + `app-settings.json` + `layout-store.json` + `llama-store.json` + `themes/*.css`。
⚠️ 审计新发现：**书籍 EPUB 文件与论文文件（books/ 目录）当前也完全不在备份里**（原来只靠 L2 文件通道，L2 禁用后即零保护），一并纳入。

**纳入项（数据布局已逐条核实）**：

| 项 | 落盘位置 | 说明 |
|---|---|---|
| 书籍 EPUB 文件 | `{appData}/books/{bookId}/` | 原 L2 通道职责，L2 停用后由 L1 接管 |
| 论文全部产物 | `{appData}/books/{paperId}/`（与书同目录体系） | paper.md、images/、可选 source.pdf、**翻译 translation-zh.json**；**划线/标注在 app.db 笔记表**；句级对齐结果随翻译/对齐产物落盘同目录，整目录递归备份不遗漏 |
| 论文向量库 | `{appData}/papers/vectors.sqlite` | 可重建但重建费 embedding API 调用，纳入（哈希不变不重传，零边际流量） |
| `agent-workspace/` | `{appData}/agent-workspace/` | Agent 产出文件 |
| `agent-skills/` | 配置目录 | 自定义技能文件 |
| 字体 + 背景图 | 配置目录 fonts/ + 背景目录 | 用户拍板纳入（L2 停用后唯一通道） |
| 七个 store 配置 JSON | 配置目录 | mcp/agent-settings/chat-settings/quick-command/web-search/tts/converter；批次 A 后密钥全在 keyring，落盘文件天然无密，直接打包 |

**明确排除**：
- `rag-index/`（书籍向量索引）：embedding 向量+分块元数据，"批量向量化"可一键重建——它是**派生数据**不是原始数据，备份只保原始数据
- 密钥：永不上云（用户已确认）

**流量安全设计（用户核心关切：坚果云月 1G 上传配额）**：
1. **哈希对比强制跳过**：修正无变化检测——由"只对比 db 哈希"改为"全部打包内容哈希"，无变化零流量
2. **大包/小包分离**：大而稳定的文件（EPUB、论文 md+images、字体、背景）按 sha256 内容寻址**单独上传一次**（复用 L2 files 通道的成熟实现思路）；日常备份 zip 只含 db + 配置 + 资产清单（几 MB 级）——变更时只重传小包，大文件永不重复上传
3. 恢复流程：解包 zip → 按清单懒下载缺失资产

**其余实施要点**：manifest.version 升级 + restore.rs 对应恢复 + 端到端测试（备份→恢复→逐项核对：书/论文/翻译/划线/技能/工作区/字体背景）。

## ③ 更名 Better SageRead（独立维护）——已讨论定调，未动手

用户拍板（2026-08-09）：更名 Better SageRead，默认路径/软件名与原软件撇清（纯技术原因，防用户混淆，非成果窃取）；致谢大大方方写明作者与链接。**现有数据均为开发测试数据，无需迁移机制，发布前干干净净换标识即可**。

原仓库：`https://github.com/xincmm/sageread`（作者 xincmm，742+ Star，React+Tauri 框架奠定者）。

**实施清单**：
- `tauri.conf.json` identifier 改为新值（如 `com.bettersageread.app`）→ appData/appConfig 目录自然隔离，无需迁移代码（用户确认数据可弃）
- productName 改 Better SageRead、窗口标题、安装包/产物名、release workflow 产物名、README/仓库描述
- keyring 服务名随 identifier 变化 → 首次运行提示重新输入密钥（与"密钥不上云"口径一致）
- 云端目录布局（sageread/backups）改名与否实施时定（改名则旧备份不可达，用户数据可弃故无碍，倾向上改干净）
- **致谢写死三处**：关于页显著位置、README、NOTICE 文件；措辞："基于 xincmm 的开源项目 SageRead（github.com/xincmm/sageread）发展而来，原作者奠定了核心框架"
- 不改：应用内提示词与内部小文案

## ④ 最后：用户手册 + repo wiki + 提示词对齐（用户指定收尾项）

1. 撰写用户手册：各页面功能、Agent 三档权限模式、备份恢复、同步规划、MCP、技能、快捷指令、快捷键
2. 全局助手知识注入：repo wiki + 用户手册 → 候选方案：① RAG 索引检索；② 精简版注入 central 提示词；③ 组合（提示词放导航、RAG 放全文）
3. 提示词对齐巡检：`constants/{prompt,central-prompt,paper-prompt}.ts` + DB 基词 vs B–J 批能力（安全模式语义、新工具指引、⟦引用N⟧/⟦图片N⟧ 标记说明、滚动摘要呼应）

---

## 本轮已完成（2026-08-09）

- ✅ mindmap 暗色黑字修复（markmap 内置 CSS 写死 `--markmap-text-color:#333`，按主题覆盖）+ 工具栏暗色可见性
- ✅ mindmap zoom/pan 显式声明（滚轮=缩放、拖拽平移本就支持）
