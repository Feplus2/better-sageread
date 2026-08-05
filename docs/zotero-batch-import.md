# Zotero 批量导入：Collection 继承与三方合并

> 2026-08-04 建立。从本地 Zotero 库批量导入文献（元数据 + PDF + Collection 分类），核心原则是**导入即继承，不做同步**：文献入库后 SageRead 是分类的唯一事实来源。

## 一、架构

```
papers 页「Zotero 导入」按钮
  → zotero-import-dialog（数据目录 → 扫描 → Collection 树勾选 → 批量执行 → 报告）
  → Rust zotero_scan_library（拷贝 zotero.sqlite+ journal 到临时目录只读打开）
  → 服务层 zotero-import-service.ts：
      去重链（zotero_key→DOI→标题精确→标题相似+首作者→哈希兜底）
      文件夹准备（映射表 → createFolder / 改名同步）
      已存在条目三方合并（planFilingMerge）
      新条目逐篇 startPaperPdfImport（复用 Papers_Converter sidecar 串行队列）
  → 每篇：inject_zotero_key（frontmatter+metadata.json）→ scan_papers_dir → save_paper → setPaperFolders → zotero_upsert_paper_state
```

## 二、数据表（database.rs 迁移）

- `zotero_collections(collection_key PK, folder_id, name, parent_key, updated_at)`：Collection→文件夹映射。按 key 走，本地改名不影响映射；name 是"上次导入时的 Zotero 名"快照，用于改名三方判断。
- `zotero_paper_state(paper_id PK, zotero_key UNIQUE, collection_keys JSON, updated_at)`：上次导入时该文献的 Zotero 归属快照（三方合并的 base）。

## 三、去重链

| 序 | 依据 | 命中处理 |
|---|---|---|
| 1 | `zotero_paper_state.zotero_key` | 老 Zotero 文献：跳过 + 三方合并 |
| 2 | metadata.json `zotero_key` | 收养：回写状态 |
| 3 | DOI 归一化（去前缀、小写） | 收养 + 报告"DOI" |
| 4 | 标题归一化精确相等 | 收养 + 报告"标题" |
| 5 | 标题 bigram Dice ≥0.9 且首作者姓一致 | 收养 + 报告"疑似重复" |
| 6 | `save_paper` sha256 "已存在" | 最终安全网，按收养处理 |

收养 = `inject_zotero_key` 回写 frontmatter+metadata.json 并补建状态（base=∅，经三方合并规则自然获得归档：本地未在 Zotero 管辖文件夹内 → 视为未动过 → 挂载）。

## 四、Collection 三方合并

K=映射表 ∪ 本次勾选；Z_old=快照∩K；Z_new=当前 Zotero 归属∩K；M=key→folderId；L=本地归属；L_rel=L∩M(K)。

| Zotero 侧 | 本地（L_rel vs M(Z_old)） | 动作 |
|---|---|---|
| Z_new==Z_old | 任意 | 不动 |
| 变了 | 相等（本地没动过） | apply：`(L − M(K)) ∪ M(Z_new)`，快照推进 |
| 变了 | 不等（两边都动过） | **本地赢**不动，进报告；快照仍推进到 Z_new（报告一次不纠缠） |

文件夹规则：新勾选无映射→建文件夹（父先子后，父未勾选挂根级）；Zotero 改名→本地名==快照名才跟随改名，否则保留本地名，两路都更新快照；本地回收站中的映射文件夹→不复活不重建，跳过挂载并报告；Zotero 侧删 collection→本地绝不动。

## 五、数据源（Zotero 7 本地库，schema 已实测）

- 拷贝 `zotero.sqlite`(+-journal/-wal/-shm) 到临时目录再 `mode=ro` 打开，规避运行中锁。
- collections/collectionItems/items(+itemTypes)/itemData(+fields,itemDataValues)/itemCreators(+creators, fieldMode=1 整名在 lastName)/itemAttachments/deletedItems；libraries.type='user' 过滤本机库。
- PDF 解析：linkMode 0/1 → `storage/{附件key}/{path 去 "storage:" 前缀}`；linkMode 2 → path 原样；`Path::exists` 校验，无有效 PDF 的条目进报告"无 PDF"区。
- 勾选边界：条目同时在已勾/未勾 collection → 只挂已勾；全部未勾 → 不导入；「未分类」伪节点覆盖无归属条目。

## 六、验证

- `cargo check`（src-tauri）：通过，无 error（仅既有 jan-utils/llamacpp 警告）
- `pnpm --filter app exec tsc --noEmit`：通过；`biome check` 变更文件：clean（papers/index.tsx 一处 useExhaustiveDependencies 告警为 HEAD 既有，未动）
- CDP 冒烟（scripts/cdp-test-zotero-import.mjs，fixture 由 scripts/make-zotero-fixture.py 生成）：**25/25 PASS**——扫描 13 项（嵌套/DOI/year/首作者/hasPdf/多归属/未分类）+ 勾选边界 4 项 + 去重链 4 分支 + 三方合并 4 分支
- 真实库只读扫描（本机 %USERPROFILE%\Zotero）：6 collections（嵌套正确）、152 条目、125 篇 PDF 路径可解析、25 篇未分类（与直接 SQL 核对一致）、含中文文件名的 PDF 路径解析正确
- **真实端到端验收（2026-08-05，用户实测，§七清单全部通过）**：首导 78 篇正常（含文件夹创建与挂载）；重复导入全部跳过；三方合并三分支（noop/apply/冲突保留本地）行为正确；移动、改名跟随、中途取消全部正常
- 报告弹窗溢出修复（2026-08-05）：Radix ScrollArea 的 display:table 视口 + 嵌套滚动导致长列表横向撑破/纵向堆叠 → 改单层原生 overflow-y-auto 容器；真实场景（87 篇选择、85 跳过 + 2 无 PDF 报告）复测无横向溢出、内部滚动正常

## 八、源 PDF 留存与重解析（2026-08-05）

- **留存策略**：Zotero 导入不拷 PDF，frontmatter/metadata.json 记录 `zotero_pdf_path` 回链（用户偏好轻便；Zotero storage 是规范出处）；拖入/单篇导入则由 `save_paper` 把 `source.pdf` 拷入 `books/{id}` 自包含（原路径可能失效）。`inject_zotero_key` 支持可选 `zoteroPdfPath`（YAML 单引号防反斜杠转义）；**早期未记录回链的 Zotero 论文在下次 Zotero 导入时经 merge 循环幂等补齐**。
- **重解析**：`replace_paper_content(paperId, sourceDir, metadata)` 整体替换 paper.md/images/metadata.json 而**保留论文 id**（文件夹/对话/标注存活；文内高亮随正文变化可能漂移，text 兜底重锚定）。前端 `services/paper-reparse-service.ts`：PDF 来源按 `zotero_pdf_path` → `books/{id}/source.pdf` 顺序解析，都没有则计失败继续；Zotero 论文重解析后先回写 zotero_key/zotero_pdf_path 再替换。入口：文献库批量操作条「重新解析」（paper-reparse-service reparsePapers）与行级快捷按钮。**注意**：存在性检查必须走 Rust `path_exists`——前端 plugin-fs 有作用域限制看不到库外路径（2026-08-05 实踩）。

## 九、解析质量守卫与辅助任务提速（2026-08-05）

- **退化循环检测**（`utils/degenerate.ts`）：签名周期法（字母→a/数字→0 后找短周期连续重复，阈值：单行、周期 ≤50、≥10 次、跨度 ≥300），实测命中 nm 逃逸（周期 9×91）与 fire 重复（周期 5×200），正常论文与宽表零误报。接入三链路：Zotero 批量报告「解析质量疑似异常」分区、单篇/多篇 PDF 导入 toast 警告、重解析收尾计数。命中不阻断入库，建议换引擎重新解析。
- **轻量任务思考强度控制**：双通道——①AI SDK 原生 `utilityTaskProviderOptions`（openai o系/gpt-5→reasoningEffort low；gemini-2.5+→thinkingBudget 0；openrouter→reasoning low 自动忽略不支持者；grok-3-mini→low）；②请求体注入 `createUtilityModelInstance`（DeepSeek V4 默认开思考→`thinking:{type:"disabled"}`；GLM bigmodel→同参；Qwen dashscope→`enable_thinking:false`；Kimi 按模型分档：K3→`reasoning_effort:low`、K2.x→thinking disabled、思考专用型号不下发）。端点 400 报思考参数错误时自动去补丁重放一次（防未来端点变更击穿）。翻译（术语表/正文批/元数据）、AI 标题、AI 分类 5 处 generateText 全部接入；**对话区不受影响**（仅轻量任务走专用实例）。实测：CDP 直验档位表全对。
- **翻译并发**：正文批循环改 3 路并发（块索引互不相交、快照落盘幂等），墙钟约降 3 倍。

## 七、端到端验收清单（✅ 2026-08-05 用户实测全部通过，留作回归清单）

前置：转换引擎 Token 恢复可用（设置 → PDF 转换）；dev 实例以 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 pnpm dev` 启动。

1. **首导**：Zotero 导入 → 选一个小 Collection（如「自动化实验室」4 篇）→ 开始导入。核对：文件夹自动创建、篇目挂载正确、报告"新导入"数正确、paper.md frontmatter 含 `zotero_key`、阅读页可正常打开。
2. **重复导入**：同样选择再跑一次 → 全部"跳过重复（Zotero 记录）"，书库无重复条目。
3. **三方合并三分支**：
   - noop：本地把某篇移到自建文件夹，Zotero 侧不动 → 再导 → 该篇归属不变、报告无合并记录；
   - apply：在 Zotero 里把一篇（本地没动过的）挪进另一个已映射 Collection → 再导 → 该篇自动跟随移动，报告"归属合并 +1"；
   - conflict：挑一篇本地移动过 **且** Zotero 侧也挪过的 → 再导 → 报告"分类冲突保留本地"，本地归属不变；第三次再导 → 不再重复报告该冲突（快照已推进）。
4. **元数据判重收养**：先用「导入 PDF」单篇导入一篇 Zotero 里已有的 PDF（不走 Zotero 通道）→ 再跑 Zotero 导入 → 该篇被 DOI/标题判重跳过并收养（frontmatter 补写 zotero_key、报告标注判重方式）。
5. **改名跟随**：Zotero 侧改 Collection 名 → 再导 → 本地文件夹跟随改名；本地手动改过的文件夹 → 再导 → 本地名保留。
6. **取消**：大批量导入中途点取消 → 当前篇终止、队列停止、报告标"已取消"，已入库篇目完好。
7. **多篇 PDF 批量拖入**（同日落地的另一改动）：弹窗点选多文件 + 页面直接拖入多个 PDF → 队列逐篇转换、收尾卡汇总"完成 N（跳过 M · 失败 K）"、单篇失败不中断。

跑完把每步实际结果补到 §六，异常单独立项。
