# 动效体系：平滑转场 + 性能模式 实施计划（2026-08-24 讨论定稿）

> **状态：批次 1、3、4、5 已实施（批次 1：2026-08-25，commit c6e2a44，地基三档 + 管理态 + 进度卡离场编排；
> 批次 3：2026-08-26，tab/路由交叉淡入 + /chat 常驻层淡入淡出 + Tabs 滑动气泡指示器，
> CDP 实盘验证 46 项全过（scripts/cdp-motion-batch3-verify.mjs 可复跑；批次 5 落地后回归断言已适配 keepalive 语义）；
> 批次 4：2026-08-26，阅读器侧栏冻结式滑入滑出（书籍+论文共用 SidebarMotionProvider/MotionSidebar，
> 动画期内容钉宽、结束帧一次性 reflow + foliate-resize-update）+ 书库标签列表宽度推移（MotionSidebarCollapse，
> width 过渡为第一宪法受控例外），CDP 实盘验证 21 项全过（scripts/cdp-motion-batch4-verify.mjs 可复跑）；
> 批次 5：2026-08-26，commit 5b50c51，主页路由 keepalive 化（AnimatedRouteLayers visited 集合常驻、
> 二次切换零重挂载）+ 全 TabsContent 面进场动画（motion-enter-slide-up，token 驱动三档退化），
> CDP 实盘验证 17 项全过（scripts/cdp-motion-batch5-verify.mjs 可复跑）。
> 批次 2 内容已并入批次 1。二期（共享元素/手势）立项见 docs/archive/motion-phase2-plan.md。**
> 来源：用户提出——应用内大量"动作"（卡片弹出、侧边栏、进入管理状态、划线等）帧间硬切无过渡，想要 iOS 式连贯丝滑；同时接受动效有卡顿风险，须在设置页提供性能模式开关，用户说了算。
> 结论：**能实现，且本项目底子好于一般 Web 应用**。90% 丝滑感来自纯 CSS 即可覆盖的部分；framer-motion 仅在三个 CSS 干不了的场合启用；性能模式是"降级三档"而非"全关"。

## 一、现状盘点（2026-08-24 调查事实）

### 1.1 已有动效（第 0 层，零成本）

全部 radix 浮层已配 `data-state` 进出场（tw-animate-css）：

- `packages/app/src/components/ui/dialog.tsx:28,51`（overlay fade + content fade/zoom，设置页即此）
- `ui/dropdown-menu.tsx:31,194`、`ui/popover.tsx:27`、`ui/select.tsx:69`、`ui/tooltip.tsx:35`、`ui/context-menu.tsx`、`ui/alert-dialog.tsx` 均有 fade/zoom/slide 进出场
- 全局 hover 缓动基线：`index.css:117-139`（交互元件 150ms ease-out，只覆盖绘制属性）
- `ui/sheet.tsx`（slide 300/500ms）与 `ui/drawer.tsx`（vaul）**已封装但无使用方**，继续躺着

存量密度：`animate-*` 87 处（spin 40 / in 15 / out 13）、`transition-*` 122 处——"spinner + radix 进出场 + hover 微动效"水平，无 JS 动画。

### 1.2 硬切清单（本方案的主战场）

| 场景 | 实现方式 | 文件 |
|---|---|---|
| 阅读器侧栏（笔记/AI） | 条件渲染硬切 | `reader-layout.tsx:494,543`（`isNotepadVisible && <Resizable/>`） |
| 书库侧栏标签列表 | 条件渲染硬切 | `sidebar.tsx:218`（`isLibraryExpanded && <TagList/>`） |
| 管理状态（图书馆） | 条件渲染硬切 | `library/index.tsx:352`（批量条）、`book-item.tsx:570`（复选框） |
| 管理状态（文献库） | 条件渲染硬切 | `papers/index.tsx:461,1385,1667` |
| 右下角进度卡堆叠 | 纯条件渲染，无动画 | `bottom-right-stack.tsx:23,32`、`global-convert-progress.tsx:200,204,209` |
| 书库↔阅读器 tab 切换 | 常驻层 `visibility` + zIndex 硬切 | `reader-layout.tsx:461-486,593-600` |
| 主页内页切换 | react-router `<Routes>`，无过渡 | `home-layout.tsx:159-224` |

### 1.3 关键架构事实（影响方案取舍）

1. **保活 tab 架构是转场理想底子**：所有 tab 常驻（absolute inset-0 多层 + visibility 切换 + tab 休眠机制 `reader-layout.tsx:88-154`），两画面同时在场，转场只需改合成器属性，近零成本。
2. **性能前科**：论文页 5.3 万元素时，打开任意 radix 弹层触发全页强制样式重算 6.3s，靠 `content-visibility: auto` 压到 1.8s（`index.css:697-708` 注释记载）。**任何越线动画（动 layout 属性）会在论文页复现此墙。**
3. **书籍划线在 closed shadow DOM 内**：`packages/foliate-js/paginator.js:446` `attachShadow({ mode: "closed" })`，高亮是 `overlayer.js:17-24,52-74` 程序化绘制的 SVG（颜色为 fill 属性，app 侧 `use-annotator.ts:98-109` 每次 JS 重绘）——**外层 CSS 物理不可达**。论文划线走 CSS Custom Highlight API（`index.css:380-515` `::highlight(paper-anno-*)`），全局 CSS 可管。
4. **framer-motion 已在依赖但零使用**（`packages/app/package.json:63`，全 workspace 源码无 import）——启用不构成新增依赖。
5. **Tauri 架构**：Windows WebView2 = Chromium；macOS WKWebView / Linux WebKitGTK 为 WebKit 系。
6. 设置存取现成：`app-settings-store.ts:30-58`（zustand persist → `tauri-storage.ts` JSON 文件）；`SystemSettings` 类型在 `src/types/settings.ts:28+`，当前无任何动效字段。
7. CSS 变量 token 体系完备（`themes/default.css` oklch 全家桶 + `index.css:55-108` @theme 映射），动效 token 照抄此模式。

## 二、设计宪法：iOS 丝滑的四条纪律

iOS 连贯感可解构为四条，Web 全有对应物（类比：硬切是 PPT 翻页——上一帧还在、下一帧换了张图；iOS 是抽屉推拉——同一物体连续移动）：

| iOS 做法 | 本质 | Web 对应 |
|---|---|---|
| 动画跑专用合成线程 | 只碰 `transform` / `opacity`，GPU 搬现成图层，不重排不重绘 | CSS transition（同样上合成线程） |
| 物理曲线 | 快起缓停，非匀速 | `cubic-bezier(0.16, 1, 0.3, 1)`（ease-out-expo）/ 弹簧 |
| 可中断可重定向 | 开到一半反向，从当前位置接着来 | CSS transition 天生支持；JS 动画需专门处理 |
| 转场协调 | 新旧画面同帧交接，无空白帧 | 两层交叉淡入（保活架构红利） |

**第一宪法：动效只准碰 `transform` / `opacity`（含 `visibility` 的延迟切换）。** 守住则 5.3 万元素也丝滑；越线（width/top/margin 逐帧重排、大面积模糊阴影逐帧重算）即在论文页复现 6.3s 惨案。性能模式的最大价值正是对此兜底——任何越线实现，开关一开全部退化成 0.01ms，一键回到硬切世界（逃生舱）。

## 三、分层路线（按性价比排序）

| 层 | 内容 | 成本 | 备注 |
|---|---|---|---|
| 0 | radix 浮层进出场 | 已完成 | 不花钱 |
| 1 | 消灭条件渲染硬切：管理态 pop/滑入、进度卡出入场、侧栏（先书库后阅读器） | 低 | 纯 CSS + 少量卸载编排 |
| 2 | 动效 token 体系 + 三档性能模式 | 低（半天级） | 地基，先于第 1 层落地 |
| 3 | 页面/tab 交叉淡入；共享元素转场（封面→阅读器，framer-motion layoutId） | 中 | 保活架构红利 |
| 4 | 手势驱动 + 可中断（侧栏边缘拖拽、按速度决定开合） | 高 | 二期，必须 JS |

要点：

- **离场是第 1 层唯一的技术坎**：React 条件渲染"卸载即消失"，没有离场帧。解法：radix 式 closing 态延迟卸载（播完动画再 unmount），或 AnimatePresence。进度卡堆叠容器内卡片增减的位移是 FLIP 场景，纯 CSS 可接受硬位移，要顺滑则属 framer-motion `layout` 甜点区。
- **交叉淡入**：常驻层 `visibility` 硬切改为旧层 opacity 1→0 / 新层 0→1（可加 4px 上移），配 `transition-delay` 处理 visibility 的离散切换；注意双层同现时的 zIndex 与 pointer-events。全程合成器属性。
- **侧栏见裁定三。**

## 四、五个裁定（讨论结论）

### 裁定一：不急着启用 framer-motion，能用 CSS 绝不用 JS

与"能用规则绝不用模型"同构。CSS transition 跑合成线程，主线程再卡动画也不掉帧——这本身是丝滑的保险；JS 逐帧驱动在主线程，论文页负载下它自己就是掉帧源。framer-motion 仅在三个 CSS 干不了的场合启用：**离场卸载编排（AnimatePresence）、共享元素（layoutId）、手势**——且只用于那几个点，不全局接管。vaul 桌面端无用，继续躺。

### 裁定二：性能模式 = 降级三档，不是全关

业界口径一致：iOS"减弱动态效果"用淡入淡出替代位移缩放（硬切比慢动画更晃眼）；macOS 是"减少透明度"而非去掉过渡。同款三档：

| 档位 | 值 | 效果 |
|---|---|---|
| 完整动效 | `full`（默认） | 全量 |
| 仅淡入淡出 | `fade-only`（性能模式） | 时长压短、位移/缩放退化为 fade |
| 遵循系统 | `system` | 跟随 `prefers-reduced-motion` |

默认 full 的理由：桌面 Tauri 应用硬件可控性高于浏览器网页；低配机用户自行开 fade-only。

### 裁定三：阅读器内侧栏不做逐帧推移

推移式（内容区跟宽）最 iOS，但 EPUB 是 foliate iframe 分页渲染——宽度逐帧变 = **逐帧重新分页**，必炸。三口径按优先级：

1. **覆盖式**：侧栏滑出盖在内容上，零重排，纯 transform，最便宜（iOS 临时面板同款）——推荐默认
2. **冻结式**：动画期间冻结内容区宽度，动画结束后一次性重分页（观感近推移，代价可控）
3. **本体动画式**：侧栏本体滑入 + 内容区瞬间换宽（现状保留，只加动势）

书库/文献库页无 iframe，不受此限。re-resizable 用户手调宽度须被动画记住，不得与动画打架（动画收起时记录当前宽度，展开还原）。

### 裁定四：划线高亮本期不碰

书籍划线在 closed shadow DOM，动效须改 foliate 源码层面（overlayer 绘制协议），投入产出不划算。论文侧（Highlight API）全局 CSS 管得到，但划线非闪跳重灾区，不做。

### 裁定五：不押注 View Transitions API

代码量极小很诱人，但 Tauri 内核分平台：Windows WebView2（Chromium）支持；macOS WKWebView、Linux WebKitGTK **均不支持**。跨平台会留一堆平台分支。framer-motion layoutId 全平台一致，作为共享元素的实现选型。

## 五、动效 token 体系与性能模式落地设计

### 5.1 CSS 变量（照抄主题色 token 模式）

```css
/* index.css @theme 或 :root */
:root {
  --motion-dur-fast: 120ms;   /* 微交互：复选框 pop、hover */
  --motion-dur-base: 200ms;   /* 面板开合、卡片出入场 */
  --motion-dur-slow: 300ms;   /* 页面/tab 转场 */
  --motion-ease: cubic-bezier(0.16, 1, 0.3, 1);  /* ease-out-expo */
}
[data-motion="fade-only"] { --motion-dur-slow: 120ms; --motion-dur-base: 80ms; /* 位移/缩放类另行退化 */ }
[data-motion="reduced"]   { --motion-dur-fast: 0.01ms; --motion-dur-base: 0.01ms; --motion-dur-slow: 0.01ms; }
```

数值依据：iOS HIG / Material Motion 公开区间（微交互 100-200ms、面板 200-250ms、转场 300ms），不发明。

**规矩：所有动效只准引用 token，不准写裸数值。** `data-motion` 属性挂 documentElement，由设置驱动，一处切换全局生效，零组件级 if 分支。

### 5.2 设置项

- `SystemSettings` 加字段 `motionMode: "full" | "fade-only" | "system"`（默认 `full`），走 `app-settings-store` persist → Tauri JSON，现成链路零新增基建
- `system` 档实现：监听 `matchMedia('(prefers-reduced-motion: reduce)')`，命中则等价 `reduced`，否则 `full`；监听变化实时切换
- 设置 UI 落在 settings-dialog general 分区，三选一（radio group 或 segmented）

### 5.3 fade-only 的退化语义

位移/缩放类动画在 fade-only 下退化为纯 fade（对齐 iOS"减弱动态效果"口径）。实现口径：位移距离变量化（`--motion-slide: 8px`，fade-only 下 `0px`；scale 同理 `--motion-scale: 0.98` → `1`），或对位移类动画统一走一个工具类族，fade-only 下改写为 fade-only 变体。实施时二选一，倾向前者（仍是纯变量规则）。

### 5.4 动态壁纸冻结（2026-08-28 补，用户裁定）

生效档位 ≠ full 时（fade-only，或 system 档命中减弱动效折算为 reduced），`ThemeBackgroundVideo` 将 `--bg-video` 视频层 **pause 冻结在当前帧**（静态壁纸化），播放控制全部命令式（不用 autoPlay 属性，规避 autoplay 算法与显式 pause 的竞态）。动机：全屏 loop 视频的持续解码+逐帧合成与 keepalive 大层 visibility 翻转的 raster 突发抢 GPU（图书馆↔文献库切换卡顿的加重因子）。

两条实现红线：
- **冻结而非卸载**：视频壁纸主题的全局画布 `--background` 是半透明遮罩（怜烟 14%/22% alpha），阅读区纯色背景也走 translucentSolid——整层卸掉会透出 html 白底，暗色模式视觉必破。冻结既拿走解码/合成开销，又让半透明栈原样成立。
- **首帧未解码不得先 pause**：首帧尚未解码时（preload 策略未取到数据的情况下）视频帧渲染为透明，须等 `loadeddata` 再停（readyState ≥ HAVE_CURRENT_DATA 直接停）。

普适性：判定只看 `useEffectiveMotionMode() !== "full"`，不感知具体主题——任何声明 `--bg-video` 的自定义视频壁纸自动受控。切回 full 档从冻结位置无缝续播。

## 六、风险清单

1. **越线动画**（动 layout 属性）→ 论文页复现 6.3s 重排惨案。对策：第一宪法 + code review 口径 + 性能模式兜底退化。
2. **离场卸载时机**：React 条件渲染无 exit 帧，需 closing 态编排；编排期间组件仍需响应数据更新（进度卡收尾数据不能丢）。
3. **closed shadow DOM**：书籍划线 CSS 不可达（裁定四已排除）。
4. **re-resizable × 动画**：拖拽内联 width 与动画收起的冲突，须记录/还原用户宽度。
5. **双层同现的交叉淡入**：zIndex、pointer-events、以及被淡出层的滚动位置/焦点保持（保活架构本身已保证渲染在场，风险低）。
6. **follow-through 细节**：动画中断（快速来回开合侧栏）CSS transition 天然可中断，但 visibility 延迟切换的离散逻辑要测快速连打。

## 七、实施顺序与验收口径（待实施，本节为施工序）

| 序 | 批次 | 内容 | 验收 |
|---|---|---|---|
| 1 | 地基 | motion token 三档变量 + `data-motion` 生效链 + 设置项三选一 + system 档媒体查询 | 切换设置，肉眼验证各档；system 档随 OS 开关实时变 |
| 2 | 小 DOM 先行 | 管理态（复选框 pop、批量条滑入，图书馆+文献库）+ 进度卡出入场（含离场编排） | 连续开关无残影；进度卡收尾数据在离场动画期间正确显示 |
| 3 | tab 转场 | 书库↔阅读器交叉淡入 + 4px 位移；主页路由切换同款 | 快速连续切 tab 无闪烁、无空白帧；滚动位置保持 |
| 4 | 侧栏 | 书库侧栏（推移式，无 iframe）→ 阅读器侧栏（覆盖式或冻结式，裁定三） | re-resizable 宽度记忆正确；fade-only/reduced 档全部退化 |
| 5 | 二期候选 | 共享元素（layoutId）+ 手势拖拽（framer-motion 登场） | 另行立项 |

每批必测：论文页（大 DOM 压力场）下开启动效的帧率；三档切换的正确退化。

## 八、不做清单（明确排除）

- View Transitions API（裁定五：跨平台不支持）
- 划线/标注高亮动效（裁定四：closed shadow DOM）
- vaul / drawer 手势库启用（桌面端无场景）
- framer-motion 全局接管（仅三场合：离场编排 / 共享元素 / 手势）
- 毛玻璃 backdrop-blur 类大面积模糊动效（性能杀手，即使 full 档也慎用）
