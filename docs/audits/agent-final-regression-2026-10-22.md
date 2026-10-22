# Agent 大更新 · 最终回归报告（2026-10-22）

> 范围：P0 → P1 → P2 全部工程项 · 默认文档工具模式 = new · 旧工具可在设置回退 legacy
> 环境：dev 实例（Tauri v2 + Vite 1420 + CDP 9223）· 模型 deepseek-flash · temperature 0

## 1. 结论

- 10 题 × 3 次：**内容 30/30、干净通过 30/30**（无外部搜索/命令行/readLocalFile 绕路）；
- 能力探针：**3/3 通过**（多图对比 / 深度考证 / 三文档对比）；
- L1 工具断言：**41/41 通过**；合成图视觉探针：单图 PASS、双图 PASS；
- 默认 new 模式下 10 题冒烟（1 次）10/10 通过；
- 旧工具 alias 保留，设置页可一键切回 legacy；默认迁移 v2 会把旧 both 迁到 new。

## 2. 最终 10 题 ×3（默认 new）

| 题目 | 通过 | 平均 token | 平均步数 | 平均耗时 |
|---|---|---|---|---|
| book-locate-ch3 | 3/3 | 29,390 | 3.33 | 7.7s |
| paper-figure-3-rational | 3/3 | 37,249 | 5.33 | 10.3s |
| paper-figure-2-prussian | 3/3 | 29,083 | 4.67 | 10.3s |
| position-summary-ch2 | 3/3 | 28,240 | 3.33 | 7.9s |
| cross-doc-interface-design | 3/3 | 109,989 | 15.0 | 29.7s |
| methods-dataset-scale | 3/3 | 110,125 | 11.33 | 21.1s |
| citation-ref-12 | 3/3 | 16,703 | 2.0 | 5.8s |
| unindexed-book-meaning | 3/3 | 82,517 | 7.33 | 17.1s |
| refusal-quantum | 3/3 | 19,496 | 3.0 | 8.0s |
| position-where-ch2 | 3/3 | 16,779 | 2.0 | 6.6s |
| **总体** | **30/30** | **47,957**（中位 32,097） | **5.73** | **12.4s** |

## 3. 与 G1 基线对比

| 指标 | G1（旧工具集） | 最终（new） |
|---|---|---|
| 内容通过 | 29/30 | **30/30** |
| 干净通过 | 27/30 | **30/30** |
| 平均 token | 40,533 | 47,957 |
| 中位 token | 25,041 | 32,097 |
| 平均步数 | 5.10 | 5.73 |
| 平均耗时 | 10.4s | 12.4s |
| 跨文献 | 176,790 / 15 步 / 1/3 空答案 | 109,989 / 15 步 / 3/3 通过 |

解读：均值 token 上升主要来自「图片真正被看见」（figure 题需要 vision token）和未索引回退（82.5k）；跨文献 token 比 G1 降 38%，但步数仍 15，未达到早期设想的 ≤10 步——这是残留项。

## 4. 门槛

| 门槛 | 结果 |
|---|---|
| 内容 ≥28/30 | ✅ 30/30 |
| 干净通过 ≥29/30 | ✅ 30/30 |
| 跨文献 ≤80k/≤10 步 | ❌ 110k / 15 步（v2 分桶口径下 vs legacy 更省：122k→110k 级） |
| describeTool = 0 | ❌ 38（但均来自目录牌模式的自描述，用户不可见；new 模式仍触发目录牌：18 工具/10.6k 字符?） |
| 平均工具调用 ≤4 | ❌ 5.7（跨文献/方法题拉高） |
| 中位 token ≤25k | ❌ 32.1k |
| 平均耗时 ≤12s | ❌ 12.4s（略超） |

说明：部分旧门槛是在「未真正看图/未做跨库」时定的，最终指标应按分桶口径（agent-ab-bucket-2026-10-22.md）与 G1 对比看；上表保留原始门槛数字，不粉饰。

## 5. 能力探针（默认 new）

| 探针 | 结果 | 步数/耗时 | token |
|---|---|---|---|
| probe-multi-figure | ✅ facts 5/6 | 8 / 22.0s | 71,148 |
| probe-deep-research | ✅ facts 6/6 | 5 / 13.8s | 26,484 |
| probe-cross-doc-3 | ✅ facts 5/5 | 21 / 44.7s | 256,887 |

## 6. 验证脚本与数据

- L1：`scripts/cdp-verify-p1-document-tools.mjs` — 41/41；
- 单图视觉探针：`scripts/cdp-verify-vision-probe.mjs` — PASS；
- 双图探针：`scripts/cdp-verify-two-images.mjs` — PASS；
- 10 题数据：`.tmp-eval-runs/final-10x3/`；探针：`.tmp-eval-runs/final-probes/`；
- 分桶 A/B：`docs/audits/agent-ab-bucket-2026-10-22.md`；能力探针首跑：`docs/audits/agent-p1-4-probes-2026-10-22.md`。

## 7. 残留与建议

1. **跨文献/方法/未索引题 token 与步数高**：题目本身要求多文档多窗口，当前 guidance 已限制「读了就答」但模型仍会扩大读取；下一步可做「分桶按题预算」或检索前置（先 searchLibrary 再读 1-2 窗）。
2. **new 模式仍强制轻量目录牌**（P1-4 为省每步 schema 做的优化）：describeTool 38 由此而来，属于预期成本；是否改回全量注入 18 工具 schema（约 10.6k 字符）需要再做一次 A/B，别拍脑袋。
3. **未索引文档**：正确率优先，token 不设门槛；继续用「建议向量化」提示。
4. 发版前建议：确认 Release Notes 用户可见文案，按既有流程 tag/push/Draft/发布。
