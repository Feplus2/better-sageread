# 模型表维护工作流（vision-map / reasoning-map）

> 新型号发布时的标准动作清单。两张表 = 视觉能力表（能不能吃图）与思考档位表
> （思考开关/档位怎么下发）。2026-09-23 随 Opus 5.5 / GPT-6 Sol·Luna / Grok 4.7
> 批次沉淀；首日实操为 2026-09-22 MiMo-V2.6 入表。

## 1. 生效机制与副本拓扑

```
厂商发模
  → site/maps/*.json          远程热更新源（EdgeOne Pages，push main 自动部署）
  → packages/app/src/ai/providers/maps/*.json   打包兜底（随发布版出去）
  → Books_Converter gui/src/lib/vision-map.ts   移植副本（带逐行核实注释，仅视觉表）
```

- 客户端三级生效链：打包表 → localStorage 缓存 → 远程表，`updatedAt` **严格更晚**
  才整表替换（`maps/map-runtime.ts`）。远程拉取在启动后异步进行，失败静默回退
  （`services/model-maps-service.ts`）。
- **是同一张表，但有三处物理副本**。SageRead 两处必须逐字节一致（改完用
  `cp site/maps/*.xson → packages/.../maps/` 同步，不要手改两遍）；Books_Converter
  是带注释的移植，键值必须与 SageRead 视觉表一致。
- 一致性巡检：`node scripts/maps-sync-check.mjs`（三处副本比对 + 形状校验，
  漂移退出码 1）。改表后必跑。

## 2. 改表标准流程

1. **核实**：逐型号查官方文档——输入模态（图像？）与思考参数（开关/档位/传输格式）。
   每行都要有出处；二手校验源可用 OpenRouter 目录 API
   （`curl https://openrouter.ai/api/v1/models` 的 `architecture.input_modalities`）。
   核实不到的档位不要猜：视觉表未收录默认放行（放行恰好正确的代价不对称）；
   思考表未收录 = auto 不下发（防 400）。官方站点当日不可达时，在提交信息里记
   来源与日期，留复核挂账。
2. **加行 + 递增 `updatedAt`**（site/maps 两份 JSON）。**同一天内第二次更新必须
   带时间**（如 `2026-09-22T16:00:00+08:00`），否则与当天早些时候的字典同戳，
   已拉过的客户端不会采纳（严格更晚规则）。
3. **同步打包副本**：`cp site/maps/*.json packages/app/src/ai/providers/maps/`。
4. **同步 Books_Converter 移植**：`F:\MyProjects\Books_Converter\gui\src\lib\vision-map.ts`
   按它的分节与注释惯例加行（注释写明核实日期与出处），并更新头注日期。
   BC 的思考映射（`vlm_client.py`）是端点级启发式且只覆盖 deepseek/GLM/ dashscope/
   豆包四家端点——SageRead 侧新型号若属于这四家端点才需要同步，否则不动。
   BC 仓库规则：改完跑 `gui` 的 `tsc --noEmit` + `vitest run`；**不在该仓库 commit**。
5. **补冒烟断言**：`scripts/cdp-test-vision-map.mjs` / `cdp-test-reasoning-map.mjs`
   各加新批次的放行/拦截与档位断言（含"无行型号 UI 不出档位"的反向断言）。
6. **静态检查**：`pnpm --filter app exec tsc --noEmit` + `pnpm exec biome check <改动文件>`
   + `node scripts/maps-sync-check.mjs` 全绿。
7. **部署**：提交并 `git push origin local:main` → EdgeOne Pages 自动重建（约 1 分钟）。
8. **验证远程**：`curl https://www.bettersageread.cn/maps/*.json` 看 `updatedAt` 与新行
   （客户端拉取带 `_ts` 防 CDN 陈旧，手动验证也加上）。
9. **CDP 端到端**：dev 实例（`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=
   --remote-debugging-port=9223 pnpm tauri dev`）跑三个脚本：
   `cdp-test-vision-map.mjs` / `cdp-test-reasoning-map.mjs` /
   `cdp-test-model-maps-hotupdate.mjs`（版本闸/整表替换/缓存写入全链路）。

## 3. 现行口径备忘（踩过的坑）

- **Anthropic 不加思考行**：聊天通道没有 anthropic 分派（`chatReasoningProviderOptions`
  无 case，`factory.ts:221` 仅建 provider）。加行会让 UI 出档位但不下发参数 =
  死档位。Anthropic 新型号只入视觉表。（冒烟里有反向断言守着。）
- **OpenAI effort 六档**：`none/low/medium/high/xhigh/max`（gpt-6-sol/luna 官方型号页）；
  Astra 无 none（恒思考，alwaysOn）。
- **MiMo**：官方端点 `api.xiaomimimo.com`，思考参数文档口径 `thinking:{type:
  enabled|disabled}`（勿用阿里托管的 `enable_thinking` 口径）。
- **日期快照归一**：`-YYYY-MM-DD`/`-YYYYMMDD`/`-DDMMYY` 六位数后缀会被剥离后查表，
  快照型号一般不用单独加行（冒烟里有覆盖）。
- **空表/非法形状会被客户端拒绝**（防部署事故擦空）；同版/更旧表不采纳（不抖动）。
- 已装机的旧版本在下次启动时自动拉到新表——**热更新只覆盖 JSON 表；分派代码
  （host 检查、参数形状）在客户端包里，改了要等下个发布版**。

## 4. 已知挂账

- 存量 `mimo-v2.5` 等三行是 budget 型（`enable_thinking`），与小米官方
  `thinking:{type}` 口径不一致（疑似按阿里云托管文档收录），待核实修订。
- 两个冒烟脚本存在与表演进脱节的既有断言（2026-09-22 盘点：视觉 6 条、思考 17 条），
  需逐条对照官方文档裁定后刷新，不要把它们当红灯停更。
- Grok 4.7 的 `none` 档：docs.x.ai 当日不可达，按 4.6 同机制同文档小节收录，
  待 docs.x.ai 可达后复核（最坏情况 off 档 400，聊天/轻量任务均有 400 重放兜底）。
