# 多模态（视觉）能力映射表 —— 枚举式调研

调研日期：2026-08-24。目标：把 `packages/app/src/ai/providers/vision-map.ts` 的命名启发式 + 提供商保守默认，替换为逐家枚举的映射表。本文只出方案，不动代码。

证据等级说明：OpenAI / DeepSeek / Anthropic / 智谱 / Qwen / Kimi / OpenRouter 七家的结论均核实到官方文档正文（附 URL 与关键原文）；Google（ai.google.dev）与 xAI（docs.x.ai）在本调研环境不可直连，改用官方 GitHub SDK 源码、官方合作方文档（Oracle OCI）、OpenRouter 实时模型 API 与引用官方文档的二手来源交叉核实，已逐条标注。

---

## 一、枚举映射表草案（provider × 型号族 → 是否放行图片）

维护原则沿用 vision-map 头部注释与 reasoning-map 的共识：**只拦"确定不支持图片"的已知组合；未知型号/自定义端点默认放行**（误拦比误发更伤体验——纯文本模型收到图只是被 transport 剔图，不会报错；视觉模型被误拦则功能直接残废）。下表是"已知"部分的枚举；不在表内的型号走默认放行。

### 1. OpenAI（providerId: `openai`）

官方口径（[Models 页](https://developers.openai.com/api/docs/models)）："All latest OpenAI models support text and image input"。GPT-5 全系、GPT-4.1/4o 系、o1/o3/o4-mini 均支持图片输入；Codex 专用型（gpt-5.3-codex、gpt-5-codex-mini）也早已不是纯文本。

| 型号族（正则） | 判定 | 备注 |
|---|---|---|
| `^gpt-5`（含 5.1/5.2/5.3-codex/5.4*/5.5/5.6-*、mini/nano/pro/codex 变体） | ✅ 放行 | 当前主线；5/5-mini/5-nano/5-pro 已废弃但 2026-12-11 才停服 |
| `^gpt-4\.1` | ✅ 放行 | 4.1-nano 2026-10-23 停服 |
| `^gpt-4o` | ✅ 放行 | |
| `^o1`、`^o3$`、`^o3-pro`、`^o4-mini` | ✅ 放行 | 均已废弃、2026-10/12 停服，目前可用；o3-pro 的 Modalities 未在页面正文核到，按支持处理 |
| `^o3-mini` | ❌ 拦截 | 官方页明确 "Image: Not supported"，2026-10-23 停服 |
| `^gpt-3\.5` | ❌ 拦截 | 现行规则已拦；2026-09/10 陆续停服 |
| `^gpt-oss-` | ❌ 拦截 | 开放权重，官方页仅文本/推理/工具，无视觉 |
| `^gpt-4-`（0613 等旧快照）、`^gpt-4-turbo` | ❌ 拦截（保守） | 2026-10-23 停服；gpt-4-turbo 历史上有 vision 但官方 deprecation 口径下按将停服处理，拦了无害 |
| `^gpt-image-`、`dall-e`、audio/embedding 系 | 不适用 | 非聊天模型，不会出现在聊天型号位 |

### 2. DeepSeek（`deepseek`）

官方当前仅三个型号（[Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing)），Vision 指南原文："Only vision models (`deepseek-v4-flash-vision-exp`) accept images; other models return a `400` error"。

| 型号族 | 判定 | 备注 |
|---|---|---|
| `^deepseek-.*vision`（当前唯一：`deepseek-v4-flash-vision-exp`，2026-08-21 上线） | ✅ 放行 | 实验性；文本能力与 V4-Flash 持平 |
| `^deepseek-v4-flash$`、`^deepseek-v4-pro$` | ❌ 拦截 | 传图 400 |
| `^deepseek-(chat|reasoner|coder)$` | ❌ 拦截 | 已于 2026-07-24 停用，拦截无害（用户配置里可能残留） |
| `deepseek-vl2` 等 | 不存在于官方 API | 仅开源权重自托管，无官方端点 |

### 3. Anthropic（`anthropic`）

官方原话（[Models overview](https://docs.anthropic.com/en/docs/about-claude/models/overview)）："All current Claude models support text and image input … and vision." 当前在售 10 个 Active 型号（Fable 5 / Mythos 5 / Opus 5 / Sonnet 5 / Opus 4.8/4.7/4.6/4.5 / Sonnet 4.6/4.5 / Haiku 4.5）全部支持图片，**无纯文本在售型号**；3.x 及更早已在官方平台全退役（最后 Haiku 3 于 2026-04-20 退役）。

| 型号族 | 判定 | 备注 |
|---|---|---|
| `^claude-(fable|mythos|opus|sonnet|haiku)-` | ✅ 放行 | 覆盖全部在售；4.6 代起 ID 不带日期后缀但仍是固定快照 |
| `^claude-3-5-haiku`、`^claude-2`、`^claude-1`、`^claude-instant` | ❌ 拦截 | 历史上著名的无视觉型号（3.5 Haiku）与远古型号；官方平台已调不动，拦截仅防御存量配置 |
| 其余 `claude-3-*`（3-haiku/3-opus/3-sonnet/3.5-sonnet 等） | ✅ 放行（或不再列出） | 历史上有视觉；官方已退役，Bedrock/Vertex 可能仍可调用且行为不变 |

### 4. Google Gemini（`google` / `gemini`）

**主线文本模型没有纯文本型号**：2.5 全系与 3.x 全系（3-flash / 3-pro / 3.1-pro / 3.1-flash-lite / 3.5-flash(-lite) / 3.6-flash / 3.7-flash）均为全模态输入（text/image/audio/video/file → text），OpenRouter 当日元数据逐型号确认 `input_modalities` 含 `image`。

| 型号族 | 判定 | 备注 |
|---|---|---|
| `^gemini-2\.5-(pro|flash|flash-lite)`、`^gemini-3`（全部 3.x 文本主线） | ✅ 放行 | 含 `-image` 图像生成变体（也吃图片输入） |
| `^gemini-.*-(tts|embedding)`、`^gemini-embedding` | 不适用/拦截均可 | 非聊天模型 |
| `^gemini-3\.5-flash-cyber` | ⚠️ 存疑（倾向拦截） | 2026-07 限量试点安全专用模型，二手称其纯文本，无官方页面可核 |

### 5. xAI Grok（`grok`）

docs.x.ai 本环境不可直连，以下为 Oracle 官方合作页 + OpenRouter 当日目录 + 引用官方文档的二手来源交叉结论：**当前 API 目录内所有聊天型号均为 text+image(+file)→text，无纯文本聊天型号**（连代码专用的 grok-build-0.1 / grok-code-fast 也支持图片输入）。

| 型号族 | 判定 | 备注 |
|---|---|---|
| `^grok-(4(\.\d+|-\d)|build|code-fast)`（4.20 系/4.3/4.5/4.6/build/code-fast） | ✅ 放行 | 现役全族 |
| `^grok-4(-fast|-1-fast|-0709)?$`、`^grok-3`、`grok-2-vision` | ✅ 放行（遗留 ID） | 2026-05-15 起重定向到 grok-4.3（多模态）；grok-2-vision 已退出官方目录 |
| `^grok-imagine-`、`^grok-voice-` | 不适用 | 图像/视频生成与语音，非聊天图片输入场景 |
| `grok-4-heavy` | 不存在于 API | 消费端 SuperGrok Heavy 专属 |

### 6. 智谱 GLM（`zhipu` / `bigmodel`，官方[模型概览](https://docs.bigmodel.cn/cn/guide/start/model-overview)核实）

命名规律（2026 在售对话模型）：**版本号后紧跟 `v` = 视觉理解**（`glm-X.Yv…` / `glm-5v…` / `glm-4v…`）；`v` 出现在其他位置（voice/cogview）不算；"Flash/FlashX/AirX" 只是免费/极速档位标记，与模态无关。

| 型号族 | 判定 | 备注 |
|---|---|---|
| `^glm-5v-`（glm-5v-turbo，2026-04 上线） | ✅ 放行 | **现行启发式会误拦**（其正则只认 `4…v`） |
| `^glm-4\.\d+v`（4.6v 全系、4.5v、4.1v-thinking 全系） | ✅ 放行 | 4.5v 疑似下架边缘（概览表已移除），保留放行无妨 |
| `^glm-4v-`（glm-4v-flash） | ✅ 放行 | 免费图像理解 |
| `^glm-ocr$`、`^autoglm-phone$` | ✅ 放行（可选） | 名字无 v 但吃图片；OCR 走专用 layout_parsing 接口，聊天链路用不上，可不加 |
| 其余全部 `glm-*` 文本系（5.3/5.2/5.1/5/5-turbo、4.7/4.6/4.5 系、4-flash/long/plus/air 等） | ❌ 拦截 | 各详情页输入模态均明确"文本"；GLM-5.3 原文"目前仅支持处理文本模态信息" |
| `glm-z1-*`、`glm-4-voice`、`cogview-*`、`cogvideox-*` | ❌ 拦截 | Z1 已弃用；voice 是语音；cog 系是生成 |

### 7. 阿里 Qwen / DashScope（`dashscope` / `qwen`，官方[视觉理解选型页](https://help.aliyun.com/zh/model-studio/vision-model/)核实）

**2026 年最大变化："-vl / omni / qvq 才看图"的规律已失效。** 自 2026-02 的 Qwen3.5 起，旗舰主线（3.5/3.6/3.7/3.8 的 plus/flash/开源尺寸型号）全部是"原生视觉语言系列"，型号名无 vl/omni 字样却原生支持图像+视频输入。

| 型号族 | 判定 | 备注 |
|---|---|---|
| `-vl-`（qwen-vl-*、qwen2.5-vl-*、qwen3-vl-*） | ✅ 放行 | 旧 VL 系仍在售但"不再首选推荐" |
| `^qvq-`（qvq-max/plus） | ✅ 放行 | 视觉推理"仅思考"系，仅流式输出 |
| `omni`（qwen3.5-omni-*、qwen3-omni-flash 等） | ✅ 放行 | 全模态；qwen-omni-turbo 已停止更新 |
| `^qwen3\.[56]\.(plus|flash|\d+b)`、`^qwen3\.7-(plus|flash)`、`^qwen3\.8-(max|27b)` | ✅ 放行 | **原生视觉主线，现行启发式全部误拦** |
| `^qwen3\.7-max-2026-06-08` 及之后快照 | ✅ 放行 | max 线按快照逐步开视觉：该快照起带视觉 |
| `-ocr`（qwen3.5-ocr、qwen-vl-ocr）、`^gui-` | ✅ 放行 | OCR / GUI 截图专用 |
| `^qwen3-max`（含 -preview）、`-max-preview`、`^qwen3\.7-max(-2026-05-20)?$`、`^qwen3\.8-2\.4t-` | ❌ 拦截 | 官方文本生成页明确警示"仅支持文本接口，直接替换模型会导致报错" |
| `-coder-`、`^qwen-plus`、`^qwen-flash`、`^qwen3-(235b|30b|next)`、`-mt-`、qwen-doc/deep-research 等 | ❌ 拦截 | 代码系/商业文本系/老开源文本系/垂直文本，官方能力标签仅"文本生成" |
| `qwen3.5-max` | 不存在 | 若未来出现无法按规律推断（max 线视觉按快照逐步开放），届时需实测 |

### 8. 月之暗面 Kimi / Moonshot（`moonshot` / `kimi`，官方[模型列表](https://platform.kimi.com/docs/models)与[视觉指南](https://platform.kimi.com/docs/guide/use-kimi-vision-model)核实）

关键背景：文档站已迁 platform.kimi.com；**视觉能力已内嵌进主型号**，不再有独立 vision 型号路线。kimi-k2 全系 2026-05-25 已下线；moonshot-v1 系与 kimi-k2.5 将于 **2026-08-31 全平台下线**。

| 型号族 | 判定 | 备注 |
|---|---|---|
| `^kimi-k3` | ✅ 放行 | 当前旗舰，"原生支持视觉理解"，图片+视频输入 |
| `^kimi-k2\.7-code(-highspeed)?$` | ✅ 放行 | 2026 新 Coding 型号，图片+视频输入，思考常开 |
| `^kimi-k2\.6$` | ✅ 放行 | 视觉+文本，支持视频 |
| `^kimi-k2\.5$` | ✅ 放行（至 2026-08-31） | 即将下线 |
| `^moonshot-v1-(8k|32k|128k)-vision-preview$` | ✅ 放行（至 2026-08-31） | 注意正确命名是 `-vision-preview`，不存在 `moonshot-v1-vision` |
| `^moonshot-v1-(8k|32k|128k)$` | ❌ 拦截 | 纯文本，2026-08-31 下线 |
| `^kimi-k2(-|$)`（k2/k2-thinking/k2-turbo 等） | ❌ 拦截（防御） | 已下线；生命周期内均纯文本。**注意 `kimi-k2.` 带点的 2.5/2.6/2.7 是多模态，别用 `^kimi-k2` 一刀切** |

### 9. OpenRouter（`openrouter`）与自定义端点

- **OpenRouter**：聚合 400+ 家模型，"默认放行"会对大量纯文本型号误放行（实测 2026-08-24 目录 422 个文本输出模型中仅 250 个支持图片输入）。两条改进路径：
  1. **运行时用目录 API 判断（推荐，真正的"枚举"）**：`GET https://openrouter.ai/api/v1/models` 的每个模型含 `architecture.input_modalities`（取值子集 `["text","image","file","audio","video"]`），判断 = 数组含 `image`。可缓存。注意端点级差异（`/models/{author}/{slug}/endpoints` 可能更窄）与路由器型号（`openrouter/auto` 标注多模态但取决于被路由模型）。
  2. 静态表方案：按 `作者/型号` 前缀套用上面各家的型号族规则（目录前缀与官方 ID 基本一致，如 `deepseek/deepseek-v4-flash-vision-exp`、`z-ai/glm-4.6v`），前缀外的未知作者默认放行。
- **自定义 OpenAI 兼容端点**：维持现状默认放行，与 vision-map 现行原则一致（用户自建端点可能支持视觉）。这也是与 reasoning-map 惯例的统一处：两者都是"已知才做确定性处理，未知走保守安全默认"——只是 vision 的安全默认是放行（剔图不报错），reasoning 的安全默认是不下发（防 400），方向不同、原则同一。

---

## 二、当前启发式的误判清单（对照 `vision-map.ts` 现状）

### 误拦截（支持图片但被拦，功能残废）

| 条目 | 现行行为 | 实际能力 |
|---|---|---|
| **moonshot/kimi 全线默认 false**：`kimi-k3`、`kimi-k2.6`、`kimi-k2.7-code(-highspeed)`、`kimi-k2.5` | 命名不含 vision/-vl/vlm/omni/4v/数字v → **全拦** | 官方视觉指南明确支持图片（k3/k2.6/k2.7-code 还支持视频）。**这是现行表最严重的误伤：Kimi 全部现役主力型号都不能发图** |
| **dashscope/qwen 仅 `-vl|qvq`**：`qwen3.5-plus/flash`、`qwen3.6-plus/flash`、`qwen3.7-plus/flash`、`qwen3.8-max/27b` 等原生视觉主线 | **全拦** | 官方"原生视觉语言系列"，图像+视频输入；2026-02 起的主线全部误拦 |
| qwen `-ocr`、`gui-plus` | 拦 | OCR/截图专用视觉型号 |
| **zhipu 仅 `4[.\d]*v`**：`glm-5v-turbo` | 拦（5v 不匹配 4…v） | 2026-04 上线的多模态 Coding 基座 |
| 智谱 `glm-ocr`、`autoglm-phone` | 拦 | 吃图片的专用型号（聊天链路用不上 OCR，影响小） |

### 误放行（纯文本但被放行，发了图被静默剔掉/或远端 400）

| 条目 | 现行行为 | 实际能力 |
|---|---|---|
| **openai 非 gpt-3.5 全 true**：`o3-mini`、`gpt-oss-120b/20b` | 放行 | 官方明确不支持图片（o3-mini "Image: Not supported"） |
| **openrouter 默认 true**：经 OpenRouter 用 deepseek-v4-pro、glm 文本系、qwen3-max、codestral 等纯文本型号 | 放行 | 实测目录约 40% 型号（172/422）不支持图片输入 |
| **anthropic 默认 true**：`claude-3-5-haiku` 等历史 ID | 放行 | 3.5 Haiku 无视觉（官方已退役，仅防御意义） |
| **命名启发式全局前置**：任何提供商型号名带 omni/-vl/vision 等即放行 | 放行 | 各家调研未发现现存的反例（带这些关键词的都是真视觉），风险低；但它让下游枚举表的"拦截"分支对撞名型号失效，枚举化后建议把启发式降级为"未知型号的兜底放行"，已知拦截项优先 |

### 命名启发式本身

`VISION_NAME_RE = /vision|-vl|vlm|omni|multimodal|4v\b|\.?\d+v\b/` 在 2026-08 的覆盖率：对 DeepSeek（vision-exp）、Kimi 老 vision-preview、Qwen VL/Omni、智谱 4xV 有效；对 Kimi 现役主线、Qwen 原生视觉主线、智谱 5V **完全失效**（正是误拦截清单前三条）。枚举表落地后它只需兜底未知新命名。

---

## 三、与 reasoning-map 维护惯例的统一建议

1. **同一原则，两个方向**：已知组合做确定性处理，未知走安全默认。vision 侧未知默认放行（transport 剔图兜底）；reasoning 侧未知默认不下发（防 400）。建议在新 vision 枚举表头部把这条不对称写清楚，避免后人误以为两张表惯例不一致。
2. **同一样板格式**：型号族正则 + 一句官方依据 + 调研日期，注释内嵌关键事实（如"kimi-k2 已下线勿一刀切 `^kimi-k2`"、"qwen max 线视觉按快照开放"这类易踩坑点）。
3. **优先级**：已知拦截 > 已知放行 > 命名启发式（兜底未知新型号）> provider 默认。现行实现是启发式最优先，导致拦截分支可被撞名绕过；枚举化后应反转。
4. **OpenRouter 特例**：如能接受一次运行时请求，用 `/api/v1/models` 的 `input_modalities` 做真枚举，可顺带缓存 reasoning 的 `supported_efforts`/`mandatory` 元数据（对 reasoning-map 也有用，见下）。

---

## 四、reasoning-map.ts 注释事实核对（2026 年中声明 vs 2026-08 现状）

| 注释声明 | 核对结论 | 说明 |
|---|---|---|
| "Anthropic 4.6/4.7 起废弃 thinking.budget_tokens 改 effort 档位（Sonnet 5 收旧写法 400）" | **方向正确，需精化** | 4.6 代是 deprecated-but-functional（能用有警告）；**硬 400 从 4.7 起**（含全部 5 代/Fable/Mythos）。effort 枚举为 low/medium/high/xhigh/max，位置在顶层 `output_config.effort` 而非 thinking 对象内；`max` 4.6+ 可用，`xhigh` 仅 Fable5/Mythos5/Opus5/Opus4.8/4.7/Sonnet5。来源：[thinking-troubleshooting](https://docs.anthropic.com/en/docs/build-with-claude/thinking-troubleshooting)、[effort](https://docs.anthropic.com/en/docs/build-with-claude/effort) |
| "本应用 anthropic 走 OpenAI 兼容通道，effort 参数面无实证 → 不下发" | **仍准确，且有新实锤** | 官方 OpenAI 兼容页明确 `reasoning_effort`: **Ignored**；`output_config` 在该页完全没有出现。"不下发"结论正确，注释可升级为"官方明示忽略"。另注意 4.7+ 模型连 temperature/top_p/top_k 非默认值都 400。来源：[OpenAI SDK 兼容层](https://docs.anthropic.com/en/api/openai-sdk) |
| "Gemini 3.x 起废弃 thinkingBudget 整数改 thinkingLevel 枚举；3.1 Pro 不认 minimal" | **准确，且发现新同类** | thinkingLevel 枚举 minimal/low/medium/high 确认；2.5 系仍用 thinkingBudget 确认；**新增：gemini-3.7-flash 也移除了 minimal**（传 minimal 直接报错），gemini-3-pro 仅 low/high 且不可关。来源：python-genai SDK types.py、[官方迁移指南](https://dev.to/googleai/gemini-36-flash-35-flash-lite-developer-guide-268i)、OpenRouter supported_efforts 实测 |
| "DeepSeek：thinking 开关 + reasoning_effort 仅 high/max（无 low 档）" | **已过时（2026-08-13 起）** | V4-Pro/V4-Flash 已支持 **low/high/max 三档**（[Change Log](https://api-docs.deepseek.com/updates/) 原文："now support three thinking effort levels: low / high / max"）。当前实现把用户选 low 映射为 thinking disabled，偏保守；对齐官方应改为 `reasoning_effort: "low"` |
| "Kimi K3：reasoning_effort low/high/max；K2.x 混合模型仅开关；思考专用型号关不掉" | **准确，但举例型号已下线** | K3 属实（官方"推理强度支持 low/high/max，默认 max"，且"K3 始终开启思考，关不了"）。过时点：`kimi-k2-thinking` 2026-05-25 已下线，当前"关不掉思考"的是 **kimi-k3** 与 **kimi-k2.7-code(-highspeed)**（传 disabled 直接 400）。来源：[K3 快速开始](https://platform.kimi.com/docs/guide/kimi-k3-quickstart)、[思考模型指南](https://platform.kimi.com/docs/guide/use-thinking-models) |
| "OpenAI 按模型子集支持 none/minimal/low/medium/high（更新的有 xhigh/max）" | **仍准确，可细化** | 全集 7 档确认；细化：`minimal` 仅初代 gpt-5 族，`none` 是 5.1 起的"不推理"档，`xhigh` 从 5.2/5.3-codex 起，`max` 仅 GPT-5.6 族。来源：[Reasoning 指南](https://developers.openai.com/api/docs/guides/reasoning) |
| "OpenRouter 对不支持推理的模型自动忽略，可安全下发；无实证 none 档" | **前半仍准确，后半已过时** | `none` 已有官方实证（"Disables reasoning entirely"），effort 全集含 xhigh/max；**但新增 mandatory 陷阱**：`reasoning.mandatory=true` 的模型（如 gemini-3.1-pro-preview）会拒绝 `effort:"none"`——off 映射 low 的现行做法恰好规避了该坑，可保留。来源：[Reasoning Tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens) |
| "仅 grok-3-mini 系列支持 reasoning_effort（grok-4 恒思考关不掉）" | **已过时** | grok-3-mini 2026 年 2–5 月陆续退役；现役：grok-4.3 支持 none/low/medium/high（none 可关），grok-4.5 仅 low/medium/high 不可关，grok-4.6 low/medium/high/xhigh，grok-4.20 走 `reasoning.enabled` 开关。来源：promptfoo xAI 页（2026-08-24）、引用 docs.x.ai 的 GitHub issue（docs.x.ai 本环境不可直连，建议有网环境复核） |

---

## 五、官方来源汇总

- OpenAI：[Models](https://developers.openai.com/api/docs/models)、[Images and vision](https://developers.openai.com/api/docs/guides/images-vision)、[Reasoning](https://developers.openai.com/api/docs/guides/reasoning)、[Deprecations](https://developers.openai.com/api/docs/deprecations)
- DeepSeek：[Vision 指南](https://api-docs.deepseek.com/guides/vision)、[V4-Flash-Vision-Exp 发布](https://api-docs.deepseek.com/news/news260821/)、[Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)、[Change Log](https://api-docs.deepseek.com/updates/)、[Pricing](https://api-docs.deepseek.com/quick_start/pricing)
- Anthropic：[Models overview](https://docs.anthropic.com/en/docs/about-claude/models/overview)、[Vision](https://docs.anthropic.com/en/docs/build-with-claude/vision)、[Extended thinking](https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking)、[Thinking troubleshooting](https://docs.anthropic.com/en/docs/build-with-claude/thinking-troubleshooting)、[Effort](https://docs.anthropic.com/en/docs/build-with-claude/effort)、[Deprecations](https://docs.anthropic.com/en/docs/about-claude/model-deprecations)、[OpenAI SDK 兼容](https://docs.anthropic.com/en/api/openai-sdk)
- Google（间接）：[python-genai types.py](https://raw.githubusercontent.com/googleapis/python-genai/main/google/genai/types.py)、[官方 3.6/3.5 迁移指南（dev.to/googleai）](https://dev.to/googleai/gemini-36-flash-35-flash-lite-developer-guide-268i)、OpenRouter 模型 API 实测
- xAI（间接）：[Oracle OCI xAI 模型页](https://docs.oracle.com/en-us/iaas/Content/generative-ai/xai-grok-4-1-fast.htm)、[promptfoo xAI provider](https://www.promptfoo.dev/docs/providers/xai/)、OpenRouter 模型 API 实测；docs.x.ai 待有网环境复核
- 智谱：[模型概览](https://docs.bigmodel.cn/cn/guide/start/model-overview)、[GLM-5V-Turbo](https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5v-turbo)、[GLM-4.6V](https://docs.bigmodel.cn/cn/guide/models/vlm/glm-4.6v)、[GLM-5.3（纯文本原文）](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3)
- Qwen：[视觉理解选型](https://help.aliyun.com/zh/model-studio/vision-model/)、[模型上架与更新](https://help.aliyun.com/zh/model-studio/newly-released-models)、[视觉推理](https://help.aliyun.com/zh/model-studio/visual-reasoning)、[文本生成（纯文本警示）](https://help.aliyun.com/zh/model-studio/text-generation)、[模型列表](https://help.aliyun.com/zh/model-studio/models)
- Kimi：[模型列表](https://platform.kimi.com/docs/models)、[视觉模型指南](https://platform.kimi.com/docs/guide/use-kimi-vision-model)、[K3 快速开始](https://platform.kimi.com/docs/guide/kimi-k3-quickstart)、[思考模型](https://platform.kimi.com/docs/guide/use-thinking-models)
- OpenRouter：[Models（Architecture Object）](https://openrouter.ai/docs/guides/overview/models)、[Reasoning Tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)、[API Overview](https://openrouter.ai/docs/api_reference/overview)、`GET https://openrouter.ai/api/v1/models`（2026-08-24 实测快照）

## 六、遗留风险

1. Google 与 xAI 官方站点本环境不可直连，相关结论经二手/网关元数据交叉，落地代码前建议在有网环境复核 ai.google.dev 与 docs.x.ai。
2. 模型生命周期极快（本次调研即发现 Kimi 全线换血、DeepSeek 视觉型号 3 天前才上线），枚举表注释务必带调研日期，并建议把"OpenRouter 目录 API 实测"作为低成本的定期校验手段。
3. `qwen3.7-max` 这类"按快照逐步开放视觉"的型号提醒：正则若只匹配型号族名不匹配快照日期，会存在边界误判；qwen max 线建议显式枚举快照或保守拦截。
