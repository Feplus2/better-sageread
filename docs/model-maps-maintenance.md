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
   （SageRead 当前配套 BC 1.3.9；BC 新版大版本升级/搬进 SageRead 是另一条独立计划，暂缓，不影响模型表移植这条路。）
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
- **恒思考新型号（alwaysOn）加行前先确认"有没有下发通道"**：原生 providerOptions
  （openai/google/openrouter/grok）或通道 B host 分派，至少有一条能到；否则行 = 死档位。
  2026-10-20 MiniMax 就是先补 host 分派再加入表（与 hunyuan/doubao/mimo 同款教训）。
- **alwaysOn 行的 off/none 控制词钳制**（2026-10-20 修复）：`clampReasoningLevel` 对
  off/none/on/auto 控制词原样放行（供非 alwaysOn 分支做开关映射），但恒思考型号不接受
  控制词。现在 `chatReasoningProviderOptions` / `chatReasoningBodyPatch` 在钳制后统一把
  alwaysOn 行的 off/none 落到 `levels[0]`（与 `auxThinkingLevel` 同口径），避免换型号后
  persist 的 off 直接下发 400。
- **日期快照归一**：`-YYYY-MM-DD`/`-YYYYMMDD`/`-DDMMYY` 六位数后缀会被剥离后查表，
  快照型号一般不用单独加行（冒烟里有覆盖）。
- **空表/非法形状会被客户端拒绝**（防部署事故擦空）；同版/更旧表不采纳（不抖动）。
- 已装机的旧版本在下次启动时自动拉到新表——**热更新只覆盖 JSON 表；分派代码
  （host 检查、参数形状）在客户端包里，改了要等下个发布版**。

## 4. 已知挂账

- 2026-10-25 批次：**Kimi K3.1 Pro（`kimi-k3.1-pro`）已入表**（site/maps + 打包副本 + BC 视觉移植同步）。
  官方 [K3.1 Pro 指南](https://platform.moonshot.cn/docs/guide/kimi-k3-1-pro-quickstart.md)、
  [推理强度](https://platform.moonshot.cn/docs/guide/use-reasoning-effort.md)、
  [Messages](https://platform.moonshot.cn/docs/api/messages.md)、
  [Responses](https://platform.moonshot.cn/docs/api/responses.md)、
  [定价](https://platform.moonshot.cn/docs/pricing/chat) 核实：1,048,576 上下文；文本/图片/视频输入；
  始终思考且只有 `low/high/max`（默认 max）。Chat Completions 顶层 `reasoning_effort`，
  Responses `reasoning:{effort}`，Anthropic Messages `output_config:{effort}`，三者不可混用。
  `max_completion_tokens` 默认 131,072、最大 1,048,576；未把上限写成每次请求的预留，未新增高速版。
  K3/K3.1 的 `high` 仍是 `high`，不要误写成 `max`；K2.x 的 thinking 映射保持原样。
  分派与预算代码随客户端发布，旧客户端仅拉 JSON 不会获得这些修复。
  实测（2026-10-25，CherryIN `moonshotai/kimi-k3.1-pro`；当时无官方 key，后续已补测官方）：目录可发现，
  文本、完整 assistant/reasoning 工具历史、有效 PNG 和标准 `/v1/messages` 均为 HTTP 200；
  隔离 App 的 `manageThreads list`、`manageSkill toggle`（不传 skillName）与图片调用通过。
  `/v1/responses` 返回 HTTP 200 但正文 0 字节，**该中继 Responses 未验证通过**；
  三种协议的请求形状另由真实 provider 适配器捕获验证，不把空响应当成功，也不静默换协议。
  同日官方原始 Chat/Messages 文本均为 HTTP 200，应用内普通文本、流式文本与 PNG 实测通过。普通 JSON 的 thinking
  可缺省 `signature`，Anthropic SDK 因而拒绝 `content[0].signature`；仅在官方 Moonshot 的成功 JSON 响应中
  补空字符串标记缺失，保留思考与正文，其他响应及中继不改写。流式解析路径不改写；
  `test-kimi-k31-fetch.mjs` 31/31（缺失字段的非流式/流式/中继边界）通过。后续官方 Responses
  已实测：HTTP 200、正文 1,482 字节、回复“Responses 协议可用。”；应用内文本、工具历史与 PNG 也通过。
  CherryIN 本轮无可用密钥，未发送请求，不能据此判断渠道结果。
  目录同时出现 highspeed：K3 系列 1M 上下文已核实，但其视觉/推理参数未独立核实。
  现有 longest-prefix 会让它继承 Pro 的档位与协议补丁；未单列入表或实测，后续复核。

- 2026-10-20 批次核实结论（均已入表，site/maps + 打包副本 + BC 视觉移植三处同步，maps-sync-check 绿）：
  - **Gemini 4 Argon（`gemini-4-argon`）已入表**：Google 官方发布页（blog.google）/Gemini API
    "What's new in Gemini 4 Argon"/Gemini Interactions SDK 2.1.0 发布说明核实。要点：
    1,048,576 统一上下文；视觉多模态（Roboflow Vision Evals #1、SDK 标注 multimodal）；
    **恒思考不可关**（none 映射为 low 且隐藏思考）；原生 thinkingLevel 仅 `low/medium/high`
    （默认 medium），**拒绝 minimal**、拒绝 thinkingBudget 与 level 并用。走 google 通道
    providerOptions `thinkingConfig.thinkingLevel`，**无需改分派代码**。
    **未接 long decode**：官方对 `xhigh/max` 档才放开 >64K 输出（升 maxOutputTokens），
    本客户端表内最高 high；如需支持要改客户端分派，随发布版走。
  - **MiniMax M3.1 Flash（API id `MiniMax-M3.1-Flash`，表键 `minimax-m3.1-flash`）已入表**：
    官方 blog（2026-10-19，匿名代号 **Space Bunny** 为其早期版本）+ platform.minimax.io 文档核实。
    要点：1M 上下文；多模态（text/image/video 输入）；**恒思考不可关**
    （`thinking:{type:"disabled"}` 或 `reasoning_effort:"none"` 直接 400）；
    思考深度走 `reasoning_effort`：low/medium/high/xhigh/max（省略默认 max）。
    **同时补了 MiniMax 请求体分派分支**（`api.minimax.io` / `api.minimaxi.com` /
    `api.minimax.chat`）：此前表里 minimax-m3/m2.5/h3 三行是死条目（无 host 分派）；
    新分支对 alwaysOn 行发 `reasoning_effort`，存量 switch 行保持 `thinking:{type}` 口径不变。
  - 反向断言已加：两模型视觉放行（含 OpenRouter 作者前缀归一）、Gemini 三档/恒思考、
    MiniMax 五档/off 钳到 low 且不发 disabled；存量 minimax-m3 switch 行为不变。
- 2026-10-14 批次核实结论：
  - **gpt-6.1-sol 已入表**（恒思考五档 low/medium/high/xhigh/max，none/minimal 不支持）：
    OpenAI reasoning 指南（默认 medium）+ DataCamp 引官方型号页（none/minimal 明确不支持）。
    `-pro` 变体靠前缀命中同行。OpenAI/OpenRouter 通道直接生效。
  - **step-5-preview**：StepFun 官方推理接入文档（platform.stepfun.com/docs/zh/step-plan/
    integrations/reasoning-api）确认三档 low/medium/high，Chat Completion 用 `reasoning_effort`、
    Messages 用 `output_config.effort`，官方文档未提思考开关。**未入表**：客户端无 stepfun
    端点分派分支（通道 B 无 host 匹配），加行 = 死档位（同 Anthropic 口径）；如需支持，
    先补 stepfun 分派代码（随发布版出去），再入表。
  - **mistral-large-4**：Mistral 文档确认支持 `reasoning_effort`（同族口径
    none/low/medium/high），但官方文档站当日抓取不可达、未经一手核实，且无 mistral
    端点分派分支。**未入表**，待官方文档复核 + 补分派代码。
  - **muse-wonder**：OpenRouter 目录确认支持 reasoning/reasoning_effort；二手源
    （ZenMux）称五档 low~max、Meta 官方文档（dev.meta.ai/docs/reasoning）当日不可达，
    "Muse Wonder Full 另有 max" 暗示普通版到 xhigh——档位边界未坐实，且无 meta
    端点分派分支。**未入表**，待官方文档复核。

- 存量 `mimo-v2.5` 等三行是 budget 型（`enable_thinking`），与小米官方
  `thinking:{type}` 口径不一致（疑似按阿里云托管文档收录），待核实修订。
- 2026-10-25 独立核查旧冒烟断言时发现 **10 个基线缺口**：视觉 3 个、思考 7 个。
  当时用 `GAP` 保留失败方向，不以修改预期来消红；`ALLOW_PREEXISTING_MAP_GAPS=1`
  只允许验收其他批次，不把缺口计为通过。
- **2026-10-27：7 个思考映射缺口已全部修复**，默认冒烟 69/69、0 GAP。
- **2026-11-05：3 个视觉映射缺口已全部修复**：
  [qwen3.7-max 基名当前等同 2026-05-20 纯文本快照](https://help.aliyun.com/zh/model-studio/qwen3-7-max)、
  [qwen3.8-2.4t-a95b 仅文本](https://help.aliyun.com/zh/model-studio/qwen3-8-2-4t-a95b)、
  [gpt-4-0613 不支持图片](https://developers.openai.com/api/docs/models/gpt-4)。
  同时修复 qwen3.7-max 的日期归一：各快照独立判断，未收录新快照沿用未知默认，避免把后期视觉快照
  误继承为早期纯文本。默认视觉冒烟 81/81 + 3 RESOLVED，热更新 35/35；
  Books_Converter 同步 298 行并新增 `gui/src/lib/__tests__/vision-map.test.ts`。无需允许缺口开关。
- Grok 4.7 的 `none` 档：docs.x.ai 当日不可达，按 4.6 同机制同文档小节收录，
  待 docs.x.ai 可达后复核（最坏情况 off 档 400，聊天/轻量任务均有 400 重放兜底）。


- **2026-11-07：腾讯 Hy4 正式版已入表并实测**（site/maps + app 打包镜像；updatedAt=`2026-11-07T22:21:56+08:00`）。
  官方[混元调用指南](https://cloud.tencent.com/document/product/1823/132252)确认 TokenHub OpenAI Chat、low/high 恒思考与视觉理解；默认 `tencent` 预置为 `https://tokenhub.tencentmaas.com/v1`，OpenAI Chat。正式版 `hy4:true`，`hy4-preview` 原有纯文本映射不变。
  授权 Key 实测：目录 HTTP 200、125 个型号，文本 `42`、流式只读工具、历史回放与数字图片 `7391` 均成功。
  真实目录 Hy4 的 `contextWindow=1024000`、`maxOutputTokens=64000`，静态预算采用该保守实测值，不按二进制展开。
  本次明确不进入 Books Converter 下一轮、不部署远程表；`SAGEREAD_ONLY=1 node scripts/maps-sync-check.mjs` 仅核对 SageRead 两处镜像，不能把另一项目的移植标为完成。下一轮 BC 开发仍需同步该行。
