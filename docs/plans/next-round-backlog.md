# 下一轮待办清单（2026-08-09 补漏审计 + 用户拍板修订版）

G–J 批已全部完工（详见 `docs/archive/agent-next-phase-plan.md`）。本文档收录剩余事项，按施工顺序排列。
用户手册 + repo wiki + 提示词对齐按用户要求放到**最后**；原 P3（外部跟踪）、P4（可选润色）移除。

---

## 🆕 2026-08-17 发布前实测问题三连 —— ✅ 已全部修复并发布（v0.2.1 / v1.3.3 / v1.0.0，2026-08-18）

1. **Books Converter 无目录书结构散架**：无目录页时 `_light_metadata_pass` 的 LLM 会拿标题列表编造假 toc_entries（条目 page=扫描页为伪造指纹），假锚点在 `_calibrate_levels` 以最高优先级锁死层级。修法：两目录页识别器均未命中 → 丢弃 LLM toc_entries 走形状栈无锚点路径；可选增强 = fitz PDF outline 先验。修复+回归由子任务执行。
   - 顺带确认：用户实测书为《Integral Calculus Made Easy》(Deepak Bhardwaj, 2006 重排)，页页带版权水印——**官网书籍对比图必须换公版书**（Gutenberg #33283 Calculus Made Easy PDF 已下载至 `.tmp-calc/`）。
2. **工具返回普遍截断太短**：根因=索引分片 300 token（embedding 上限所迫）+ `readPaperSection` 硬截 6000 且无续读 + `readPaperFull` 硬截 30000 + topK 默认 5。已修（本仓库）：section/full 参数化（maxChars+offset 续读，默认 16000/50000，上限 40000/100000）、paperSearch topK 5→8、ragSearch limit 3→5、context 邻居默认 2→3。tsc 绿。
3. **Zotero Brain 下载 403**：主因=Unpaywall 占位邮箱被 422 静默杀掉（`.env` 的 `UNPAYWALL_EMAIL` 未填），流量压到出版商直链，Wiley/ACS/Elsevier/MDPI 的 Cloudflare/Akamai 对非浏览器一律 403。修法：默认 UA、Unpaywall 422 可见化、oa_locations 优先 repository 副本、S2 429 退避加长。用户侧待办：填真实邮箱、可选配 CORE_API_KEY。

---

## 🆕 2026-08-18 发版与官网上线 —— 主线已闭环，余下全是等备案的外部依赖

**已发布**：Better SageRead v0.2.1（CI 构建 + updater JSON）、Books_Converter v1.3.3（GUI/CLI 双包）、zotero-brain-slim v1.0.0（首个发布）。Papers_Converter / sageread-mcp 为纯源码组件，无 Release 属正常。

**官网**：`site/` 已入库主仓库（EdgeOne Pages 根目录 `site`，push 即自动部署）；`cosBase` 已接腾讯云 COS（`sageread-dl-1444623537` / ap-guangzhou，四包已验证可下载）。下载表版本号经 `dl.js` 实时同步 GitHub Release，发新版无需改站。EdgeOne 默认 `*.edgeone.cool` 仅 3 小时预览链接（401 属正常），正式访问须绑自定义域名。

**COS 自动同步 CI**：`cos-sync.yml`（两仓库同款）监听 Release 发布自动传包；Secrets 用 CAM 子用户密钥（仅 COS 权限）。踩坑记录：① `gh release download` 必须带 `--repo`；② 跨境默认端点会 UserNetworkTooSlow（51 分钟断连），已对桶开启**全球加速**并改走 `cos.accelerate.myqcloud.com`；③ coscmd `-e` 端点**不带桶名**（自动前置，带全域名会双拼）。实测 SagRead/Books 双通道均 2 分钟内同步完成。

**计数函数**：~~`site/edge-functions/api/dl.js`~~ **已放弃（2026-09-17 用户确认：KV Storage 申请制一直批不下来）**。dl.js 代码留档不再跟进。

**备案线**：~~用户推进中~~ **已完成（2026-09-17 用户确认：备案早已搞定）**。

**上线前清理（未做）**：根目录 `.tmp-*`（含 `.tmp-cos-upload/` 四包汇集、`.tmp-site-prototype/` 旧 demo 母带）、Books_Converter 下 `_*.py` 一次性脚本（_release/_watch/_setup_secrets/_enable_accel 等）。`.tmp-cos-upload` 删前确认 COS 桶已有同名文件。

---

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

1. `README.md` 技能表格删"技能市场"表述；`docs/archive/agent-capability-roadmap.md` P2 段自建技能索引仓市场划线删除（注明 2026-08-09 拍板不做，以 ecosystem-plan 为准）。
2. E5 按用户拍板「改文档不改代码」修订：plan 原文改为实现口径 `sandbox="allow-scripts allow-modals"`（`html-preview.tsx`，opaque origin）并附风险评估。
3. `registry.ts` 头注释与 `mcp-registry-service.ts` oci 文案已按现状改写（"MCP 预留后续迭代"、"待批次 D" 两处过时口径清除）。

---

## ① L2 增量同步：保留 BETA，不锁死（2026-08-10 修订拍板）

~~原决定（2026-08-09）：L2 整体禁用、锁死开关。~~ **已撤销**。新口径：
- L2 保留 BETA 静默运行——代码已七七八八，禁用反而让存量双设备用户断功能；"增益且无害"
- **L1 的任何功能不得依赖 L2**（见 ② 的核心原则）；L2 只是让双设备日常更顺畅
- 503/429 退避、存量回填压测、移动端语义：维持"移动端立项时再做"原决策
- 进度"不及时"是空闲调度的有意取舍（阅读中不同步防卡顿，静止 10s 后 25s tick 推/拉），不是 bug，不改

**已完成的小修（2026-08-10，cargo test 37+1 绿）**：
1. ✅ `tables.rs` 补 threads/skills 的 `scope` 列（H2/技能作用域列此前不进 changeset，对端错位）；threads 的消息级合并链路（`ThreadRowData`/`thread_row_from_data`/`fetch_thread_row`/`thread_row_to_json`）同步补 scope，旧包无此字段回落 'book'
2. ✅ changeset 线上格式改 **gzip(JSONL)**（魔数嗅探兼容存量裸包；实测结构化 JSON 压缩 10 倍+）+ **单行 20MB 安全阀**（超限跳过并告警，防工具密集巨线程烧坚果云配额）
3. ✅ `folders` / `paper_folders` / `prompt_presets` 入 L2b：`SyncTable.pk` 语义升级为"主键表达式"（paper_folders 复合键用 `paper_id || ':' || folder_id`）；paper_folders 走 INSERT OR IGNORE；prompt_presets 加 apply 钩子维护同 scope 的 is_active 互斥；`zotero_collections`/`zotero_paper_state` 明确**永不同步**（device-local 链接状态）

**L2 已知语义备忘（不是缺陷，换机场景可接受）**：threads 已是消息级并集合并（锚点归并，2026-07-21 定）；整行全量上云但有 gzip+安全阀；同一对话两端同时编辑按消息并集收敛。

## ② L1 完备备份（"完整搬家"）—— **已落地（2026-09-17 源码实锤确认）**

备份侧（`core/sync/backup.rs`）：小包 = app.db（VACUUM INTO 在线快照）+ 配置目录 JSON 全收 + themes/*.css；资产捆 = 书籍/论文每本一捆（EPUB/paper.md/images/译文/封面）+ 全局向量库（注册 sqlite-vec 后 VACUUM 快照，防 WAL 脏页）+ 字体 + 阅读背景 + Agent 工作区 + 聊天附件；整包内容哈希门控（无变化零流量）→ 索引判存只传缺失捆（零 PROPFIND）→ 轮转 + 孤儿 GC。恢复侧（`restore.rs`）：manifest v3（`bettersageread-backup` 格式校验）+ 按 sha256 逐捆比对、只下载缺失/不同资产、下载后哈希复验 + pending-restore 替换流程。设计案的 v2 已迭代到 v3，纳入清单全数落地，"恢复后向量检索立即可用"成立。

**核心原则（用户 2026-08-10 拍板）**：L1 恢复 = **完整搬家**。用户在 A 设备备份、B 设备恢复，只开 L1 不开 L2，也**什么都不缺**——填好各类 key 之后开箱即用（含向量检索立即可用）。L2 是增益，绝不为 L1 补缺。

### 纳入清单（落盘位置已逐条核实）

**小包（日常备份 zip，几 MB 级）**：
| 项 | 位置 | 说明 |
|---|---|---|
| app.db | `{appData}/database/app.db` | VACUUM INTO 快照（现状），全表保真（threads 含 scope、folders、prompt_presets 等全在） |
| 全部配置 JSON | 配置目录 | 现有 3 个 + **model-provider.json（A 批后无密，排除理由已过时）**、converter-store、mcp-servers、agent-settings、chat-settings、quick-command、web-search、tts、webdav-config（密码已置空）、proxy.json、secret-names.json（只有名称无值）。策略由"白名单"改"**全收减排除清单**"（新增配置文件自动纳入） |
| themes/*.css | 配置目录 | 现状已有 |
| 资产清单 manifest.json | 包内 | 大包 sha256 索引（见下） |

**大包（sha256 内容寻址，一次一传，哈希不变永不重传）**：
| 项 | 位置 | 说明 |
|---|---|---|
| 书籍/论文全部文件 | `{appData}/books/{id}/` 整目录递归 | EPUB、paper.md、images/、translation-zh.json、可选 source.pdf、cover.jpg（封面就在 books/ 内，已核实） |
| 全局向量库 | `{appData}/papers/vectors.sqlite` | books+papers 统一的 chunk/embedding 库（按 paper_id 分片）；远程 embedding 重建要 API 费，**纳入** |
| 字体 | `{appData}/fonts/`（.woff2） | 与 L2a 同路径（已核实） |
| 阅读背景 | `{config}/reader-backgrounds/` | 已核实 |
| Agent 工作区 | `{appData}/agent-workspace/` | 仅默认路径；用户改到外部目录（如 Obsidian 库）的不纳入（不替用户备份第三方目录） |

**钉死排除**：`secrets-fallback.json`（keyring 降级时的**明文**密钥，进包即破功）、`sync-state.json`（L2 设备身份，进包致两端撞 device_id）、`mcp-local.json`（运行时令牌）、`sync-staging/`、`l2-snapshots/`、一切 keyring 内容。

### 流量安全设计（坚果云月 1G 上传配额）

1. **小包哈希门控升级**：现状只对比 db 哈希 → 改为"全部打包内容哈希"（db+全部 JSON+themes+清单），无变化零流量
2. **大包池**：`sageread/backups/assets/{sha256}` 内容寻址，manifest 记录 `{path, sha256, size, kind}`；本地哈希比对，不变不传；大文件永不重复上传
3. **小包路径照旧**：`sageread/backups/{timestamp}.zip`，保留轮转（默认 10 份）
4. **大包 GC**：轮转删除旧小包时，清理不再被任何现存 manifest 引用的 assets（与备份轮转同生命周期；防配额只进不出）

### manifest v2 与恢复流程

- `version: 2`，新增 `assets[]` 清单；恢复端按 version 分流，v1 老备份走原逻辑（向后兼容）
- 恢复：下载小包 → 解 manifest → 恢复前自动本地备份现状（可回滚，现状已有）→ pending-restore 重启替换 db/JSON/themes（现状流程）→ **大包按清单比对本地 sha256，只下载缺失/不同的文件**到目标路径
- 大包恢复策略：**后台异步全量下载 + 进度展示**（"开箱即用"原则，不做懒下载分级）；下载期间书籍/论文点开可插队优先
- 密钥与 {secret:}：keyring 永不上云；用户在 B 端重填同名 key 后，MCP env 的 `{{secret:}}` 引用（含迁移器搬入的 `MCP_*` 名称，secret-names.json 已随包带来名称清单）自然恢复可用

### 实施第 0 步（开工先核实）

1. 枚举配置目录实际 JSON 文件清单，逐一定性（含密/设备相关）后定排除清单终稿
2. 确认书籍 RAG 是否还有独立 `rag-index/` 目录遗存（当前证据：向量统一在 `papers/vectors.sqlite`，`rag-index` 是 backlog 旧口径，若存在一并纳入）
3. `agent-skills/` 是否仍有文件形态技能（技能主体现已入 DB skills 表并入 L2b；有文件则纳入小包）

### 端到端验收清单

备份 → 恢复 → 逐项核对：书籍 EPUB / 论文（paper.md+图+译文）/ 对话（含 central scope）/ 划线标注 / **全库向量检索立即可用** / MCP 配置与 stdio server / 字体背景 / 工作区 / 技能与提示词预设 / 设置全量。坚果云后台确认：大包只传一次、日常小包为 MB 级。

## ③ 更名 Better SageRead（独立维护）—— **已完成（2026-09-17 用户确认）**

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

## ⑤ 体验小点与加固项（2026-08-10 增补）

用户提出的三个小点（后续优化，不阻塞）：

1. ~~**Zotero brain MCP 的 create_collection 走不通**~~ ✅ 已搞定（2026-09-17 用户确认，销账）
2. **全局主题统一巡检**：各组件/同级 icon 的颜色与 hover 响应存在散落不一致（如通知箱提示框未纳入主题色系）；与 ④ 的文案巡检合并为一次全面 UI+文案大扫除
3. **输入框标点自动配对**：引号、单引号、括号等应自动成双并把光标置于中间

技术加固与放行门槛（2026-08-10 讨论拍板）：

4. **恢复侧加固（低优先级）**：`stage_restore` 下载资产捆后不解包校验 manifest 内容哈希，理论上有损包静默风险。本轮已做全量 sha256 比对证明管道字节级无损，此项属防御性加固
5. **自动备份调度同款隐患（低优先级）**：`reader-layout.tsx` 的 WebDAV 自动备份 effect 也是"挂载时读一次配置"（hourly/daily），运行期改 auto_backup 要刷新才生效。L2 调度器已于 2026-08-10 改为每 tick 自检配置（见 ② 节修复记录），此处的自动备份尚未同款改造
6. ~~论文 + L2 资产通道缺口~~ **已解决（2026-08-11，commit 51385e8）**：论文整目录 zip 捆接入文件通道（上传/下载/自动联动/仅云端徽标与点击下载门全部落地，实测逐文件零差异）。另：L2 安全快照并发撞名已修（b3d78ee）、QC 表格断号误报已修（sidecar 9caa665）、自动备份调度运行期自检已修（ec94304）、聊天输入标点配对已做（dd6cede）、表格内公式渲染已修（9605e04）
7. ~~**L1 放行两条前置**~~ **已随 L1 体系一并关闭（2026-09-17 用户复核口径同上：远古事项按完成论）**

---

## ⑥ 远景：论文交叉引用超链接重建（2026-08-17 提出）—— ✅ 已拍板立项（2026-08-19）

**施工计划见 `docs/archive/paper-link-rebuild-plan.md`**：P1 保留 PDF 原生链接
（fitz link annotations + 锚点映射）→ P2 参考文献增强链（结构化解析 +
元数据 + 在库检查 + 获取/落地页兜底，含 zotero-brain no_pdf 结构化返回改造）
→ P3 语义重建（无链接论文保守补链 + 图书脚注 epub:type 语义化弹注）。
机制结论：PDF 跳转信息存于 link annotations（独立于文字层），OCR 解析
全部丢失但可用 PyMuPDF `page.get_links()` 确定性捡回；EPUB 侧
`epub:type=noteref` 语义化后 foliate 弹注白捡。

**问题**（原始记录）：源 PDF 里"见图 3 / 表 2 / [12]"这类交叉引用是可点击跳转的，
解析成 Markdown 后全部丢失。竞品 ScholarRead 在解析后的文本里保留了
这个能力（机制未知）。

**待调研的问题**：
1. MinerU/PaddleOCR 的解析产物里是否保留 PDF 内部链接注解（link annots）
   或交叉引用的坐标信息？PyMuPDF 可直接读源 PDF 的 link annotations
   （`page.get_links()` 含内部跳转目标页/坐标）——关键在把"源 PDF 的链接
   目标"映射到"解析后 Markdown 的位置锚点"。
2. 若链接注解不可得，降级方案：对 `Fig. N` / `Figure N` / `表 N` / `[N]`
   做文本模式识别，与已建好的图表锚点（图表速跳面板的数据）和参考文献
   区块做配对，阅读器侧渲染时转为可点击锚链接。文本方案的风险是误匹配
   （"Figure 8" 出现在图注自身 vs 正文引用）与多义（[12] 是引用还是数学区间）。
3. 参考文献 [N] 的跳转目标：参考文献列表已在解析产物里，锚定相对容易；
   图表 N 的跳转目标已有图表速跳面板的基础设施可复用。

**价值**：精读场景高频（看引用跳图表/文献是读论文的核心动作），
且是"别人有我们没有"的体验差距。与图表速跳面板是互补而非替代
（面板是目录式导航，链接是行文内跳转）。

---

## 本轮已完成（2026-08-09）

- ✅ mindmap 暗色黑字修复（markmap 内置 CSS 写死 `--markmap-text-color:#333`，按主题覆盖）+ 工具栏暗色可见性
- ✅ mindmap zoom/pan 显式声明（滚轮=缩放、拖拽平移本就支持）

---

## 已知问题（待复现排查）

- ~~**更新后快捷方式重复**~~ **✅ 已根治（2026-08-25，v0.2.3 起生效）**：复现现场勘查坐实——
  非双安装，是同一安装的两份图标：`tauri.conf.json` 未设 NSIS `installMode`，
  交互安装走用户级（图标落用户桌面）、静默更新走系统级（图标落公共桌面）所致。
  修复：钉死 `installMode: "perMachine"`（f9ea80e）+ 更新确认框（启动强更同版本根修，
  纯手动口径见下）。存量机器的旧图标手动删一次即可。
- ~~**重转后旧译文错位风险**~~ **✅ 已根治（2026-08-24，v0.2.2 起生效）**：
  版本锚治理落地——`translation-zh.json` 记 sourceHash，重解析后旧译本判 stale 不显示，
  续翻/重翻恢复（dec212c）。
- **更新弹窗策略最终口径（2026-08-25 用户拍板）**：启动不做任何自动检查/下载；
  仅设置页「检查更新」手动触发弹确认框（e25a28c，v0.2.3 起）。

## 下一版候选（2026-08-25 增补）

- ~~**新版本小红点提醒**~~ **✅ 已做（2026-08-25，随 v0.3.0 线）**：启动静默检查
  （update-store `silentCheck`，只置 `availableUpdate` 标志位、绝不弹框/下载）；
  顶栏设置齿轮与设置页「检查更新」按钮挂小红点 + 「有新版本 vX.Y.Z」提示；
  手动检查/更新成功后清旗标。CDP 实盘：silentCheck 正常解析、flag 正确落位。

### 已清挂账小项（2026-08-25，v0.3.0 线）- ✅ **脚注翻译**：`fn:<id>` 独立键入译本（不占块序号，同一幂等 hash 语义）；
  视图重建译文模式整块替换/对照模式译文 div 内联进脚注区；导出对照收 indented 引用续块；
  `restoreFootnoteRefs` 硬保证译文模式 `[^id]` 引用标记不丢（丢失则 GFM 不渲染脚注区，
  译文脚注成死文本——测试钉死）；翻译提示词 rule 2 补脚注引用标记保留。
- ✅ **app 重启级恢复**：`pending_done` 落盘 `{appData}/papers-converter/pending-done.json`
  （done 落槽即写、消费清除即删、状态查询磁盘兜底——产物目录缺失/文件损坏静默清理），
  CDP 实盘 PASS（`scripts/cdp-verify-pending-done-persist.mjs`）。
- ✅ **converter sidecar Job Object 防孤儿**：MCP 的 Job 实现收编至 `core/process_tree.rs`
  （全局共享 KILL_ON_JOB_CLOSE Job），books_converter/papers_converter 两个 sidecar spawn 即挂靠
  （PyInstaller 孙进程默认随父入 Job，app 崩溃整树陪葬）。
- ✅ **metadata.json 读改写并发窗口（原挂账项 6）**：翻译（title_zh/abstract_zh、
  translationRunState）× 向量化版本锚 × Zotero 回链三类写者的「读-改-写」整文件互覆窗口
  收编为一把全局锁——插件新增 `metadata_json.rs` 的 `patch_metadata_json`（锁内读改写合并），
  插件向量锚、app 侧 `inject_zotero_key`、新命令 `patch_paper_metadata_json`（TS 翻译服务
  两处写者经 invoke 走它）全部走同一路径。cargo 52+25 绿、翻译容错单测 8/8 绿。
- ✅ **同步方向复核（原挂账项 7）**：审计完成，结论见 `docs/audits/sync-direction-audit.md`——
  单次 502 全链路 fail-closed（无根因）；钓出 6 个真实风险点（P0 修剪误删未消费包、
  P1 sync-state 非原子写致水位清零+删除复活、P2 拉取尾部水位跳跃、P3 暂时坏包 3 次永弃、
  P4 无 L2 互斥、P5 进度回落键被顶翻）。**修法已列，动 sync 临界区前需用户拍板范围。**

### v0.3.0 主线：P2 统一任务队列 + P3 有界并发 + P4 AI 体验

**施工规格已全部落定（2026-08-25）**：
- `docs/archive/task-queue-p2-plan.md`——五通道统一模型 + 六直跑入口收敛入队 + 图书两通道队列化 +
  卡片点开子任务面板，分 P2-0~P2-5 六阶段，每阶段附不动清单与验证矩阵。
- `docs/archive/task-concurrency-p3-plan.md`——解析有界并发 2（多句柄化 + staging 撞车待核点）、
  向量化单篇内并行 embed + busy_timeout、翻译维持 3 路；依赖 P2 完成。
- `docs/plans/ai-experience-p4-plan.md`——工具描述跳板（文案级先行）→ getBooks/status 发现增强 →
  central 语义检索（选型待定）→ 目录牌观测审计；不依赖 P2/P3 可提前搭车。

前置调研见 `docs/archive/task-system-survey.md`。

---

## 想法池（不排期，记录待议）

### AI 用量统计面板（2026-08-26 用户点子）—— ✅ 已落地并验收（2026-08-28，4d14ddc）

落地口径（用户 08-28 拍板）：**不做价格映射、不做缓存折算**；做总用量/日周月年视图/模型占比。
实现在阅读统计页内：右上角全局时间单位（今日/本周/本月/今年/全部）联动全页卡片与图表；
AI 卡 = 输入/输出 Token + 请求数 + 模型数；堆叠柱状图按模型分色（桶粒度随单位）；
饼图 + 模型明细表；热力图加年份选择器。数据源 ai_usage 流水表（每条 AI 回复一行，
onFinish 采集）——**统计自上线起算，旧对话不可回填**（metadata.totalUsage 已随消息落库，
未来若要回补有原始料）。翻译/向量化侧未接入（计费单位与链路不同，按需再议）。
（原 2026-08-26 点子记录含价格映射方案，已被用户裁定裁掉，留档备查）

## Agent 召回本次对话（readThread 工具）—— ✅ 已落地（2026-08-28，c46d3b7，用户验收「非常顺，比我想象的还要丝滑」）

（原 2026-08-27 立项记录，留档备查）

**场景**：上下文自动截断后，用户让 Agent"整理本次对话存到笔记"——Agent 看不到早期
消息。用户口径：这类任务不需要工具调用返回结果，只要用户提问 + AI 答复（与导出对话
的渲染口径一致：text/quote 保留，tool/reasoning 跳过）。

**现状（已查证，基建 90% 在）**：消息落库不滞后（每条 AI 回复 onFinish 即 editThread，
存储侧已做 tool 结果截断）；`renderMessageMarkdown` 管线现成（只留 text/quote）；
`manage-threads` 工具已有列表/搜索/导出——但导出走文件对话框（Agent 用不了），且无
"读内容"动作，Agent 也无从知道"当前对话"的 threadId。

**方案（约 40 行）**：manage-threads 加 `action: "read"`——不带 threadId 默认取当前
scope 最新一条（即本次对话），返回 buildThreadMarkdown 文本。注意：末条消息流式中
落库滞后一条，返回里注明。

### 图书转换队列化与 UI 重构（2026-08-30 用户提出）—— ✅ 已完成（2026-09-17 用户确认：队列化早已搞定）

现状问题清单（用户实测，重构时逐条核销）：
- 图书转换无队列化、不支持多本排队；队列化思想下应支持：多 PDF 排队、随时加入、
  队列中任意删除、转换完成自动退出队列并自动导入（现在完成不自动导入，要手动点）。
- 转换窗口拖入 PDF 时模糊遮罩盖错了范围：现在主页全页面变灰而转换窗口不灰；
  正确是主页不变、只有转换窗口变灰。
- 转换完成后 PDF 仍挂在任务列表视窗不清除；「更换」按钮语义在队列里很怪，
  应被「删除→新加入队列」替代（用户给了 DOM 选择器证据：按钮显示「更换」而非「×」）。
- 重解析图书缺入口（右键菜单没有「重新解析」）；权衡：重解析需要保存 source.pdf，
  大书几十兆存一份似乎得不偿失——设计时要有取舍结论（存 or 不存 or 用户可选）。

### 图书翻译任务体系跟进（2026-08-30，挂账）

- book-translate 通道未接入右下角任务栏（bottom-right-stack 按通道渲染卡片，新通道无卡）；
  图书翻译没有队列化呈现（通道内并发 1 但 UI 无队列感）。
- AI 工具链未跟进：无「翻译图书/查图书翻译状态」工具（process-paper 只有论文侧）；
  加的时候要带冲突矩阵（翻译×向量化×转换同书互斥——docs/plans/book-translation-plan.md「未来待办」
  节已有 blocking 矩阵设计口径）。

---

## 🆕 2026-09-13 阅读器渲染/位置/Agent 内容保真 —— 本轮挂账

本轮已修并提交（local 分支）：h5/h6 字号下限、foliate HMR 防重守卫、TOC 打瞌睡/误判章末、公式横向导轨、表格单元格防污染。
~~进行中~~ **全部已完工（2026-09-16）**：A 章节定位（5f8669c，用户复验通过）、D 表格滚动框+双导轨（用户复验通过）、E1 工具折叠（1cabad2）、E2 results 计数（同）、E3 describeTool（8959e3d）、E4 rag 报错翻译+门控（e5fc02e）、C+B readBookSection JS 读取层重写 + 公式 LaTeX 化（1de2abd/151c104）、E6 对话自动命名（e400cd2）、E7 历史对话高亮（a785156）。除模型映射表热更新外均已经用户验收。

### 🔴 转换器侧治本（用户明确要求，勿忘）

**Books_Converter 在 latex2mathml 阶段把原始 LaTeX 写进 `<annotation encoding="application/x-tex">`**。
- 动机：当前 EPUB 的 MathML 无原文，阅读器/Agent/RAG 只能拿到扁平公式；写入 annotation 后，任何工具都能零成本取回精确 LaTeX，无需运行时反解。
- 兼容性：`<annotation>` 是 MathML 规范原生元素（MathML Core），不参与渲染，浏览器/Calibre/其他阅读器一律忽略，无副作用；是本问题的标准做法。
- 配套：本仓库侧——向量化管道与文本提取优先读 annotation（有则直接用原文，无则走运行时反解兜底）。
- 范围：只对转换产物生效；存量老书需重新转换才有 annotation（不强制重转）。

### 其他备忘

- 论文侧公式引用同样有扁平化风险：论文阅读器渲染的是 KaTeX DOM，划词引用拿到的是渲染文本而非 markdown 源里的 `$...$`。修法：引用抓取时经 paper-highlight-locator 的 quote→源映射回解 LaTeX（并入本轮 B 项施工）。
- 未向量化书的 rag* 工具报错统一为"本书未建立向量索引"，并评估此类书是否直接不注册 rag* 工具（并入 E4）。

---

## 模型映射表热更新 —— ✅ 已落地（2026-09-16，b56b620，待用户验收）

**动机**：`vision-map.ts` / `reasoning-map.ts` 两张模型映射表随厂商发模频繁更新，但每次都要随软件发版才能触达用户。

**落地口径（与原方案的差异）**：表体迁为 `packages/app/src/ai/providers/maps/*.json` 唯一事实源（构建期打包兜底）；`services/model-maps-service.ts` 启动后异步拉 `https://www.bettersageread.cn/maps/*.json`（tauri http 出网绕 CORS，5s 超时，`_ts` 防 CDN 陈旧，失败静默）；`maps/map-runtime.ts` 三级生效链（打包表 → localStorage 缓存 `visionMapCache`/`reasoningMapCache` → 远程），`updatedAt` 严格更晚才整表替换（不逐行合并，防远程删除的过期行残留）；空表/非法形状显式拒绝。同步查询 API 签名不变。维护流程：改表 = 改 app 内 JSON 递增 updatedAt + 同步 `site/maps/` 推送。**远程生效待站点部署；本地兜底即时可用。**

- **转换器表格漏转残留**：Feeling Great（英文版）chapter_002 有一个表格未被转换成 HTML，以 Markdown 表格纯文本（`|---|` 管道符）留在 `<p>` 里渲染。阅读器无法补救（内容问题），需转换器侧排查该表格的提取路径。

- ~~**库卡片 hover 光效**~~ ✅ 已落地（2026-09-16，77945d7，用户已验收）：`.book-card`/`.paper-entry-card` 主题色柔光，与 .chat-thread-card 同口径（颜色过渡走动效 token，位移+光影仅 full 档）。

- ~~**剪切板图片 Ctrl+V 直发**~~ ✅ 已落地（2026-09-16，606053e，用户已验收）：输入区 onPaste 拦剪贴板图片进附件链路（与上传按钮同一视觉闸门），三面板共用组件一并生效。

### 通用附件上传（回形针扩展，用户 2026-09-16 提出）—— ✅ 方案已拍板（2026-09-17），施工中

**现状**：回形针只收图片（`accept="image/*"`，过视觉模型闸门）；Agent 读本地文件只能靠 readLocalFile 等工具按路径访问（权限允许时）。`tauri.conf.json` 已开 `dragDropEnabled`（原生拖拽直接给真实路径，免 base64 免复制）。

**开箱即用方案调研（2026-09-16）**：

- **MarkItDown（微软，MIT，用户点名方向）**：Python 包 + CLI（`markitdown file -o out.md`），一站式覆盖 PDF/DOCX/PPTX/XLSX/HTML/CSV/EPUB/图片(EXIF+OCR)/音频，输出就是为 LLM 优化的 Markdown（标题/表格/列表结构保留）。已知短板：复杂/扫描版 PDF 成功率低（pdfminer 系，无布局分析）——聊天附件场景多为文本型 PDF，够用；扫描件走下方三通道分流。落地形态 = PyInstaller sidecar（与 books_converter 同基建：Rust spawn + Job Object 防孤儿），一次性调用非常驻；代价是安装包 +几十 MB（**用户已拍板接受**）、冷启动 1–3s。
- **JS 小分队**：mammoth/pdfjs/SheetJS 覆盖不如 MarkItDown 且等于自养迷你转换链——不做，避免重复造轮子。**Pandoc**：不读 PDF/PPTX/XLSX 输入，出局。

**拍板架构（三层 + 扫描件分流）**：
1. 文本类（.md/.txt/.py/.json/.csv/.log 等 ≤32KB）→ 直读注入消息（不过 sidecar，零延迟）【阈值 256KB→32KB：256KB 直注入 ≈6 万+ token 且随每轮请求重复计费，Phase A 实施时收紧】；
2. PDF/Office/EPUB 等 → MarkItDown sidecar 转 .md 后注入（>8000 字符截断 + 转存文件路径供 Agent 续读）；
3. 超大（>50MB）/转换失败/纯二进制 → 路径登记（复制入 `attachments/`，消息里登记路径，Agent 用 readLocalFile/searchFiles 自取）。
**扫描版/复杂版 PDF 分流（2026-09-17 二轮拍板）**：不走多模态栅格化单开路线，**直接复用设置页已有的 PDF 转换引擎——MinerU 优先、PaddleOCR 兜底（用户原话："有哪个用哪个，优先 MinerU"）**。触发时机：MarkItDown 提取为空/乱码（扫描件特征）或用户指定；引擎不可用（未安装/未配置）→ 路径登记 + 明确提示，不静默失败。
阈值：单文件 ≤50MB、单次 ≤10 个；交互：原生拖拽 + 回形针 accept 扩宽，附件区文件 chip 显图标+名称+大小。
**施工分期**：A. app 侧附件基建 ✅（dc8d2bb，E2E 过）；B. MarkItDown sidecar 打包接入 ✅（df210cf，E2E 过：PDF/DOCX 自动转 md 注入）；C. 扫描件分流 ✅（本轮，E2E 过：扫描版 PDF → MarkItDown 空 → MinerU 引擎 16s 解析成功，OCR 全文注入）。**附件上传三期全部完工（2026-09-17）**。
